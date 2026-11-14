import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubPaths } from './engine.js';
import { StorageError } from './errors.js';
import { ffmpegBin } from './ffmpeg.js';
import { isSafeId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { MEDIA_AREAS } from './permissions.js';
import { probeFile } from './probe.js';
import { loadRegistry } from './registry.js';
import { LAYOUT, type Workspace } from './workspace.js';

/**
 * Timeline visuals (paket 1): an audio waveform and a strip of video thumbnails per media
 * version, so editors can see speech pauses and scenes on the timeline. Pure FFmpeg, read-only,
 * computed once and cached per version (versions are immutable).
 */

/** One peak per bucket; 20 ms buckets keep a 1-hour file under ~250 KB of base64. */
export const PEAK_BUCKET_MS = 20;
/** Thumbnails: at most this many frames, at least this far apart. */
export const MAX_THUMBS = 120;
export const MIN_THUMB_INTERVAL_MS = 1000;
export const THUMB_HEIGHT = 72;
/** Up to this length every frame is decoded (exact thumbnails); longer files use keyframes only. */
export const KEYFRAME_ONLY_FROM_MS = 120_000;

export interface MediaVisuals {
  schema_version: 1;
  version_id: string;
  duration_ms: number;
  /** Waveform: base64 of one byte (0–255, linear peak) per PEAK_BUCKET_MS; null = no audio. */
  peaks: { bucket_ms: number; data: string } | null;
  /** Thumbnail strip: one JPEG with `count` frames side by side; frame i shows source time i*interval_ms. */
  thumbs: { interval_ms: number; count: number; frame_w: number; frame_h: number; jpeg: string } | null;
  made_at: number;
  /** Part that could not be made this time (the other part is still shown; not cached, retried later). */
  gagal?: { peaks?: string; thumbs?: string };
}

const cacheFile = (ws: Workspace, versionId: string) => path.join(ws.root, LAYOUT.meta, 'visuals', `${versionId}.json`);

function validateCached(x: unknown): MediaVisuals {
  const o = x as MediaVisuals;
  if (!o || o.schema_version !== 1 || typeof o.version_id !== 'string') throw new StorageError('WORKSPACE_INVALID', 'cache visual rusak');
  return o;
}

function run(args: string[], signal?: AbortSignal, onStdout?: (b: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', (b: Buffer) => onStdout?.(b));
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 4000) err += b.toString();
    });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => reject(new StorageError('PRECONDITION', `FFmpeg tidak bisa dijalankan: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new StorageError('PRECONDITION', 'Dibatalkan'));
      else if (code === 0) resolve();
      // FFmpeg's stderr names the input file and our temp JPEG: no local paths to the browser.
      else reject(new StorageError('PRECONDITION', `FFmpeg gagal (${code}): ${scrubPaths(err.trim().slice(-300))}`));
    });
  });
}

/** Decode mono 8 kHz PCM and keep the peak of each bucket, scaled to 0–255 (pure streaming). */
async function makePeaks(file: string, signal?: AbortSignal): Promise<string> {
  const rate = 8000;
  const perBucket = (rate * PEAK_BUCKET_MS) / 1000;
  const out: number[] = [];
  let peak = 0;
  let n = 0;
  let carry: Buffer | null = null;
  await run(['-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], signal, (chunk) => {
    const b = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = b.length - (b.length % 2);
    for (let i = 0; i < even; i += 2) {
      const v = Math.abs(b.readInt16LE(i));
      if (v > peak) peak = v;
      if (++n === perBucket) {
        out.push(peak);
        peak = 0;
        n = 0;
      }
    }
    carry = even < b.length ? b.subarray(even) : null;
  });
  if (n > 0) out.push(peak);
  // Normalise to the loudest bucket so quiet recordings still show a readable shape.
  const max = Math.max(1, ...out);
  return Buffer.from(out.map((v) => Math.round((v / max) * 255))).toString('base64');
}

/**
 * One JPEG strip of evenly spaced frames.
 *
 * Bug fix (W05 / W15, FFmpeg 9): with `-skip_frame nokey` a short clip with ONE keyframe (long
 * GOP, common for phone / editor exports) gives fewer frames than tiles, so `tile` only emits its
 * strip when flushed at the end — and that frame reaches the MJPEG encoder as limited ("tv") range,
 * which FFmpeg 9's MJPEG refuses ("Non full-range YUV is non-standard" → -22, nothing written →
 * 422). Now: convert to full range (`out_range=full` + `yuvj420p`) before `tile`, and decode every
 * frame for files up to KEYFRAME_ONLY_FROM_MS so short clips get real thumbnails, not one frame.
 */
async function makeThumbs(file: string, durationMs: number, srcW: number, srcH: number, signal?: AbortSignal): Promise<NonNullable<MediaVisuals['thumbs']>> {
  const interval = Math.max(MIN_THUMB_INTERVAL_MS, Math.ceil(durationMs / MAX_THUMBS / 100) * 100);
  const count = Math.max(1, Math.ceil(durationMs / interval));
  const frameH = THUMB_HEIGHT;
  const frameW = Math.max(2, Math.round((frameH * (srcW || 9)) / (srcH || 16) / 2) * 2);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-thumbs-'));
  const jpg = path.join(dir, 'strip.jpg');
  try {
    await run(
      [
        ...(durationMs > KEYFRAME_ONLY_FROM_MS ? ['-skip_frame', 'nokey'] : []),
        '-i', file, '-map', '0:v:0', '-an',
        '-vf', `fps=1000/${interval},scale=${frameW}:${frameH}:force_original_aspect_ratio=increase:out_range=full,crop=${frameW}:${frameH},format=yuvj420p,tile=${count}x1`,
        '-frames:v', '1', '-q:v', '6', '-y', jpg,
      ],
      signal,
    );
    const data = await fsp.readFile(jpg);
    return { interval_ms: interval, count, frame_w: frameW, frame_h: frameH, jpeg: data.toString('base64') };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Waveform + thumbnails of one media version (read-only). Cached per version. */
export async function mediaVisuals(ws: Workspace, input: { version_id: string; signal?: AbortSignal; now?: number }): Promise<MediaVisuals & { cached: boolean }> {
  if (!isSafeId(input.version_id)) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  const reg = await loadRegistry(ws);
  const v = reg.versions[input.version_id];
  if (!v) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', `Media sedang ${v.lifecycle}; pulihkan dulu`);
  if (v.integrity !== 'ok') throw new StorageError('INTEGRITY', `Media ${v.integrity}; perlu verifikasi`);
  const cache = cacheFile(ws, v.version_id);
  const hit = await readJson(cache, validateCached).catch(() => null);
  if (hit) return { ...hit, cached: true };

  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  const out = await ws.blobs.withLocalFile(rel, async (file): Promise<MediaVisuals> => {
    const probe = v.probe ?? (await probeFile(file));
    if (!probe) throw new StorageError('PRECONDITION', 'File ini bukan video/audio');
    // Waveform and thumbnails fail independently: one broken part never hides the other.
    const gagal: NonNullable<MediaVisuals['gagal']> = {};
    const why = (e: unknown) => {
      if (input.signal?.aborted) throw e;
      return (e instanceof Error ? e.message : String(e)).slice(0, 300);
    };
    let peaks: MediaVisuals['peaks'] = null;
    if (probe.audio_codec)
      try {
        peaks = { bucket_ms: PEAK_BUCKET_MS, data: await makePeaks(file, input.signal) };
      } catch (e) {
        gagal.peaks = why(e);
      }
    let thumbs: MediaVisuals['thumbs'] = null;
    if (probe.video_codec)
      try {
        thumbs = await makeThumbs(file, probe.duration_ms, probe.width ?? 0, probe.height ?? 0, input.signal);
      } catch (e) {
        gagal.thumbs = why(e);
      }
    // Both wanted parts broken: a real error (the route answers it), not an empty result.
    if ((gagal.peaks || !probe.audio_codec) && (gagal.thumbs || !probe.video_codec) && (gagal.peaks || gagal.thumbs)) throw new StorageError('PRECONDITION', gagal.thumbs ?? gagal.peaks!);
    return { schema_version: 1, version_id: v.version_id, duration_ms: probe.duration_ms, peaks, thumbs, made_at: input.now ?? Date.now(), ...(gagal.peaks || gagal.thumbs ? { gagal } : {}) };
  });
  // A partial result is not cached: the missing part is tried again next time.
  if (!out.gagal) {
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    await writeJsonAtomic(cache, out);
  }
  return { ...out, cached: false };
}
