// R11 Motion Transfer over HTTP: start a `transfer` job, read the scenes, edit them (Owner / Editor),
// fetch a frame with the session header; a Reviewer reads but cannot edit; no plan to open.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace } from '../src/core.js';
import { engineRoutes } from '../src/engine.js';
import type { Role } from '../src/roles.js';
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

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r11-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(root, { recursive: true });
  const src = path.join(dir, 'referensi.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
  const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Celana Korset', varian: [], ukuran: '' }] }, actor: 'user' });
  await createProject(ws, { project_id: 't', name: 'Transfer' });
  const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  let role: Role = 'editor';
  const copilot = createCopilot(ws);
  const app = createApp({ ws, roleOf: () => role, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engineRoutes(ws, { copilot, config })] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse>; raw: Buffer; type: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const type = String(res.headers['content-type'] ?? '');
            resolve({ status: res.statusCode ?? 0, raw, type, json: type.includes('json') ? JSON.parse(raw.toString('utf8') || 'null') : null });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  const asRole = (r: Role) => {
    role = r;
  };
  return { call, asRole, ref: { media_id: v.media.media_id, version_id: v.version.version_id } };
}

describe('R11 Motion Transfer API', () => {
  it.skipIf(!hasFfmpeg)('start → scenes → merge / delete → frame; reviewer reads only; no edit plan', async () => {
    const { call, asRole, ref } = await setup();
    const start = await call('/api/projects/t/engine/jobs', { mode: 'transfer', sources: [{ kunci: '$sumber', ref }], produk: 'Celana Korset' });
    expect(start.status).toBe(200);
    const jid = start.json.job.job_id as string;
    expect(start.json.job.mode).toBe('transfer');
    let state = '';
    for (let i = 0; i < 200 && state !== 'siap'; i++) {
      state = (await call(`/api/projects/t/engine/jobs/${jid}`)).json.job.state;
      if (state !== 'siap') await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(state).toBe('siap');
    // Extra fields are refused (no AI switch, no batch extras).
    expect((await call('/api/projects/t/engine/jobs', { mode: 'transfer', sources: [{ kunci: '$sumber', ref }], ai: true })).status).toBe(422);

    const base = `/api/projects/t/engine/jobs/${jid}/transfer`;
    const v = (await call(base)).json.transfer;
    expect(v).toMatchObject({ jumlah_mesin: 4, versi: 0, diubah: false, produk: 'Celana Korset' });
    const merged = await call(`${base}/edit`, { aksi: 'gabung', id: '1', expected_versi: 0 });
    expect(merged.status).toBe(200);
    expect(merged.json.transfer.adegan.map((a: { id: string }) => a.id)).toEqual(['1+2', '3', '4']);
    expect((await call(`${base}/edit`, { aksi: 'hapus', id: '3', expected_versi: 0 })).status).toBe(409);
    expect((await call(`${base}/edit`, { aksi: 'hapus', id: '3', expected_versi: 1, x: 1 })).status).toBe(400);

    const img = await call(`${base}/gambar/2`);
    expect([img.status, img.type, img.raw.subarray(0, 2).toString('hex')]).toEqual([200, 'image/jpeg', 'ffd8']);
    expect((await call(`${base}/gambar/9`)).status).toBe(404);
    expect((await call(`${base}/gambar/..%2Fjob.json`)).status).toBe(404);

    // No edit plan for a transfer job.
    expect((await call(`/api/projects/t/engine/jobs/${jid}/plan`, {})).status).toBe(400);

    asRole('reviewer');
    expect((await call(base)).status).toBe(200);
    expect((await call(`${base}/gambar/1`)).status).toBe(200);
    expect((await call(`${base}/edit`, { aksi: 'hapus', id: '3', expected_versi: 1 })).status).toBe(403);
  }, 60_000);
});
