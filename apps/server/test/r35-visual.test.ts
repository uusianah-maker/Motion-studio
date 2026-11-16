// R35 Visual Tools (contract §18.10): one engine job per tool for the selected clip's media; made
// files imported into Media once; deteksi → reframe chain; refusals.
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

describe('R35 Visual Tools (API)', () => {
  it.skipIf(!hasFfmpeg)('hapus latar + perjelas → files in Media (once); deteksi → reframe with keyframe_app; bad input refused', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r35-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const svc = new StorageService(ws);
    const root = path.join(dir, 'engine');
    await fsp.mkdir(root, { recursive: true });
    const src = path.join(dir, 'klip.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
    const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    const ref = { media_id: v.media.media_id, version_id: v.version.version_id };
    await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
    await createProject(ws, { project_id: 'p', name: 'P' });
    const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
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
    const runJob = async (visual: Record<string, unknown>) => {
      const s = await call('/api/projects/p/engine/jobs', { mode: 'visual', ref, visual });
      expect(s.status, JSON.stringify(s.json)).toBe(200);
      const id = s.json.job.job_id as string;
      for (let i = 0; i < 100; i++) {
        const st = (await call(`/api/projects/p/engine/jobs/${id}`)).json.job.state;
        if (st !== 'menunggu' && st !== 'berjalan') break;
        await new Promise((ok) => setTimeout(ok, 100));
      }
      return id;
    };
    for (const bad of [{ alat: 'sihir' }, { alat: 'hapus_latar', kualitas: 'ultra' }, { alat: 'perjelas', mode: 'kualitas', skala: 2 }, { alat: 'lacak' }, { alat: 'lacak', kotak: [0.9, 0.9, 0.5, 0.5] }, { alat: 'reframe', kanvas: [1080, 1920] }])
      expect((await call('/api/projects/p/engine/jobs', { mode: 'visual', ref, visual: bad })).status, JSON.stringify(bad)).toBe(422);

    const hl = await runJob({ alat: 'hapus_latar', kualitas: 'cepat' });
    const job = JSON.parse(await fsp.readFile(path.join(ws.root, 'PROJECTS', 'p', '06_ENGINE', hl, 'job.json'), 'utf8'));
    expect(job.visual).toMatchObject({ alat: 'hapus_latar', model: 'isnet-general-use', fps: 10 });
    expect(path.basename(job.visual.masuk)).toMatch(/\.mp4$/);
    const r1 = (await call(`/api/projects/p/engine/jobs/${hl}/visual`)).json.visual;
    expect(r1).toMatchObject({ alat: 'hapus_latar', hasil: { media_id: expect.any(String) }, masker: { media_id: expect.any(String) } });
    expect(JSON.stringify(r1)).not.toMatch(/[A-Za-z]:[\\/]/); // no local paths to the browser
    const again = (await call(`/api/projects/p/engine/jobs/${hl}/visual`)).json.visual;
    expect(again.hasil).toEqual(r1.hasil); // imported once

    const pj = await runJob({ alat: 'perjelas', mode: 'cepat', skala: 2 });
    const r2 = (await call(`/api/projects/p/engine/jobs/${pj}/visual`)).json.visual;
    expect(r2).toMatchObject({ alat: 'perjelas', info: { jadi: [720, 1280] } });
    const names = ((await call('/api/media?scope=all')).json.media as { display_name: string }[]).map((m) => m.display_name);
    expect(names.some((n) => n.startsWith('Tanpa latar'))).toBe(true);
    expect(names.some((n) => n.startsWith('Diperjelas'))).toBe(true);

    // Swap the clip to the result and back (set_media, one undo each).
    await svc.editTimeline({ project_id: 'p', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 1000 }] });

    const dt = await runJob({ alat: 'deteksi', jenis: ['wajah'] });
    expect((await call(`/api/projects/p/engine/jobs/${dt}/visual`)).json.visual.data.jalur[0].id).toBe('wajah-1');
    const rf = await runJob({ alat: 'reframe', jalur_job: dt, kanvas: [1080, 1920], fit: 'pas', awal_ms: 0 });
    const rjob = JSON.parse(await fsp.readFile(path.join(ws.root, 'PROJECTS', 'p', '06_ENGINE', rf, 'job.json'), 'utf8'));
    expect(path.basename(rjob.visual.jalur)).toBe('jalur.json');
    expect(rjob.visual.jalur_job).toBeUndefined();
    const r3 = (await call(`/api/projects/p/engine/jobs/${rf}/visual`)).json.visual;
    expect(r3.data.keyframe_app).toHaveLength(2);
  }, 90_000);
});
