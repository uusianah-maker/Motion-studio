import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** 25 Nov (keyframe manual): real FFmpeg renders of rotation, new easings and overlay keyframes. */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const gray = (out: string, t: number, w: number) => {
  const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true });
  return (x: number, y: number) => b[y * w + x]!;
};
const rgb = (out: string, t: number, w: number) => {
  const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  return (x: number, y: number) => [b[(y * w + x) * 3]!, b[(y * w + x) * 3 + 1]!, b[(y * w + x) * 3 + 2]!] as const;
};

describe.skipIf(!hasFfmpeg)('keyframe manual: render sungguhan', () => {
  it('video rotates 90°, overlay picture moves right, easing "lembut" renders', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const vid = path.join(fx.src, 'white.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], { windowsHide: true });
    const png = path.join(fx.src, 'red.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=40x40', '-frames:v', '1', png], { windowsHide: true });
    const v = await svc.importMedia({ sourcePath: vid, scope: { kind: 'shared' }, actor: 'user' });
    const p = await svc.importMedia({ sourcePath: png, scope: { kind: 'shared' }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'rot', name: 'ROT' });
    await svc.editTimeline({
      project_id: 'rot',
      expected_revision: 0,
      actor: 'user',
      ops: [
        // 0 → 1 s: rotate to 90° (portrait white picture becomes a landscape band), shrinks a bit with "lembut".
        { op: 'add_clip', track_kind: 'video', media: { media_id: v.media.media_id, version_id: v.version.version_id }, start_ms: 0, duration_ms: 3000, keyframes: [{ at_ms: 0 }, { at_ms: 1000, rot: 90, scale: 0.9, ease: 'lembut' }] },
        // red square, centre, moves 30 % to the right between 1 s and 2 s
        { op: 'add_clip', track_kind: 'overlay', media: { media_id: p.media.media_id, version_id: p.version.version_id }, start_ms: 0, duration_ms: 3000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 20, opasitas: 1, margin: 4, layer: 0 }, keyframes: [{ at_ms: 1000 }, { at_ms: 2000, x: 0.3, ease: 'out' }] },
      ],
    });
    const res = await renderProject(fx.ws, { project_id: 'rot', output_name: 'rot.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'rot'))[0]!.rel);
    if (process.env.KF_DEMO_OUT) copyFileSync(out, process.env.KF_DEMO_OUT);
    // before rotating: the whole canvas is white (top row too)
    expect(gray(out, 0.02, 180)(90, 10)).toBeGreaterThan(200);
    // after 90° the white band is only 180×0.9 = 162 px tall: top and bottom are black, centre white
    const g = gray(out, 1.5, 180);
    expect(g(20, 10)).toBeLessThan(40);
    expect(g(20, 310)).toBeLessThan(40);
    expect(g(10, 160)).toBeGreaterThan(200);
    // overlay: red at the centre at 0.5 s, ~30 % to the right at 2.5 s (centre clear of red)
    const at = (t: number, x: number) => rgb(out, t, 180)(x, 160);
    const isRed = (c: readonly number[]) => c[0]! > 180 && c[1]! < 90 && c[2]! < 90;
    expect(isRed(at(0.5, 90))).toBe(true);
    expect(isRed(at(2.5, 90 + 54))).toBe(true);
    expect(isRed(at(2.5, 90))).toBe(false);
  }, 120_000);
});
