import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppOptions, HOST, createApp } from '../src/app.js';
import { StorageError, initWorkspace } from '../src/core.js';
import { ApiError, toApiError } from '../src/errors.js';
import { readJsonBody } from '../src/http.js';
import { start } from '../src/main.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-srv-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return initWorkspace(path.join(dir, 'ws'));
}

async function running(extra: Partial<AppOptions> = {}) {
  const ws = await workspace();
  const app = createApp({ ws, ...extra });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  return { app, port, ws };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { error?: { code: string; message: string } } & Record<string, unknown>;
}

function call(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `${HOST}:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('W03 server API dasar', () => {
  it('listens on loopback only; health is public and reveals nothing', async () => {
    const { app, port } = await running();
    expect((app.server.address() as { address: string }).address).toBe('127.0.0.1');
    const r = await call(port, { path: '/api/health' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('session needs the per-start token; actor is always user', async () => {
    const { app, port, ws } = await running();
    expect(app.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await call(port, { path: '/api/session' })).body.error?.code).toBe('UNAUTHORIZED');
    expect((await call(port, { path: '/api/session', headers: auth('0'.repeat(64)) })).status).toBe(401);
    expect((await call(port, { path: '/api/session', headers: { authorization: `Basic ${app.token}` } })).status).toBe(401);
    const ok = await call(port, { path: '/api/session', headers: auth(app.token) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ actor: 'user', workspace_id: ws.meta.workspace_id, storage_backend: 'local-fs' });
    const other = await running();
    expect(other.app.token).not.toBe(app.token); // fresh token per start
  });

  it('rejects foreign Host (DNS rebinding) and foreign Origin even with a valid token', async () => {
    const { app, port } = await running({ allowedOrigins: ['http://127.0.0.1:5173'] });
    const host = await call(port, { path: '/api/session', headers: { ...auth(app.token), host: `evil.example:${port}` } });
    expect([host.status, host.body.error?.code]).toEqual([403, 'HOST_REJECTED']);
    const origin = await call(port, { path: '/api/session', headers: { ...auth(app.token), origin: 'https://evil.example' } });
    expect([origin.status, origin.body.error?.code]).toEqual([403, 'ORIGIN_REJECTED']);
    expect((await call(port, { path: '/api/session', headers: { ...auth(app.token), origin: `http://localhost:${port}` } })).status).toBe(200);
    expect((await call(port, { path: '/api/session', headers: { ...auth(app.token), origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
  });

  it('typed errors: unknown route 404, wrong method 405, storage errors mapped without details, unknown → INTERNAL', async () => {
    const seen: unknown[] = [];
    const { app, port } = await running({
      onError: (e) => seen.push(e),
      routes: [
        { method: 'GET', path: '/api/t/conflict', handle: async () => { throw new StorageError('CONFLICT', 'Sudah ada', { abs: 'C:\\secret\\path' }); } },
        { method: 'GET', path: '/api/t/boom', handle: async () => { throw new Error('C:\\secret\\stack'); } },
      ],
    });
    const h = auth(app.token);
    expect((await call(port, { path: '/api/nope', headers: h })).body.error?.code).toBe('NOT_FOUND');
    expect((await call(port, { method: 'POST', path: '/api/health' })).status).toBe(405);
    const c = await call(port, { path: '/api/t/conflict', headers: h });
    expect(c.status).toBe(409);
    expect(c.body).toEqual({ error: { code: 'CONFLICT', message: 'Sudah ada' } });
    const b = await call(port, { path: '/api/t/boom', headers: h });
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toContain('secret');
    expect(seen).toHaveLength(1); // logged server-side only
  });

  it('error mapping table', () => {
    expect(toApiError(new StorageError('NOT_FOUND', 'x')).status).toBe(404);
    expect(toApiError(new StorageError('FORBIDDEN', 'x')).status).toBe(403);
    expect(toApiError(new StorageError('PRECONDITION', 'x')).status).toBe(422);
    expect(toApiError(new StorageError('PATH_OUTSIDE_WORKSPACE', 'x')).status).toBe(400);
    expect(toApiError(new StorageError('INDEX_INVALID', 'x')).status).toBe(500);
    expect(toApiError(new StorageError('WORKSPACE_LOCKED', 'x')).status).toBe(503);
    const api = new ApiError(418, 'BAD_REQUEST', 'x');
    expect(toApiError(api)).toBe(api);
  });
});

describe('W03 JSON body rules', () => {
  const req = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    Object.assign(Readable.from([Buffer.from(body)]), { headers }) as unknown as http.IncomingMessage;
  const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: ApiError) => e.code);

  it('accepts a JSON object', async () => {
    expect(await readJsonBody(req('{"name":"x"}'))).toEqual({ name: 'x' });
  });
  it('the client can never choose the actor', async () => {
    expect(await codeOf(readJsonBody(req('{"actor":"user"}')))).toBe('ACTOR_NOT_ALLOWED');
    expect(await codeOf(readJsonBody(req('{"actor":"ai","x":1}')))).toBe('ACTOR_NOT_ALLOWED');
  });
  it('content type, size, syntax and shape are enforced', async () => {
    expect(await codeOf(readJsonBody(req('{}', { 'content-type': 'text/plain' })))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await codeOf(readJsonBody(req('{"a":"' + 'x'.repeat(100) + '"}'), 50))).toBe('PAYLOAD_TOO_LARGE');
    expect(await codeOf(readJsonBody(req('{}', { 'content-type': 'application/json', 'content-length': '999999999' })))).toBe('PAYLOAD_TOO_LARGE');
    expect(await codeOf(readJsonBody(req('{bad')))).toBe('BAD_REQUEST');
    expect(await codeOf(readJsonBody(req('[1,2]')))).toBe('BAD_REQUEST');
    expect(await codeOf(readJsonBody(req('null')))).toBe('BAD_REQUEST');
  });
});

describe('W03 startup', () => {
  it('opens the workspace, runs recovery, prints the session URL with the token in the fragment', async () => {
    const ws = await workspace();
    const lines: string[] = [];
    const s = await start({ MOTION_WORKSPACE: ws.root, MOTION_PORT: '0' }, (l) => lines.push(l));
    cleanup.push(() => s.app.close());
    expect(s.recovery.corrupt_journal).toEqual([]);
    expect(lines.join('\n')).toContain(`http://127.0.0.1:${s.port}/#token=${s.app.token}`);
    expect((await call(s.port, { path: '/api/session', headers: auth(s.app.token) })).status).toBe(200);
  });
  it('refuses to start without a workspace or with a bad port', async () => {
    await expect(start({}, () => undefined)).rejects.toThrow(/MOTION_WORKSPACE/);
    const ws = await workspace();
    await expect(start({ MOTION_WORKSPACE: ws.root, MOTION_PORT: 'abc' }, () => undefined)).rejects.toThrow(/MOTION_PORT/);
  });
});
