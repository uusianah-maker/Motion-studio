// R34 "Suara dari Teks" (contract §21): voices, a tts job, the voice over imported into Media + the
// Brand Kit (kind vo), sentence/word times for subtitles without Whisper, pronunciation from the kit.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace, readBrandFor } from '../src/core.js';
const readBrand = readBrandFor;
import { engineRoutes } from '../src/engine.js';
import { apiRoutes } from '../src/routes.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fake-engine.mjs');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r34-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(root, { recursive: true });
  const brand = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', pelafalan: [{ tulisan: 'Aysilla', ucapan: 'Ay-si-la' }] }, actor: 'user' })).result;
  await createProject(ws, { project_id: 'vo', name: 'Suara' });
  await svc.updateProjectMeta({ project_id: 'vo', expected_revision: 0, brand_id: brand.brand_id, actor: 'user' });
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
  return { ws, call, brand_id: brand.brand_id };
}

describe('R34 Suara dari Teks (API)', () => {
  it('voices; a job from a paragraph → VO in Media + Brand Kit (vo), times per sentence/word, pronunciation sent', async () => {
    const s = await setup();
    const v = await s.call('/api/engine/suara');
    expect(v.json).toMatchObject({ tersedia: true });
    expect(v.json.suara.map((x: { id: string }) => x.id)).toContain('windows:Andika');

    expect((await s.call('/api/projects/vo/engine/jobs', { mode: 'tts', tts: { teks: '' } })).status).toBe(422);
    expect((await s.call('/api/projects/vo/engine/jobs', { mode: 'tts', tts: { teks: 'Halo.', kecepatan: 3 } })).status).toBe(422);
    const start = await s.call('/api/projects/vo/engine/jobs', { mode: 'tts', tts: { teks: 'Halo kak, ini Aysilla. Harganya cuma 99 ribu!\nCek keranjang kuning', suara: 'windows:Andika', kecepatan: 1, jeda_ms: 300 } });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const id = start.json.job.job_id as string;
    for (let i = 0; i < 100; i++) {
      const st = (await s.call(`/api/projects/vo/engine/jobs/${id}`)).json.job.state;
      if (st !== 'menunggu' && st !== 'berjalan') break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const job = JSON.parse(await fsp.readFile(path.join(s.ws.root, 'PROJECTS', 'vo', '06_ENGINE', id, 'job.json'), 'utf8'));
    expect(job.tts).toEqual({ kalimat: ['Halo kak, ini Aysilla.', 'Harganya cuma 99 ribu!', 'Cek keranjang kuning'], suara: 'windows:Andika', kecepatan: 1, jeda_ms: 300 });
    const kit = JSON.parse(await fsp.readFile(path.join(s.ws.root, 'PROJECTS', 'vo', '06_ENGINE', id, 'brand_kit.json'), 'utf8'));
    expect(kit.teks.pelafalan).toEqual({ Aysilla: 'Ay-si-la' });

    const r = await s.call(`/api/projects/vo/engine/jobs/${id}/tts`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const tts = r.json.tts;
    expect(tts.kalimat.map((k: { teks: string }) => k.teks)).toEqual(job.tts.kalimat);
    expect(tts.gabungan).toMatchObject({ media_id: expect.any(String) });
    expect(tts.kalimat.every((k: { ref: unknown }) => !!k.ref)).toBe(true);
    expect(tts.kalimat[1].mulai).toBeGreaterThan(tts.kalimat[0].akhir); // the pause between sentences
    // Brand Kit library: one VO asset for the whole take.
    const b = await readBrand(s.ws, s.brand_id);
    expect(b.aset.filter((a) => a.jenis === 'vo').map((a) => [a.id, a.ref.version_id])).toEqual([[`vo-${id.toLowerCase()}`, tts.gabungan.version_id]]);
    // Reading again does not import twice.
    await s.call(`/api/projects/vo/engine/jobs/${id}/tts`);
    expect((await readBrand(s.ws, s.brand_id)).aset.filter((a) => a.jenis === 'vo')).toHaveLength(1);
    const media = (await s.call('/api/media?scope=all')).json.media as { display_name: string }[];
    expect(media.filter((m) => m.display_name.startsWith(`VO ${id}`))).toHaveLength(4);
    // Known text + word times of the take (subtitles without Whisper).
    const vo = (await s.call(`/api/vo/${tts.gabungan.version_id}`)).json.vo;
    expect(vo.teks).toBe(job.tts.kalimat.join(' '));
    expect(vo.kalimat[0].kata.map((w: { teks: string }) => w.teks)).toEqual(['Halo', 'kak,', 'ini', 'Aysilla.']);
    expect((await s.call(`/api/vo/${tts.kalimat[2].ref.version_id}`)).json.vo.kalimat).toHaveLength(1);
  }, 60_000);
});
