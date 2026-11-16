import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rerunBeatspot } from '../src/storage/beatspot.js';
import { engineJobDir, prepareEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { StorageService } from '../src/storage/service.js';
import { LAYOUT, createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R37 (KONTRAK-ENGINE §22): "VO dari Library" — a brand VO (jenis `vo`, "Suara dari Teks") is the
 * main voice of Generate / Batch / Beat Spot. job.json `vo`, `<job>/vo_index.json` copied from
 * `.motionstudio/vo/<version>.json`, VO must be a brand asset (it travels in brand_kit.json).
 */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? `${e.code}:${e.message}` : 'RAW';
  }
};
const S = [{ kunci: '$sumber', ref: { media_id: 'm_1', version_id: 'v_1' } }];
const brief = { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' };
const base = { project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief, ai: false };

describe('R37 VO dari Library', () => {
  it('validates the choice; refuses "musik" with a VO (engine §22.1)', () => {
    expect(validateEngineJob({ ...base, vo: { aset: 'vo-ays-1' } }).vo).toEqual({ aset: 'vo-ays-1', suara_footage: 'mati', subtitle: true });
    expect(validateEngineJob({ ...base, vo: { aset: 'vo-ays-1', suara_footage: 'pelan', subtitle: false } }).vo).toEqual({ aset: 'vo-ays-1', suara_footage: 'pelan', subtitle: false });
    expect(validateEngineJob({ ...base, audio_pilihan: 'keduanya', vo: { aset: 'vo-ays-1' } }).vo?.aset).toBe('vo-ays-1');
    expect(validateEngineJob({ ...base, vo: null })).not.toHaveProperty('vo');
    for (const bad of [{ aset: '../x' }, { aset: 'a', suara_footage: 'keras' }, { aset: 'a', subtitle: 'ya' }, { aset: 'a', media: 'x' }, 'vo']) expect(code(() => validateEngineJob({ ...base, vo: bad })), JSON.stringify(bad)).toMatch(/^EDIT_INVALID/);
    expect(code(() => validateEngineJob({ ...base, audio_pilihan: 'musik', vo: { aset: 'a' } }))).toMatch(/musik saja/);
    expect(validateEngineJob({ project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: S[0]!.ref }], vo: { aset: 'vo-1', suara_footage: 'asli' } }).vo?.suara_footage).toBe('asli');
  });

  it('job folder: vo in job.json, index copied, VO in sumber (Generate) + brand_kit.json; clear refusals', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[], scope: { kind: 'shared' } | { kind: 'project'; project_id: string }) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    await createProject(fx.ws, { project_id: 'g', name: 'G' });
    const foot = await gen('footage.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], { kind: 'project', project_id: 'g' });
    const vo = await gen('vo.wav', ['-f', 'lavfi', '-i', 'sine=f=200:d=3'], { kind: 'shared' });
    const plain = await gen('vo-polos.wav', ['-f', 'lavfi', '-i', 'sine=f=300:d=2'], { kind: 'shared' });
    const index = { schema: 'vo-index/1', job_id: 'AYS-20261116-001', teks: 'Halo kak. Diskon hari ini.', kalimat: [{ teks: 'Halo kak.', mulai: 0, akhir: 1.2, kata: [{ teks: 'Halo', mulai: 0, akhir: 0.5 }, { teks: 'kak.', mulai: 0.5, akhir: 1.2 }] }, { teks: 'Diskon hari ini.', mulai: 1.5, akhir: 2.9, kata: [] }] };
    await fsp.mkdir(path.join(fx.ws.root, LAYOUT.meta, 'vo'), { recursive: true });
    await fsp.writeFile(path.join(fx.ws.root, LAYOUT.meta, 'vo', `${vo.version_id}.json`), JSON.stringify(index));
    const asset = (id: string, ref: typeof vo, jenis = 'vo') => ({ id, ref, jenis, nama: id, tag: ['vo'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true } });
    await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS', aset: [asset('vo-ays-1', vo), asset('vo-polos', plain), asset('bukan-vo', plain, 'sfx')] }, actor: 'user' });
    const prep = (extra: Record<string, unknown>) => prepareEngineJob(fx.ws, validateEngineJob({ ...base, sources: [{ kunci: '$sumber', ref: foot }], ...extra }));
    const read = async (jobId: string, f: string) => JSON.parse(await fsp.readFile(path.join(engineJobDir(fx.ws, 'g', jobId), f), 'utf8'));

    const s = await prep({ vo: { aset: 'vo-ays-1', suara_footage: 'pelan' } });
    const job = await read(s.job_id, 'job.json');
    expect(job.vo).toEqual({ media: '$vo:vo-ays-1', index: 'vo_index.json', suara_footage: 'pelan', subtitle: true });
    expect(job.sumber.map((x: { kunci: string }) => x.kunci)).toEqual(['$sumber', '$vo:vo-ays-1']);
    expect(await read(s.job_id, 'vo_index.json')).toEqual(index);
    expect((await read(s.job_id, 'brand_kit.json')).aset.some((a: { kunci: string; jenis: string; path?: string }) => a.kunci === '$vo:vo-ays-1' && a.jenis === 'vo' && !!a.path)).toBe(true);
    expect((await read(s.job_id, 'refs.json')).refs['$vo:vo-ays-1']).toEqual(vo);

    // Without vo: nothing new in the job.
    const s0 = await prep({});
    expect(await read(s0.job_id, 'job.json')).not.toHaveProperty('vo');
    await expect(fsp.access(path.join(engineJobDir(fx.ws, 'g', s0.job_id), 'vo_index.json'))).rejects.toThrow();

    await expect(prep({ vo: { aset: 'vo-lain' } })).rejects.toMatchObject({ code: 'EDIT_INVALID', message: expect.stringMatching(/belum terdaftar sebagai aset brand/) });
    await expect(prep({ vo: { aset: 'bukan-vo' } })).rejects.toMatchObject({ message: expect.stringMatching(/bukan VO/) });
    await expect(prep({ vo: { aset: 'vo-polos' } })).rejects.toMatchObject({ message: expect.stringMatching(/tidak punya teks & waktu kalimat/) });

    // Beat Spot: VO not in sumber (never mistaken for the sound), kept on a re-run.
    const b = await prepareEngineJob(fx.ws, validateEngineJob({ project_id: 'g', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: foot }], vo: { aset: 'vo-ays-1' } }));
    const bj = await read(b.job_id, 'job.json');
    expect(bj.vo.media).toBe('$vo:vo-ays-1');
    expect(bj.sumber.map((x: { kunci: string }) => x.kunci)).toEqual(['$sumber:a']);
    const again = await rerunBeatspot(fx.ws, 'g', b.job_id, { durasi: [15, 18] });
    expect((await read(again.job_id, 'job.json')).vo).toEqual(bj.vo);
    expect(await read(again.job_id, 'vo_index.json')).toEqual(index);
  }, 60_000);
});
