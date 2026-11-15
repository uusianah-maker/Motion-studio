// R11 Motion Transfer (contract §15), app side: the `transfer` job, its scene list, the team's
// delete / merge / restore (kept apart from the engine's file, logged for learning) and the frames.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type EngineConfig, engineJobDir, prepareEngineJob, readEngineStatus, runEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { readLearning } from '../src/storage/learning.js';
import { StorageService } from '../src/storage/service.js';
import { editTransfer, readTransferImage, readTransferView } from '../src/storage/transfer.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';
import { tempDir } from './helpers.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-engine.mjs');
const REF = { media_id: 'm_1', version_id: 'v_1' };

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const root = await tempDir();
  const cfg: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const f = path.join(fx.src, 'referensi.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
  const video = { media_id: r.media.media_id, version_id: r.version.version_id };
  const brand = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Celana Korset', varian: [], ukuran: '' }] }, actor: 'user' })).result;
  await createProject(fx.ws, { project_id: 't', name: 'Transfer' });
  const run = async (extra: Record<string, unknown> = {}) => {
    const s = await prepareEngineJob(fx.ws, validateEngineJob({ project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: video }], ...extra }));
    return runEngineJob(fx.ws, cfg, 't', s.job_id);
  };
  return { ...fx, svc, cfg, video, run, brand };
}

describe('R11 Motion Transfer', () => {
  it('validates the transfer request: exactly one $sumber, product text only, nothing else', async () => {
    const ok = validateEngineJob({ project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }], produk: ' Celana Korset ', deskripsi_produk: 'hitam' });
    expect(ok).toMatchObject({ mode: 'transfer', preset: 'transfer', ai: false, brief: { produk: 'Celana Korset', deskripsi_produk: 'hitam' } });
    expect(validateEngineJob({ project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }] }).brief).not.toHaveProperty('deskripsi_produk');
    for (const bad of [
      { project_id: 't', mode: 'transfer', sources: [] },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }, { kunci: '$sumber', ref: REF }] },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber:a', ref: REF }] },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: { media_id: '../x', version_id: 'v' } }] },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }], ai: true },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }], produk: 'x'.repeat(121) },
      { project_id: 't', mode: 'transfer', sources: [{ kunci: '$sumber', ref: REF }], deskripsi_produk: 5 },
    ])
      expect(await code(() => validateEngineJob(bad))).toBe('EDIT_INVALID');
  });

  it.skipIf(!hasFfmpeg)('runs the engine, shows the scenes; delete / merge / restore are the team’s, kept apart and logged', async () => {
    const { ws, run, brand } = await setup();
    const s = await run({ produk: 'Celana Korset', deskripsi_produk: 'hitam, high waist' });
    expect([s.mode, s.state]).toEqual(['transfer', 'siap']);
    const job = await fsp.readFile(path.join(engineJobDir(ws, 't', s.job_id), 'job.json'), 'utf8').then(JSON.parse);
    expect(job).toMatchObject({ mode: 'transfer', ai: false, brief: { produk: 'Celana Korset', deskripsi_produk: 'hitam, high waist' } });
    expect(job.sumber).toHaveLength(1);

    const v = await readTransferView(ws, 't', s.job_id);
    expect(v).toMatchObject({ produk: 'Celana Korset', jumlah_mesin: 4, diubah: false, versi: 0, referensi: 'referensi.mp4' }); // the uploaded name, not the stored file's
    expect(v.referensi).not.toMatch(/[\\/]/); // a file name, never a local path
    expect(v.adegan.map((a) => a.id)).toEqual(['1', '2', '3', '4']);
    expect(v.adegan[0]).toMatchObject({ dari: 0, sampai: 1.2, durasi: 1.2, gambar_no: 1, sumber: 'mesin' });
    expect(v.adegan[0]!.prompt_gambar).toContain('Celana Korset');
    const engineFile = await fsp.readFile(path.join(engineJobDir(ws, 't', s.job_id), 'out', 'transfer.json'), 'utf8');

    // Merge 2 with 3: one scene, both durations, the first one's frame, an app-made motion prompt.
    let e = await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'gabung', id: '2', expected_versi: 0, by: 'Tim' });
    expect(e.adegan.map((a) => a.id)).toEqual(['1', '2+3', '4']);
    expect(e.adegan[1]).toMatchObject({ dari: 1.2, sampai: 4.1, durasi: 2.9, gambar_no: 2, sumber: 'tim' });
    expect(e.adegan[1]!.prompt_gerak).toContain('2.9 detik');
    expect(e.adegan[1]!.prompt_gerak).toContain('adegan 2–3/4');
    expect([e.diubah, e.versi]).toEqual([true, 1]);
    // Two people at once: the stale one is refused.
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '1', expected_versi: 0 }))).toBe('CONFLICT');
    e = await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '1', expected_versi: 1 });
    expect(e.adegan.map((a) => a.id)).toEqual(['2+3', '4']);
    // 4 directly follows 3 → can be merged; after deleting 1 nothing precedes 2+3.
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'gabung', id: '4', expected_versi: 2 }))).toBe('EDIT_INVALID'); // last scene
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '1', expected_versi: 2 }))).toBe('NOT_FOUND'); // already gone
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'pindah', id: '4', expected_versi: 2 }))).toBe('EDIT_INVALID');
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '../x', expected_versi: 2 }))).toBe('EDIT_INVALID');
    // Restore = the engine's split again; the engine's own file was never touched.
    e = await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'pulihkan', expected_versi: 2 });
    expect([e.adegan.length, e.diubah, e.versi]).toEqual([4, false, 3]);
    expect(await fsp.readFile(path.join(engineJobDir(ws, 't', s.job_id), 'out', 'transfer.json'), 'utf8')).toBe(engineFile);

    // Deleting all but one is fine, the last one stays.
    let ver = 3;
    for (const id of ['1', '2', '3']) ver = (await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id, expected_versi: ver })).versi;
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '4', expected_versi: ver }))).toBe('EDIT_INVALID');
    // A merge across a deleted scene is a jump in the reference: refused.
    ver = (await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'pulihkan', expected_versi: ver })).versi;
    ver = (await editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'hapus', id: '2', expected_versi: ver })).versi;
    expect(await code(() => editTransfer(ws, { project_id: 't', job_id: s.job_id, aksi: 'gabung', id: '1', expected_versi: ver }))).toBe('EDIT_INVALID');

    // Every edit is in the brand's learning log.
    const log = (await readLearning(ws, brand.brand_id)).filter((n) => (n as { jenis?: string }).jenis === 'transfer_tim');
    expect(log.length).toBeGreaterThanOrEqual(8);
    expect(log[0]).toMatchObject({ jenis: 'transfer_tim', aksi: 'gabung', adegan: '2', sisa: 3, dari_mesin: 4, by: 'Tim' });

    // Frames: only the engine's scene images.
    const img = await readTransferImage(ws, 't', s.job_id, 3);
    expect(img.mime).toBe('image/jpeg');
    expect(img.bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    for (const no of [0, 5, 1.5, '1', -1]) expect(await code(() => readTransferImage(ws, 't', s.job_id, no))).toBe('NOT_FOUND');
    // A transfer.json pointing outside out/adegan/ is not served.
    const tf = path.join(engineJobDir(ws, 't', s.job_id), 'out', 'transfer.json');
    const doc = JSON.parse(engineFile);
    doc.adegan[0].gambar = '../job.json';
    await fsp.writeFile(tf, JSON.stringify(doc));
    expect(await code(() => readTransferImage(ws, 't', s.job_id, 1))).toBe('NOT_FOUND');
  }, 60_000);

  it.skipIf(!hasFfmpeg)('a refused reference video is a refusal (no scenes); other job kinds are not a transfer', async () => {
    const { ws, run } = await setup();
    const s = await run({ deskripsi_produk: 'tolak' });
    expect([s.state, s.alasan]).toEqual(['ditolak', 'tidak ada gambar video di file']);
    expect(await code(() => readTransferView(ws, 't', s.job_id))).toBe('PRECONDITION');
    expect((await readEngineStatus(ws, 't', s.job_id)).lease_id).toBeNull();
  }, 60_000);
});
