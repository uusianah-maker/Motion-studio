import { spawn } from 'node:child_process';
import { lowerPriority } from './priority.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { StorageError } from './errors.js';
import { ffmpegBin } from './ffmpeg.js';
import { isSafeId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { MEDIA_AREAS } from './permissions.js';
import { probeFile } from './probe.js';
import type { Clip, Timeline, TrackKind } from './project.js';
import { loadRegistry } from './registry.js';
import { type EditOp, MIN_CLIP_MS } from './timeline.js';
import { LAYOUT, type Workspace } from './workspace.js';

/**
 * Silence & scene detection (X07, PRD workflow B "silence detection → review cuts", P1 "scene
 * detection, silence removal"). Pure FFmpeg, no LLM, no network: one read-only pass over the
 * original file. Results are cached per media version (versions are immutable) and turned into
 * an ordinary edit plan that the user reviews and approves — nothing is cut automatically.
 */

export interface AnalysisParams {
  /** Below this level counts as silence (dBFS). */
  noise_db: number;
  /** Shortest pause worth reporting. */
  min_silence_ms: number;
  /** FFmpeg scene score 0..1 (lower = more scene changes). */
  scene_threshold: number;
}
export const DEFAULT_ANALYSIS: AnalysisParams = { noise_db: -35, min_silence_ms: 600, scene_threshold: 0.3 };
export const ANALYSIS_LIMITS = { noise_db: [-60, -15], min_silence_ms: [200, 5000], scene_threshold: [0.1, 0.9] } as const;

export interface MediaAnalysis {
  schema_version: 1;
  version_id: string;
  params: AnalysisParams;
  duration_ms: number;
  has_audio: boolean;
  has_video: boolean;
  /** Source-time ranges (ms) of silence, sorted. */
  silences: { from_ms: number; to_ms: number }[];
  /** Source times (ms) of scene changes, sorted. */
  scenes: number[];
  analyzed_at: number;
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export function validateParams(raw: unknown): AnalysisParams {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o !== 'object' || Array.isArray(o)) return bad('Parameter analisis harus objek');
  const extra = Object.keys(o).filter((k) => !(k in DEFAULT_ANALYSIS));
  if (extra.length) bad(`Parameter tidak dikenal: ${extra.join(', ')}`);
  const out = { ...DEFAULT_ANALYSIS };
  for (const k of Object.keys(DEFAULT_ANALYSIS) as (keyof AnalysisParams)[]) {
    if (o[k] === undefined) continue;
    const v = o[k];
    const [min, max] = ANALYSIS_LIMITS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${k} harus angka ${min}–${max}`);
    out[k] = k === 'scene_threshold' ? Math.round((v as number) * 100) / 100 : Math.round(v as number);
  }
  return out;
}

/** Parse FFmpeg's stderr (silencedetect + showinfo). Exported for tests. */
export function parseDetectLog(log: string, durationMs: number): { silences: MediaAnalysis['silences']; scenes: number[] } {
  const silences: MediaAnalysis['silences'] = [];
  let open: number | null = null;
  const scenes: number[] = [];
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Math.round(Number(s[1]) * 1000));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) {
      silences.push({ from_ms: open, to_ms: Math.min(durationMs, Math.round(Number(e[1]) * 1000)) });
      open = null;
    }
    if (/Parsed_showinfo/.test(line)) {
      const p = /pts_time:\s*([\d.]+)/.exec(line);
      if (p) scenes.push(Math.round(Number(p[1]) * 1000));
    }
  }
  if (open !== null && durationMs - open > 0) silences.push({ from_ms: open, to_ms: durationMs }); // silent to the end
  return { silences: silences.filter((x) => x.to_ms > x.from_ms), scenes: [...new Set(scenes)].filter((t) => t > 0 && t < durationMs).sort((a, b) => a - b) };
}

function runDetect(file: string, p: AnalysisParams, hasAudio: boolean, hasVideo: boolean, signal?: AbortSignal): Promise<string> {
  const graph: string[] = [];
  const maps: string[] = [];
  if (hasAudio) {
    graph.push(`[0:a:0]silencedetect=n=${p.noise_db}dB:d=${(p.min_silence_ms / 1000).toFixed(3)}[aout]`);
    maps.push('-map', '[aout]');
  }
  if (hasVideo) {
    // Small frames are plenty for a scene score and keep this fast on long footage.
    // Frame 0 always passes (the parser ignores t=0): with no scene change at all the output
    // would otherwise be empty, which FFmpeg treats as an error.
    graph.push(`[0:v:0]scale=160:-2,select='eq(n\\,0)+gt(scene\\,${p.scene_threshold})',showinfo[vout]`);
    maps.push('-map', '[vout]');
  }
  const args = ['-hide_banner', '-nostdin', '-v', 'info', '-i', file, '-filter_complex', graph.join(';'), ...maps, '-f', 'null', '-'];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StorageError('CANCELLED', 'Analisis dibatalkan'));
    const child = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    lowerPriority(child);
    let log = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, 15 * 60_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      // Keep only the lines we parse (a long video logs a lot).
      for (const line of d.split('\n')) if (/silence_(start|end)|Parsed_showinfo.*pts_time/.test(line)) log += `${line}\n`;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new StorageError('RENDER_UNAVAILABLE', 'FFmpeg tidak bisa dijalankan'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new StorageError('CANCELLED', 'Analisis dibatalkan'));
      else if (code === 0) resolve(log);
      else reject(new StorageError('RENDER_FAILED', `Analisis FFmpeg gagal (kode ${code})`));
    });
  });
}

const cacheFile = (ws: Workspace, versionId: string) => path.join(ws.root, LAYOUT.meta, 'analysis', `${versionId}.json`);
const sameParams = (a: AnalysisParams, b: AnalysisParams) => a.noise_db === b.noise_db && a.min_silence_ms === b.min_silence_ms && a.scene_threshold === b.scene_threshold;

function validateCached(x: unknown): MediaAnalysis {
  const o = x as MediaAnalysis;
  if (!o || o.schema_version !== 1 || !Array.isArray(o.silences) || !Array.isArray(o.scenes)) throw new StorageError('WORKSPACE_INVALID', 'cache analisis rusak');
  return o;
}

/** Analyse one media version (read-only). Cached per version + params. */
export async function analyzeMedia(ws: Workspace, input: { version_id: string; params?: unknown; signal?: AbortSignal; now?: number }): Promise<MediaAnalysis & { cached: boolean }> {
  if (!isSafeId(input.version_id)) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  const params = validateParams(input.params);
  const reg = await loadRegistry(ws);
  const v = reg.versions[input.version_id];
  if (!v) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', `Media sedang ${v.lifecycle}; pulihkan dulu`);
  if (v.integrity !== 'ok') throw new StorageError('INTEGRITY', `Media ${v.integrity}; perlu verifikasi`);
  const cache = cacheFile(ws, v.version_id);
  const hit = await readJson(cache, validateCached).catch(() => null);
  if (hit && sameParams(hit.params, params)) return { ...hit, cached: true };

  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  const result = await ws.blobs.withLocalFile(rel, async (file) => {
    const probe = v.probe ?? (await probeFile(file));
    if (!probe) throw new StorageError('PRECONDITION', 'File ini bukan video/audio yang bisa dianalisis');
    const hasAudio = !!probe.audio_codec;
    const hasVideo = !!probe.video_codec;
    const log = await runDetect(file, params, hasAudio, hasVideo, input.signal);
    return { probe, hasAudio, hasVideo, ...parseDetectLog(log, probe.duration_ms) };
  });
  const out: MediaAnalysis = {
    schema_version: 1,
    version_id: v.version_id,
    params,
    duration_ms: result.probe.duration_ms,
    has_audio: result.hasAudio,
    has_video: result.hasVideo,
    silences: result.silences,
    scenes: result.scenes,
    analyzed_at: input.now ?? Date.now(),
  };
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await writeJsonAtomic(cache, out);
  return { ...out, cached: false };
}

export interface CutRequest {
  clip_id: string;
  /** Source-time silences to remove (normally a subset of the analysis, chosen by the user). */
  silences: { from_ms: number; to_ms: number }[];
  /** Source-time scene changes to split at. */
  scenes: number[];
  /** Silence kept on each side of a cut so speech is not clipped. */
  padding_ms: number;
}

export const MAX_CUTS = 400;

function findClip(t: Timeline, id: string): { kind: TrackKind; clip: Clip } | null {
  for (const tr of t.tracks) for (const c of tr.clips) if (c.clip_id === id) return { kind: tr.kind, clip: c };
  return null;
}

/**
 * Turn chosen silences/scenes of ONE media clip into edit ops (pure). Source times are mapped onto
 * the timeline through the clip's position and trim. Cuts are emitted latest-first so earlier
 * timeline times stay valid; scene splits are mapped through the removed ranges.
 */
export function cutOps(t: Timeline, req: unknown): { ops: EditOp[]; removed_ms: number; warnings: string[] } {
  const r = (req ?? {}) as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !['clip_id', 'silences', 'scenes', 'padding_ms'].includes(k));
  if (extra.length) bad(`Field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(r.clip_id)) bad('clip_id tidak valid');
  const found = findClip(t, r.clip_id as string);
  if (!found?.clip.media) return bad('Pilih klip video/audio di linimasa');
  const pad = r.padding_ms === undefined ? 150 : r.padding_ms;
  if (typeof pad !== 'number' || !Number.isFinite(pad) || pad < 0 || pad > 1000) bad('padding_ms harus 0–1000');
  const sil = Array.isArray(r.silences) ? r.silences : bad('silences harus daftar');
  const scn = Array.isArray(r.scenes) ? r.scenes : bad('scenes harus daftar');
  if (sil.length + scn.length > MAX_CUTS) bad(`Maksimal ${MAX_CUTS} potongan sekali jalan`);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 24 * 3_600_000 ? Math.round(x) : bad('waktu tidak valid'));

  const { clip, kind } = found;
  const inMs = clip.in_ms ?? 0;
  const srcEnd = inMs + (clip.end_ms - clip.start_ms);
  const toTimeline = (src: number) => clip.start_ms + (src - inMs);
  const warnings: string[] = [];

  // Silences → timeline ranges inside this clip, padded, merged, long enough.
  const ranges = (sil as unknown[])
    .map((s) => {
      const o = s as Record<string, unknown>;
      return { from: Math.max(num(o.from_ms) + (pad as number), inMs), to: Math.min(num(o.to_ms) - (pad as number), srcEnd) };
    })
    .filter((x) => x.to - x.from >= MIN_CLIP_MS * 2)
    .map((x) => ({ from: toTimeline(x.from), to: toTimeline(x.to) }))
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const x of ranges) {
    const last = merged[merged.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else merged.push({ ...x });
  }
  if ((sil as unknown[]).length && !merged.length) warnings.push('Semua jeda terlalu pendek setelah diberi jarak aman; tidak ada yang dipotong.');

  const ops: EditOp[] = [];
  for (const x of [...merged].reverse()) ops.push({ op: 'remove_range', from_ms: x.from, to_ms: x.to });

  // Scenes → timeline times, shifted by the removed ranges before them; skip ones inside a cut
  // or too close to a clip edge.
  const shift = (tl: number) => merged.filter((x) => x.to <= tl).reduce((n, x) => n + (x.to - x.from), 0);
  const splits = (scn as unknown[])
    .map(num)
    .filter((src) => src > inMs && src < srcEnd)
    .map(toTimeline)
    .filter((tl) => !merged.some((x) => tl >= x.from && tl < x.to))
    .map((tl) => tl - shift(tl));
  const removed = merged.reduce((n, x) => n + (x.to - x.from), 0);
  const newStart = clip.start_ms;
  const newEnd = clip.end_ms - removed;
  // Seams left by the cuts (where two pieces of the clip now meet): a split there would be a no-op.
  const seams = merged.map((x) => x.from - shift(x.from));
  const kept = [...new Set(splits)]
    .filter((tl) => tl - newStart >= MIN_CLIP_MS && newEnd - tl >= MIN_CLIP_MS && seams.every((sm) => Math.abs(tl - sm) >= MIN_CLIP_MS))
    .sort((a, b) => b - a);
  // Two splits closer than a minimum clip would make a sliver: keep the first of each pair.
  const spaced: number[] = [];
  for (const tl of kept) if (!spaced.length || spaced[spaced.length - 1]! - tl >= MIN_CLIP_MS) spaced.push(tl);
  for (const tl of spaced) ops.push({ op: 'split_at', track_kind: kind, at_ms: tl });
  const asked = (scn as unknown[]).length;
  if (asked > spaced.length) warnings.push(`${asked - spaced.length} potongan adegan dilewati (di dalam jeda yang dihapus, di luar klip, atau terlalu dekat dengan potongan lain).`);
  if (!ops.length) bad('Tidak ada potongan yang dipilih.');
  return { ops, removed_ms: removed, warnings };
}
