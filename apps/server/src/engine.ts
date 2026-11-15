import type { Route } from './app.js';
import type { Copilot } from './copilot.js';
import {
  type EngineConfig,
  type EngineMode,
  type EngineStatus,
  type Workspace,
  audit,
  continueRefusedJob,
  editTransfer,
  isBatchName,
  isJobId,
  listEngineBatches,
  listProjectIds,
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
  readTransferImage,
  readBeatspotView,
  rerunBeatspot,
  readTransferView,
  runEngineJob,
  setShotExclusions,
  settleOrphanJob,
  validateEngineJob,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';
import { sendBytes } from './stream.js';
import { Readable } from 'node:stream';

/**
 * U6 engine runner routes (KONTRAK-ENGINE v0.3). The engine (Python, `D:\VIBECODING\remotion`)
 * runs as a child process, one job at a time per server (Whisper is CPU/GPU heavy); others wait.
 * Its plan only reaches the timeline through the normal Copilot path (source `engine`): diff →
 * the team approves → one undo step. Nothing is rendered here.
 */
export function engineRoutes(ws: Workspace, opts: { copilot: Copilot; config: EngineConfig | null; onError?: (e: unknown) => void }): Route[] {
  return createEngine(ws, opts).routes;
}

/**
 * The engine runner + its routes. `stopAll` (server stop) cancels queued jobs, kills the running
 * engine (and its Whisper / FFmpeg children) and waits for it, so no Python outlives the server
 * and a restarted server never finds a live job it would settle as an orphan (audit Jenius #2).
 */
export function createEngine(ws: Workspace, opts: { copilot: Copilot; config: EngineConfig | null; onError?: (e: unknown) => void }): { routes: Route[]; stopAll: () => Promise<void>; sweepOrphans: () => Promise<number> } {
  const queue: { project_id: string; job_id: string; mode: EngineMode }[] = [];
  const active = new Map<string, AbortController>();
  /** Requests preparing a job right now, per project: never "orphans" (Checkpoint I H1, audit Jenius #4). */
  const preparing = new Map<string, number>();
  let running = false;
  let current: Promise<void> | null = null;
  let stopping = false;
  const key = (p: string, j: string) => `${p}/${j}`;
  // `engine daftar_batch` spawns Python: one at a time, answer reused for a few seconds, dropped
  // when a job (Pisah Audio) may have changed the engine's konten/.
  type BatchList = { tersedia: boolean; batches: Awaited<ReturnType<typeof listEngineBatches>>; alasan: string | null };
  let batchCache: { at: number; value: BatchList } | null = null;
  let batchFlight: Promise<BatchList> | null = null;

  const pump = () => {
    if (running || stopping || !opts.config) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    const ac = new AbortController();
    active.set(key(next.project_id, next.job_id), ac);
    current = runEngineJob(ws, opts.config, next.project_id, next.job_id, { mode: next.mode, signal: ac.signal })
      .then(() => undefined)
      .catch((e: unknown) => opts.onError?.(e))
      .finally(() => {
        active.delete(key(next.project_id, next.job_id));
        batchCache = null;
        running = false;
        current = null;
        pump();
      });
  };
  /**
   * Server start (audit Jenius #9): jobs a previous server left waiting / running are settled now,
   * not only when someone opens them — their leases are freed and Pisah Audio's copies removed.
   */
  const sweepOrphans = async () => {
    let n = 0;
    for (const p of await listProjectIds(ws).catch(() => [] as string[])) {
      for (const s of await listEngineJobs(ws, p).catch(() => [])) {
        if (s.state !== 'menunggu' && s.state !== 'berjalan') continue;
        if ((await live(s)) !== s) n++;
      }
    }
    return n;
  };
  /** Prepare a job (counted as "preparing" for the orphan check) and put it in the queue. */
  const enqueue = async (projectId: string, prepare: () => Promise<EngineStatus>): Promise<EngineStatus> => {
    if (queue.length >= 20) throw new ApiError(429, 'BUSY', 'Antrean mesin penuh (20); tunggu dulu');
    if (stopping) throw new ApiError(409, 'BUSY', 'Server sedang dihentikan; coba lagi sebentar lagi');
    preparing.set(projectId, (preparing.get(projectId) ?? 0) + 1);
    try {
      const status = await prepare();
      queue.push({ project_id: status.project_id, job_id: status.job_id, mode: status.mode });
      pump();
      return status;
    } finally {
      const left = (preparing.get(projectId) ?? 1) - 1;
      if (left > 0) preparing.set(projectId, left);
      else preparing.delete(projectId);
    }
  };
  const stopAll = async () => {
    stopping = true;
    for (const q of queue.splice(0)) {
      const s = await readEngineStatus(ws, q.project_id, q.job_id).catch(() => null);
      if (s) await settleOrphanJob(ws, s, 'Server dihentikan sebelum job ini mulai; jalankan lagi').catch((e: unknown) => opts.onError?.(e));
    }
    for (const ac of active.values()) ac.abort();
    await current;
  };

  /** Jobs this server is not running or queueing were left by a previous server: settle them. */
  const live = async (s: EngineStatus) =>
    active.has(key(s.project_id, s.job_id)) || (preparing.get(s.project_id) ?? 0) > 0 || queue.some((q) => q.project_id === s.project_id && q.job_id === s.job_id) ? s : settleOrphanJob(ws, s);
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

  const routes: Route[] = [
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
        return { job: await enqueue(input.project_id, () => prepareEngineJob(ws, input)) };
      },
    },
    {
      // R1 (hybrid): "Tetap lanjut" after a refusal because the audio sounded like a song — a new
      // Generate job with the same inputs and the engine's song check skipped.
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/lanjut',
      handle: async ({ params, actor }) => {
        needEngine();
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const job = jobParam(params.job_id);
        return { job: await enqueue(params.project_id!, () => continueRefusedJob(ws, params.project_id!, job)) };
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
          return { job: await settleOrphanJob(ws, await readEngineStatus(ws, params.project_id!, job), 'Dibatalkan pengguna sebelum mulai') };
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
        if (s.mode === 'transfer') throw new ApiError(400, 'BAD_REQUEST', 'Motion Transfer tidak punya rencana edit');
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
          prompt: `Draf ${s.mode === 'batch' ? 'Batch Remix' : s.mode === 'beatspot' ? 'Beat Spot' : 'Generate Otomatis'} ${job}${variant ? ` ${variant}` : ''}`,
          ops: p.ops,
          rationale: `${hook}${dur}. Disusun mesin; render ditahan sampai disetujui.`,
          warnings,
        });
        await audit(ws, { op: 'engine.plan', actor, outcome: 'ok', project_id: params.project_id!, job_id: job, plan_id: out.plan.plan_id, imported: p.imported.length });
        return { ...out, rencana: p.rencana, qc: p.qc };
      },
    },
    {
      // R16 Beat Spot: the engine's cut report + the settings the job ran with + its files.
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id/beatspot',
      handle: async ({ params }) => ({ beatspot: await readBeatspotView(ws, params.project_id!, jobParam(params.job_id)) }),
    },
    {
      // Hybrid: run Beat Spot again on the same files with the team's order / exclusions / people.
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/beatspot/ulang',
      handle: async ({ req, params, actor }) => {
        needEngine();
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh menjalankan mesin');
        const body = await readJsonBody(req);
        onlyKeys(body, ['beatspot']);
        const job = jobParam(params.job_id);
        return { job: await enqueue(params.project_id!, () => rerunBeatspot(ws, params.project_id!, job, body.beatspot)) };
      },
    },
    {
      // R11 Motion Transfer: the scenes (engine split + the team's deletes / merges).
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id/transfer',
      handle: async ({ params }) => ({ transfer: await readTransferView(ws, params.project_id!, jobParam(params.job_id)) }),
    },
    {
      // Hybrid: the team deletes / merges scenes or goes back to the engine's split.
      method: 'POST',
      path: '/api/projects/:project_id/engine/jobs/:job_id/transfer/edit',
      handle: async ({ req, params, actor, user }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh mengubah adegan');
        const body = await readJsonBody(req);
        onlyKeys(body, ['aksi', 'id', 'expected_versi']);
        return { transfer: await editTransfer(ws, { project_id: params.project_id!, job_id: jobParam(params.job_id), aksi: body.aksi, id: body.id, expected_versi: body.expected_versi, by: user?.name ?? null }) };
      },
    },
    {
      // One scene frame (the page fetches it with the session header, then shows / downloads it).
      method: 'GET',
      path: '/api/projects/:project_id/engine/jobs/:job_id/transfer/gambar/:no',
      handle: async ({ req, res, params }) => {
        const no = /^\d{1,4}$/.test(params.no ?? '') ? Number(params.no) : -1;
        const img = await readTransferImage(ws, params.project_id!, jobParam(params.job_id), no);
        await sendBytes(req, res, { size: img.bytes.length, mime: img.mime, open: async (r) => Readable.from(r ? img.bytes.subarray(r.start, r.end + 1) : img.bytes) });
        return undefined;
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
  return { routes, stopAll, sweepOrphans };
}
