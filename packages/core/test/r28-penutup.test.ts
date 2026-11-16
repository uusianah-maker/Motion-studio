import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineJobDir, prepareEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R28 (owner): "Video penutup" per job di Buat video — dari Aset / unggah baru / tanpa. Pilihan
 * masuk ke salinan brand_kit.json job itu (`visual.penutup` + `$penutup`), kontrak mesin tetap.
 */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : 'RAW';
  }
};
const brief = { produk: 'X', varian: '', harga: '', placement: 'tiktok', catatan: '' };
const S = [{ kunci: '$sumber', ref: { media_id: 'm_1', version_id: 'v_1' } }];

describe('R28 video penutup per job', () => {
  it('validates the choice: a ref, null (tanpa) or absent (brand default)', () => {
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false, penutup: null }).penutup).toBeNull();
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false })).not.toHaveProperty('penutup');
    expect(validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false, penutup: { ref: S[0]!.ref } }).penutup).toEqual({ ref: S[0]!.ref });
    for (const bad of ['x', { ref: { media_id: '../a', version_id: 'v' } }, { ref: S[0]!.ref, detik: 3 }]) expect(code(() => validateEngineJob({ project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false, penutup: bad })), JSON.stringify(bad)).toBe('EDIT_INVALID');
  });

  it("brand_kit.json of the job: brand default / chosen file / none — never in job.json", async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[], scope: { kind: 'shared' } | { kind: 'project'; project_id: string }) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    await createProject(fx.ws, { project_id: 'g', name: 'G' });
    const src = await gen('bicara.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], { kind: 'project', project_id: 'g' });
    const outroA = await gen('penutup-a.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], { kind: 'shared' });
    const outroB = await gen('penutup-b.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], { kind: 'shared' });
    await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS', outro: { ref: outroA, detik: 3 }, aset: [{ id: 'penutup-b', ref: outroB, jenis: 'penutup', nama: 'B' }] }, actor: 'user' });
    const run = async (extra: Record<string, unknown>) => {
      const s = await prepareEngineJob(fx.ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: src }], preset: 'p', brief, ai: false, ...extra }));
      const dir = engineJobDir(fx.ws, 'g', s.job_id);
      const read = async (f: string) => JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      return { kit: await read('brand_kit.json'), refs: (await read('refs.json')).refs, job: await read('job.json') };
    };
    const asetPenutup = (k: { aset: { kunci: string; path?: string }[] }) => k.aset.filter((a) => a.kunci === '$penutup');

    const def = await run({});
    expect(def.kit.visual.penutup).toEqual({ aset: '$penutup', detik: 3 });
    expect(def.refs.$penutup).toEqual(outroA);

    const chosen = await run({ penutup: { ref: outroB } });
    expect(chosen.kit.visual.penutup).toEqual({ aset: '$penutup', detik: 3 });
    expect(asetPenutup(chosen.kit)).toHaveLength(1);
    expect(asetPenutup(chosen.kit)[0]!.path).toMatch(/penutup-b\.mp4$|\.mp4$/);
    expect(chosen.refs.$penutup).toEqual(outroB);
    expect(chosen.job).not.toHaveProperty('penutup');

    const none = await run({ penutup: null });
    expect(none.kit.visual.penutup).toEqual({ aset: null, detik: 3 });
    expect(asetPenutup(none.kit)).toHaveLength(0);
    expect(none.refs).not.toHaveProperty('$penutup');

    await expect(run({ penutup: { ref: { media_id: 'm_x', version_id: 'v_x' } } })).rejects.toMatchObject({ code: 'EDIT_INVALID' });
  }, 60_000);
});
