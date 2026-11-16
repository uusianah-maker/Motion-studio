import { execFile } from 'node:child_process';

/** What the editor needs to know about a media version (W07). Read once, stored in the registry. */
export interface MediaProbe {
  duration_ms: number;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  /** R25b: pixel format of the video (`yuv420p10le` = 10-bit, which browsers cannot decode). Older probes: absent. */
  pix_fmt?: string | null;
  /** R25b: average frame rate of the video. Older probes: absent. */
  fps?: number | null;
}

/** ffprobe "decodes" plain text as a video stream; these are never real footage. */
const PSEUDO_CODECS = new Set(['ansi', 'tty', 'bin_data', 'mjpeg_text']);
/** Codecs a Chromium-based browser can preview directly (others still import; preview warns). */
export const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

export const ffprobeBin = (): string => process.env.MOTION_FFPROBE || 'ffprobe';

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Probe a local file with ffprobe.
 * - `undefined`: ffprobe could not run (not installed / not startable) → try again later (backfill).
 * - `null`: ffprobe ran and found no real audio/video stream → not playable media.
 * Import works in every case; the editor just falls back to defaults.
 */
export async function probeFile(file: string): Promise<MediaProbe | null | undefined> {
  let out: string;
  try {
    out = await run(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,duration,pix_fmt,avg_frame_rate', '-of', 'json', file]);
  } catch (e) {
    // Spawn failures carry a string code (ENOENT, EACCES…); a non-zero exit carries a number.
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    return typeof err.code === 'string' || err.killed ? undefined : null; // timeout = retry later
  }
  let j: { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; pix_fmt?: string; avg_frame_rate?: string }[] };
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.codec_name && !PSEUDO_CODECS.has(s.codec_name));
  const audio = streams.find((s) => s.codec_type === 'audio' && s.codec_name);
  if (!video && !audio) return null;
  // Prefer the stream duration (format duration includes container padding).
  const secs = Number(video?.duration ?? audio?.duration ?? j.format?.duration);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return {
    duration_ms: Math.round(secs * 1000),
    width: video?.width ?? null,
    height: video?.height ?? null,
    video_codec: video?.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    ...(video ? { pix_fmt: video.pix_fmt ?? null, fps: frameRate(video.avg_frame_rate) } : {}),
  };
}

/** "60000/1001" → 59.94 (null when unknown). */
function frameRate(r: string | undefined): number | null {
  const [a, b] = (r ?? '').split('/').map(Number);
  const v = b ? a! / b : a;
  return v && Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 100) / 100 : null;
}

export function validateProbe(x: unknown): MediaProbe | null {
  if (x === null) return null;
  const o = x as Partial<MediaProbe>;
  const okDim = (n: unknown) => n === null || (typeof n === 'number' && Number.isInteger(n) && n > 0);
  const okCodec = (c: unknown) => c === null || (typeof c === 'string' && c.length <= 32);
  if (!o || typeof o.duration_ms !== 'number' || !Number.isFinite(o.duration_ms) || o.duration_ms <= 0 || !okDim(o.width) || !okDim(o.height) || !okCodec(o.video_codec) || !okCodec(o.audio_codec)) {
    throw new Error('probe tidak valid');
  }
  const out: MediaProbe = { duration_ms: o.duration_ms, width: o.width ?? null, height: o.height ?? null, video_codec: o.video_codec ?? null, audio_codec: o.audio_codec ?? null };
  // R25b: optional (older probes have neither); bad values are dropped, never fatal.
  if (o.pix_fmt === null || (typeof o.pix_fmt === 'string' && o.pix_fmt.length <= 32)) out.pix_fmt = o.pix_fmt;
  if (o.fps === null || (typeof o.fps === 'number' && Number.isFinite(o.fps) && o.fps > 0 && o.fps < 1000)) out.fps = o.fps;
  return out;
}

/** X06: a still image (logo). `null` = not a PNG/JPEG/WebP picture ffprobe can read. */
export async function probeImage(file: string): Promise<{ width: number; height: number; codec: string } | null> {
  let out: string;
  try {
    out = await run(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', file]);
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(out) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[] };
    const s = (j.streams ?? []).find((x) => x.codec_type === 'video' && ['png', 'mjpeg', 'webp'].includes(x.codec_name ?? ''));
    return s && s.width && s.height && s.width <= 8192 && s.height <= 8192 ? { width: s.width, height: s.height, codec: s.codec_name! } : null;
  } catch {
    return null;
  }
}
