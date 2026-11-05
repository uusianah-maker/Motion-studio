import { promises as fsp } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Serve the built web UI (apps/web/dist). Only two shapes of path exist: `/` (index.html)
 * and `/assets/<flat-name>` (hashed Vite output). Nothing else on disk is reachable, so
 * traversal is impossible by construction. The UI contains no secrets; the API still needs
 * the session token.
 */
const ASSET_RE = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Strict CSP: only our own scripts/styles; no inline script, no framing, no foreign connections. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function resolveStatic(dir: string, pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return path.join(dir, 'index.html');
  if (ASSET_RE.test(pathname) && !pathname.includes('..')) return path.join(dir, 'assets', pathname.slice('/assets/'.length));
  return null;
}

/** Returns false when the path is not a UI file (caller answers 404). */
export async function serveStatic(dir: string, pathname: string, res: ServerResponse, head: boolean): Promise<boolean> {
  const file = resolveStatic(dir, pathname);
  if (!file) return false;
  let data: Buffer;
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile()) return false;
    data = await fsp.readFile(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const isIndex = ext === '.html';
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
  });
  res.end(head ? undefined : data);
  return true;
}
