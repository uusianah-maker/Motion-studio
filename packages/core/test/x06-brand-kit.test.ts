import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_BRAND, brandRenderRefs, validateBrandInput } from '../src/storage/brand.js';
import { checkPlan, planLocal } from '../src/storage/copilot.js';
import { buildIndex, holdersOf } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { findFont } from '../src/storage/ffmpeg.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { importMedia } from '../src/storage/registry.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
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
const sysFont = findFont();
const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const KIT = { name: 'Aysilla', colors: ['#7a1f5c', '#f4d35e'], text_color: '#ffffff', font: null, logo: null };

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const imp = async (file: string, name: string) => {
    const r = await importMedia(fx.ws, { sourcePath: file, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  return { ...fx, svc, imp };
}

describe('X06 Brand Kit', () => {
  it('validates the kit: colours, names, logo placement; unknown fields refused', async () => {
    expect(validateBrandInput({ ...KIT, colors: ['#FF0000'], name: '  Toko\nKu ' })).toMatchObject({ name: 'Toko Ku', colors: ['#ff0000'] });
    const bad = [
      { ...KIT, colors: ['merah'] },
      { ...KIT, colors: Array(7).fill('#000000').map((c, i) => `#00000${i}`) },
      { ...KIT, colors: ['#000000', '#000000'] },
      { ...KIT, name: '' },
      { ...KIT, text_color: 'putih' },
      { ...KIT, logo: { ref: { media_id: 'm_1', version_id: 'v_1' }, corner: 'middle', size: 10, opacity: 1 } },
      { ...KIT, logo: { ref: { media_id: 'm_1', version_id: 'v_1' }, corner: 'tr', size: 90, opacity: 1 } },
      { ...KIT, font: { media_id: '../x', version_id: 'v_1' } },
      { ...KIT, owner: 'x' },
    ];
    for (const b of bad) expect(await code(() => validateBrandInput(b)), JSON.stringify(b).slice(0, 80)).toBe('EDIT_INVALID');
  });

  it.skipIf(!hasFfmpeg || !sysFont)('save: revision check, font must be a real .ttf/.otf, logo must be an image; kit holds them (never trashed)', async () => {
    const { ws, svc, src, imp } = await setup();
    expect((await svc.readBrandKit()).revision).toBe(0);
    const png = path.join(src, 'logo.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png], { windowsHide: true });
    const logo = await imp(png, 'logo.png');
    const ttf = path.join(src, 'brand.ttf');
    await fsp.copyFile(sysFont!.replace(/bd\.ttf$/i, '.ttf'), ttf).catch(() => fsp.copyFile(sysFont!, ttf));
    const font = await imp(ttf, 'brand.ttf');
    const fake = path.join(src, 'palsu.ttf');
    await fsp.writeFile(fake, 'bukan font');
    const fakeFont = await imp(fake, 'palsu.ttf');

    const r = await svc.setBrandKit({ expected_revision: 0, kit: { ...KIT, font, logo: { ref: logo, corner: 'tr', size: 18, opacity: 0.9 } }, actor: 'user' });
    expect(r.result).toMatchObject({ revision: 1, font, logo: { corner: 'tr' } });
    expect(await code(() => svc.setBrandKit({ expected_revision: 0, kit: KIT, actor: 'user' }))).toBe('CONFLICT');
    expect(await code(() => svc.setBrandKit({ expected_revision: 1, kit: { ...KIT, font: fakeFont }, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.setBrandKit({ expected_revision: 1, kit: { ...KIT, logo: { ref: font, corner: 'tl', size: 10, opacity: 1 } }, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.setBrandKit({ expected_revision: 1, kit: KIT, actor: 'ai' }))).toBe('FORBIDDEN');
    const idx = await buildIndex(ws);
    if (!idx.ok) throw new Error(idx.errors.join());
    expect(holdersOf(idx.index, logo.version_id)).toEqual([{ kind: 'brand', brand_id: expect.any(String), slot: 'logo' }]);
    expect(holdersOf(idx.index, font.version_id)).toEqual([{ kind: 'brand', brand_id: expect.any(String), slot: 'font' }]);
  });

  it('style font + set_brand_logo op: validated, undoable shape, stored manifest checked', () => {
    let n = 0;
    const t0 = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'text', text: 'Hai', style: { font: 'brand' }, start_ms: 0, duration_ms: 1000 }]), () => `c_${++n}`);
    expect(t0.tracks[0]!.clips[0]!.style).toEqual({ font: 'brand' });
    const t1 = applyOps(t0, validateOps([{ op: 'set_brand_logo', on: true }]), () => 'x');
    expect(t1.brand_logo).toBe(true);
    // Any later edit keeps the logo switch (regression: the timeline clone used to drop it).
    expect(applyOps(t1, [{ op: 'set_canvas', ratio: '1:1' }, { op: 'set_text', clip_id: 'c_1', text: 'Halo' }], () => 'y').brand_logo).toBe(true);
    expect('brand_logo' in applyOps(t1, [{ op: 'set_brand_logo', on: false }], () => 'x')).toBe(false);
    expect(t0.brand_logo).toBeUndefined();
    for (const bad of [{ op: 'set_brand_logo', on: 'ya' }, { op: 'add_clip', track_kind: 'text', text: 'x', style: { font: 'Comic' }, start_ms: 0, duration_ms: 500 }]) {
      expect(() => validateOps([bad])).toThrow();
    }
    const m = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    expect(() => validateProjectManifest({ ...m, timeline: { tracks: [], brand_logo: 'ya' } })).toThrow();
    expect(validateProjectManifest({ ...m, timeline: { tracks: [], brand_logo: true } }).timeline.brand_logo).toBe(true);
    expect(checkPlan(t0, [{ op: 'set_brand_logo', on: true }]).labels).toEqual(['Tampilkan logo brand']);
    expect(checkPlan(t0, [{ op: 'set_brand_logo', on: true }]).diff.map((d) => d.summary)).toEqual(['Logo brand: tampil']);
  });

  it('Copilot brand words use the kit; refuse clearly when the kit is empty', () => {
    const t: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'text', text: 'Promo', start_ms: 0, duration_ms: 2000 }], () => 'c_1');
    const brand = { colors: ['#7a1f5c', '#f4d35e'], text_color: '#ffffff', has_font: true, has_logo: true };
    const run = (p: string, b: typeof brand | null = brand) => {
      const r = planLocal(p, { timeline: t, selected_clip_ids: ['c_1'], ...(b ? { brand: b } : {}) });
      return r.ok ? r.ops : r.message;
    };
    expect(run('pakai brand')).toEqual([{ op: 'set_style', clip_id: 'c_1', style: { bg: '#7a1f5c', bg_opacity: 1, color: '#ffffff', font: 'brand' } }]);
    expect(run('warna brand')).toEqual([{ op: 'set_style', clip_id: 'c_1', style: { color: '#7a1f5c' } }]);
    expect(run('kotak brand')).toEqual([{ op: 'set_style', clip_id: 'c_1', style: { bg: '#7a1f5c', bg_opacity: 1 } }]);
    expect(run('font brand')).toEqual([{ op: 'set_style', clip_id: 'c_1', style: { font: 'brand' } }]);
    expect(run('font bawaan')).toEqual([{ op: 'set_style', clip_id: 'c_1', style: { font: 'default' } }]);
    expect(run('tampilkan logo')).toEqual([{ op: 'set_brand_logo', on: true }]);
    expect(run('sembunyikan logo')).toEqual([{ op: 'set_brand_logo', on: false }]);
    // New text in the brand look.
    const add = planLocal('tambah teks "Halo" detik 3-5 gaya brand', { timeline: t, brand });
    expect(add.ok && add.ops[0]).toMatchObject({ op: 'add_clip', style: { bg: '#7a1f5c', font: 'brand' } });
    // Empty kit.
    const none = { colors: [], text_color: '#ffffff', has_font: false, has_logo: false };
    expect(run('pakai brand', none)).toMatch(/Brand Kit belum punya warna/);
    expect(run('font brand', none)).toMatch(/Brand Kit belum punya font/);
    expect(run('tampilkan logo', none)).toMatch(/Brand Kit belum punya logo/);
    expect(run('pakai brand', null)).toMatch(/Brand Kit belum punya warna/);
  });

  it('render plan: brand font file for brand-styled text, logo overlay in the chosen corner', () => {
    const t: Timeline = {
      brand_logo: true,
      tracks: [
        { track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 1000, media: { media_id: 'm_1', version_id: 'v_1' } }] },
        {
          track_id: 't',
          kind: 'text',
          clips: [
            { clip_id: 'b', start_ms: 0, end_ms: 1000, text: 'Brand', style: { font: 'brand' } },
            { clip_id: 'c', start_ms: 0, end_ms: 1000, text: 'Biasa', style: { y: 0.6 } },
          ],
        },
      ],
    };
    const inputs = new Map([['v_1', { path: 'C:/s.mp4', probe: { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' } }]]);
    const plan = buildRenderPlan(t, inputs, { ...DEFAULT_RENDER, short_side: 360 }, 'C:/f/arialbd.ttf', 'C:/f/arial.ttf', { font: 'brand.otf', logo: { path: 'C:/x/logo.png', corner: 'bl', size: 20, opacity: 0.8 } });
    const [a, b] = plan.graph.split('drawtext=').slice(1);
    expect(a).toContain('fontfile=fontk.otf');
    expect(b).toContain('fontfile=fontb.ttf');
    expect(plan.args).toEqual(expect.arrayContaining(['-loop', '1', '-i', 'C:/x/logo.png']));
    expect(plan.graph).toContain('scale=72:-2,format=rgba,colorchannelmixer=aa=0.80');
    expect(plan.graph).toContain('overlay=x=14:y=H-h-14');
    // Kit without a font: brand-styled text falls back to the default face.
    const noFont = buildRenderPlan(t, inputs, { ...DEFAULT_RENDER, short_side: 360 }, 'C:/f/arialbd.ttf', 'C:/f/arial.ttf');
    expect(noFont.graph).not.toContain('fontk');
    expect(noFont.graph).not.toContain('overlay');
    expect(brandRenderRefs({ tracks: [] }, { ...EMPTY_BRAND, logo: { ref: { media_id: 'm', version_id: 'v' }, corner: 'tl', size: 10, opacity: 1, show: 'sepanjang' } })).toEqual({ font: null, font_caption: null, logo: null, lut: null });
  });

  it.skipIf(!hasFfmpeg || !sysFont)('real render: logo lands in its corner, brand-font text renders, logo + font leased with the clip', async () => {
    const { ws, svc, src, imp } = await setup();
    const grey = path.join(src, 'grey.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', grey], { windowsHide: true });
    const vid = await imp(grey, 'grey.mp4');
    const png = path.join(src, 'logo.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png], { windowsHide: true });
    const logo = await imp(png, 'logo.png');
    const ttf = path.join(src, 'brand.ttf');
    await fsp.copyFile(sysFont!, ttf);
    const font = await imp(ttf, 'brand.ttf');
    await svc.setBrandKit({ expected_revision: 0, kit: { ...KIT, font, logo: { ref: logo, corner: 'tr', size: 25, opacity: 1 } }, actor: 'user' });
    await createProject(ws, { project_id: 'b', name: 'B' });
    await svc.editTimeline({
      project_id: 'b',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: vid, start_ms: 0, duration_ms: 1000 },
        { op: 'add_clip', track_kind: 'text', text: 'HALO', style: { font: 'brand', y: 0.7 }, start_ms: 0, duration_ms: 1000 },
        { op: 'set_brand_logo', on: true },
      ],
    });
    const r = await renderProject(ws, { project_id: 'b', output_name: 'brand.mp4', actor: 'user' }, { settings: { short_side: 240, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    expect(r.preflight.snapshot.map((s) => s.version_id).sort()).toEqual([vid.version_id, logo.version_id, font.version_id].sort());
    const out = path.join(ws.root, (await listOutputs(ws, 'b'))[0]!.rel);
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', 'scale=24:42', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 20 });
    const redIn = (x0: number, x1: number, y0: number, y1: number) => {
      let c = 0;
      for (let y = Math.floor(y0 * 42); y < Math.ceil(y1 * 42); y++)
        for (let x = Math.floor(x0 * 24); x < Math.ceil(x1 * 24); x++) {
          const i = (y * 24 + x) * 3;
          if (raw[i]! > 150 && raw[i + 1]! < 90 && raw[i + 2]! < 90) c++;
        }
      return c;
    };
    expect(redIn(0.6, 1, 0, 0.25)).toBeGreaterThanOrEqual(3); // top-right
    expect(redIn(0, 0.5, 0, 1)).toBe(0); // nowhere on the left
    expect((await readProject(ws, 'b')).timeline.brand_logo).toBe(true);
  }, 90_000);
});
