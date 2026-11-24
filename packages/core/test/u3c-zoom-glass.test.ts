import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/storage/copilot.js';
import { validateEffect, zoomAt, zoomExpr } from '../src/storage/effects.js';
import { isStorageError } from '../src/storage/errors.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { contrastText, validateStyle } from '../src/storage/textStyle.js';
import { buildAss } from '../src/storage/ass.js';
import { type Timeline, applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
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
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
let n = 0;
const ids = () => `c_${++n}`;
const V = { media_id: 'm_1', version_id: 'v_1' };

describe('U3c zoom effects + glass boxes', () => {
  it('effects: validated, only on the effects track, curves (cut / smooth ramp / zoom-through)', () => {
    expect(validateEffect({ type: 'zoom' })).toEqual({ type: 'zoom', scale: 1.2, mode: 'smooth', x: 0.5, y: 0.5 });
    expect(validateEffect({ type: 'zoom_through', scale: 1.6, x: 0.3 })).toEqual({ type: 'zoom_through', scale: 1.6, x: 0.3, y: 0.5 });
    for (const bad of [{ type: 'spin' }, { type: 'zoom', scale: 5 }, { type: 'zoom', mode: 'wobble' }, { type: 'zoom', x: 2 }, { type: 'zoom_through', mode: 'cut' }]) expect(code(() => validateEffect(bad)), JSON.stringify(bad)).toBe('EDIT_INVALID');
    expect(zoomAt({ type: 'zoom', scale: 1.5, mode: 'cut', x: 0.5, y: 0.5 }, 0, 1000)).toBe(1.5);
    expect(zoomAt({ type: 'zoom', scale: 1.5, mode: 'smooth', x: 0.5, y: 0.5 }, 125, 1000)).toBeCloseTo(1.25);
    expect(zoomAt({ type: 'zoom_through', scale: 1.4, x: 0.5, y: 0.5 }, 150, 300)).toBeCloseTo(1.2);
    // Keluhan tim: smooth = cosine ease in AND back out at the end (render expression = preview curve).
    const sm = { type: 'zoom', scale: 1.5, mode: 'smooth', x: 0.5, y: 0.5 } as const;
    expect(zoomAt(sm, 62.5, 1000)).toBeCloseTo(1 + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * 0.25)));
    expect(zoomAt(sm, 500, 1000)).toBe(1.5);
    expect(zoomAt(sm, 875, 1000)).toBeCloseTo(1.25);
    expect(zoomAt(sm, 1000, 1000)).toBe(1);
    expect(zoomAt(sm, 100, 200)).toBe(1.5); // short clip: in and out share it
    const ex = zoomExpr(sm, 2000, 3000);
    const evalAt = (t: number) => Function('t', 'clip', 'min', 'cos', 'PI', `return ${ex}`)(t, (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)), Math.min, Math.cos, Math.PI) as number;
    for (const ms of [0, 40, 125, 300, 700, 900, 990]) expect(evalAt(2 + ms / 1000)).toBeCloseTo(zoomAt(sm, ms, 1000), 3);
    const t =applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 4000 }, { op: 'add_clip', track_kind: 'effects', effect: { type: 'zoom', scale: 1.3 }, start_ms: 1000, duration_ms: 1000 }]), ids);
    expect(t.tracks.find((x) => x.kind === 'effects')!.clips[0]!.effect).toMatchObject({ type: 'zoom', scale: 1.3 });
    expect(code(() => applyOps(t, validateOps([{ op: 'add_clip', track_kind: 'effects', start_ms: 3000, duration_ms: 500 }]), ids))).toBe('EDIT_INVALID'); // no effect
    expect(code(() => applyOps(t, validateOps([{ op: 'add_clip', track_kind: 'text', text: 'x', effect: { type: 'zoom' }, start_ms: 0, duration_ms: 500 }]), ids))).toBe('EDIT_INVALID');
    expect(checkPlan(t, [{ op: 'add_clip', track_kind: 'effects', effect: { type: 'zoom_through' }, start_ms: 3000, duration_ms: 300 }]).ops).toHaveLength(1);
    expect(validateStyle({ bg_blur: 12 })).toEqual({ bg_blur: 12 });
    expect(code(() => validateStyle({ bg_blur: 50 }))).toBe('EDIT_INVALID');
  });

  it('boxed keyword (accent = caption colour): box in the highlight colour, text in contrast', () => {
    expect([contrastText('#fffdd0'), contrastText('#7a1f5c')]).toEqual(['#000000', '#ffffff']);
    const font = { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: true };
    const ass = buildAss({
      clips: [{ kind: 'subtitle', clip: { clip_id: 'c', start_ms: 0, end_ms: 1000, text: 'anti kusut', style: { color: '#fffdd0', highlight: { words: ['kusut'], color: '#fffdd0', scale: 1.2, current: false, box: true } } } }],
      width: 1080,
      height: 1920,
      ratio: '9:16',
      total_ms: 1000,
      fonts: { bold: font, regular: { ...font, bold: false }, brand: null, caption: null },
    });
    const ev = ass.split('\n').find((l) => l.startsWith('Dialogue'))!;
    expect(ev).toMatch(/\\c&H000000&\\3c&HD0FDFF&\\3a&H00&\\bord\d+\\shad0[^}]*\}kusut/); // black on the cream box
    expect(ev).toMatch(/\\c&HD0FDFF&[^}]*\}anti/); // normal word: cream text, normal border
  });

  it('render plan: zoom before text (sub-pixel perspective), glass blur limited to the clip time', () => {
    const t: Timeline = {
      tracks: [
        { track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 3000, media: V }] },
        { track_id: 't', kind: 'text', clips: [{ clip_id: 'b', start_ms: 500, end_ms: 1500, text: 'Kaca', style: { bg: '#ffffff', bg_opacity: 0.3, bg_blur: 10 } }] },
        { track_id: 'e', kind: 'effects', clips: [{ clip_id: 'z', start_ms: 1000, end_ms: 2000, effect: { type: 'zoom', scale: 1.5, mode: 'cut', x: 0.5, y: 0.5 } }] },
      ],
    };
    const probe = { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' };
    const g = buildRenderPlan(t, new Map([['v_1', { path: 'C:/s.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 1080 }, 'C:/f/arialbd.ttf').graph;
    const zoom = g.indexOf('perspective=');
    const blur = g.indexOf('gblur=sigma=10');
    const text = g.indexOf('drawtext=');
    expect(zoom).toBeGreaterThan(0);
    expect(blur).toBeGreaterThan(zoom); // zoom first, then glass, then the text on top
    expect(text).toBeGreaterThan(blur);
    expect(g).toContain("enable='between(t,0.500,1.500)'");
    // Keluhan tim: float window (no whole-pixel zoompan crop), only while the effect is on screen.
    expect(g).not.toContain('zoompan');
    expect(g).toContain("x0='(W-W/(if(between(((in-1)/30)\\,1.000\\,1.9995)\\,1.5\\,1)))*(if(between(((in-1)/30)\\,1.000\\,1.9995)\\,0.5\\,0.5))'");
    expect(g).toContain(":interpolation=cubic:sense=source:eval=frame:enable='between(t,1.000,1.9995)'");
    const plain = buildRenderPlan({ tracks: [t.tracks[0]!] }, new Map([['v_1', { path: 'C:/s.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 1080 }, null).graph;
    expect(plain).not.toContain('perspective');
    expect(plain).not.toContain('gblur');
  });

  it.skipIf(!hasFfmpeg)('real render: a 2× zoom makes the centre square 4× bigger only during the effect; glass smooths only under the box', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, filter: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const square = await gen('sq.mp4', 'color=c=black:s=360x640:r=30:d=3,drawbox=x=150:y=290:w=60:h=60:color=white:t=fill');
    await createProject(fx.ws, { project_id: 'z', name: 'Z' });
    await svc.editTimeline({
      project_id: 'z',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: square, start_ms: 0, duration_ms: 3000 },
        { op: 'add_clip', track_kind: 'effects', effect: { type: 'zoom', scale: 2, mode: 'cut', x: 0.5, y: 0.5 }, start_ms: 1000, duration_ms: 1000 },
      ],
    });
    expect((await renderProject(fx.ws, { project_id: 'z', output_name: 'z.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast' } })).status).toBe('completed');
    const zout = path.join(fx.ws.root, (await listOutputs(fx.ws, 'z'))[0]!.rel);
    const gray = (file: string, t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    const whites = (b: Buffer) => b.reduce((n, v) => n + (v > 200 ? 1 : 0), 0);
    const before = whites(gray(zout, 0.5));
    const during = whites(gray(zout, 1.5));
    const after = whites(gray(zout, 2.5));
    expect(during / before).toBeGreaterThan(3.4);
    expect(during / before).toBeLessThan(4.6);
    expect(Math.abs(after - before) / before).toBeLessThan(0.1);

    // Glass: a checkerboard; under the box the pattern is smoothed (low contrast) while the text shows.
    const checker = await gen('ck.mp4', "nullsrc=s=360x640:r=30:d=3,geq=lum='255*mod(floor(X/6)+floor(Y/6)\\,2)':cb=128:cr=128");
    await createProject(fx.ws, { project_id: 'g', name: 'G' });
    await svc.editTimeline({
      project_id: 'g',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: checker, start_ms: 0, duration_ms: 3000 },
        { op: 'add_clip', track_kind: 'text', text: 'KACA', style: { y: 0.5, size: 8, color: '#ff0000', bg: '#808080', bg_opacity: 0.05, bg_blur: 20, outline: false }, start_ms: 1000, duration_ms: 1000 },
      ],
    });
    expect((await renderProject(fx.ws, { project_id: 'g', output_name: 'g.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast' } })).status).toBe('completed');
    const gout = path.join(fx.ws.root, (await listOutputs(fx.ws, 'g'))[0]!.rel);
    // Contrast in a strip just inside the box edge (above the letters) vs far away from it.
    const contrast = (b: Buffer, y0: number, y1: number, x0: number, x1: number) => {
      let lo = 255;
      let hi = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const v = b[y * 360 + x]!;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      return hi - lo;
    };
    const on = gray(gout, 1.5);
    const off = gray(gout, 0.5);
    expect(contrast(on, 296, 300, 150, 210)).toBeLessThan(contrast(off, 296, 300, 150, 210) * 0.5); // blurred under the box
    expect(contrast(on, 40, 60, 150, 210)).toBeGreaterThan(150); // the rest of the frame stays sharp
  }, 120_000);
});
