import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBrandKit, libraryFor, validateBrandInput } from '../src/storage/brand.js';
import { findFont } from '../src/storage/ffmpeg.js';
import { applyLut, lutMatrix, parseCube } from '../src/storage/lut.js';
import { clipRefs, validateProjectManifest } from '../src/storage/project.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { fontOfRef, fontRef, validateStyle } from '../src/storage/textStyle.js';
import { applyOps, editManifest, timelineMedia, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R38a (owner: "add aset: audio, transisi, efek, font — SEMUA jenis, dari luar"): new library kinds
 * (video efek, transisi, LUT, font, preset teks), "semua brand" scope, Aset fonts in texts (render +
 * held/leased), LUT data + validation.
 */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cube = (size: number, f: (r: number, g: number, b: number) => [number, number, number]) => {
  const lines = ['TITLE "uji"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
};
const err = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe('R38a LUT (.cube)', () => {
  it('parses, applies trilinear, fits a matrix; refuses broken files', () => {
    const inv = parseCube(cube(5, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    expect(inv.size).toBe(5);
    expect(applyLut(inv, 0.25, 0.5, 1).map((v) => +v.toFixed(3))).toEqual([0.75, 0.5, 0]);
    const m = lutMatrix(inv);
    expect(m[0]!.map((v) => Math.round(v))).toEqual([-1, 0, 0, 1]);
    // A curve is only approximated by the matrix (preview), exactly by applyLut (swatch / lut3d).
    const curve = parseCube(cube(9, (r, g, b) => [r * r, g * g, b * b]));
    expect(applyLut(curve, 0.5, 0.5, 0.5)[0]).toBeCloseTo(0.25, 2);
    expect(err(() => parseCube('LUT_3D_SIZE 3\n0 0 0\n'))).toMatch(/isi LUT harus 27 warna/);
    expect(err(() => parseCube('LUT_1D_SIZE 16\n'))).toMatch(/1D/);
    expect(err(() => parseCube('halo'))).toMatch(/LUT_3D_SIZE/);
  });
});

describe('R38a font Aset di gaya teks', () => {
  it('style font = ref:<media>/<version>; held by the project (GC, undo); bad refs refused', () => {
    const F = { media_id: 'm_f', version_id: 'v_f' };
    expect(fontRef(fontOfRef(F))).toEqual(F);
    expect(validateStyle({ font: 'ref:m_f/v_f' }, 's').font).toBe('ref:m_f/v_f');
    expect(err(() => validateStyle({ font: 'ref:../x' }, 's'))).toMatch(/font harus/);
    const V = { media_id: 'm_v', version_id: 'v_v' };
    const L = { media_id: 'm_l', version_id: 'v_l' };
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000, lut: L },
      { op: 'add_clip', track_kind: 'text', text: 'Halo', style: { font: fontOfRef(F) }, start_ms: 0, duration_ms: 1000 },
    ]), () => `c_${Math.random().toString(36).slice(2, 8)}`);
    const refs = t.tracks.flatMap((tr) => tr.clips.flatMap((c) => clipRefs(c))).map((r) => r.version_id).sort();
    expect(refs).toEqual(['v_f', 'v_l', 'v_v']);
    expect(timelineMedia(t).map((r) => r.version_id).sort()).toEqual(['v_f', 'v_l', 'v_v']);
    const m = editManifest({ schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, timeline: t, snapshots: [] }, validateOps([{ op: 'set_picture', clip_id: t.tracks[0]!.clips[0]!.clip_id, lut: null }]), 'x', { now: 2, newId: () => 's_1', newClipId: () => 'c_x' });
    expect(m.timeline.tracks[0]!.clips[0]!.lut).toBeUndefined();
    expect(validateProjectManifest(JSON.parse(JSON.stringify(m))).snapshots[0]!.media.map((r) => r.version_id).sort()).toEqual(['v_f', 'v_l', 'v_v']);
  });
});

describe('R38a Brand Kit: jenis aset baru, preset teks, semua brand', () => {
  it('validates the new fields (older kits = empty)', () => {
    const k = validateBrandInput({ name: 'A' });
    expect([k.preset_teks, k.lut_bawaan]).toEqual([[], null]);
    const p = validateBrandInput({ name: 'A', preset_teks: [{ id: 'cta-kuning', nama: 'CTA kuning', track: 'text', teks: 'Cek keranjang!', durasi_ms: 2500, style: { size: 6, bg: '#ffd23f' }, tag: ['CTA'], semua_brand: true }] }).preset_teks[0]!;
    expect(p).toMatchObject({ id: 'cta-kuning', tag: ['cta'], semua_brand: true, style: { size: 6, bg: '#ffd23f' } });
    expect(err(() => validateBrandInput({ name: 'A', preset_teks: [{ id: 'x', nama: 'X', teks: 'a', style: { size: 999 } }] }))).toMatch(/size/);
    expect(err(() => validateBrandInput({ name: 'A', preset_teks: [{ id: 'x', nama: 'X', teks: 'a' }, { id: 'x', nama: 'Y', teks: 'b' }] }))).toMatch(/dobel/);
  });

  it('files must match their kind; shared library across brands; export as `lainnya` + tag', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const imp = async (name: string, content: Buffer | string) => {
      const f = path.join(fx.src, name);
      await fsp.writeFile(f, content);
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const fontFile = findFont();
    const FONT = fontFile ? await imp(`huruf${path.extname(fontFile)}`, await fsp.readFile(fontFile)) : await imp('huruf.ttf', Buffer.from([0, 1, 0, 0, 0, 0]));
    const LUT = await imp('hangat.cube', cube(3, (r, g, b) => [Math.min(1, r * 1.1), g, b * 0.9]));
    const BAD_LUT = await imp('rusak.cube', 'LUT_3D_SIZE 3\n0 0 0\n');
    const FAKE_FONT = await imp('palsu.ttf', 'bukan font');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64:d=0.5', '-c:v', 'libvpx-vp9', path.join(fx.src, 'leak.webm')], { windowsHide: true });
    const LEAK = { media_id: '', version_id: '' };
    {
      const r = await svc.importMedia({ sourcePath: path.join(fx.src, 'leak.webm'), scope: { kind: 'shared' }, actor: 'user' });
      Object.assign(LEAK, { media_id: r.media.media_id, version_id: r.version.version_id });
    }
    const a = (id: string, ref: typeof LUT, jenis: string, extra: Record<string, unknown> = {}) => ({ id, ref, jenis, nama: id, tag: ['uji'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true }, ...extra });
    const create = (aset: unknown[], extra: Record<string, unknown> = {}) => svc.createBrand({ kit: { name: 'Merek', kode: 'MRK', aset, ...extra }, actor: 'user' });
    await expect(create([a('lut-rusak', BAD_LUT, 'lut')])).rejects.toMatchObject({ message: expect.stringMatching(/isi LUT harus 27 warna/) });
    await expect(create([a('font-palsu', FAKE_FONT, 'font')])).rejects.toMatchObject({ message: expect.stringMatching(/font harus file .ttf atau .otf yang sah/) });
    await expect(create([a('efek-salah', LUT, 'video_efek')])).rejects.toMatchObject({ message: expect.stringMatching(/video efek harus video/) });
    await expect(create([], { lut_bawaan: BAD_LUT })).rejects.toMatchObject({ message: expect.stringMatching(/LUT bawaan/) });
    const one = (await svc.createBrand({ kit: { name: 'Satu', kode: 'SAT', aset: [a('hangat', LUT, 'lut', { semua_brand: true }), a('leak', LEAK, 'video_efek'), ...(fontFile ? [a('huruf', FONT, 'font', { semua_brand: true })] : [])], lut_bawaan: LUT, preset_teks: [{ id: 'cta-a', nama: 'CTA A', teks: 'Beli', semua_brand: true }] }, actor: 'user' })).result;
    const two = (await svc.createBrand({ kit: { name: 'Dua', kode: 'DUA', aset: [a('hangat', LEAK, 'video_efek')] }, actor: 'user' })).result;
    const lib = await libraryFor(fx.ws, two.brand_id);
    // Own "hangat" wins over the shared one; the shared font + preset come with their brand name.
    expect(lib.aset.map((x) => `${x.id}:${x.jenis}:${x.dari ?? '-'}`)).toEqual(['hangat:video_efek:-', ...(fontFile ? ['huruf:font:Satu'] : [])]);
    expect(lib.preset_teks.map((p) => `${p.id}:${p.dari}`)).toEqual(['cta-a:Satu']);
    const ex = await exportBrandKit(fx.ws, one.brand_id, { paths: false });
    const byKey = Object.fromEntries((ex.aset as { kunci: string; jenis: string; tag: string[] }[]).map((x) => [x.kunci, x]));
    expect(byKey['$lainnya:hangat']).toMatchObject({ jenis: 'lainnya', tag: ['lut', 'uji'] });
    expect(byKey['$lainnya:leak']).toMatchObject({ jenis: 'lainnya', tag: ['video_efek', 'uji'] });
  }, 60_000);
});

describe.skipIf(!hasFfmpeg || !findFont())('R38a render nyata: teks dengan font Aset', () => {
  it('drawtext + libass use the uploaded font file (copied into the job, leased); a clip LUT is leased and never probed as video', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const src = findFont()!;
    const fontF = path.join(fx.src, `brand-baru${path.extname(src)}`);
    await fsp.copyFile(src, fontF);
    const fr = await svc.importMedia({ sourcePath: fontF, scope: { kind: 'shared' }, actor: 'user' });
    const F = { media_id: fr.media.media_id, version_id: fr.version.version_id };
    const vf = path.join(fx.src, 'v.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vf], { windowsHide: true });
    const vr = await svc.importMedia({ sourcePath: vf, scope: { kind: 'shared' }, actor: 'user' });
    const lf = path.join(fx.src, 'hangat.cube');
    await fsp.writeFile(lf, cube(3, (r, g, b) => [r, g, b * 0.8]));
    const lr = await svc.importMedia({ sourcePath: lf, scope: { kind: 'shared' }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'f', name: 'F' });
    await svc.editTimeline({
      project_id: 'f',
      expected_revision: 0,
      actor: 'user',
      ops: validateOps([
        { op: 'add_clip', track_kind: 'video', media: { media_id: vr.media.media_id, version_id: vr.version.version_id }, start_ms: 0, duration_ms: 1000, lut: { media_id: lr.media.media_id, version_id: lr.version.version_id } },
        { op: 'add_clip', track_kind: 'text', text: 'HALO', style: { font: fontOfRef(F), size: 12, color: '#ffffff' }, start_ms: 0, duration_ms: 1000 },
        { op: 'add_clip', track_kind: 'subtitle', text: 'kata demi kata', words: [{ text: 'kata', start_ms: 0, end_ms: 300 }, { text: 'demi', start_ms: 300, end_ms: 600 }, { text: 'kata', start_ms: 600, end_ms: 1000 }], style: { font: fontOfRef(F) }, start_ms: 0, duration_ms: 1000 },
      ]),
    });
    const res = await renderProject(fx.ws, { project_id: 'f', output_name: 'f.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    expect((await listOutputs(fx.ws, 'f')).length).toBe(1);
  }, 60_000);
});
