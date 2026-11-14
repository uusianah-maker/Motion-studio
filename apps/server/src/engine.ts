import type { Route } from './app.js';
import type { Copilot } from './copilot.js';
import {
  type EngineConfig,
  type EngineMode,
  type EngineStatus,
  type Workspace,
  audit,
  isBatchName,
  isJobId,
  listEngineBatches,
  listEngineJobs,
  loadEnginePlan,
  prepareEngineJob,
  readBatchDecisions,
  readEngineBatchView,
  readEngineLog,
  readEngineStatus,
  readPisahResult,
  readProject,
  readShotExclusions,
  readShotLibrary,
  readShotThumbs,
  runEngineJob,
  setShotExclusions,
  settleOrphanJob,
  validateEngineJob,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';

/**
 * U6 engine runner routes (KONTRAK-ENGINE v0.3). The engine (Python, `D:\VIBECODING\remotion`)
 * runs as a child process, one job at a time per server (Whisper is CPU/GPU heavy); others wait.
 * Its plan only reaches the timeline through the normal Copilot path (source `engine`): diff →
 * the team approves → one undo step. Nothing is rendered here.
 */
export function engineRoutes(ws: Workspace, opts: { copilot: Copilot; config: EngineConfig | null; onError?: (e: unknown) => void }): Route[] {
  const queue: { project_id: string; job_id: string; mode: EngineMode }[] = [];
  const active = new Map<string, AbortController>();
  /** Jobs being prepared by a request right now: never "orphans" (Checkpoint I H1). */
  const preparing = new Set<string>();
  let running = false;
  const key = (p: string, j: string) => `${p}/${j}`;
  // `engine daftar_batch` spawns Python: one at a time, answer reused for a few seconds, dropped
  // when a job (Pisah Audio) may have changed the engine's konten/.
  type BatchList = { tersedia: boolean; batches: Awaited<ReturnType<typeof listEngineBatches>>; alasan: string | null };
  let batchCache: { at: number; value: BatchList } | null = null;
  let batchFlight: Promise<BatchList> | null = null;

  const pump = () => {
    if (running || !opts.config) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    const ac = new AbortController();
    active.set(key(next.project_id, next.job_id), ac);
    void runEngineJob(ws, opts.config, next.project_id, next.job_id, { mode: next.mode, signal: ac.signal })
      .catch((e: unknown) => opts.onError?.(e))
      .finally(() => {
        active.delete(key(next.project_id, next.job_id));
        batchCache = null;
        running = false;
        pump();
      });
  };

  /** Jobs this server is not running or queueing were left by a previous server: settle them. */
  const live = async (s: EngineStatus) =>
    active.has(key(s.project_id, s.job_id)) || preparing.has(s.project_id) || queue.some((q) => q.project_id === s.project_id && q.job_id === s.job_id) ? s : settleOrphanJob(ws, s);
  const jobParam = (j: string | undefined) => {
    if (!isJobId(j)) throw new ApiError(404, 'NOT_FOUND', 'Job mesin tidak ditemukan');
    return j;
  };
  const batchParam = (b: string | undefined) => {
    if (!isBatchName(b)) throw new ApiError(404, 'NOT_FOUND', 'Batch tidak ditemukan');
    return b;
  };
  const needEngine = () => {
    if (!opts.config) throw new ApiError(409, 'ENGINE_MISSING', 'Mesin belum dipasang di server ini (set MOTION_ENGINE_ROOT ke folder repo mesin)');
    return opts.config;
  };

  return [
    {
      method: 'GET',
      path: '/api/engine',
      handle: async () => ({ installed: !!opts.config, running: running ? 1 : 0, waiting: queue.length }),
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs',
      handle: async ({ params }) => {
        await readProject(ws, params.project_id!);
        const jobs = await listEngineJobs(ws, params.project_id!);
        return { jobs: await Promise.all(jobs.map(live)) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs',
      handle: async ({ req, params, actor }) => {
        needEngine();
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const body = await readJsonBody(req);
        const input = validateEngineJob({ ...(body as object), project_id: params.project_id });
        // The team's shot exclusions live here (app side); the engine gets them in job.json.
        if (input.batch) {
          const kecuali = await readShotExclusions(ws, input.batch.batch);
          if (kecuali.length) input.batch.kecualikan_shot = kecuali;
        }
        if (queue.length >= 20) throw new ApiError(429, 'BUSY', 'Antrean mesin penuh (20); tunggu dulu');
        preparing.add(input.project_id);
        try {
          const status = await prepareEngineJob(ws, input);
          queue.push({ project_id: status.project_id, job_id: status.job_id, mode: status.mode });
          pump();
          return { job: status };
        } finally {
          preparing.delete(input.project_id);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id',
      handle: async ({ params }) => {
        const s = await live(await readEngineStatus(ws, params.project_id!, jobParam(params.job_id)));
        return { job: s, log: s.state === 'gagal' ? await readEngineLog(ws, s.project_id, s.job_id, opts.config) : null };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/cancel',
      handle: async ({ params }) => {
        const job = jobParam(params.job_id);
        const k = key(params.project_id!, job);
        const qi = queue.findIndex((q) => key(q.project_id, q.job_id) === k);
        if (qi >= 0) {
          queue.splice(qi, 1);
          return { job: await settleOrphanJob(ws, await readEngineStatus(ws, params.project_id!, job)) };
        }
        const ac = active.get(k);
        if (!ac) throw new ApiError(409, 'NOT_RUNNING', 'Job tidak sedang berjalan');
        ac.abort();
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id/batch',
      handle: async ({ params }) => {
        const job = jobParam(params.job_id);
        // Checkpoint I L2: the media map holds local paths — the browser does not need it (dropped
        // by readEngineBatchView, which also adds the per-sentence shot breakdown).
        return { batch: await readEngineBatchView(ws, params.project_id!, job), decisions: await readBatchDecisions(ws, params.project_id!, job) };
      },
    },
    {
      // U5: the team approves / strikes rows; approved rows become approved variant projects.
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/batch/decide',
      handle: async ({ req, params, svc, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menyetujui batch');
        const body = await readJsonBody(req);
        onlyKeys(body, ['rows']);
        const r = await svc.decideBatch({ project_id: params.project_id!, job_id: jobParam(params.job_id), rows: body.rows, config: opts.config, actor });
        return { decisions: r.result };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/plan',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['variant']);
        const job = jobParam(params.job_id);
        const s = await readEngineStatus(ws, params.project_id!, job);
        if (s.state !== 'siap') throw new ApiError(409, 'NOT_READY', 'Rencana mesin belum siap');
        if (s.mode === 'pisah') throw new ApiError(400, 'BAD_REQUEST', 'Pisah Audio tidak punya rencana edit');
        const variant = body.variant === undefined ? undefined : typeof body.variant === 'string' ? body.variant : undefined;
        const p = await loadEnginePlan(ws, opts.config, params.project_id!, job, variant);
        const r = p.rencana as { hook?: { teks?: unknown }; durasi?: { akhir?: unknown }; peringatan?: unknown; ragu?: unknown; menunggu_u3?: unknown };
        const list = (x: unknown) => (Array.isArray(x) ? x : []);
        const warnings = [
          ...list(r.peringatan).map((w) => `Mesin: ${String((w as { jenis?: unknown }).jenis ?? 'peringatan')} "${String((w as { teks?: unknown }).teks ?? '')}" di ${String((w as { detik?: unknown }).detik ?? '?')} dtk`),
          ...list(r.ragu).map((w) => `Periksa kata "${String((w as { teks?: unknown }).teks ?? '')}" di ${String((w as { detik?: unknown }).detik ?? '?')} dtk (${String((w as { alasan?: unknown }).alasan ?? 'ragu')})`),
          ...(list(r.menunggu_u3).length ? [`Efek dilewati mode kompat: ${list(r.menunggu_u3).map(String).join(', ')}`] : []),
        ];
        const hook = typeof r.hook?.teks === 'string' ? `Hook "${r.hook.teks}"` : 'Draf otomatis';
        const dur = typeof r.durasi?.akhir === 'number' ? `, ${r.durasi.akhir.toFixed(1).replace('.', ',')} dtk` : '';
        const out = await opts.copilot.propose({
          project_id: params.project_id!,
          source: 'engine',
          prompt: `Draf ${s.mode === 'batch' ? 'Batch Remix' : 'Generate Otomatis'} ${job}${variant ? ` ${variant}` : ''}`,
          ops: p.ops,
          rationale: `${hook}${dur}. Disusun mesin; render ditahan sampai disetujui.`,
          warnings,
        });
        await audit(ws, { op: 'engine.plan', actor, outcome: 'ok', project_id: params.project_id!, job_id: job, plan_id: out.plan.plan_id, imported: p.imported.length });
        return { ...out, rencana: p.rencana, qc: p.qc };
      },
    },
    {
      // Pisah Audio result: which files got video / vocals / music (no local paths).
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id/pisah',
      handle: async ({ params }) => ({ pisah: await readPisahResult(ws, params.project_id!, jobParam(params.job_id)) }),
    },
    {
      // Batch dropdown (fitur 2): `engine daftar_batch`. An engine without it = free text in the form.
      method: 'GET',
      path: '/api/engine/batches',
      handle: async () => {
        const cfg = needEngine();
        if (batchCache && Date.now() - batchCache.at < 5000) return batchCache.value;
        batchFlight ??= listEngineBatches(cfg)
          .then((batches): BatchList => ({ tersedia: true, batches, alasan: null }))
          .catch((e: unknown): BatchList => ({ tersedia: false, batches: [], alasan: e instanceof Error ? e.message : String(e) }))
          .then((value) => {
            batchCache = { at: Date.now(), value };
            return value;
          })
          .finally(() => {
            batchFlight = null;
          });
        return batchFlight;
      },
    },
    {
      // Shot Library (fitur 5): labels per shot + the team's exclusions.
      method: 'GET',
      path: '/api/engine/batches/:batch/shots',
      handle: async ({ params }) => {
        const cfg = needEngine();
        const batch = batchParam(params.batch);
        return { library: await readShotLibrary(cfg, batch), kecualikan: await readShotExclusions(ws, batch) };
      },
    },
    {
      // Engine-made thumbnails as data URLs (an <img> cannot send the session's Authorization).
      method: 'GET',
      path: '/api/engine/batches/:batch/thumbs',
      handle: async ({ params, url }) => {
        const cfg = needEngine();
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        if (!ids.length) throw new ApiError(400, 'BAD_REQUEST', 'ids wajib');
        return { thumbs: await readShotThumbs(cfg, batchParam(params.batch), ids) };
      },
    },
    {
      method: 'POST',
      path: '/api/engine/batches/:batch/kecualikan',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh mengubah Shot Library');
        const body = await readJsonBody(req);
        onlyKeys(body, ['shots']);
        return { kecualikan: await setShotExclusions(ws, { batch: batchParam(params.batch), shots: body.shots, actor }) };
      },
    },
  ];
}
