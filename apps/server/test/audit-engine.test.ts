// Audit Jenius (14 Nov 2026) on the engine runner: server stop kills the engine, two starts on one
// project at once, the reason of a job cancelled while queued.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace, prepareEngineJob, readEngineStatus, validateEngineJob } from '../src/core.js';
import { createEngine } from '../src/engine.js';
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-aud-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(path.join(root, 'konten'), { recursive: true });
  const src = path.join(dir, 'bicara.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], { windowsHide: true });
  const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(ws, { project_id: 'g', name: 'Generate' });
  const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const copilot = createCopilot(ws);
  const engine = createEngine(ws, { copilot, config });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engine.routes] });
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
  const job = (catatan: string) => ({ mode: 'generate', sources: [{ kunci: '$sumber', ref: { media_id: v.media.media_id, version_id: v.version.version_id } }], preset: 'p', brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan }, ai: false });
  return { ws, call, engine, job, copilot, config };
}

describe('audit Jenius: engine runner', () => {
  it.skipIf(!hasFfmpeg)('#2 server stop: the running engine is killed and waited for, queued jobs settled', async () => {
    const s = await setup();
    const a = (await s.call('/api/projects/g/engine/jobs', s.job('lambat'))).json.job.job_id as string; // engine sleeps 20 s
    const b = (await s.call('/api/projects/g/engine/jobs', s.job(''))).json.job.job_id as string;
    for (let i = 0; i < 100 && (await readEngineStatus(s.ws, 'g', a)).state !== 'berjalan'; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await readEngineStatus(s.ws, 'g', a)).state).toBe('berjalan');
    const t0 = Date.now();
    await s.engine.stopAll();
    expect(Date.now() - t0).toBeLessThan(15_000); // killed, not waited out
    expect(await readEngineStatus(s.ws, 'g', a)).toMatchObject({ state: 'gagal', lease_id: null });
    expect(await readEngineStatus(s.ws, 'g', b)).toMatchObject({ state: 'gagal', alasan: 'Server dihentikan sebelum job ini mulai; jalankan lagi', lease_id: null });
    // Nothing new starts while stopping.
    expect((await s.call('/api/projects/g/engine/jobs', s.job(''))).status).toBe(409);
  }, 60_000);

  it.skipIf(!hasFfmpeg)('#4 two starts on one project at the same moment: two jobs, two ids, no 500; #7 cancel while queued says so', async () => {
    const s = await setup();
    const [r1, r2] = await Promise.all([s.call('/api/projects/g/engine/jobs', s.job('lambat')), s.call('/api/projects/g/engine/jobs', s.job(''))]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r1.json.job.job_id).not.toBe(r2.json.job.job_id);
    // The second one waits behind the slow one: cancelling it is the user's doing, not a restart.
    const ids = [r1.json.job.job_id as string, r2.json.job.job_id as string];
    let waiting = ids[1]!;
    for (const id of ids) if ((await readEngineStatus(s.ws, 'g', id)).state === 'menunggu') waiting = id;
    const c = await s.call(`/api/projects/g/engine/jobs/${waiting}/cancel`, {});
    expect(c.status).toBe(200);
    expect(c.json.job).toMatchObject({ state: 'gagal', alasan: 'Dibatalkan pengguna sebelum mulai' });
    await s.engine.stopAll();
  }, 60_000);

  it.skipIf(!hasFfmpeg)('#9 server start: jobs a previous server left waiting are settled at once (lease freed)', async () => {
    const s = await setup();
    // A job prepared by the "previous server" (status menunggu, lease held) that never ran.
    const left = await prepareEngineJob(s.ws, validateEngineJob({ project_id: 'g', ...s.job('') }));
    expect(left).toMatchObject({ state: 'menunggu' });
    const fresh = createEngine(s.ws, { copilot: s.copilot, config: s.config });
    expect(await fresh.sweepOrphans()).toBe(1);
    expect(await readEngineStatus(s.ws, 'g', left.job_id)).toMatchObject({ state: 'gagal', lease_id: null });
    expect(await fresh.sweepOrphans()).toBe(0);
  }, 60_000);
});
