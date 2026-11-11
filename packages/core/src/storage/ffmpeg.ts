import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { StorageError } from './errors.js';
import { ffprobeBin } from './probe.js';

/**
 * FFmpeg plumbing for render (W08): tool check, running a job with progress/cancel, and the
 * owner's mandatory rule — the output carries NO metadata before it counts as done.
 */
export const ffmpegBin = (): string => process.env.MOTION_FFMPEG || 'ffmpeg';

/** Oldest FFmpeg major we accept: `-/filter_complex <file>` and drawtext `text_align` need 7.x. */
export const MIN_FFMPEG_MAJOR = 7;

export type ToolProblem = 'FFMPEG_MISSING' | 'FFMPEG_TOO_OLD' | 'FFMPEG_NO_LIBX264' | 'FFMPEG_NO_DRAWTEXT' | 'FFPROBE_MISSING';

export interface ToolCheck {
  ok: boolean;
  /** e.g. "9.0.2"; null when unknown (git builds print no release number). */
  version: string | null;
  problems: ToolProblem[];
}

function exec(bin: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const checks = new Map<string, Promise<ToolCheck>>();

/** Cached per binary path: FFmpeg ≥7 with libx264 + drawtext, and a working ffprobe. */
export function checkTools(bin = ffmpegBin(), probe = ffprobeBin()): Promise<ToolCheck> {
  const key = `${bin}\0${probe}`;
  let hit = checks.get(key);
  if (!hit) {
    hit = runCheck(bin, probe);
    checks.set(key, hit);
    // A failed check is retried next time (the owner may install FFmpeg while the server runs).
    void hit.then((r) => (r.ok ? undefined : checks.delete(key)));
  }
  return hit;
}

async function runCheck(bin: string, probe: string): Promise<ToolCheck> {
  const problems: ToolProblem[] = [];
  let version: string | null = null;
  try {
    const out = await exec(bin, ['-hide_banner', '-version']);
    const m = /ffmpeg version n?(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
    if (m) {
      version = m.slice(1).filter(Boolean).join('.');
      if (Number(m[1]) < MIN_FFMPEG_MAJOR) problems.push('FFMPEG_TOO_OLD');
    }
    const [enc, flt] = await Promise.all([exec(bin, ['-hide_banner', '-encoders']), exec(bin, ['-hide_banner', '-filters'])]);
    if (!/\slibx264\s/.test(enc)) problems.push('FFMPEG_NO_LIBX264');
    if (!/\sdrawtext\s/.test(flt)) problems.push('FFMPEG_NO_DRAWTEXT');
  } catch {
    problems.push('FFMPEG_MISSING');
  }
  try {
    await exec(probe, ['-hide_banner', '-version']);
  } catch {
    problems.push('FFPROBE_MISSING');
  }
  return { ok: problems.length === 0, version, problems };
}

/** Sans font for text/subtitle burn-in (bold by default). `MOTION_FONT` / `MOTION_FONT_REGULAR` override. */
export function findFont(weight: 'bold' | 'regular' = 'bold'): string | null {
  const windir = process.env.WINDIR ?? 'C:/Windows';
  if (weight === 'regular') {
    const env = process.env.MOTION_FONT_REGULAR;
    if (env) return existsSync(env) ? env : null;
    const regular = [
      `${windir}/Fonts/arial.ttf`,
      `${windir}/Fonts/segoeui.ttf`,
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
    ];
    return regular.find((f) => existsSync(f)) ?? findFont('bold');
  }
  const env = process.env.MOTION_FONT;
  if (env) return existsSync(env) ? env : null;
  const candidates = [
    `${windir}/Fonts/arialbd.ttf`,
    `${windir}/Fonts/segoeuib.ttf`,
    `${windir}/Fonts/arial.ttf`,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
  ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

/**
 * Run FFmpeg (args must include `-progress pipe:1`). Progress = encoded output time in ms.
 * Abort kills the process. Failures keep the stderr tail for the server-side audit only:
 * it contains local paths, so it never goes to the browser (Checkpoint D F5).
 */
export function runFfmpeg(args: string[], opts: { cwd: string; signal?: AbortSignal; onTime?: (ms: number) => void; bin?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new StorageError('CANCELLED', 'Render dibatalkan'));
    const child = spawn(opts.bin ?? ffmpegBin(), args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)$/.exec(line);
        if (m) opts.onTime?.(Math.floor(Number(m[1]) / 1000));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new StorageError('RENDER_UNAVAILABLE', 'FFmpeg tidak bisa dijalankan', { cause: (e as NodeJS.ErrnoException).code ?? 'spawn' }));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new StorageError('CANCELLED', 'Render dibatalkan'));
      else if (code === 0) resolve();
      else reject(new StorageError('RENDER_FAILED', `FFmpeg gagal (kode ${code})`, { stage: 'encode', exit_code: code, stderr_tail: stderr }));
    });
  });
}

// ------------------------------------------------------------------ metadata verification

/** Container/stream tags that are technical (not identifying) and that MP4 always carries. */
const ALLOWED_FORMAT_TAGS: Record<string, RegExp> = {
  major_brand: /^[a-z0-9 ]{4}$/i,
  minor_version: /^\d+$/,
  compatible_brands: /^[a-z0-9 ]+$/i,
};
const ALLOWED_STREAM_TAGS: Record<string, RegExp> = {
  language: /^und$/,
  // With empty handler names + bitexact the muxer writes these generic constants.
  handler_name: /^(VideoHandler|SoundHandler)$/,
  vendor_id: /^\[0\]\[0\]\[0\]\[0\]$/,
};
/** Tag keys whose values are technical; never used as "source fingerprint" markers. */
const TECHNICAL_KEYS = new Set([...Object.keys(ALLOWED_FORMAT_TAGS), ...Object.keys(ALLOWED_STREAM_TAGS), 'creation_time', 'duration', 'timecode']);

/** Encoder fingerprints FFmpeg/x264 embed unless told not to (long enough to never match by chance). */
const ENCODER_MARKERS: readonly RegExp[] = [/Lavf\d+\.\d+/, /Lavc\d+\.\d+/, /x264 - core \d+/, /libx264/];

interface ProbeJson {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; tags?: Record<string, string>; side_data_list?: unknown[] }[];
  chapters?: unknown[];
}

async function probeJson(file: string): Promise<ProbeJson> {
  const out = await exec(ffprobeBin(), ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], 60_000);
  return JSON.parse(out) as ProbeJson;
}

/**
 * Metadata values in the SOURCE files (title, author, GPS, device, encoder…). The render must
 * not carry any of them. Short values are skipped: they would match compressed bytes by chance.
 */
export async function sourceMetadataMarkers(file: string): Promise<string[]> {
  let j: ProbeJson;
  try {
    j = await probeJson(file);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const add = (tags: Record<string, string> | undefined) => {
    for (const [k, v] of Object.entries(tags ?? {})) if (!TECHNICAL_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.trim().length >= 8) out.add(v.trim());
  };
  add(j.format?.tags);
  for (const s of j.streams ?? []) add(s.tags);
  return [...out];
}

export interface CleanCheck {
  ok: boolean;
  problems: string[];
  /** Technical tags that remain (documented as allowed). */
  kept_tags: string[];
  hash: string;
  size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
}

/**
 * The owner's rule (2026-11-08): an output is only "done" when ffprobe shows no metadata tags
 * beyond the technical allowlist, no chapters, no encoder fingerprints, and none of the source
 * files' metadata values anywhere in the bytes. Also checks the expected streams/size/duration.
 * The byte scan doubles as the hash of the verified bytes (compared again after upload).
 */
export async function verifyCleanOutput(
  file: string,
  expect: { width: number; height: number; duration_ms: number; source_markers: readonly string[] },
): Promise<CleanCheck> {
  const problems: string[] = [];
  const kept = new Set<string>();
  let j: ProbeJson;
  try {
    j = await probeJson(file);
  } catch {
    j = {};
    problems.push('ffprobe tidak bisa membaca hasil render');
  }
  const checkTags = (where: string, tags: Record<string, string> | undefined, allowed: Record<string, RegExp>) => {
    for (const [k, v] of Object.entries(tags ?? {})) {
      const rule = allowed[k];
      if (rule && rule.test(v)) kept.add(`${where}.${k}=${v}`);
      else problems.push(`tag tersisa: ${where}.${k}`);
    }
  };
  checkTags('format', j.format?.tags, ALLOWED_FORMAT_TAGS);
  const streams = j.streams ?? [];
  streams.forEach((s, i) => checkTags(`stream${i}`, s.tags, ALLOWED_STREAM_TAGS));
  if ((j.chapters ?? []).length) problems.push('chapter tersisa');
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (streams.length !== 2 || video.length !== 1 || audio.length !== 1) problems.push(`stream tidak sesuai (video ${video.length}, audio ${audio.length}, total ${streams.length})`);
  if (video[0] && (video[0].codec_name !== 'h264' || video[0].width !== expect.width || video[0].height !== expect.height)) problems.push('video bukan H.264 dengan ukuran canvas');
  if (audio[0] && audio[0].codec_name !== 'aac') problems.push('audio bukan AAC');
  const dur = Number(j.format?.duration);
  const duration_ms = Number.isFinite(dur) ? Math.round(dur * 1000) : null;
  if (duration_ms === null || Math.abs(duration_ms - expect.duration_ms) > 250) problems.push(`durasi ${duration_ms ?? '?'} ms, harusnya ${expect.duration_ms} ms`);

  // Byte scan (latin1 = one char per byte) with overlap so markers split across chunks are found.
  const markers = [...ENCODER_MARKERS, ...expect.source_markers.map((m) => new RegExp(escapeRe(Buffer.from(m, 'utf8').toString('latin1'))))];
  const found = new Set<number>();
  const h = createHash('sha256');
  let size = 0;
  let tail = '';
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const b = chunk as Buffer;
    h.update(b);
    size += b.length;
    const text = tail + b.toString('latin1');
    markers.forEach((re, i) => {
      if (!found.has(i) && re.test(text)) found.add(i);
    });
    tail = text.slice(-1024);
  }
  for (const i of found) problems.push(i < ENCODER_MARKERS.length ? `jejak encoder di byte file (${ENCODER_MARKERS[i]!.source})` : 'metadata file sumber ikut terbawa');
  return { ok: problems.length === 0, problems, kept_tags: [...kept].sort(), hash: `sha256:${h.digest('hex')}`, size, duration_ms, width: video[0]?.width ?? null, height: video[0]?.height ?? null };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
