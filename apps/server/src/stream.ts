import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './errors.js';

/**
 * Signed playback URLs (W07). A `<video src>` cannot send the Bearer token, so the API hands out
 * short-lived URLs bound to ONE media version: HMAC-SHA256(server-only key, version_id + expiry).
 * The key is random per server start; nothing is stored. Expired/forged/other-version links fail.
 */
export const STREAM_TTL_MS = 10 * 60_000;

export function createStreamSigner(now: () => number = Date.now) {
  const key = randomBytes(32);
  const mac = (versionId: string, exp: number) => createHmac('sha256', key).update(`${versionId}.${exp}`).digest('hex');
  return {
    sign(versionId: string, ttlMs = STREAM_TTL_MS): { url: string; expires_at: number } {
      const exp = now() + ttlMs;
      return { url: `/api/stream/${encodeURIComponent(versionId)}?exp=${exp}&sig=${mac(versionId, exp)}`, expires_at: exp };
    },
    verify(versionId: string, expRaw: string | null, sig: string | null): void {
      const exp = Number(expRaw);
      if (!expRaw || !Number.isSafeInteger(exp) || !sig || !/^[0-9a-f]{64}$/.test(sig)) throw new ApiError(401, 'UNAUTHORIZED', 'Link pemutaran tidak valid');
      if (exp < now()) throw new ApiError(401, 'UNAUTHORIZED', 'Link pemutaran kedaluwarsa');
      const want = Buffer.from(mac(versionId, exp), 'hex');
      if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) throw new ApiError(401, 'UNAUTHORIZED', 'Link pemutaran tidak valid');
    },
  };
}
export type StreamSigner = ReturnType<typeof createStreamSigner>;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};
export const mimeFor = (rel: string): string => MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';

/** Parse a single `bytes=` range. null = no/ignored Range header (serve whole file). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or malformed: whole file
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) throw new ApiError(416, 'BAD_REQUEST', 'Range tidak bisa dipenuhi');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw new ApiError(416, 'BAD_REQUEST', 'Range tidak bisa dipenuhi');
  return { start, end };
}

/** Send bytes with Range support. Client aborts (seeking) are normal and ignored. */
export async function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  file: { size: number; mime: string; open: (range?: { start: number; end: number }) => Promise<NodeJS.ReadableStream> },
): Promise<void> {
  const range = parseRange(req.headers.range, file.size);
  const headers: Record<string, string | number> = {
    'Content-Type': file.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`, 'Content-Length': range.end - range.start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': file.size });
  }
  const stream = await file.open(range ?? undefined);
  await pipeline(stream, res).catch(() => undefined);
}
