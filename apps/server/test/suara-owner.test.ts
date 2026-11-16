// Suara owner (contract §23): the sample list, a check job and a training job, the report with
// example takes imported into Media; removals are sent once as hapus_contoh.
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
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-suara-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(root, { recursive: true });
  const brand = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' })).result;
  await createProject(ws, { project_id: 'so', name: 'Suara owner' });
  await svc.updateProjectMeta({ project_id: 'so', expected_revision: 0, brand_id: brand.brand_id, actor: 'user' });
  const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const copilot = createCopilot(ws);
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engineRoutes(ws, { copilot, config })] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown, method?: string) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: method ?? (data ? 'POST' : 'GET'), headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  let n = 0;
  const sample = async (name: string, video = false) => {
    const f = path.join(dir, name);
    n += 1;
    const audio = ['-f', 'lavfi', '-i', `sine=f=${200 + n * 37}:d=1`];
    execFileSync(FFMPEG, ['-v', 'error', ...(video ? ['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=1', ...audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest'] : audio), f], { windowsHide: true });
    const m = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    return { media_id: m.media.media_id, version_id: m.version.version_id };
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const j = (await call(`/api/projects/so/engine/jobs/${id}`)).json.job;
      if (j.state !== 'menunggu' && j.state !== 'berjalan') return j;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('job timeout');
  };
  return { ws, call, sample, wait };
}

const job = (refs: { media_id: string; version_id: string }[], latih: boolean, hapus?: string[]) => ({
  mode: 'suara_profil',
  sources: refs.map((r) => ({ kunci: `$media:${r.media_id}`, ref: r })),
  suara_profil: { latih, ...(hapus ? { hapus_contoh: hapus } : {}) },
});

describe('Suara owner (§23, API)', () => {
  it('sample list: add audio/video, the same media once, remove → hapus_contoh sent once', async () => {
    const s = await setup();
    const a = await s.sample('satu.wav');
    const b = await s.sample('dua.mp4', true);
    expect((await s.call('/api/suara-owner')).json.suara_owner).toEqual({ schema: 'suara-owner/1', contoh: [], dihapus: [] });
    expect((await s.call('/api/suara-owner/contoh', { contoh: [{ media_id: 'x', version_id: 'y' }] })).status).toBe(422);
    const added = await s.call('/api/suara-owner/contoh', { contoh: [a, b, a] });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect(added.json.suara_owner.contoh).toEqual([b, a]);
    const del = await s.call(`/api/suara-owner/contoh/${a.media_id}`, undefined, 'DELETE');
    expect(del.json.suara_owner).toMatchObject({ contoh: [b], dihapus: [`$media:${a.media_id}`] });

    const start = await s.call('/api/projects/so/engine/jobs', job([b], false, [`$media:${a.media_id}`]));
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const j = await s.wait(start.json.job.job_id);
    const written = JSON.parse(await fsp.readFile(path.join(s.ws.root, 'PROJECTS', 'so', '06_ENGINE', j.job_id, 'job.json'), 'utf8'));
    expect(written.suara_profil).toEqual({ profil: 'owner', nama: 'Suara owner', tambah_contoh: [`$media:${b.media_id}`], hapus_contoh: [`$media:${a.media_id}`], latih: false });
    expect(written.sumber).toEqual([{ kunci: `$media:${b.media_id}`, path: expect.any(String) }]);
    expect((await s.call('/api/suara-owner')).json.suara_owner.dihapus).toEqual([]); // delivered
  });

  it('check job (too little) then training job → report, example take imported into Media', async () => {
    const s = await setup();
    const refs = [await s.sample('a.wav'), await s.sample('bb.wav'), await s.sample('ccc.wav'), await s.sample('dddd.wav')];
    expect((await s.call('/api/projects/so/engine/jobs', job([], true))).status).toBe(422);
    expect((await s.call('/api/projects/so/engine/jobs', { ...job(refs, false), sources: [{ kunci: '$media:lain', ref: refs[0] }] })).status).toBe(422);

    const c = await s.wait((await s.call('/api/projects/so/engine/jobs', job(refs.slice(0, 2), false))).json.job.job_id);
    expect(c.state).toBe('siap');
    const r1 = (await s.call(`/api/projects/so/engine/jobs/${c.job_id}/suara-profil`)).json.suara_profil;
    expect(r1).toMatchObject({ status: 'kurang_contoh', durasi_bersih_total: 190, minimal_dtk: 300, target_dtk: [600, 900], contoh_hasil: [] });
    expect(r1.contoh[0]).toMatchObject({ kunci: `$media:${refs[0]!.media_id}`, media_id: refs[0]!.media_id, snr_db: 30, dipakai: true });

    const t = await s.wait((await s.call('/api/projects/so/engine/jobs', job(refs, true))).json.job.job_id);
    const r2 = (await s.call(`/api/projects/so/engine/jobs/${t.job_id}/suara-profil`)).json.suara_profil;
    expect(r2).toMatchObject({ status: 'siap', backend: 'applio', durasi_bersih_total: 380 });
    expect(r2.contoh_hasil).toEqual([{ teks: 'Halo kak, ini suara owner.', ref: { media_id: expect.any(String), version_id: expect.any(String) } }]);
    const again = (await s.call(`/api/projects/so/engine/jobs/${t.job_id}/suara-profil`)).json.suara_profil;
    expect(again.contoh_hasil[0].ref).toEqual(r2.contoh_hasil[0].ref); // imported once
    const media = (await s.call('/api/media')).json.media as { media_id: string; display_name: string }[];
    expect(media.find((m) => m.media_id === r2.contoh_hasil[0].ref.media_id)?.display_name).toMatch(/^Suara owner .* contoh 01\.wav$/);
  });
});
