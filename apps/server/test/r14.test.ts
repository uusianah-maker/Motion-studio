// R14 over HTTP: an import makes a light preview copy in the background; the editor's stream link
// then points at it (signed separately); the original stays available with ?asli=1.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace, proxyPath } from '../src/core.js';
import { createProxyQueue } from '../src/proxy.js';
import { apiRoutes } from '../src/routes.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('R14 preview proxy over HTTP', () => {
  it.skipIf(!hasFfmpeg)('import → proxy in the background → stream link uses it; original with ?asli=1; links are not interchangeable', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r14-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const proxies = createProxyQueue();
    const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }, undefined, undefined, proxies) });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const req = (p: string, init: { method?: string; body?: Buffer; headers?: Record<string, string>; auth?: boolean } = {}) =>
      new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const r = http.request(
          { host: HOST, port, path: p, method: init.method ?? 'GET', headers: { host: `${HOST}:${port}`, ...(init.auth === false ? {} : { authorization: `Bearer ${app.token}` }), ...(init.body ? { 'content-length': String(init.body.length) } : {}), ...init.headers } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
          },
        );
        r.on('error', reject);
        r.end(init.body);
      });
    const json = (b: Buffer) => JSON.parse(b.toString('utf8'));
    const src = path.join(dir, 'besar.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], { windowsHide: true });
    const body = await fsp.readFile(src);
    const up = await req('/api/media/import?scope=shared', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'besar.mp4' } });
    expect(up.status).toBe(200); // answered without waiting for the proxy
    const vid = json(up.body).version.version_id as string;
    await proxies.idle();
    const list = json((await req('/api/media')).body).media;
    expect(list[0]).toMatchObject({ proxy: 'siap' });
    const link = json((await req(`/api/media/${vid}/stream-url`)).body);
    expect(link).toMatchObject({ proxy: true, mime: 'video/mp4' });
    expect(link.url).toContain('proxy=1');
    const proxied = await req(link.url, { auth: false });
    expect(proxied.status).toBe(200);
    expect(proxied.body.length).toBe((await fsp.stat(proxyPath(ws, vid))).size);
    expect(proxied.body.length).toBeLessThan(body.length);
    const ranged = await req(link.url, { auth: false, headers: { range: 'bytes=0-99' } });
    expect([ranged.status, ranged.body.length]).toEqual([206, 100]);
    const orig = json((await req(`/api/media/${vid}/stream-url?asli=1`)).body);
    expect(orig.proxy).toBe(false);
    expect((await req(orig.url, { auth: false })).body.length).toBe(body.length);
    // A link signed for the original does not open the proxy (and the other way round).
    const swapped = orig.url.replace('?exp=', '?proxy=1&exp=');
    expect((await req(swapped, { auth: false })).status).toBe(401);
    // The manual button on media that has one already.
    expect(json((await req(`/api/media/${vid}/proxy`, { method: 'POST', body: Buffer.from('{}'), headers: { 'content-type': 'application/json' } })).body)).toEqual({ proxy: 'siap' });
  }, 90_000);

  it.skipIf(!hasFfmpeg)('HEVC (DJI/iPhone): not previewable until its light copy exists, then preview=true', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r14h-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const proxies = createProxyQueue();
    const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }, undefined, undefined, proxies) });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const req = (p: string, init: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}) =>
      new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const r = http.request({ host: HOST, port, path: p, method: init.method ?? 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(init.body ? { 'content-length': String(init.body.length) } : {}), ...init.headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        r.on('error', reject);
        r.end(init.body);
      });
    const json = (b: Buffer) => JSON.parse(b.toString('utf8'));
    const src = path.join(dir, 'dji.mp4');
    try {
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=540x960:r=30:d=1', '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
    } catch {
      return; // ffmpeg without libx265: nothing to check here
    }
    const up = await req('/api/media/import?scope=shared', { method: 'POST', body: await fsp.readFile(src), headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'dji.mp4' } });
    expect(up.status).toBe(200);
    expect(json(up.body).version.preview).toBe(false); // the original cannot play in a browser
    await proxies.idle();
    const m = json((await req('/api/media')).body).media[0];
    expect(m.proxy).toBe('siap');
    expect(m.versions[0].preview).toBe(true); // the editor shows the video (from the light copy)
  }, 90_000);
});
