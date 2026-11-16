import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { OVERLAY_DEFAULT, contentEnd, overlayBox, overlayOrder, validateOverlay } from '../src/storage/overlay.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, editManifest, stepHistory, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R26 (owner): overlay berlapis — beberapa gambar (logo, watermark, stiker, frame) di track
 * overlay dengan urutan lapisan, posisi preset + geser, skala, opasitas, margin, durasi
 * (sepanjang video / detik tertentu). Satu perubahan = satu undo; render = pratinjau (overlayBox).
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
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? `${e.code}:${e.message}` : `RAW:${String(e)}`;
  }
};
let n = 0;
const ids = () => `c_${++n}`;
const V = { media_id: 'm_v', version_id: 'v_v' };
const LOGO = { media_id: 'm_l', version_id: 'v_l' };
const STIKER = { media_id: 'm_s', version_id: 'v_s' };
const BASE = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
const overlays = (t: Timeline) => t.tracks.find((x) => x.kind === 'overlay')?.clips ?? [];
const make = () =>
  applyOps({ tracks: [] }, validateOps([
    { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 4000 },
    { op: 'add_clip', track_kind: 'overlay', media: LOGO, start_ms: 0, duration_ms: 4000, overlay: { ...OVERLAY_DEFAULT, sepanjang: true } },
    { op: 'add_clip', track_kind: 'overlay', media: STIKER, start_ms: 1000, duration_ms: 1000 },
  ]), ids);

describe('R26 overlay: validasi & tata letak', () => {
  it('refuses bad specs and overlays off the overlay track', () => {
    for (const bad of [
      { pos: 'atas', dx: 0, dy: 0, skala: 10, opasitas: 1, margin: 4, layer: 0 },
      { ...OVERLAY_DEFAULT, skala: 1 },
      { ...OVERLAY_DEFAULT, opasitas: 0 },
      { ...OVERLAY_DEFAULT, margin: 30 },
      { ...OVERLAY_DEFAULT, dx: 2 },
      { ...OVERLAY_DEFAULT, layer: 1.5 },
      { ...OVERLAY_DEFAULT, warna: 'merah' },
      { pos: 'tl' },
    ]) expect(code(() => validateOverlay(bad)), JSON.stringify(bad)).toMatch(/^RAW/);
    for (const bad of [
      { op: 'add_clip', track_kind: 'overlay', media: LOGO, start_ms: 0, duration_ms: 500, overlay: { ...OVERLAY_DEFAULT, skala: 300 } },
      { op: 'set_overlay', clip_id: 'a', overlay: {} },
      { op: 'set_overlay', clip_id: 'a', overlay: { opasitas: 2 } },
      { op: 'set_overlay_layer', clip_id: 'a', to: 'atas' },
    ]) expect(code(() => validateOps([bad])), JSON.stringify(bad)).toMatch(/^EDIT_INVALID/);
    expect(code(() => applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'overlay', start_ms: 0, duration_ms: 500 }]), ids))).toMatch(/gambar atau video/);
    expect(code(() => applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'broll', media: LOGO, start_ms: 0, duration_ms: 500, overlay: OVERLAY_DEFAULT }]), ids))).toMatch(/hanya di track overlay/);
  });

  it('box: preset corner + margin + nudge, height from the picture (even pixels)', () => {
    // 1080×1920 canvas, 200×100 picture at 20 % width = 216 wide, 108 high; margin 4 % of 1080 = 43.
    expect(overlayBox({ ...OVERLAY_DEFAULT, pos: 'tl', skala: 20, margin: 4 }, 1080, 1920, 200, 100)).toEqual({ x: 43, y: 43, w: 216, h: 108 });
    expect(overlayBox({ ...OVERLAY_DEFAULT, pos: 'br', skala: 20, margin: 4 }, 1080, 1920, 200, 100)).toEqual({ x: 1080 - 216 - 43, y: 1920 - 108 - 43, w: 216, h: 108 });
    expect(overlayBox({ ...OVERLAY_DEFAULT, pos: 'c', skala: 20, margin: 4, dx: 0.1, dy: -0.05 }, 1080, 1920, 200, 100)).toEqual({ x: 432 + 108, y: 906 - 96, w: 216, h: 108 });
  });

  it('a whole-video overlay never makes the video longer', () => {
    const t = make();
    const longer = applyOps(t, validateOps([{ op: 'trim_clip', clip_id: overlays(t)[0]!.clip_id, edge: 'end', to_ms: 9000 }]), ids);
    expect(contentEnd(longer.tracks)).toBe(4000);
  });
});

describe('R26 overlay: edit, lapisan, undo', () => {
  it('overlays may overlap; new ones go in front; layer moves renumber', () => {
    const t = make();
    const [logo, stiker] = overlays(t);
    expect([logo!.overlay!.layer, stiker!.overlay!.layer]).toEqual([0, 1]);
    expect(overlayOrder(overlays(t)).map((c) => c.media!.version_id)).toEqual(['v_l', 'v_s']);
    const back = applyOps(t, validateOps([{ op: 'set_overlay_layer', clip_id: stiker!.clip_id, to: 'belakang' }]), ids);
    expect(overlayOrder(overlays(back)).map((c) => c.media!.version_id)).toEqual(['v_s', 'v_l']);
    const front = applyOps(back, validateOps([{ op: 'set_overlay_layer', clip_id: stiker!.clip_id, to: 'maju' }]), ids);
    expect(overlayOrder(overlays(front)).map((c) => c.media!.version_id)).toEqual(['v_l', 'v_s']);
    // Other tracks still refuse overlaps.
    expect(code(() => applyOps(t, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 1000, duration_ms: 500 }]), ids))).toMatch(/tumpang tindih/);
  });

  it('set_overlay changes only the given fields; sepanjang can be switched off; split keeps the spec', () => {
    const t = make();
    const logo = overlays(t)[0]!;
    const t1 = applyOps(t, validateOps([{ op: 'set_overlay', clip_id: logo.clip_id, overlay: { pos: 'bl', opasitas: 0.5, sepanjang: false } }]), ids);
    expect(overlays(t1)[0]!.overlay).toEqual({ ...OVERLAY_DEFAULT, pos: 'bl', opasitas: 0.5 });
    const t2 = applyOps(t1, validateOps([{ op: 'split_clip', clip_id: logo.clip_id, at_ms: 2000 }]), ids);
    expect(overlays(t2).filter((c) => c.media!.version_id === 'v_l').map((c) => c.overlay!.pos)).toEqual(['bl', 'bl']);
    expect(code(() => applyOps(t, validateOps([{ op: 'set_overlay', clip_id: t.tracks[0]!.clips[0]!.clip_id, overlay: { pos: 'c' } }]), ids))).toMatch(/Hanya klip overlay/);
  });

  it('one change = one undo; the manifest round-trips and holds the overlay media', () => {
    const m0 = { ...BASE, timeline: make() };
    const logo = overlays(m0.timeline)[0]!;
    const ctx = { now: 2, newId: ids, newClipId: ids };
    const m1 = editManifest(m0, validateOps([{ op: 'set_overlay', clip_id: logo.clip_id, overlay: { skala: 30, margin: 8 } }]), 'Atur overlay', ctx);
    const back = stepHistory(m1, 'undo', ctx);
    expect(overlays(back.timeline)[0]!.overlay!.skala).toBe(OVERLAY_DEFAULT.skala);
    const again = validateProjectManifest(JSON.parse(JSON.stringify(m1)));
    expect(overlays(again.timeline)[0]!.overlay!.skala).toBe(30);
    expect(m1.snapshots.at(-1)!.media.map((x) => x.version_id).sort()).toEqual(['v_l', 'v_s', 'v_v']);
    expect(code(() => validateProjectManifest({ ...m1, timeline: { tracks: [{ track_id: 'overlay', kind: 'overlay', clips: [{ clip_id: 'x', start_ms: 0, end_ms: 500, media: LOGO }] }] } }))).toMatch(/overlay/);
  });
});

describe('R26 rencana render', () => {
  it('pictures are looped, drawn back to front over the text, the brand logo last', () => {
    const t = make();
    const probe = { duration_ms: 4000, width: 180, height: 320, video_codec: 'h264', audio_codec: null };
    const plan = buildRenderPlan(t, new Map([['v_v', { path: 'v.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 180 }, null, null, {
      font: null,
      logo: { path: 'brand.png', corner: 'tl', size: 10, opacity: 1 },
      overlays: new Map([
        ['v_l', { path: 'logo.png', still: true }],
        ['v_s', { path: 'stiker.png', still: true }],
      ]),
    });
    const inputs = plan.args.flatMap((a, i) => (a === '-i' ? [plan.args[i + 1]] : []));
    expect(inputs).toEqual(['v.mp4', 'logo.png', 'stiker.png', 'brand.png']);
    // 180-wide canvas: 18 % → 32 px; margin 4 % of 180 = 7.
    expect(plan.graph).toContain('scale=32:-2,format=rgba,colorchannelmixer=aa=1.00,setsar=1[ov0]');
    expect(plan.graph).toMatch(/\[vl0\]\[ov0\]overlay=x=W-w-7:y=7:eof_action=pass:format=auto:enable='between\(t,0,4\)'\[vl1\]/);
    expect(plan.graph).toMatch(/\[vl1\]\[ov1\]overlay=.*enable='between\(t,1,2\)'\[vl2\]/);
    expect(plan.graph).toMatch(/\[vl2\]\[logo\]overlay=x=7:y=7:eof_action=pass:format=auto,format=yuv420p,trim=end_frame=120\[vout\]/);
    expect(code(() => buildRenderPlan(t, new Map([['v_v', { path: 'v.mp4', probe }]]), DEFAULT_RENDER, null))).toMatch(/Media overlay tidak tersedia/);
  });
});

describe.skipIf(!hasFfmpeg)('R26 render nyata FFmpeg (kecil)', () => {
  it('a red PNG in the top right for the whole video, a green one in the centre for 1–2 s only', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[]) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const black = await gen('hitam.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    const red = await gen('merah.png', ['-f', 'lavfi', '-i', 'color=c=red:s=40x40', '-frames:v', '1']);
    const green = await gen('hijau.png', ['-f', 'lavfi', '-i', 'color=c=lime:s=40x40', '-frames:v', '1']);
    await createProject(fx.ws, { project_id: 'ov', name: 'ov' });
    await svc.editTimeline({
      project_id: 'ov',
      expected_revision: 0,
      actor: 'user',
      ops: validateOps([
        { op: 'add_clip', track_kind: 'video', media: black, start_ms: 0, duration_ms: 3000 },
        { op: 'add_clip', track_kind: 'overlay', media: red, start_ms: 0, duration_ms: 3000, overlay: { pos: 'tr', dx: 0, dy: 0, skala: 20, opasitas: 1, margin: 0, layer: 0, sepanjang: true } },
        { op: 'add_clip', track_kind: 'overlay', media: green, start_ms: 1000, duration_ms: 1000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 50, opasitas: 1, margin: 0, layer: 1 } },
      ]),
    });
    const res = await renderProject(fx.ws, { project_id: 'ov', output_name: 'ov.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'ov'))[0]!.rel);
    const frame = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    const px = (b: Buffer, x: number, y: number) => [b[(y * 180 + x) * 3]!, b[(y * 180 + x) * 3 + 1]!, b[(y * 180 + x) * 3 + 2]!];
    const f0 = frame(0.5);
    const f1 = frame(1.5);
    // Red box: 20 % of 180 = 36 px wide in the top-right corner (x 144–179, y 0–35).
    expect(px(f0, 165, 15)[0]).toBeGreaterThan(180);
    expect(px(f0, 165, 15)[1]).toBeLessThan(60);
    expect(px(f0, 90, 160)[1]).toBeLessThan(40); // centre still black at 0.5 s
    expect(px(f1, 90, 160)[1]).toBeGreaterThan(180); // green at 1.5 s
    expect(px(f1, 165, 15)[0]).toBeGreaterThan(180); // red still there
  }, 60_000);
});

describe('R26 Brand: logo default otomatis + overlay per job (Buat video)', () => {
  const kit = (logo_otomatis: boolean) => ({ logo_otomatis, logo: { ref: LOGO, corner: 'bl' as const, size: 22, opacity: 0.8, show: 'sepanjang' as const } });
  const draft = [
    { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 5000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'hai', start_ms: 4000, duration_ms: 2000 },
  ];

  it('auto logo: one whole-video overlay from the kit logo, in front; none when off / empty / already there', async () => {
    const { autoLogoOp } = await import('../src/storage/engine.js');
    const op = autoLogoOp(kit(true) as never, draft)!;
    expect(op).toEqual({ op: 'add_clip', track_kind: 'overlay', media: LOGO, start_ms: 0, duration_ms: 6000, overlay: { ...OVERLAY_DEFAULT, pos: 'bl', skala: 22, opasitas: 0.8, layer: 999, sepanjang: true } });
    // It is a valid op on the draft (hybrid: an ordinary overlay clip afterwards).
    const t = applyOps({ tracks: [] }, validateOps([...draft, op]), ids);
    expect(overlays(t)).toHaveLength(1);
    expect(autoLogoOp(kit(false) as never, draft)).toBeNull();
    expect(autoLogoOp(kit(true) as never, [])).toBeNull();
    expect(autoLogoOp(kit(true) as never, [...draft, { op: 'set_brand_logo', on: true }])).toBeNull();
    expect(autoLogoOp(kit(true) as never, [...draft, op])).toBeNull();
  });

  it('job overlays: validated, whole video or [dari, sampai) clipped to the draft', async () => {
    const { jobOverlayOps, validateJobOverlays } = await import('../src/storage/engine.js');
    for (const bad of [
      'x',
      [{ ref: { media_id: '../x', version_id: 'v' }, overlay: OVERLAY_DEFAULT }],
      [{ ref: LOGO, overlay: { ...OVERLAY_DEFAULT, skala: 0 } }],
      [{ ref: LOGO, overlay: OVERLAY_DEFAULT, dari_ms: 2000, sampai_ms: 1000 }],
      [{ ref: LOGO, overlay: OVERLAY_DEFAULT, warna: 1 }],
      Array.from({ length: 11 }, () => ({ ref: LOGO, overlay: { ...OVERLAY_DEFAULT, sepanjang: true } })),
    ]) expect(code(() => validateJobOverlays(bad)), JSON.stringify(bad).slice(0, 80)).toMatch(/^EDIT_INVALID/);
    const list = validateJobOverlays([
      { ref: LOGO, overlay: { ...OVERLAY_DEFAULT, sepanjang: true } },
      { ref: STIKER, overlay: OVERLAY_DEFAULT, dari_ms: 4000, sampai_ms: 9000 },
      { ref: STIKER, overlay: OVERLAY_DEFAULT, dari_ms: 7000, sampai_ms: 8000 },
    ]);
    const ops = jobOverlayOps(list, 6000);
    expect(ops.map((o) => [o.start_ms, o.duration_ms])).toEqual([
      [0, 6000],
      [4000, 2000],
    ]);
    expect(overlays(applyOps({ tracks: [] }, validateOps([...draft, ...ops]), ids))).toHaveLength(2);
  });

  it('Brand Kit: overlay picture kinds, auto logo needs a logo, export keeps the engine contract kinds', async () => {
    const { validateBrandInput, assetKunci } = await import('../src/storage/brand.js');
    expect(code(() => validateBrandInput({ name: 'A', logo_otomatis: true }))).toMatch(/pilih logo default dulu/);
    const k = validateBrandInput({ name: 'A', logo: { ref: LOGO, corner: 'tr', size: 18, opacity: 1, show: 'sepanjang' }, logo_otomatis: true, aset: [{ id: 'diskon', ref: STIKER, jenis: 'stiker' }] });
    expect(k.logo_otomatis).toBe(true);
    expect(k.aset[0]!.jenis).toBe('stiker');
    expect(validateBrandInput({ name: 'A' }).logo_otomatis).toBe(false);
    expect(assetKunci({ jenis: 'stiker', id: 'diskon' })).toBe('$lainnya:diskon');
    expect(assetKunci({ jenis: 'logo', id: 'utama' })).toBe('$logo:utama');
  });
});
