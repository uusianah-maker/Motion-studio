import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLeases } from '../src/storage/deps.js';
import { type EngineConfig, KUNCI_GABUNGAN, MAKS_FOOTAGE_IKLAN, continueRefusedJob, loadEnginePlan, prepareEngineJob, runEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';
import { tempDir } from './helpers.js';

/** §26 (KONTRAK-ENGINE v0.4.9): Video Iklan with several footage, joined by the engine in list order. */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-engine.mjs');
const brief = (catatan = '') => ({ produk: 'Loose Pants', varian: 'Espresso', harga: '', placement: 'tiktok', catatan });
const R = (n: number) => ({ media_id: `m_${n}`, version_id: `v_${n}` });
const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const root = await tempDir();
  await fsp.mkdir(path.join(root, 'aset'));
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(root, 'aset', 'musik-lokal.wav')], { windowsHide: true });
  const cfg: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const gen = async (name: string, size: string) => {
    const f = path.join(fx.src, name);
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=s=${size}:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'g' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(fx.ws, { project_id: 'g', name: 'Video iklan' });
  const foot = [await gen('Konten 1 (1).mp4', '360x640'), await gen('Konten 2 (2).mp4', '720x1280'), await gen('Konten 3 (1).mp4', '640x360')];
  return { ...fx, cfg, foot };
}

describe('§26 Video Iklan: several footage', () => {
  it('validates: one footage = $sumber (old jobs), several = $sumber:<id> each, 1–20', () => {
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: R(1) }], preset: 'p', brief: {} }).sources).toHaveLength(1);
    const many = validateEngineJob({ project_id: 'g', mode: 'generate', sources: [3, 1, 2].map((n) => ({ kunci: `$sumber:f${n}`, ref: R(n) })), preset: 'p', brief: {} });
    expect(many.sources.map((s) => s.kunci)).toEqual(['$sumber:f3', '$sumber:f1', '$sumber:f2']); // the order is kept
    // The same footage twice (e.g. an opening shot reused at the end) is allowed: keys differ.
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber:a', ref: R(1) }, { kunci: '$sumber:b', ref: R(1) }], preset: 'p', brief: {} }).sources).toHaveLength(2);
    for (const sources of [
      [],
      [{ kunci: '$sumber:f1', ref: R(1) }], // one footage keeps the old key
      [{ kunci: '$sumber', ref: R(1) }, { kunci: '$sumber:f2', ref: R(2) }],
      [{ kunci: '$sumber:f1', ref: R(1) }, { kunci: '$sumber:f1', ref: R(2) }],
      Array.from({ length: MAKS_FOOTAGE_IKLAN + 1 }, (_, i) => ({ kunci: `$sumber:f${i}`, ref: R(i) })),
    ])
      expect(() => validateEngineJob({ project_id: 'g', mode: 'generate', sources, preset: 'p', brief: {} }), JSON.stringify(sources).slice(0, 80)).toThrow();
  });

  it.skipIf(!hasFfmpeg)('job.json lists the footage in order; the joined video is imported once as project media; refused job continues with the same list', async () => {
    const { ws, cfg, foot } = await setup();
    const sources = [foot[1]!, foot[0]!, foot[2]!].map((ref, i) => ({ kunci: `$sumber:f${i + 1}`, ref }));
    const s = await prepareEngineJob(ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources, preset: 'p', brief: brief(), ai: false }));
    const jdir = path.join(ws.root, 'PROJECTS', 'g', '06_ENGINE', s.job_id);
    const job = JSON.parse(await fsp.readFile(path.join(jdir, 'job.json'), 'utf8'));
    expect(job.sumber.map((x: { kunci: string }) => x.kunci)).toEqual(['$sumber:f1', '$sumber:f2', '$sumber:f3']);
    expect(new Set(job.sumber.map((x: { path: string }) => x.path)).size).toBe(3);
    expect(job.sumber.every((x: { path: string }) => path.isAbsolute(x.path))).toBe(true);
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine').flatMap((l) => l.media.map((m) => m.version_id)).sort()).toEqual(foot.map((f) => f.version_id).sort());
    expect((await runEngineJob(ws, cfg, 'g', s.job_id)).state).toBe('siap');

    const plan = await loadEnginePlan(ws, cfg, 'g', s.job_id);
    expect(plan.imported).toEqual(expect.arrayContaining([KUNCI_GABUNGAN]));
    const video = (plan.ops as { track_kind?: string; media?: { version_id: string } }[]).filter((o) => o.track_kind === 'video');
    expect(video).toHaveLength(1);
    const reg = await loadRegistry(ws);
    const joined = reg.versions[video[0]!.media!.version_id]!;
    expect(foot.map((f) => f.version_id)).not.toContain(joined.version_id); // the joined file, not one footage
    expect(reg.media[joined.media_id]!.scope).toEqual({ kind: 'project', project_id: 'g' });
    expect((plan.rencana.sumber_gabungan as { bagian: unknown[] }).bagian).toHaveLength(3);
    expect((await loadEnginePlan(ws, cfg, 'g', s.job_id)).imported).toEqual([]); // remembered in refs.json

    // "Tetap lanjut" after a song refusal keeps every footage, in order.
    const lagu = await prepareEngineJob(ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources, preset: 'p', brief: brief('lagu'), ai: false }));
    expect((await runEngineJob(ws, cfg, 'g', lagu.job_id)).state).toBe('ditolak');
    const lanjut = await continueRefusedJob(ws, 'g', lagu.job_id);
    const job2 = JSON.parse(await fsp.readFile(path.join(ws.root, 'PROJECTS', 'g', '06_ENGINE', lanjut.job_id, 'job.json'), 'utf8'));
    expect(job2.sumber.map((x: { kunci: string; path: string }) => [x.kunci, x.path])).toEqual(job.sumber.map((x: { kunci: string; path: string }) => [x.kunci, x.path]));
    expect(job2.abaikan_cek_ucapan).toBe(true);
  }, 90_000);

  it.skipIf(!hasFfmpeg)('the joined video must be inside THIS job out/ folder', async () => {
    const { ws, cfg, foot } = await setup();
    const sources = foot.map((ref, i) => ({ kunci: `$sumber:f${i + 1}`, ref }));
    const s = await prepareEngineJob(ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources, preset: 'p', brief: brief('gabung-kabur'), ai: false }));
    expect((await runEngineJob(ws, cfg, 'g', s.job_id)).state).toBe('siap');
    expect(await code(() => loadEnginePlan(ws, cfg, 'g', s.job_id))).toBe('PRECONDITION');
  }, 90_000);
});
