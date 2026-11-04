import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './errors.js';

export const MAX_JSON_BYTES = 1024 * 1024;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendError(res: ServerResponse, e: ApiError): void {
  sendJson(res, e.status, { error: { code: e.code, message: e.message } });
}

/**
 * Read a JSON object body: `application/json` only, at most `limit` bytes, must be an object.
 * The actor is decided by the server, never by the client: any `actor` field is refused.
 */
export async function readJsonBody(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Body harus application/json');
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Body terlalu besar');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Body terlalu besar');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'JSON tidak valid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'BAD_REQUEST', 'Body harus objek JSON');
  if (Object.hasOwn(parsed, 'actor')) throw new ApiError(400, 'ACTOR_NOT_ALLOWED', 'Aktor ditentukan server, tidak boleh dikirim klien');
  return parsed as Record<string, unknown>;
}
