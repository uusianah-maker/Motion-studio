// R18 (KONTRAK-ENGINE §17): preset style fields from Hanagaki's study, Brand Kit tagline +
// watermark, the four Aysilla example presets, and the per-job audio choice. All optional:
// an old kit / job without them stays exactly as it was.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rerunBeatspot } from '../src/storage/beatspot.js';
import { examplePresets, exportBrandKit, validateBrandInput } from '../src/storage/brand.js';
import { type EngineConfig, engineJobDir, prepareEngineJob, runEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';
import { tempDir } from './helpers.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-engine.mjs');
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const P = (extra: Record<string, unknown> = {}) => ({ id: 'p1', nama: 'Preset', ...extra });

describe('R18 presets, tagline, watermark, audio choice', () => {
  it('preset §17.1 fields are kept when set and absent when not (old presets unchanged)', () => {
    const old = validateBrandInput({ name: 'Aysilla', kode: 'AYS', presets: [P()] }).presets[0]!;
    for (const k of ['jenis', 'shot', 'transisi', 'penutup', 'beat']) expect(old).not.toHaveProperty(k);
    expect(Object.keys(old.caption).sort()).toEqual(['maks_kata', 'mode', 'pop_ms']);
    expect(Object.keys(old.hook).sort()).toEqual(['dari_ucapan', 'maks_kata', 'teks']);
    const p = validateBrandInput({
      name: 'Aysilla',
      kode: 'AYS',
      presets: [P({ jenis: 'street_interview', caption: { y: 0.76, warna: '#F5EFA0', outline: '#000000', kotak: true }, hook: { y: 0.18, ukuran: 4.5, baris: 2, warna: '#ffffff', dari_kalimat_kuat: true }, shot: { target_dtk: 1.9, maks_dtk: 3.5 }, transisi: { ganti_orang: 'flash' }, penutup: { end_card: true }, beat: { tiap_ketukan: 4, bpm: 120 } })],
    }).presets[0]!;
    expect(p).toMatchObject({ jenis: 'street_interview', caption: { y: 0.76, warna: '#f5efa0', outline: '#000000', kotak: true }, hook: { y: 0.18, ukuran: 4.5, baris: 2, warna: '#ffffff', dari_kalimat_kuat: true }, shot: { target_dtk: 1.9, maks_dtk: 3.5 }, transisi: { ganti_orang: 'flash' }, penutup: { end_card: true }, beat: { tiap_ketukan: 4, bpm: 120 } });
    for (const bad of [{ jenis: 'tutorial' }, { hook: { baris: 4 } }, { hook: { ukuran: 9 } }, { caption: { y: 1.5 } }, { caption: { warna: 'kuning' } }, { beat: { tiap_ketukan: 3 } }, { beat: { bpm: 300 } }, { transisi: { ganti_orang: 'wipe' } }, { shot: { lama: 2 } }])
      expect(code(() => validateBrandInput({ name: 'A', kode: 'AYS', presets: [P(bad)] }))).toBe('EDIT_INVALID');
  });

  it('the four §17.4 examples have the study numbers', () => {
    const ex = Object.fromEntries(examplePresets().map((p) => [p.id, p]));
    expect(Object.keys(ex)).toEqual(['aysilla-interview', 'aysilla-test-produk', 'aysilla-harian', 'aysilla-beatspot']);
    expect(ex['aysilla-interview']).toMatchObject({ jenis: 'street_interview', caption: { y: 0.76, warna: '#f5efa0', maks_kata: 4 }, hook: { y: 0.18, ukuran: 4.5 }, shot: { target_dtk: 1.9, maks_dtk: 3.5 }, transisi: { ganti_orang: 'flash' }, durasi: { min: 40, max: 55 } });
    expect(ex['aysilla-test-produk']).toMatchObject({ jenis: 'test_produk', caption: { y: 0.45 }, shot: { target_dtk: 1.6 } });
    expect(ex['aysilla-harian']).toMatchObject({ jenis: 'harian_studio', hook: { y: 0.54, ukuran: 3.4, baris: 2, warna: '#ffffff' }, shot: { target_dtk: 1.2, maks_dtk: 3.5 }, durasi: { min: 13, max: 18 } });
    expect(ex['aysilla-beatspot']).toMatchObject({ jenis: 'beat_spot', beat: { tiap_ketukan: 4, bpm: 120 }, durasi: { min: 15, max: 18 } });
  });

  it('tagline + watermark: validated, exported as teks.tagline / visual.watermark (absent = not exported)', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    expect(code(() => validateBrandInput({ name: 'A', kode: 'AYS', watermark: { teks: 'x', y: 2 } }))).toBe('EDIT_INVALID');
    expect(code(() => validateBrandInput({ name: 'A', kode: 'AYS', tagline: 'x'.repeat(121) }))).toBe('EDIT_INVALID');
    const plain = (await svc.createBrand({ kit: { name: 'Polos', kode: 'PLS' }, actor: 'user' })).result;
    const e0 = (await exportBrandKit(fx.ws, plain.brand_id, { paths: false })) as { teks: Record<string, unknown>; visual: Record<string, unknown> };
    expect(e0.teks).not.toHaveProperty('tagline');
    expect(e0.visual).not.toHaveProperty('watermark');
    const b = (await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS', tagline: 'CUCI · JEMUR · LANGSUNG PAKAI', watermark: { teks: '@aysilla.factory', y: 0.9 } }, actor: 'user' })).result;
    expect(b.watermark).toEqual({ teks: '@aysilla.factory', y: 0.9, lebar: 0.4, opasitas: 0.6 });
    const e = (await exportBrandKit(fx.ws, b.brand_id, { paths: false })) as { teks: Record<string, unknown>; visual: Record<string, unknown> };
    expect(e.teks.tagline).toBe('CUCI · JEMUR · LANGSUNG PAKAI');
    expect(e.visual.watermark).toEqual({ teks: '@aysilla.factory', y: 0.9, lebar: 0.4, opasitas: 0.6 });
  });

  it('audio_pilihan: vo | musik | keduanya on Generate, Batch, Beat Spot; absent = not sent', () => {
    const S = [{ kunci: '$sumber', ref: { media_id: 'm_1', version_id: 'v_1' } }];
    const brief = { produk: 'X', varian: '', harga: '', placement: 'tiktok', catatan: '' };
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false, audio_pilihan: 'vo' }).audio_pilihan).toBe('vo');
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false })).not.toHaveProperty('audio_pilihan');
    expect(validateEngineJob({ project_id: 'g', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: S[0]!.ref }], audio_pilihan: 'keduanya', preset: 'aysilla-beatspot' })).toMatchObject({ audio_pilihan: 'keduanya', preset: 'aysilla-beatspot' });
    for (const a of ['lagu', 1, true]) expect(code(() => validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false, audio_pilihan: a }))).toBe('EDIT_INVALID');
    expect(code(() => validateEngineJob({ project_id: 'g', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: S[0]!.ref }], preset: '../x' }))).toBe('EDIT_INVALID');
  });

  it('Beat Spot job.json: preset + audio_pilihan written, "auto" / empty BPM left out for the preset; kept on re-run', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS', presets: examplePresets() }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'b', name: 'B' });
    const f = path.join(fx.src, 'mall.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'b' }, actor: 'user' });
    const ref = { media_id: r.media.media_id, version_id: r.version.version_id };
    const s = await prepareEngineJob(fx.ws, validateEngineJob({ project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber:mall', ref }], preset: 'aysilla-beatspot', audio_pilihan: 'vo', beatspot: { durasi: [15, 18] } }));
    const job = JSON.parse(await fsp.readFile(path.join(engineJobDir(fx.ws, 'b', s.job_id), 'job.json'), 'utf8'));
    expect(job).toMatchObject({ preset: 'aysilla-beatspot', audio_pilihan: 'vo', beatspot: { durasi: [15, 18] } });
    expect(job.beatspot).not.toHaveProperty('ketukan_per_potong');
    expect(job.beatspot).not.toHaveProperty('bpm');
    const cfg: EngineConfig = { root: await tempDir(), command: process.execPath, script: FAKE, timeout_ms: 60_000 };
    await runEngineJob(fx.ws, cfg, 'b', s.job_id);
    const again = await rerunBeatspot(fx.ws, 'b', s.job_id, { durasi: [15, 18], ketukan_per_potong: 2 });
    const job2 = JSON.parse(await fsp.readFile(path.join(engineJobDir(fx.ws, 'b', again.job_id), 'job.json'), 'utf8'));
    expect(job2).toMatchObject({ preset: 'aysilla-beatspot', audio_pilihan: 'vo', beatspot: { ketukan_per_potong: 2 } });
  }, 60_000);
});
