// Regression tests for Checkpoint D findings on the HTTP layer.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';
import { UPLOAD_PREFIX, apiRoutes, sweepUploadTemp } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp(prefix: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function server() {
  const ws = await initWorkspace(path.join(await tmp('msc-cpd-'), 'ws'));
  const uploadTmp = await tmp('msc-cpd-up-');
  const app = createApp({ ws, routes: apiRoutes({ tmpDir: uploadTmp }) });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const headers = (extra: Record<string, string> = {}) => ({ host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...extra });
  const send = (method: string, p: string, body?: Buffer | string, extra: Record<string, string> = {}) =>
    new Promise<{ status: number; body: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const r = http.request({ host: HOST, port, method, path: p, headers: headers({ ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...extra }) }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      r.on('error', reject);
      r.end(body);
    });
  return { app, port, uploadTmp, headers, send };
}

describe('Checkpoint D (server)', () => {
  it('F1: restore over HTTP accepts no free destination', async () => {
    const s = await server();
    const r = await s.send('POST', '/api/trash/v_0123456789abcdef/restore', JSON.stringify({ destination: 'SHARED_MEDIA/.importing-x.mp4' }), { 'content-type': 'application/json' });
    expect([r.status, r.body.error.code]).toEqual([400, 'BAD_REQUEST']);
  });

  it('F3: no 5-minute total request limit; idle sockets are closed after 2 minutes', async () => {
    const s = await server();
    expect(s.app.server.requestTimeout).toBe(0);
    expect(s.app.server.timeout).toBe(120_000);
  });

  it('F4: unknown project is refused before any byte is stored', async () => {
    const s = await server();
    const r = await s.send('POST', '/api/media/import?scope=project&project_id=nope', Buffer.from('x'.repeat(1000)), { 'content-type': 'application/octet-stream' });
    expect(r.status).toBe(404);
    expect(await fsp.readdir(s.uploadTmp)).toEqual([]);
  });

  it('F4: a second upload while one is running is refused (BUSY); the first completes', async () => {
    const s = await server();
    const total = 200_000;
    // Upload A: send half the body and keep the request open.
    const a = http.request({ host: HOST, port: s.port, method: 'POST', path: '/api/media/import?scope=shared', headers: s.headers({ 'content-type': 'application/octet-stream', 'content-length': String(total), 'x-file-name': 'a.mp4' }) });
    const aDone = new Promise<{ status: number; body: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      a.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      a.on('error', reject);
    });
    a.write(Buffer.alloc(total / 2, 1));
    // Wait until the server has started receiving A (its temp folder exists).
    for (let i = 0; i < 100 && (await fsp.readdir(s.uploadTmp)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const b = await s.send('POST', '/api/media/import?scope=shared', Buffer.from('other bytes'), { 'content-type': 'application/octet-stream', 'x-file-name': 'b.mp4' });
    expect([b.status, b.body.error.code]).toEqual([409, 'BUSY']);
    a.end(Buffer.alloc(total / 2, 2));
    const ra = await aDone;
    expect(ra.status).toBe(200);
    expect(ra.body.version.size).toBe(total);
    // And after A finished, uploads work again.
    expect((await s.send('POST', '/api/media/import?scope=shared', Buffer.from('third'), { 'content-type': 'application/octet-stream' })).status).toBe(200);
  });

  it('F4: stale upload temp folders are swept at startup; fresh and foreign ones are kept', async () => {
    const dir = await tmp('msc-sweep-');
    const now = Date.now();
    const old = new Date(now - 7 * 3_600_000);
    const stale = path.join(dir, `${UPLOAD_PREFIX}stale`);
    const fresh = path.join(dir, `${UPLOAD_PREFIX}fresh`);
    const foreign = path.join(dir, 'other-app-stale');
    for (const d of [stale, fresh, foreign]) {
      await fsp.mkdir(d);
      await fsp.writeFile(path.join(d, 'f.bin'), 'x');
    }
    for (const p of [path.join(stale, 'f.bin'), stale, path.join(foreign, 'f.bin'), foreign]) await fsp.utimes(p, old, old);
    expect(await sweepUploadTemp(dir, 6 * 3_600_000, now)).toEqual([`${UPLOAD_PREFIX}stale`]);
    expect((await fsp.readdir(dir)).sort()).toEqual([`${UPLOAD_PREFIX}fresh`, 'other-app-stale']);
  });

  it('F5: the dashboard does not ship the audit trail to the browser', async () => {
    const s = await server();
    const d = await s.send('GET', '/api/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.dashboard).not.toHaveProperty('recent_audit');
    expect(d.body.dashboard).toHaveProperty('gc');
  });
});
