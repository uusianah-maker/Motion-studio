import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRANSITIONS, TRANSITION_LABEL, transitionCss, validateTransition, xfadeTransition } from '../src/storage/clipLook.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R23d (owner 16 Nov): Fade ke hitam, Zoom in, Blur, Pull out (own xfade expression). */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('R23d transisi', () => {
  it('new types are valid and named; xfade names / own pull-out expression', () => {
    for (const t of ['hitam', 'zoom_in', 'blur', 'pull_out'] as const) {
      expect(TRANSITIONS).toContain(t);
      expect(validateTransition({ type: t, ms: 600 })).toEqual({ type: t, ms: 600 });
    }
    expect([TRANSITION_LABEL.hitam, TRANSITION_LABEL.zoom_in, TRANSITION_LABEL.blur, TRANSITION_LABEL.pull_out]).toEqual(['Fade ke hitam', 'Zoom in', 'Blur', 'Pull out (zoom out)']);
    expect([xfadeTransition('hitam'), xfadeTransition('zoom_in'), xfadeTransition('blur')]).toEqual(['fadeblack', 'zoomin', 'hblur']);
    expect(xfadeTransition('pull_out')).toMatch(/^custom:expr='if\(eq\(PLANE,0\),b0\(floor/);
    expect(xfadeTransition('pull_out')).not.toMatch(/st\(|ld\(/); // no shared registers (slice threads)
  });
  it('preview approximations peak at the cut', () => {
    expect(transitionCss('hitam', 0.5).black).toBe(1);
    expect(transitionCss('hitam', 0).black).toBe(0);
    expect(transitionCss('blur', 0.5).blur).toBe(12);
    expect(transitionCss('zoom_in', 0.4).transform).toBe('scale(1.400)');
    expect(transitionCss('pull_out', 0.5).transform).toBe('scale(1.500)');
    expect(transitionCss('pull_out', 1).transform).toBe('scale(1.000)');
  });

  it.skipIf(!hasFfmpeg)('real render: all four keep the total length; black at the fade-to-black cut; pull out mixes then lands on B', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, color: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=180x320:r=30:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const red = await gen('merah.mp4', 'red');
    const blue = await gen('biru.mp4', 'blue');
    await createProject(fx.ws, { project_id: 'tr', name: 'tr' });
    await svc.editTimeline({ project_id: 'tr', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 1000, in_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 1000, duration_ms: 1000, transition: { type: 'hitam', ms: 600 } },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 2000, duration_ms: 1000, transition: { type: 'zoom_in', ms: 400 } },
      { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 3000, duration_ms: 1000, transition: { type: 'blur', ms: 400 } },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 4000, duration_ms: 1000, transition: { type: 'pull_out', ms: 600 } },
    ] as never });
    const res = await renderProject(fx.ws, { project_id: 'tr', output_name: 'tr.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'tr'))[0]!.rel);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { windowsHide: true }).toString());
    expect(dur).toBeGreaterThan(4.95);
    expect(dur).toBeLessThan(5.1);
    const at = (t: number) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      const i = (160 * 180 + 90) * 3;
      return [b[i]!, b[i + 1]!, b[i + 2]!];
    };
    expect(at(0.3)[0]).toBeGreaterThan(200);
    expect(Math.max(...at(1.0))).toBeLessThan(90); // fade to black: (near) black at the cut
    expect(at(1.6)[2]).toBeGreaterThan(200);
    const mid = at(4.0); // pull out: half red, half blue
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[2]).toBeGreaterThan(60);
    expect(at(4.6)[0]).toBeGreaterThan(200); // then the incoming clip, full
  }, 120_000);

  it('tahap 2: Spin + Glitch are own xfade expressions without registers; preview follows the same curve', () => {
    for (const t of ['spin', 'glitch'] as const) {
      expect(validateTransition({ type: t })).toEqual({ type: t, ms: 500 });
      expect(xfadeTransition(t)).toMatch(/^custom:expr='/);
      expect(xfadeTransition(t)).not.toMatch(/st\(|ld\(/);
    }
    expect([TRANSITION_LABEL.spin, TRANSITION_LABEL.glitch]).toEqual(['Spin (putar)', 'Glitch']);
    expect(transitionCss('spin', 0.5).transform).toBe('rotate(180.0deg) scale(0.400)');
    expect(transitionCss('spin', 1).transform).toBe('rotate(360.0deg) scale(1.000)');
    expect(transitionCss('glitch', 0.5).glitch).toBe(1);
    expect(transitionCss('glitch', 0).glitch).toBe(0);
  });

  it.skipIf(!hasFfmpeg)('real render: Spin shrinks + turns the picture at the cut (black corners), Glitch shifts bands; length kept', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, src: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}s=180x320:r=30:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const red = await gen('merah.mp4', 'color=c=red');
    const bars = await gen('bars.mp4', 'testsrc');
    await createProject(fx.ws, { project_id: 'sg', name: 'sg' });
    await svc.editTimeline({ project_id: 'sg', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 1000, in_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 1000, duration_ms: 1000, transition: { type: 'spin', ms: 800 } },
      { op: 'add_clip', track_kind: 'video', media: bars, start_ms: 2000, duration_ms: 1000, transition: { type: 'glitch', ms: 600 } },
    ] as never });
    const res = await renderProject(fx.ws, { project_id: 'sg', output_name: 'sg.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'sg'))[0]!.rel);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { windowsHide: true }).toString());
    expect(dur).toBeGreaterThan(2.95);
    expect(dur).toBeLessThan(3.1);
    const frame = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const px = (b: Buffer, x: number, y: number) => [b[(y * 180 + x) * 3]!, b[(y * 180 + x) * 3 + 1]!, b[(y * 180 + x) * 3 + 2]!];
    const cut = frame(1.0);
    expect(Math.max(...px(cut, 5, 5))).toBeLessThan(50); // corner: black around the shrunken picture
    expect(px(cut, 90, 160)[0]).toBeGreaterThan(180); // centre: still the (red) picture
    expect(px(frame(0.3), 5, 5)[0]).toBeGreaterThan(200); // before: full frame
    // Glitch: at the cut the bars are shifted sideways compared with the clean picture later.
    const shifted = frame(2.0);
    const clean = frame(2.7);
    let diff = 0;
    for (let x = 0; x < 180; x += 3) diff += Math.abs(px(shifted, x, 40)[1]! - px(clean, x, 40)[1]!);
    expect(diff).toBeGreaterThan(500);
  }, 120_000);
});
