import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';
import { CSP, resolveStatic } from '../src/static.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-static-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const web = path.join(dir, 'web');
  await fsp.mkdir(path.join(web, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(web, 'index.html'), '<!doctype html><div id="root"></div>');
  await fsp.writeFile(path.join(web, 'assets', 'index-abc.js'), 'console.log(1)');
  await fsp.writeFile(path.join(dir, 'secret.txt'), 'do not serve');
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const app = createApp({ ws, staticDir: web });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  return { app, port };
}

function get(port: number, p: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: HOST, port, path: p, method: opts.method ?? 'GET', headers: { host: opts.host ?? `${HOST}:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('W05 static UI serving', () => {
  it('only "/" and flat /assets/* names map to files', () => {
    expect(resolveStatic('/w', '/')).toBe(path.join('/w', 'index.html'));
    expect(resolveStatic('/w', '/assets/index-abc.js')).toBe(path.join('/w', 'assets', 'index-abc.js'));
    for (const bad of ['/assets/../secret.txt', '/../secret.txt', '/assets/a/b.js', '/src/main.tsx', '/assets/', '/assets/.hidden', '/package.json']) {
      expect(resolveStatic('/w', bad), bad).toBeNull();
    }
  });

  it('serves the UI without a token, with strict CSP and no framing; API still needs the token', async () => {
    const { app, port } = await setup();
    const index = await get(port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toContain('unsafe-inline');
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.headers['cache-control']).toBe('no-store');
    const js = await get(port, '/assets/index-abc.js');
    expect([js.status, js.headers['content-type'], js.headers['cache-control']]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    expect((await get(port, '/assets/index-abc.js', { method: 'HEAD' })).body).toBe('');
    expect((await get(port, '/api/session')).status).toBe(401);
    expect((await get(port, '/api/session', { headers: { authorization: `Bearer ${app.token}` } })).status).toBe(200);
  });

  it('never serves anything else; Host check still applies', async () => {
    const { port } = await setup();
    for (const p of ['/secret.txt', '/../secret.txt', '/assets/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/nope.js']) {
      const r = await get(port, p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('do not serve');
    }
    expect((await get(port, '/', { host: `evil.example:${port}` })).status).toBe(403);
    expect((await get(port, '/', { method: 'POST' })).status).toBe(404);
  });
});
