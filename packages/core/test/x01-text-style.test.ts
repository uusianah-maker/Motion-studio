import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { DEFAULT_STYLES, effectiveStyle, layoutText, validateStyle, wrapCharsFor } from '../src/storage/textStyle.js';
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

describe('X01 text style', () => {
  it('validateStyle: known fields, ranges, colours; unknown keys refused', () => {
    expect(validateStyle({ x: 0.25, color: '#FF0000', bg: null, align: 'left', bold: false })).toEqual({ x: 0.25, color: '#ff0000', bg: null, align: 'left', bold: false });
    for (const bad of [{ x: 1.2 }, { size: 1 }, { size: 30 }, { color: 'red' }, { bg: '#12345' }, { align: 'justify' }, { bold: 'ya' }, { font: 'Comic Sans' }, 'merah', null]) {
      expect(code(() => validateStyle(bad)), JSON.stringify(bad)).toBe('EDIT_INVALID');
    }
    expect(effectiveStyle('subtitle', { color: '#ffee00' })).toEqual({ ...DEFAULT_STYLES.subtitle, color: '#ffee00' });
  });

  it('layout is scale-free: same lines for any pixel size, more chars on wider canvases', () => {
    const s = effectiveStyle('text');
    const text = 'Diskon besar-besaran hari ini untuk semua produk pilihan';
    expect(layoutText(text, s, '9:16')).toBe(layoutText(`  ${text} `, s, '9:16'));
    expect(wrapCharsFor(s, '16:9')).toBeGreaterThan(wrapCharsFor(s, '9:16'));
    expect(layoutText(text, { ...s, width: 0.3 }, '9:16').split('\n').length).toBeGreaterThan(layoutText(text, s, '9:16').split('\n').length);
  });

  it('set_style merges, add_clip carries a style, split keeps text + style, media clips refuse style', () => {
    const t0 = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'text', text: 'Halo', style: { color: '#ff0000' }, start_ms: 0, duration_ms: 4000 }]), ids);
    const id = t0.tracks[0]!.clips[0]!.clip_id;
    const t1 = applyOps(t0, validateOps([{ op: 'set_style', clip_id: id, style: { y: 0.7, bg: '#ffff00' } }]), ids);
    expect(t1.tracks[0]!.clips[0]!.style).toEqual({ color: '#ff0000', y: 0.7, bg: '#ffff00' });
    expect(t0.tracks[0]!.clips[0]!.style).toEqual({ color: '#ff0000' }); // pure: the old timeline is untouched (undo)
    const t2 = applyOps(t1, [{ op: 'split_clip', clip_id: id, at_ms: 2000 }], ids);
    expect(t2.tracks[0]!.clips.map((c) => [c.text, c.style?.bg])).toEqual([
      ['Halo', '#ffff00'],
      ['Halo', '#ffff00'],
    ]);
    const withVideo: Timeline = applyOps(t2, [{ op: 'add_clip', track_kind: 'video', media: { media_id: 'm_1', version_id: 'v_1' }, start_ms: 0, duration_ms: 1000 }], ids);
    const vid = withVideo.tracks.find((t) => t.kind === 'video')!.clips[0]!.clip_id;
    expect(code(() => applyOps(withVideo, [{ op: 'set_style', clip_id: vid, style: { x: 0.5 } }], ids))).toBe('EDIT_INVALID');
    expect(code(() => validateOps([{ op: 'set_style', clip_id: id, style: {} }]))).toBe('EDIT_INVALID');
    expect(code(() => validateOps([{ op: 'add_clip', track_kind: 'video', style: { x: 0.1 }, start_ms: 0, duration_ms: 1 }]))).toBe('OK'); // shape ok…
    expect(code(() => applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', style: { x: 0.1 }, start_ms: 0, duration_ms: 1000 }], ids))).toBe('EDIT_INVALID'); // …refused on a media track
  });

  it('stored manifests validate styles (bad colour = PROJECT_INVALID, no style on media clips)', () => {
    const base = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    const mk = (clip: Record<string, unknown>, kind = 'text') => ({ ...base, timeline: { tracks: [{ track_id: kind, kind, clips: [{ clip_id: 'c1', start_ms: 0, end_ms: 1000, ...clip }] }] } });
    expect(code(() => validateProjectManifest(mk({ text: 'a', style: { color: '#00ff00' } })))).toBe('OK');
    expect(code(() => validateProjectManifest(mk({ text: 'a', style: { color: 'hijau' } })))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest(mk({ media: { media_id: 'm_1', version_id: 'v_1' }, style: { x: 0.5 } }, 'video')))).toBe('PROJECT_INVALID');
  });

  it('render plan: each clip drawn with its own colour, box, outline, weight, alignment and centre', () => {
    const t: Timeline = {
      canvas: { ratio: '9:16' },
      tracks: [
        { track_id: 'text', kind: 'text', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 1000, text: 'Halo', style: { x: 0.25, y: 0.7, color: '#ff0000', bg: '#ffff00', bg_opacity: 1, outline: false, bold: false, align: 'left' } }] },
        { track_id: 'subtitle', kind: 'subtitle', clips: [{ clip_id: 's', start_ms: 0, end_ms: 1000, text: 'Sub' }] },
      ],
    };
    const plan = buildRenderPlan(t, new Map(), { ...DEFAULT_RENDER, short_side: 1080 }, 'C:/f/arialbd.ttf', 'C:/f/arial.ttf');
    const [a, s] = plan.graph.split('drawtext=').slice(1);
    expect(a).toContain('fontfile=fontr.ttf');
    expect(a).toContain('fontcolor=0xff0000');
    expect(a).toContain('text_align=L');
    expect(a).toContain('x=270-text_w/2:y=1344-text_h/2');
    expect(a).toContain('box=1:boxcolor=0xffff00@1');
    expect(a).not.toContain('bordercolor'); // outline off
    expect(s).toContain('fontfile=fontb.ttf');
    expect(s).toContain('box=1:boxcolor=0x000000@0.62');
    expect(plan.files.map((f) => f.content)).toEqual(['Halo', 'Sub']);
  });

  it.skipIf(!hasFfmpeg)('real render: the text box lands where the style puts it, in its colour', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    // Plain grey footage, so any yellow in the frame can only be the text box.
    const grey = path.join(fx.src, 'grey.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', grey], { windowsHide: true });
    const imp = await svc.importMedia({ sourcePath: grey, scope: { kind: 'shared' }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'promo', name: 'P' });
    await svc.editTimeline({
      project_id: 'promo',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 1000 },
        { op: 'add_clip', track_kind: 'text', text: 'HALO', style: { x: 0.3, y: 0.75, size: 8, color: '#000000', bg: '#ffff00', bg_opacity: 1, outline: false }, start_ms: 0, duration_ms: 1000 },
      ],
    });
    const r = await renderProject(fx.ws, { project_id: 'promo', output_name: 'gaya.mp4', actor: 'user' }, { settings: { short_side: 240, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'promo'))[0]!.rel);
    // 24×? downscaled frame as raw RGB: count yellow pixels per quadrant.
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', 'scale=24:42', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 20 });
    // Yellow-ish pixels (the box; black glyphs inside it get averaged in by the downscale).
    const yellowIn = (x0: number, x1: number, y0: number, y1: number) => {
      let count = 0;
      for (let y = Math.floor(y0 * 42); y < Math.ceil(y1 * 42); y++)
        for (let x = Math.floor(x0 * 24); x < Math.ceil(x1 * 24); x++) {
          const i = (y * 24 + x) * 3;
          if (raw[i]! > 140 && raw[i + 1]! > 140 && raw[i + 2]! < 110) count++;
        }
      return count;
    };
    expect(yellowIn(0, 0.6, 0.65, 0.85)).toBeGreaterThanOrEqual(4); // box around (0.3, 0.75)
    expect(yellowIn(0.6, 1, 0.65, 0.85)).toBe(0); // not on the right
    expect(yellowIn(0, 1, 0.05, 0.35)).toBe(0); // nothing where the default text sits
    expect((await readProject(fx.ws, 'promo')).timeline.tracks.find((t) => t.kind === 'text')!.clips[0]!.style?.bg).toBe('#ffff00');
  }, 60_000);
});
