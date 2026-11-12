import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace, readProject } from '../src/core.js';
import { engineRoutes } from '../src/engine.js';
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

async function setup(installed = true) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u6-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(path.join(root, 'aset'), { recursive: true });
  await fsp.mkdir(path.join(root, 'konten'));
  const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
  ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(root, 'aset', 'musik-lokal.wav')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'konten', 'f1.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3', path.join(root, 'konten', 'f1-vokal.wav')]);
  const src = path.join(dir, 'bicara.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(ws, { project_id: 'g', name: 'Generate' });
  await createProject(ws, { project_id: 'b', name: 'Batch' });
  const config: EngineConfig | null = installed ? { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 } : null;
  const copilot = createCopilot(ws);
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engineRoutes(ws, { copilot, config })] });
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
  const until = async (p: string, done: (j: { state: string }) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const r = await call(p);
      if (done(r.json.job)) return r.json;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`timeout ${p}`);
  };
  return { ws, call, until, ref: { media_id: v.media.media_id, version_id: v.version.version_id } };
}

const brief = { produk: 'Loose Pants', varian: 'Espresso', harga: '', placement: 'tiktok', catatan: '' };

describe('U6 engine API (Generate Otomatis + Batch Remix)', () => {
  it.skipIf(!hasFfmpeg)('generate: start → progress → plan card (engine source, diff, nothing applied) → approve = one undo step', async () => {
    const s = await setup();
    expect((await s.call('/api/engine')).json).toMatchObject({ installed: true });
    const start = await s.call('/api/projects/g/engine/jobs', { mode: 'generate', sources: [{ kunci: '$sumber', ref: s.ref }], preset: 'aysilla-konversi', brief, ai: false });
    expect(start.status).toBe(200);
    const id = start.json.job.job_id as string;
    expect(id).toMatch(/^AYS-\d{8}-001$/);
    const done = await s.until(`/api/projects/g/engine/jobs/${id}`, (j) => j.state !== 'menunggu' && j.state !== 'berjalan');
    expect(done.job).toMatchObject({ state: 'siap', persen: 100 });
    expect((await s.call('/api/projects/g/engine/jobs')).json.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([id]);
    const plan = await s.call(`/api/projects/g/engine/jobs/${id}/plan`, {});
    expect(plan.status).toBe(200);
    expect(plan.json.plan).toMatchObject({ source: 'engine', requires_approval: true, prompt: `Draf Generate Otomatis ${id}` });
    expect(plan.json.plan.rationale).toContain('Hook "Celana adem"');
    expect(plan.json.plan.warnings.join(' ')).toContain('Periksa kata "adem"');
    expect(plan.json.rencana).toMatchObject({ status: 'siap' });
    expect((await readProject(s.ws, 'g')).revision).toBe(0); // nothing changes before approval
    const applied = await s.call(`/api/projects/g/copilot/plans/${plan.json.plan.plan_id}/apply`, { expected_revision: 0 });
    expect(applied.status).toBe(200);
    const p = await readProject(s.ws, 'g');
    expect(p.revision).toBe(1);
    expect(p.timeline.tracks.map((t) => t.kind)).toEqual(['video', 'subtitle', 'music']);
    // Refusals: bad body, unknown job, project without media, wrong variant.
    expect((await s.call('/api/projects/g/engine/jobs', { mode: 'generate', sources: [], preset: 'x', brief })).status).toBe(422);
    expect((await s.call('/api/projects/g/engine/jobs/AYS-20260101-999')).status).toBe(404);
    expect((await s.call('/api/projects/g/engine/jobs/..%2F..%2Fx')).status).toBe(404);
  }, 90_000);

  it.skipIf(!hasFfmpeg)('batch: table + decisions → approved variants; engine not installed → clear 409', async () => {
    const s = await setup();
    const start = await s.call('/api/projects/b/engine/jobs', { mode: 'batch', sources: [], preset: 'aysilla-konversi', brief, mode_ops: 'u3', batch: { batch: 'winning', jumlah: 2, tujuan: 'konversi', hak_pakai_jelas: true } });
    const id = start.json.job.job_id as string;
    await s.until(`/api/projects/b/engine/jobs/${id}`, (j) => j.state === 'siap');
    const table = await s.call(`/api/projects/b/engine/jobs/${id}/batch`);
    expect(table.json.batch.varian.map((r: { id: string }) => r.id)).toEqual(['varian-001', 'varian-002']);
    expect(table.json.decisions).toEqual({});
    const d = await s.call(`/api/projects/b/engine/jobs/${id}/batch/decide`, { rows: [{ varian: 'varian-001', status: 'disetujui' }, { varian: 'varian-002', status: 'dicoret' }] });
    expect(d.status).toBe(200);
    expect(d.json.decisions['varian-002']).toEqual({ status: 'dicoret', project_id: null });
    const variants = await s.call('/api/projects/b/variants');
    expect(variants.json.variants).toHaveLength(1);
    expect(variants.json.variants[0]).toMatchObject({ state: 'approved' });
    expect((await s.call(`/api/projects/b/engine/jobs/${id}/batch/decide`, { rows: [{ varian: 'varian-001', status: 'lulus' }] })).status).toBe(422);

    const off = await setup(false);
    expect((await off.call('/api/engine')).json).toMatchObject({ installed: false });
    const r = await off.call('/api/projects/g/engine/jobs', { mode: 'generate', sources: [{ kunci: '$sumber', ref: off.ref }], preset: 'p', brief });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('ENGINE_MISSING');
  }, 120_000);
});
