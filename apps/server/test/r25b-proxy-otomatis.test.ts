// R25b: media an engine plan brings into a project get their preview copy queued right away
// (makeProxy decides whether one is needed), through the same queue as uploads.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, type Workspace, createProject, initWorkspace } from '../src/core.js';
import { engineRoutes } from '../src/engine.js';
import type { ProxyQueue } from '../src/proxy.js';
import { apiRoutes } from '../src/routes.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fake-engine.mjs');
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

describe('R25b proxy otomatis untuk media dari mesin', () => {
  it.skipIf(!hasFfmpeg)('opening a Generate plan queues a proxy for every media version it uses (once each)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r25b-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const svc = new StorageService(ws);
    const root = path.join(dir, 'engine');
    await fsp.mkdir(path.join(root, 'aset'), { recursive: true });
    const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
    ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(root, 'aset', 'musik-lokal.wav')]);
    const src = path.join(dir, 'bicara.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
    await createProject(ws, { project_id: 'g', name: 'Generate' });
    const queued: string[] = [];
    const proxies: ProxyQueue = { enqueue: async (_ws: Workspace, vid: string) => void queued.push(vid), busy: () => false, idle: async () => undefined };
    const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
    const copilot = createCopilot(ws);
    const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }, undefined, undefined, proxies), ...copilot.routes, ...engineRoutes(ws, { copilot, config, proxies })] });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const call = (p: string, body?: unknown) =>
      new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const r = http.request(
          { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
          },
        );
        r.on('error', reject);
        r.end(data);
      });
    const ref = { media_id: v.media.media_id, version_id: v.version.version_id };
    const start = await call('/api/projects/g/engine/jobs', { mode: 'generate', sources: [{ kunci: '$sumber', ref }], preset: 'aysilla-konversi', brief: { produk: 'X', varian: '', harga: '', placement: 'tiktok', catatan: '' }, ai: false });
    const id = start.json.job.job_id as string;
    for (let i = 0; i < 200; i++) {
      const s = (await call(`/api/projects/g/engine/jobs/${id}`)).json.job.state;
      if (s !== 'menunggu' && s !== 'berjalan') break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const plan = await call(`/api/projects/g/engine/jobs/${id}/plan`, {});
    expect(plan.status).toBe(200);
    const media = new Set<string>(plan.json.plan.operations.flatMap((o: { op: { media?: { version_id: string } } }) => (o.op.media ? [o.op.media.version_id] : [])));
    expect(media.has(ref.version_id)).toBe(true);
    expect(queued.sort()).toEqual([...media].sort()); // the talk video + the engine's music, each once
  }, 60_000);
});
