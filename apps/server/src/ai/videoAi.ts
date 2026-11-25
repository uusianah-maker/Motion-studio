import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Route } from '../app.js';
import { StorageService, type Workspace, readMediaBytes, readProject } from '../core.js';
import { ApiError } from '../errors.js';
import { readJsonBody } from '../http.js';
import { onlyKeys } from '../routes.js';
import { IMAGE_PROVIDERS, ImageGenError, type ImageAiStore, beliapiTask } from './imageAi.js';

/**
 * 25 Nov (owner: "OMNI FLASH 1.2 … ya 1+2"): Video AI with the beliapi.com key of "AI gambar".
 * "＋ Video AI" on the timeline and "✨ B-roll AI" in Cetakan per kalimat send a prompt (+ up to 3
 * pictures) to OMNI FLASH 1.2; the MP4 lands in the project's Media. Placing it on the timeline is
 * the editor's job (an ordinary add_clip = one Undo), so nothing changes the project behind the
 * team's back. One video at a time (the plan allows 1 running), jobs kept in memory (a restart
 * forgets the list, the files already made stay in Media).
 */
export type VideoMode = 't2v' | 'sfv' | 'i2v';
export const VIDEO_MODEL = 'omni-1.2';
const MAX_MEDIA = 5 * 1024 * 1024;
const MAX_WAIT_MS = 20 * 60_000;

export interface VideoJob {
  job_id: string;
  project_id: string;
  prompt: string;
  mode: VideoMode;
  ratio: '9:16' | '16:9';
  /** Where the editor should put the clip when it is ready (timeline ms; the editor decides). */
  tempat: { start_ms: number; max_ms: number | null; asal: 'toolbar' | 'cetakan' } | null;
  state: 'antre' | 'membuat' | 'siap' | 'gagal';
  /** beliapi status (queued, processing, …) while making. */
  status: string | null;
  hasil: { media_id: string; version_id: string } | null;
  alasan: string | null;
  created_at: number;
  finished_at: number | null;
}

const bad = (msg: string) => new ApiError(422, 'EDIT_INVALID', msg);
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export function createVideoAi(ws: Workspace, deps: { imageAi: ImageAiStore; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; tmpRoot?: string; onError?: (e: unknown) => void; now?: () => number; keep?: number }) {
  const now = deps.now ?? Date.now;
  const jobs: VideoJob[] = [];
  const refs = new Map<string, { media_id: string; version_id: string }[]>();
  let running = false;

  const pump = async (): Promise<void> => {
    if (running) return;
    const j = jobs.find((x) => x.state === 'antre');
    if (!j) return;
    running = true;
    j.state = 'membuat';
    try {
      const key = await deps.imageAi.keyOf();
      const d = deps.imageAi.raw();
      if (!key || d.provider !== 'beliapi') throw new ImageGenError('Video AI butuh penyedia beliapi.com di menu AI → AI gambar (dengan API key yang lolos Tes koneksi)', 'config');
      const media = [];
      for (const r of refs.get(j.job_id) ?? []) {
        const m = await readMediaBytes(ws, r, MAX_MEDIA);
        if (!m.mime.startsWith('image/')) throw new ImageGenError(`"${m.name}" bukan gambar`, 'config');
        media.push(`data:${m.mime};base64,${m.bytes.toString('base64')}`);
      }
      const body = { model: VIDEO_MODEL, prompt: j.prompt, ratio: j.ratio, ...(j.mode !== 't2v' ? { mode: j.mode, media } : {}) };
      const bytes = await beliapiTask(key, IMAGE_PROVIDERS.beliapi.base!, { body, what: 'OMNI FLASH 1.2', maxWaitMs: MAX_WAIT_MS, ...(deps.sleep ? { sleep: deps.sleep } : {}), onStatus: (s) => (j.status = s) }, deps.fetchImpl ?? fetch);
      const tmp = await fsp.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), 'msc-videoai-'));
      try {
        const name = `Video AI - ${j.prompt.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 40) || 'klip'}.mp4`;
        const file = path.join(tmp, name);
        await fsp.writeFile(file, bytes);
        const r = await new StorageService(ws).importMedia({ sourcePath: file, scope: { kind: 'project', project_id: j.project_id }, display_name: name, actor: 'user' });
        j.hasil = { media_id: r.media.media_id, version_id: r.version.version_id };
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
      j.state = 'siap';
    } catch (e) {
      j.state = 'gagal';
      j.alasan = e instanceof ImageGenError || e instanceof Error ? e.message.slice(0, 300) : 'Gagal membuat video';
      if (!(e instanceof ImageGenError)) deps.onError?.(e);
    } finally {
      j.finished_at = now();
      j.status = null;
      refs.delete(j.job_id);
      running = false;
      const keep = deps.keep ?? 100;
      while (jobs.length > keep) {
        const i = jobs.findIndex((x) => x.state === 'siap' || x.state === 'gagal');
        if (i < 0) break;
        jobs.splice(i, 1);
      }
      void pump();
    }
  };

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/api/projects/:project_id/video-ai',
      handle: async ({ req, params, actor }) => {
        if (actor !== 'user') throw new ApiError(403, 'FORBIDDEN', 'Hanya pengguna yang boleh membuat video AI');
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        onlyKeys(body, ['prompt', 'mode', 'ratio', 'media', 'tempat']);
        const pid = params.project_id!;
        await readProject(ws, pid);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (prompt.length < 3 || prompt.length > 4400) throw bad('Prompt 3–4.400 karakter');
        const mode = body.mode === undefined ? 't2v' : body.mode === 't2v' || body.mode === 'sfv' || body.mode === 'i2v' ? body.mode : null;
        if (!mode) throw bad('Mode harus t2v | sfv | i2v');
        const ratio = body.ratio === undefined ? '9:16' : body.ratio === '9:16' || body.ratio === '16:9' ? body.ratio : null;
        if (!ratio) throw bad('Rasio harus 9:16 atau 16:9');
        const media = Array.isArray(body.media) ? body.media : body.media === undefined ? [] : null;
        if (!media || !media.every((m) => m && typeof m === 'object' && SAFE.test((m as Record<string, unknown>).media_id as string) && SAFE.test((m as Record<string, unknown>).version_id as string))) throw bad('media harus daftar { media_id, version_id }');
        const need = mode === 't2v' ? [0, 0] : mode === 'sfv' ? [1, 1] : [1, 3];
        if (media.length < need[0]! || media.length > need[1]!) throw bad(mode === 'sfv' ? 'Mode "foto jadi awal video" butuh tepat 1 gambar' : mode === 'i2v' ? 'Mode "pakai gambar" butuh 1–3 gambar' : 'Mode teks tidak memakai gambar');
        let tempat: VideoJob['tempat'] = null;
        if (body.tempat !== undefined && body.tempat !== null) {
          const t = body.tempat as Record<string, unknown>;
          const ok = typeof t.start_ms === 'number' && Number.isFinite(t.start_ms) && t.start_ms >= 0 && (t.max_ms === undefined || t.max_ms === null || (typeof t.max_ms === 'number' && t.max_ms >= 100)) && (t.asal === 'toolbar' || t.asal === 'cetakan');
          if (!ok) throw bad('tempat tidak valid');
          tempat = { start_ms: Math.round(t.start_ms as number), max_ms: typeof t.max_ms === 'number' ? Math.round(t.max_ms) : null, asal: t.asal as 'toolbar' | 'cetakan' };
        }
        if (jobs.filter((x) => x.state === 'antre' || x.state === 'membuat').length >= 5) throw new ApiError(429, 'BUSY', 'Antrean Video AI penuh (maks 5). Tunggu yang sedang dibuat selesai.');
        const job: VideoJob = { job_id: `vid_${now().toString(36)}_${randomBytes(3).toString('hex')}`, project_id: pid, prompt, mode, ratio, tempat, state: 'antre', status: null, hasil: null, alasan: null, created_at: now(), finished_at: null };
        jobs.push(job);
        refs.set(job.job_id, media.map((m) => ({ media_id: (m as Record<string, string>).media_id!, version_id: (m as Record<string, string>).version_id! })));
        void pump();
        return { job };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/video-ai',
      handle: async ({ params }) => ({ jobs: jobs.filter((x) => x.project_id === params.project_id) }),
    },
  ];
  return { routes, jobs: () => [...jobs], idle: () => !running && !jobs.some((x) => x.state === 'antre') };
}
