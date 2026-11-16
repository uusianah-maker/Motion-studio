import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBrandInput } from '../src/storage/brand.js';
import { engineJobDir, prepareEngineJob, readKamusBelajar, validateEngineJob } from '../src/storage/engine.js';
import { learnFile } from '../src/storage/learning.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R36 (owner): Brand → C "Dipelajari dari koreksi editor" — daftar pasangan dari kamusBelajar,
 * "Tambah ke kamus" (kamus tim menang) dan "Abaikan" (kamus_abaikan, dihormati addLearnedKamus).
 */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const kor = (sebelum: string, sesudah: string, at = 1) => JSON.stringify({ jenis: 'koreksi', bagian: 'kata', track: 'subtitle', op: 'set_text', sebelum, sesudah, at });

describe('R36 kamus belajar per brand', () => {
  it('kamus_abaikan: lowercase, unique, optional (older kits)', () => {
    expect(validateBrandInput({ name: 'A' }).kamus_abaikan).toEqual([]);
    expect(validateBrandInput({ name: 'A', kamus_abaikan: ['Cana', 'cana', 'Janganlah'] }).kamus_abaikan).toEqual(['cana', 'janganlah']);
    expect(() => validateBrandInput({ name: 'A', kamus_abaikan: 'cana' })).toThrow(/kamus diabaikan/);
  });

  it('list for the Brand page + next job: kamus wins, ignored words are gone everywhere', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const kit = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' })).result;
    await fsp.mkdir(path.dirname(learnFile(fx.ws, kit.brand_id)), { recursive: true });
    await fsp.writeFile(learnFile(fx.ws, kit.brand_id), [kor('mau punya cana', 'mau punya celana'), kor('Icy Love Factory.', 'Aysilla Factory.'), kor('Janganlah sekarang yuk', 'Join Live sekarang yuk')].join('\n') + '\n');

    const r0 = await readKamusBelajar(fx.ws, kit.brand_id);
    const by = Object.fromEntries(r0.pasangan.map((p) => [p.salah, p]));
    expect(Object.keys(by).sort()).toEqual(['cana', 'icy love', 'janganlah']);
    expect([by.cana!.otomatis, by['icy love']!.otomatis, by.janganlah!.otomatis]).toEqual([true, true, false]);
    expect(r0.abaikan).toEqual([]);

    // "Tambah ke kamus" for janganlah (with the team's own spelling), "Abaikan" for cana.
    await svc.setBrandKit({ brand_id: kit.brand_id, expected_revision: kit.revision, kit: { name: kit.name, kode: kit.kode, kamus: [{ salah: 'janganlah', benar: 'Join Live' }], kamus_abaikan: ['cana'] }, actor: 'user' });
    const r1 = await readKamusBelajar(fx.ws, kit.brand_id);
    expect(r1.pasangan.map((p) => p.salah)).toEqual(['icy love']);
    expect(r1.abaikan).toEqual(['cana']);

    // Next job: the team's pair + the remaining safe pair; the ignored word is not applied.
    await createProject(fx.ws, { project_id: 'g', name: 'G' });
    const f = path.join(fx.src, 'bicara.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    const m = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'g' }, actor: 'user' });
    const s = await prepareEngineJob(fx.ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: { media_id: m.media.media_id, version_id: m.version.version_id } }], preset: 'p', brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' }, ai: false }));
    const exp = JSON.parse(await fsp.readFile(path.join(engineJobDir(fx.ws, 'g', s.job_id), 'brand_kit.json'), 'utf8'));
    expect(exp.teks.kamus).toEqual({ janganlah: 'Join Live', 'icy love': 'Aysilla' });
  }, 60_000);
});
