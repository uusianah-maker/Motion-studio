import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveKode, exportBrandKit, listBrands, readBrandFor, validateBrandInput } from '../src/storage/brand.js';
import { buildIndex, holdersOf } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { findFont } from '../src/storage/ffmpeg.js';
import { renderPreflight } from '../src/storage/preflight.js';
import { importMedia } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

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

/** The Aysilla example from BRAND-KIT-LENGKAP (A–F). */
const AYSILLA = {
  name: 'Aysilla Factory',
  kode: 'ays',
  handles: { tiktok: '@aysillafactoryid', instagram: '@aysillafactoryid' },
  target: 'Wanita 20–35, kantoran, suka celana yang nggak panas',
  nada: ['santai', 'meyakinkan', 'ceria'],
  bahasa: 'campur',
  produk: [{ nama: 'Loose Pants', varian: ['Espresso', 'Black', 'Ivory'], ukuran: 'M–XL' }],
  colors: ['#ffffff', '#000000'],
  text_color: '#ffffff',
  outline: { color: '#000000', px: 4 },
  warna_dilarang: ['merah', 'kuning', 'biru'],
  gaya: 'Clean minimalis',
  cta: { tiktok: 'Cek keranjang kuning sekarang', instagram: 'Cek link di bio' },
  disclaimer: { teks: 'Warna dapat sedikit berbeda karena cahaya', kapan: 'varian_warna' },
  kosakata: ['Aysilla Factory', 'Loose Pants'],
  kamus: [{ salah: 'Icila Factory', benar: 'Aysilla Factory' }],
  kata_kunci: ['anti kusut', 'flowy'],
  kapital: 'kata_kunci',
  emoji: false,
  guard: { prices: [{ text: '80rb-an', valid_until: '2026-11-30' }], banned: ['paling murah', 'termurah'], banned_level: 'block' },
  klaim_boleh: ['bahan adem', 'anti kusut'],
  area_bebas_teks: ['wajah', 'produk', 'bawah_15', 'kanan_tombol'],
  presets: [
    {
      id: 'aysilla-konversi',
      nama: 'Konversi',
      tujuan: 'Jualan langsung',
      placement: ['tiktok', 'shopee'],
      durasi: { min: 15, target: 20, max: 30 },
      turunan: ['9:16', '3:4', 'cover'],
      babak: [
        { dari: 0, sampai: 3, isi: 'Hook' },
        { dari: 25, sampai: 30, isi: 'CTA' },
      ],
      ritme: 'Ganti shot tiap 2–5 dtk',
      caption: { mode: 'per_kata', maks_kata: 3, pop_ms: 100 },
      hook: { teks: true, maks_kata: 6, dari_ucapan: true },
      efek: { wajib: ['glass type'], boleh: ['digital zoom', 'zoom-through'], jangan: [], maks: 3, jarak_dtk: 4 },
      audio: { suara_asli: true, sfx: 'tiap teks besar & transisi', musik: 'di bawah suara', lufs: -14 },
      qc: ['durasi', 'hook 3 dtk', 'ejaan'],
    },
  ],
};

describe('U1 Brand Kit per brand', () => {
  it('validates the full A–F sheet (kode upper-cased) and refuses junk', async () => {
    const k = validateBrandInput(AYSILLA);
    expect(k).toMatchObject({ kode: 'AYS', bahasa: 'campur', outline: { color: '#000000', px: 4 }, kapital: 'kata_kunci', presets: [{ id: 'aysilla-konversi', durasi: { target: 20 } }] });
    expect(deriveKode('Aysilla Factory')).toBe('AF');
    expect(deriveKode('Lucy')).toBe('LUCY');
    expect(validateBrandInput({ name: 'Toko Aysi', kode: '  ' }).kode).toBe('TA'); // empty field = derive from the name
    for (const bad of [
      { ...AYSILLA, kode: 'A' },
      { ...AYSILLA, kode: 'ays-1' },
      { ...AYSILLA, bahasa: 'jawa' },
      { ...AYSILLA, area_bebas_teks: ['langit'] },
      { ...AYSILLA, handles: { facebook: '@x' } },
      { ...AYSILLA, presets: [{ ...AYSILLA.presets[0], id: 'Konversi Besar' }] },
      { ...AYSILLA, presets: [{ ...AYSILLA.presets[0], durasi: { min: 30, target: 20, max: 15 } }] },
      { ...AYSILLA, presets: [{ ...AYSILLA.presets[0], turunan: ['21:9'] }] },
      { ...AYSILLA, presets: [AYSILLA.presets[0], AYSILLA.presets[0]] },
      { ...AYSILLA, kamus: [{ salah: 'x' }] },
      { ...AYSILLA, owner: 'x' },
    ]) {
      expect(await code(() => validateBrandInput(bad)), JSON.stringify(bad).slice(-60)).toBe('EDIT_INVALID');
    }
  });

  it('several brands: unique kode, default brand, per-project brand, delete only when unused', async () => {
    const { ws } = await fixtureWorkspace();
    const s = new StorageService(ws);
    const ays = (await s.createBrand({ kit: AYSILLA, actor: 'user' })).result;
    const lucy = (await s.createBrand({ kit: { name: 'Lucy Pants', kode: 'LCY', colors: ['#7a1f5c'], text_color: '#ffffff', guard: { banned: ['dijamin'] } }, actor: 'user' })).result;
    expect((await listBrands(ws)).map((b) => b.kode)).toEqual(['AYS', 'LCY']);
    expect(await s.defaultBrandId()).toBe(ays.brand_id); // the first brand becomes the default
    expect(await code(() => s.createBrand({ kit: { name: 'Lain', kode: 'AYS' }, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => s.createBrand({ kit: { name: 'X' }, actor: 'ai' }))).toBe('FORBIDDEN');
    // Update with revision check.
    expect((await s.setBrandKit({ brand_id: lucy.brand_id, expected_revision: 1, kit: { name: 'Lucy Pants', kode: 'LCY', colors: ['#000000'] }, actor: 'user' })).result.revision).toBe(2);
    expect(await code(() => s.setBrandKit({ brand_id: lucy.brand_id, expected_revision: 1, kit: { name: 'Lucy Pants' }, actor: 'user' }))).toBe('CONFLICT');

    // Projects pick a brand; missing/deleted → default.
    await createProject(ws, { project_id: 'p', name: 'P' });
    await s.updateProjectMeta({ project_id: 'p', expected_revision: 0, brand_id: lucy.brand_id, actor: 'user' });
    expect((await readProject(ws, 'p')).brand_id).toBe(lucy.brand_id);
    expect((await readBrandFor(ws, lucy.brand_id)).kode).toBe('LCY');
    expect((await readBrandFor(ws, undefined)).kode).toBe('AYS');
    expect(await code(() => s.updateProjectMeta({ project_id: 'p', expected_revision: 1, brand_id: 'b-nope', actor: 'user' }))).toBe('NOT_FOUND');
    // Duplicates keep the brand.
    expect((await s.duplicateProject({ project_id: 'p', actor: 'user' })).result.brand_id).toBe(lucy.brand_id);

    expect(await code(() => s.deleteBrand({ brand_id: lucy.brand_id, actor: 'user' }))).toBe('PRECONDITION'); // in use
    await s.setDefaultBrand({ brand_id: lucy.brand_id, actor: 'user' });
    expect(await s.defaultBrandId()).toBe(lucy.brand_id);
    await s.setDefaultBrand({ brand_id: ays.brand_id, actor: 'user' });
    const tmp = (await s.createBrand({ kit: { name: 'Sementara', kode: 'TMP' }, actor: 'user' })).result;
    await s.deleteBrand({ brand_id: tmp.brand_id, actor: 'user' });
    expect((await listBrands(ws)).map((b) => b.kode)).toEqual(['AYS', 'LCY']);
  });

  it('the brand guard and render use the PROJECT brand, not the default', async () => {
    const fx = await fixtureWorkspace(); // clock 2026-11-01
    const s = new StorageService(fx.ws);
    const ref = await importShared(fx.ws, fx.src, 'v');
    await s.createBrand({ kit: { name: 'Bebas', kode: 'BBS' }, actor: 'user' }); // default: no rules
    const strict = (await s.createBrand({ kit: { name: 'Ketat', kode: 'KTT', guard: { banned: ['termurah'] } }, actor: 'user' })).result;
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    await s.editTimeline({
      project_id: 'p',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 2000 },
        { op: 'add_clip', track_kind: 'text', text: 'Termurah se-kota', start_ms: 0, duration_ms: 1000 },
      ],
    });
    const pf = () => renderPreflight(fx.ws, { project_id: 'p', output_name: 'x.mp4', estimated_bytes: 1, actor: 'user', disk: { free_bytes: 1e12, total_bytes: 2e12 } });
    expect((await pf()).problems.map((p) => p.code)).not.toContain('BRAND_BLOCKED');
    await s.updateProjectMeta({ project_id: 'p', expected_revision: 1, brand_id: strict.brand_id, actor: 'user' });
    expect((await pf()).problems.map((p) => p.code)).toContain('BRAND_BLOCKED');
  });

  it('migrates the old single kit (X06) into the default brand, once, keeping its data', async () => {
    const fx = await fixtureWorkspace();
    const legacy = path.join(fx.ws.root, '.motionstudio', 'brand_kit.json');
    await fsp.writeFile(legacy, JSON.stringify({ schema_version: 1, revision: 3, updated_at: 5, name: 'Toko Lama', colors: ['#123456'], text_color: '#ffffff', font: null, logo: null, guard: { prices: [], banned: ['dijamin'], banned_level: 'warn' } }));
    const s = new StorageService(fx.ws);
    const k = await s.readBrandKit();
    expect(k).toMatchObject({ brand_id: 'b-utama', name: 'Toko Lama', kode: 'TL', revision: 3, colors: ['#123456'], guard: { banned: ['dijamin'], banned_level: 'warn' } });
    expect(await fsp.access(`${legacy}.migrated`).then(() => true)).toBe(true);
    expect(await fsp.access(legacy).then(() => true, () => false)).toBe(false);
    expect((await listBrands(fx.ws)).length).toBe(1);
  });

  it.skipIf(!hasFfmpeg || !findFont())('files: two fonts + logo + outro are checked, held per brand, exported as placeholders (paths only for the runner)', async () => {
    const fx = await fixtureWorkspace();
    const s = new StorageService(fx.ws);
    const imp = async (file: string) => {
      const r = await importMedia(fx.ws, { sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const png = path.join(fx.src, 'logo.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png], { windowsHide: true });
    const ttf = path.join(fx.src, 'judul.ttf');
    await fsp.copyFile(findFont()!, ttf);
    const ttf2 = path.join(fx.src, 'caption.ttf');
    await fsp.writeFile(ttf2, Buffer.concat([await fsp.readFile(findFont()!), Buffer.from('x')]));
    const mp4 = path.join(fx.src, 'outro.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-c:v', 'libx264', mp4], { windowsHide: true });
    const [logo, font, fontCap, outro] = [await imp(png), await imp(ttf), await imp(ttf2), await imp(mp4)];
    const kit = { ...AYSILLA, font, font_caption: fontCap, logo: { ref: logo, corner: 'tr', size: 25, opacity: 1, show: 'sepanjang+penutup' }, outro: { ref: outro, detik: 2.5 } };
    const b = (await s.createBrand({ kit, actor: 'user' })).result;
    expect(await code(() => s.createBrand({ kit: { name: 'Salah', kode: 'SLH', font_caption: logo }, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => s.createBrand({ kit: { name: 'Salah', kode: 'SLH', outro: { ref: font, detik: 2 } }, actor: 'user' }))).toBe('EDIT_INVALID');

    const idx = await buildIndex(fx.ws);
    if (!idx.ok) throw new Error(idx.errors.join());
    expect(holdersOf(idx.index, fontCap.version_id)).toEqual([{ kind: 'brand', brand_id: b.brand_id, slot: 'font_caption' }]);
    expect(holdersOf(idx.index, outro.version_id)).toEqual([{ kind: 'brand', brand_id: b.brand_id, slot: 'outro' }]);

    const pub = await exportBrandKit(fx.ws, b.brand_id, { paths: false });
    expect(pub).toMatchObject({
      schema: 'brand-kit-export/1',
      brand: { nama: 'Aysilla Factory', kode: 'AYS', handle: { tiktok: '@aysillafactoryid' }, bahasa: 'campur' },
      visual: { font_judul: '$font:judul', font_caption: '$font:caption', logo: { aset: '$logo', pojok: 'tr', tampil: 'sepanjang+penutup' }, penutup: { aset: '$penutup', detik: 2.5 }, outline: { warna: '#000000', px: 4 } },
      teks: { kamus: { 'Icila Factory': 'Aysilla Factory' }, kapital: 'kata_kunci' },
      aturan: { terlarang: ['paling murah', 'termurah'], level: 'block', harga: [{ teks: '80rb-an', berlaku_sampai: '2026-11-30' }], area_bebas_teks: ['wajah', 'produk', 'bawah_15', 'kanan_tombol'] },
      preset: { 'aysilla-konversi': { durasi: { min: 15, target: 20, max: 30 } } },
    });
    expect(JSON.stringify(pub)).not.toMatch(/[A-Za-z]:[\\/]|\/tmp|"path"/);
    const runner = await exportBrandKit(fx.ws, b.brand_id, { paths: true });
    const assets = runner.aset as { kunci: string; path: string }[];
    expect(assets.map((a) => a.kunci)).toEqual(['$font:judul', '$font:caption', '$logo', '$penutup']);
    for (const a of assets) expect(await fsp.access(a.path).then(() => true)).toBe(true);
  });
});
