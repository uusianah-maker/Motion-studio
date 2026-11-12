import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBrandKit, orientationOf, validateBrandInput } from '../src/storage/brand.js';
import { buildIndex, holdersOf } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { importMedia } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { fixtureWorkspace } from './fixtures.js';

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
const R = { media_id: 'm_1', version_id: 'v_1' };
const base = { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: ['Espresso'] }] };
const sfx = { id: 'pop-01', ref: R, jenis: 'sfx', tag: ['Teks-Muncul', 'pop'], lisensi: { status: 'milik_sendiri', iklan: true } };

describe('U2 asset library per brand', () => {
  it('validates assets: ids, kinds, tags (lower-case), licence rules for ads, product link', async () => {
    const k = validateBrandInput({ ...base, aset: [sfx], sfx_dilarang: ['kaget'], referensi: [{ link: 'https://www.tiktok.com/@x/video/1', tiru: 'hook cepat', jangan: 'musik keras' }] });
    expect(k.aset[0]).toMatchObject({ id: 'pop-01', jenis: 'sfx', tag: ['teks-muncul', 'pop'], lisensi: { status: 'milik_sendiri', iklan: true, bukti: '' }, instrumental: null, ada_teks_bawaan: false });
    expect(k.referensi[0]!.tiru).toBe('hook cepat');
    const bad = [
      { aset: [{ ...sfx, id: 'Pop 01' }] },
      { aset: [sfx, sfx] }, // duplicate id
      { aset: [{ ...sfx, jenis: 'video' }] },
      { aset: [{ ...sfx, lisensi: { status: 'tanpa_lisensi', iklan: true } }] }, // no licence → not for ads
      { aset: [{ ...sfx, lisensi: { status: 'belum_dicek', iklan: true } }] },
      { aset: [{ ...sfx, jenis: 'musik', lisensi: { status: 'berlisensi', iklan: true } }] }, // licensed music needs proof
      { aset: [{ ...sfx, jenis: 'musik', instrumental: false, lisensi: { status: 'milik_sendiri', iklan: true } }] }, // lyrics
      { aset: [{ ...sfx, jenis: 'broll', produk: 'Kulot' }] }, // unknown product
      { referensi: [{ link: 'tiktok.com/x' }] },
      { aset: [{ ...sfx, owner: 1 }] },
    ];
    for (const b of bad) expect(await code(() => validateBrandInput({ ...base, ...b })), JSON.stringify(b).slice(0, 80)).toBe('EDIT_INVALID');
    // Unlicensed music is allowed in the library, just never for ads.
    expect(validateBrandInput({ ...base, aset: [{ ...sfx, jenis: 'musik', lisensi: { status: 'tanpa_lisensi', iklan: false } }] }).aset[0]!.lisensi.iklan).toBe(false);
    expect([orientationOf(1080, 1920), orientationOf(1080, 1350), orientationOf(1000, 1000), orientationOf(1920, 1080), orientationOf(1000, 1300)]).toEqual(['9:16', 'lainnya', '1:1', '16:9', '3:4']);
  });

  it.skipIf(!hasFfmpeg)('real files: kinds checked, held by the brand, exported with duration/orientation/licence (paths only for the runner)', async () => {
    const fx = await fixtureWorkspace();
    const s = new StorageService(fx.ws);
    const imp = async (name: string, args: string[]) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await importMedia(fx.ws, { sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const pop = await imp('pop.wav', ['-f', 'lavfi', '-i', 'sine=f=900:d=0.25']);
    const song = await imp('ceria.mp3', ['-f', 'lavfi', '-i', 'sine=f=300:d=2']);
    const broll = await imp('detail.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=180x320:d=1', '-c:v', 'libx264']);
    const kit = {
      ...base,
      aset: [
        { id: 'pop-01', ref: pop, jenis: 'sfx', tag: ['teks-muncul'], lisensi: { status: 'milik_sendiri', iklan: true } },
        { id: 'ceria-01', ref: song, jenis: 'musik', tag: ['ceria'], mood: 'ceria', bpm: 120, instrumental: true, lisensi: { status: 'berlisensi', bukti: 'Epidemic Sound #123', iklan: true } },
        { id: 'detail-bahan', ref: broll, jenis: 'broll', tag: ['detail-bahan'], produk: 'Loose Pants', varian: 'Espresso', ada_teks_bawaan: true, lisensi: { status: 'milik_sendiri', iklan: true } },
      ],
    };
    const b = (await s.createBrand({ kit, actor: 'user' })).result;
    // A sound file cannot be b-roll.
    expect(await code(() => s.setBrandKit({ brand_id: b.brand_id, expected_revision: 1, kit: { ...kit, aset: [{ ...kit.aset[2], ref: pop }] }, actor: 'user' }))).toBe('EDIT_INVALID');

    const idx = await buildIndex(fx.ws);
    if (!idx.ok) throw new Error(idx.errors.join());
    expect(holdersOf(idx.index, song.version_id)).toEqual([{ kind: 'brand', brand_id: b.brand_id, slot: 'aset' }]);

    const pub = await exportBrandKit(fx.ws, b.brand_id, { paths: false });
    const aset = pub.aset as Record<string, unknown>[];
    expect(aset.map((a) => a.kunci)).toEqual(['$sfx:pop-01', '$musik:ceria-01', '$broll:detail-bahan']);
    expect(aset[0]).toMatchObject({ jenis: 'sfx', tag: ['teks-muncul'], lisensi_iklan: true, orientasi: null });
    expect(Math.abs((aset[0]!.durasi_ms as number) - 250)).toBeLessThan(60);
    expect(aset[1]).toMatchObject({ instrumental: true, mood: 'ceria', bpm: 120, sumber_lisensi: 'Epidemic Sound #123', status_lisensi: 'berlisensi' });
    expect(aset[2]).toMatchObject({ produk: 'Loose Pants', varian: 'Espresso', orientasi: '9:16', ada_teks_bawaan: true, durasi_ms: expect.any(Number) });
    expect(JSON.stringify(pub)).not.toMatch(/"path"/);
    const runner = await exportBrandKit(fx.ws, b.brand_id, { paths: true });
    expect((runner.aset as { path: string }[]).every((a) => typeof a.path === 'string' && a.path.length > 3)).toBe(true);
  });
});
