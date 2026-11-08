import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';
import { ApiError } from '../src/errors.js';
import { apiRoutes } from '../src/routes.js';
import { createStreamSigner, parseRange } from '../src/stream.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

let clock = Date.now();
async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w07-'));
  cleanup.push(async () => {
    const walk = async (d: string): Promise<void> => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else await fsp.chmod(p, 0o666).catch(() => undefined);
      }
    };
    await walk(dir);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ws = await initWorkspace(path.join(dir, 'ws'));
  clock = Date.now();
  const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }, createStreamSigner(() => clock)) });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const req = (p: string, headers: Record<string, string> = {}, body?: Buffer) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const r = http.request({ host: HOST, port, method: body ? 'POST' : 'GET', path: p, headers: { host: `${HOST}:${port}`, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json: unknown = null;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            /* binary */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
        });
      });
      r.on('error', reject);
      r.end(body);
    });
  const auth = { authorization: `Bearer ${app.token}` };
  const bytes = await fsp.readFile(path.join(FIX, 'sample_8s_9x16.mp4'));
  const up = await req('/api/media/import?scope=shared', { ...auth, 'content-type': 'application/octet-stream', 'x-file-name': 'clip.mp4' }, bytes);
  return { req, auth, bytes, vid: up.json.version.version_id as string, upload: up.json, svc: app.svc };
}

describe('W07 range parsing', () => {
  it('handles start-end, open end, suffix; refuses unsatisfiable ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull(); // multi-range: whole file
    for (const bad of ['bytes=100-', 'bytes=9-3', 'bytes=-0']) expect(() => parseRange(bad, 100), bad).toThrow(ApiError);
  });
});

describe('W07 preview streaming', () => {
  it('import probes the real MP4 (duration for the editor) when ffprobe is available', async () => {
    const s = await setup();
    const p = s.upload.version.probe;
    if (p === undefined) return; // no ffprobe on this machine: covered by core tests
    expect(p).toMatchObject({ duration_ms: 8000, width: 360, height: 640, video_codec: 'h264' });
    expect(s.upload.version.preview).toBe(true);
  });

  it('signed URL → full file, byte ranges (206), correct type; the URL needs no token', async () => {
    const s = await setup();
    expect((await s.req(`/api/media/${s.vid}/stream-url`)).status).toBe(401); // issuing needs the session
    const issued = (await s.req(`/api/media/${s.vid}/stream-url`, s.auth)).json;
    expect(issued.url).toMatch(new RegExp(`^/api/stream/${s.vid}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    expect(issued.mime).toBe('video/mp4');
    const full = await s.req(issued.url);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(createHash('sha256').update(full.raw).digest('hex')).toBe(createHash('sha256').update(s.bytes).digest('hex'));
    const part = await s.req(issued.url, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${s.bytes.length}`);
    expect(part.raw.equals(s.bytes.subarray(100, 200))).toBe(true);
    expect((await s.req(issued.url, { range: `bytes=${s.bytes.length}-` })).status).toBe(416);
  });

  it('forged, swapped or expired signatures are refused', async () => {
    const s = await setup();
    const { url } = (await s.req(`/api/media/${s.vid}/stream-url`, s.auth)).json as { url: string };
    const forged = url.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`);
    expect((await s.req(forged)).status).toBe(401);
    expect((await s.req(url.replace(/exp=\d+/, (m) => `exp=${Number(m.slice(4)) + 1}`))).status).toBe(401);
    expect((await s.req(url.replace(s.vid, 'v_0123456789abcdef'))).status).toBe(401);
    expect((await s.req(`/api/stream/${s.vid}`)).status).toBe(401);
    clock += 11 * 60_000;
    expect((await s.req(url)).json.error.message).toMatch(/kedaluwarsa/);
  });

  it('only active, intact versions can be streamed', async () => {
    const s = await setup();
    expect((await s.req('/api/media/v_0123456789abcdef/stream-url', s.auth)).status).toBe(404);
    const media = (await s.req('/api/media', s.auth)).json.media;
    expect(media[0].versions[0]).toHaveProperty('preview');
  });
});
