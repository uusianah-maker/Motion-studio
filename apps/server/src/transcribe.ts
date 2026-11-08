import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AiCallError, transcribe } from './ai/adapters.js';
import type { AiRouter } from './ai/router.js';
import type { Route } from './app.js';
import type { Copilot } from './copilot.js';
import {
  type Transcript,
  type Workspace,
  audit,
  buildCues,
  cuesToSubtitleOps,
  isStorageError,
  listTranscripts,
  loadRegistry,
  readProject,
  readTranscript,
  runFfmpeg,
  saveNewTranscript,
  updateCues,
  validateCues,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { bad, onlyKeys } from './routes.js';

/**
 * Captions / speech-to-text (W14). Flow: estimate (minutes × the provider's price) → the user
 * confirms that amount → audio is extracted WITHOUT metadata (title/location never leave the
 * server) → one transcription call through the W12 router + W13 budget → words → cues →
 * saved transcript → human edit (validated: no overlap, inside the media) → subtitles via an
 * edit plan (approve → apply → one undo step). Originals are never touched.
 */

export const STT_TMP_PREFIX = 'motion-stt-';
export const MAX_STT_MINUTES = 60;

interface Job {
  job_id: string;
  project_id: string;
  version_id: string;
  status: 'running' | 'completed' | 'failed';
  phase: 'extracting' | 'transcribing' | 'saving';
  transcript_id: string | null;
  error: { code: string; message: string } | null;
  created_at: number;
  finished_at: number | null;
}

const summary = (t: Transcript) => {
  const { words: _w, cues, ...rest } = t;
  void _w;
  return { ...rest, cue_count: cues.length };
};

export function transcribeRoutes(ws: Workspace, opts: { router: AiRouter; copilot: Copilot; tmpRoot: string }): Route[] {
  const jobs: Job[] = [];

  /** The media version must be usable and visible to this project. */
  async function mediaFor(projectId: string, versionId: unknown) {
    if (typeof versionId !== 'string' || !/^v_[0-9a-f]{16}$/.test(versionId)) throw bad('version_id tidak valid');
    await readProject(ws, projectId);
    const reg = await loadRegistry(ws);
    const v = reg.versions[versionId];
    const m = v ? reg.media[v.media_id] : undefined;
    if (!v || !m || (m.scope.kind === 'project' && m.scope.project_id !== projectId)) throw new ApiError(404, 'NOT_FOUND', 'Media tidak ada di proyek ini');
    if (v.lifecycle !== 'active' || v.integrity !== 'ok') throw new ApiError(409, 'CONFLICT', 'Media ada di Trash, hilang, atau berubah; transkripsi tidak bisa dijalankan');
    if (!v.probe || !v.probe.audio_codec) throw new ApiError(422, 'PRECONDITION', 'Media ini tidak punya suara (atau belum terbaca durasinya)');
    if (v.probe.duration_ms > MAX_STT_MINUTES * 60_000) throw new ApiError(422, 'PRECONDITION', `Media lebih dari ${MAX_STT_MINUTES} menit; potong dulu`);
    return { v, m, minutes: Math.ceil((v.probe.duration_ms / 60_000) * 100) / 100 };
  }

  function estimate(minutes: number) {
    const c = opts.router.first('transcription');
    return c ? { connection: c, usd: Math.round(minutes * c.prices.per_audio_minute * 1e6) / 1e6 } : null;
  }

  async function run(job: Job, rel: string, durationMs: number, mediaId: string, language: 'id' | 'en' | null, confirmUsd: number, minutes: number) {
    let dir: string | null = null;
    try {
      const work = await fsp.mkdtemp(path.join(opts.tmpRoot, STT_TMP_PREFIX));
      dir = work;
      const audio = path.join(work, 'audio.m4a');
      await ws.blobs.withLocalFile(rel, (src) =>
        runFfmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-n', '-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', audio], { cwd: work }),
      );
      job.phase = 'transcribing';
      const r = await opts.router.call(
        'transcription',
        {
          project_id: job.project_id,
          estimate: (c) => minutes * c.prices.per_audio_minute,
          // The user approved a price; a backup provider that costs more is skipped, not used silently (F-8/F-9).
          skip: (c) => (minutes * c.prices.per_audio_minute > confirmUsd + 1e-9 ? 'lebih mahal dari biaya yang disetujui' : null),
        },
        async (target, signal) => {
          const out = await transcribe(target, { file: audio, mime: 'audio/mp4', language }, signal);
          return { value: out, usage: out.usage.audio_seconds ? out.usage : { ...out.usage, audio_seconds: durationMs / 1000 }, request_id: out.request_id };
        },
      );
      if (r.cost_usd > confirmUsd * 1.05 + 0.0001) {
        await audit(ws, { op: 'transcript.cost_over_confirmed', actor: 'ai', outcome: 'alert', project_id: job.project_id, confirmed_usd: confirmUsd, cost_usd: r.cost_usd });
      }
      job.phase = 'saving';
      // Checkpoint F F-6: words outside the media are dropped; the cues built from them always pass
      // the same validation as a human edit (so saving an untouched transcript never fails).
      const words = r.value.words.filter((w) => w.start_ms < durationMs).map((w) => ({ ...w, end_ms: Math.min(w.end_ms, durationMs) }));
      const t = await saveNewTranscript(ws, {
        project_id: job.project_id,
        media_id: mediaId,
        version_id: job.version_id,
        language: r.value.language ?? language,
        provider: r.connection.provider,
        model: r.connection.model,
        source_duration_ms: durationMs,
        words,
        cues: validateCues(buildCues(words, { duration_ms: durationMs }), durationMs),
      });
      job.transcript_id = t.transcript_id;
      job.status = 'completed';
      await audit(ws, { op: 'transcript.create', actor: 'user', outcome: 'ok', project_id: job.project_id, transcript_id: t.transcript_id, version_id: job.version_id, provider: r.connection.provider, cues: t.cues.length, cost_usd: r.cost_usd }).catch(() => undefined);
    } catch (e) {
      job.status = 'failed';
      const code = e instanceof ApiError ? e.code : isStorageError(e) ? e.code : e instanceof AiCallError ? 'AI_UNAVAILABLE' : 'INTERNAL';
      const message = e instanceof ApiError || isStorageError(e) ? e.message : e instanceof AiCallError ? e.message : 'Transkripsi gagal';
      job.error = { code, message: code === 'RENDER_FAILED' || code === 'INTERNAL' ? 'Audio tidak bisa diambil dari media ini' : message };
      await audit(ws, { op: 'transcript.create', actor: 'user', outcome: 'failed', project_id: job.project_id, version_id: job.version_id, code }).catch(() => undefined);
    } finally {
      job.finished_at = Date.now();
      if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return [
    {
      method: 'POST',
      path: '/api/projects/:project_id/transcripts/estimate',
      handle: async ({ req, params }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['version_id']);
        const { minutes } = await mediaFor(params.project_id!, body.version_id);
        const est = estimate(minutes);
        return {
          minutes,
          estimate_usd: est?.usd ?? null,
          provider: est ? { connection_id: est.connection.connection_id, provider: est.connection.provider, model: est.connection.model, label: est.connection.label } : null,
          unavailable: est ? null : opts.router.available('transcription'),
        };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/transcripts',
      handle: async ({ req, params }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['version_id', 'language', 'confirm_usd', 'connection_id']);
        const projectId = params.project_id!;
        const lang = body.language ?? 'auto';
        if (lang !== 'id' && lang !== 'en' && lang !== 'auto') throw bad('language harus id | en | auto');
        const { v, m, minutes } = await mediaFor(projectId, body.version_id);
        const est = estimate(minutes);
        if (!est) throw new ApiError(503, 'AI_UNAVAILABLE', opts.router.available('transcription') ?? 'Belum ada koneksi transkripsi');
        const confirm = body.confirm_usd;
        // Paid action (Checkpoint F F-9): the user must confirm exactly the estimate that was shown,
        // for the connection it was quoted for — not "any big number".
        const tolerance = Math.max(0.0001, est.usd * 0.01);
        if (typeof confirm !== 'number' || !Number.isFinite(confirm) || Math.abs(confirm - est.usd) > tolerance || body.connection_id !== est.connection.connection_id) {
          throw new ApiError(409, 'CONFLICT', `Konfirmasi biaya dulu: perkiraan $${est.usd.toFixed(4)} (${minutes} menit × $${est.connection.prices.per_audio_minute}/menit, ${est.connection.label})`);
        }
        if (jobs.some((j) => j.status === 'running')) throw new ApiError(409, 'BUSY', 'Masih ada transkripsi yang berjalan; tunggu selesai');
        const job: Job = { job_id: `stt_${randomBytes(6).toString('hex')}`, project_id: projectId, version_id: v.version_id, status: 'running', phase: 'extracting', transcript_id: null, error: null, created_at: Date.now(), finished_at: null };
        jobs.push(job);
        while (jobs.length > 30) jobs.shift();
        run(job, v.rel_path, v.probe!.duration_ms, m.media_id, lang === 'auto' ? null : lang, est.usd, minutes).catch(() => undefined);
        return { job };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/transcripts',
      handle: async ({ params }) => {
        await readProject(ws, params.project_id!);
        return { transcripts: (await listTranscripts(ws, params.project_id!)).map(summary), jobs: jobs.filter((j) => j.project_id === params.project_id).reverse() };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/transcripts/:transcript_id',
      handle: async ({ params }) => {
        const t = await readTranscript(ws, params.project_id!, params.transcript_id!);
        const { words, ...rest } = t;
        return { transcript: { ...rest, word_count: words.length } };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/transcripts/:transcript_id',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req, 4 * 1024 * 1024);
        onlyKeys(body, ['expected_rev', 'cues']);
        const rev = body.expected_rev;
        if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) throw bad('expected_rev wajib angka');
        const t = await updateCues(ws, params.project_id!, params.transcript_id!, rev, body.cues);
        await audit(ws, { op: 'transcript.edit', actor, outcome: 'ok', project_id: t.project_id, transcript_id: t.transcript_id, rev: t.rev, cues: t.cues.length });
        const { words, ...rest } = t;
        return { transcript: { ...rest, word_count: words.length } };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/transcripts/:transcript_id/subtitles',
      handle: async ({ req, params }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['clip_id']);
        if (body.clip_id !== undefined && (typeof body.clip_id !== 'string' || body.clip_id.length > 64)) throw bad('clip_id tidak valid');
        const t = await readTranscript(ws, params.project_id!, params.transcript_id!);
        const project = await readProject(ws, t.project_id);
        const r = cuesToSubtitleOps(t, project.timeline, body.clip_id as string | undefined);
        return opts.copilot.propose({
          project_id: t.project_id,
          source: 'transcript',
          prompt: `Subtitle dari transkrip (${t.cues.length} cue)`,
          ops: r.ops,
          rationale: `${r.ops.length} subtitle dari transkrip ${t.language ?? ''}`.trim() + (r.placements > 1 ? ` di ${r.placements} klip` : ''),
          warnings: r.warnings,
        });
      },
    },
  ];
}
