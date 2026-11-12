import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { blurAt, framingFilters, placeOnCanvas, validateBlur, validateCrop } from '../src/storage/framing.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
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
const R = { x: 0, y: 0, w: 0.5, h: 0.5, dari_ms: 1000, sampai_ms: 2000, radius: 20 };

describe('U3d crop + blur areas (Batch Remix)', () => {
  it('validation: fractions inside the frame, crop ≥ 10 %, ≤ 8 areas, times ordered', () => {
    expect(validateCrop({ x: 0.25, y: 0, w: 0.5, h: 1 })).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    for (const bad of [{ x: 0.6, y: 0, w: 0.5, h: 1 }, { x: 0, y: 0, w: 0.05, h: 1 }, { x: 0, y: 0, w: 1 }, { x: 0, y: 0, w: 1, h: 1, z: 1 }, null]) expect(code(() => validateCrop(bad)), JSON.stringify(bad)).toBe('EDIT_INVALID');
    expect(validateBlur([{ ...R, radius: undefined }])[0]!.radius).toBe(20);
    for (const bad of [[{ ...R, sampai_ms: 1000 }], [{ ...R, radius: 99 }], [{ ...R, x: 0.8 }], Array(9).fill(R), 'x']) expect(code(() => validateBlur(bad))).toBe('EDIT_INVALID');
    expect(blurAt([R], 999)).toHaveLength(0);
    expect(blurAt([R], 1000)).toHaveLength(1);
    expect(blurAt([R], 2000)).toHaveLength(0);
  });

  it('ops: add_clip / set_framing only on media; split and cut keep the areas in source time', () => {
    const t0 = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 4000, in_ms: 500, crop: { x: 0, y: 0, w: 0.5, h: 1 }, blur: [R] }]), ids);
    const c = t0.tracks[0]!.clips[0]!;
    expect(c.crop).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(c.blur).toEqual([R]);
    expect(code(() => applyOps(t0, validateOps([{ op: 'add_clip', track_kind: 'text', text: 'x', crop: { x: 0, y: 0, w: 1, h: 1 }, start_ms: 0, duration_ms: 500 }]), ids))).toBe('EDIT_INVALID');
    // Split: both halves keep crop + areas (source time — nothing moves).
    const t1 = applyOps(t0, validateOps([{ op: 'split_clip', clip_id: c.clip_id, at_ms: 2000 }]), ids);
    expect(t1.tracks[0]!.clips.map((x) => [x.crop?.w, x.blur?.[0]?.dari_ms])).toEqual([
      [0.5, 1000],
      [0.5, 1000],
    ]);
    expect(t1.tracks[0]!.clips[1]!.blur).not.toBe(t1.tracks[0]!.clips[0]!.blur); // deep copies
    // Ripple cut through the middle: the right piece keeps its framing.
    const t2 = applyOps(t0, validateOps([{ op: 'remove_range', from_ms: 1000, to_ms: 1500 }]), ids);
    expect(t2.tracks[0]!.clips.every((x) => x.crop?.w === 0.5 && x.blur?.length === 1)).toBe(true);
    // set_framing: crop null = whole frame, blur [] = none.
    const t3 = applyOps(t0, validateOps([{ op: 'set_framing', clip_id: c.clip_id, crop: null, blur: [] }]), ids);
    expect(t3.tracks[0]!.clips[0]!.crop).toBeUndefined();
    expect(t3.tracks[0]!.clips[0]!.blur).toBeUndefined();
    expect(code(() => validateOps([{ op: 'set_framing', clip_id: c.clip_id }]))).toBe('EDIT_INVALID');
    // The engine plan (one add_clip with framing) passes checkPlan; the manifest validates it.
    expect(checkPlan({ tracks: [] }, [{ op: 'add_clip', track_kind: 'broll', media: V, start_ms: 0, duration_ms: 1000, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, blur: [R] }]).ops).toHaveLength(1);
    const base = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    expect(validateProjectManifest({ ...base, timeline: t0 }).timeline.tracks[0]!.clips[0]!.blur).toEqual([R]);
    expect(code(() => validateProjectManifest({ ...base, timeline: { tracks: [{ track_id: 't', kind: 'text', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 500, text: 'x', crop: { x: 0, y: 0, w: 1, h: 1 } }] }] } }))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest({ ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 500, media: V, blur: [{ ...R, radius: 999 }] }] }] } }))).toBe('PROJECT_INVALID');
  });

  it('preview geometry = render geometry (contain + centre after the crop)', () => {
    // 1920×1080 source, crop the centre 9:16 strip → fills a 1080×1920 canvas exactly.
    const crop = { x: (1920 - 607.5) / 2 / 1920, y: 0, w: 607.5 / 1920, h: 1 };
    const full = placeOnCanvas({ w: 1920, h: 1080 }, crop, { w: 1080, h: 1920 }, { x: 0, y: 0, w: 1, h: 1 });
    expect(full.left).toBeCloseTo(0, 0);
    expect(full.width).toBeCloseTo(1080, 0);
    expect(full.height).toBeCloseTo(1920, 0);
    // No crop: a 16:9 source letterboxed on 9:16; the top-left quarter lands in the top band.
    const q = placeOnCanvas({ w: 1920, h: 1080 }, undefined, { w: 1080, h: 1920 }, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(q).toEqual({ left: 0, top: (1920 - 607.5) / 2, width: 540, height: 303.75 });
    // Filters: area timed on the segment clock, then the crop; nothing when unframed.
    const f = framingFilters({ crop, blur: [R], srcStartMs: 500, durMs: 3000, shortSide: 1080, inLabel: 'i', outLabel: 'o', id: 's0' })!.join(';');
    expect(f).toContain("enable='between(t,0.500,1.500)'");
    expect(f).toContain('gblur=sigma=20');
    expect(f.indexOf('gblur')).toBeLessThan(f.lastIndexOf('crop=w=iw*0.3164'));
    expect(framingFilters({ srcStartMs: 0, durMs: 1000, shortSide: 1080, inLabel: 'i', outLabel: 'o', id: 's' })).toBeNull();
    expect(framingFilters({ blur: [R], srcStartMs: 3000, durMs: 1000, shortSide: 1080, inLabel: 'i', outLabel: 'o', id: 's' })).toBeNull(); // area not in this piece
    const t: Timeline = { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 3000, media: V, crop, blur: [R] }] }] };
    const probe = { duration_ms: 8000, width: 1920, height: 1080, video_codec: 'h264', audio_codec: 'aac' };
    const g = buildRenderPlan(t, new Map([['v_1', { path: 'C:/s.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 1080 }, null).graph;
    expect(g).toMatch(/\[0:v:0\]setpts=PTS-STARTPTS\[fi0\]/);
    expect(g).toMatch(/\[fo0\]fps=30,scale=1080:1920/);
  });

  it.skipIf(!hasFfmpeg)('real render: crop shows only the cropped part; blur only in its area and source time', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, filter: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    // 640×360: left half a checkerboard, right half solid red.
    const src = await gen('half.mp4', "nullsrc=s=640x360:r=30:d=4,geq=lum='if(lt(X\\,320)\\,255*mod(floor(X/8)+floor(Y/8)\\,2)\\,76)':cb='if(lt(X\\,320)\\,128\\,85)':cr='if(lt(X\\,320)\\,128\\,255)'");
    await createProject(fx.ws, { project_id: 'f', name: 'F' });
    await svc.editTimeline({
      project_id: 'f',
      expected_revision: 0,
      actor: 'user',
      ops: [
        // Starts 500 ms into the source; area blurred during source 1000–2000 ms = timeline 500–1500.
        { op: 'add_clip', track_kind: 'video', media: src, start_ms: 0, duration_ms: 3000, in_ms: 500, crop: { x: 0, y: 0, w: 0.5, h: 1 }, blur: [{ x: 0, y: 0, w: 0.5, h: 0.5, dari_ms: 1000, sampai_ms: 2000, radius: 30 }] },
        { op: 'set_canvas', ratio: '9:16' },
      ],
    });
    expect((await renderProject(fx.ws, { project_id: 'f', output_name: 'f.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast' } })).status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'f'))[0]!.rel);
    const frame = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    // Canvas 360×640; the 320×360 crop fits as 360×405 centred (top 117.5 … 522.5).
    const stats = (b: Buffer, y0: number, y1: number) => {
      let red = 0;
      let lo = 255;
      let hi = 0;
      for (let y = y0; y < y1; y++)
        for (let x = 20; x < 340; x++) {
          const i = (y * 360 + x) * 3;
          if (b[i]! > 150 && b[i + 1]! < 80) red++;
          lo = Math.min(lo, b[i + 1]!);
          hi = Math.max(hi, b[i + 1]!);
        }
      return { red, contrast: hi - lo };
    };
    const before = frame(0.2);
    const during = frame(1.0);
    const after = frame(2.2);
    expect(stats(before, 130, 500).red).toBe(0); // the red half is cropped away
    expect(stats(during, 140, 300).contrast).toBeLessThan(stats(before, 140, 300).contrast * 0.4); // top half blurred
    expect(stats(during, 360, 500).contrast).toBeGreaterThan(150); // bottom half still sharp
    expect(stats(after, 140, 300).contrast).toBeGreaterThan(150); // blur over after source 2000 ms
  }, 120_000);
});
