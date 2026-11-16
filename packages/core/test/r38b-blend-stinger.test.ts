import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { patchOverlay, validateOverlay, validateOverlayPatch } from '../src/storage/overlay.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R38b: overlay blend modes (video effects) + transition stingers on the overlay track. */
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
const V = { media_id: 'm', version_id: 'v' };
const S = { media_id: 's', version_id: 'sv' };

describe('R38b blend + stinger', () => {
  it('blend / stinger fields validate; normal + false clear them', () => {
    const o = validateOverlay({ pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0, blend: 'screen', stinger: true });
    expect([o.blend, o.stinger]).toEqual(['screen', true]);
    expect(() => validateOverlay({ pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0, blend: 'dodge' })).toThrow();
    const p = patchOverlay(o, validateOverlayPatch({ blend: 'normal', stinger: false }));
    expect([p.blend, p.stinger]).toEqual([undefined, undefined]);
  });
  it('place_stinger: centred on the nearest cut of the video lane, full canvas; alpha → normal, else screen', () => {
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 2000, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 4000, duration_ms: 2000 },
    ]), ids);
    const a = applyOps(t, validateOps([{ op: 'place_stinger', media: S, at_ms: 3300, duration_ms: 800 }]), ids);
    const st = a.tracks.find((x) => x.kind === 'overlay')!.clips[0]!;
    expect([st.start_ms, st.end_ms, st.overlay?.stinger, st.overlay?.blend, st.overlay?.skala, st.overlay?.pos]).toEqual([3600, 4400, true, 'screen', 100, 'c']);
    const b = applyOps(t, validateOps([{ op: 'place_stinger', media: S, at_ms: 100, duration_ms: 600, alpha: true }]), ids);
    const st2 = b.tracks.find((x) => x.kind === 'overlay')!.clips[0]!;
    expect([st2.start_ms, st2.overlay?.blend]).toEqual([1700, undefined]);
    expect(code(() => applyOps({ tracks: [] }, validateOps([{ op: 'place_stinger', media: S, at_ms: 0, duration_ms: 500 }]), ids))).toMatch(/Belum ada titik potong/);
    expect(code(() => validateOps([{ op: 'place_stinger', media: S, at_ms: 0, duration_ms: 20_000 }]))).toMatch(/^EDIT_INVALID/);
  });

  it.skipIf(!hasFfmpeg)('real render: Screen lightens only where the effect is bright; Multiply darkens; a stinger flashes at the cut', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, filter: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '8', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const blue = await gen('biru.mp4', 'color=c=0x2040c0:s=180x320:r=30:d=3');
    const green = await gen('hijau.mp4', 'color=c=0x20c040:s=180x320:r=30:d=3');
    // "Light leak": black with a red block at the top half.
    const leak = await gen('leak.mp4', 'color=c=black:s=180x320:r=30:d=3,drawbox=x=0:y=0:w=180:h=160:color=0xff0000:t=fill');
    // "Stinger": a white flash clip (no alpha → screen).
    const flash = await gen('flash.mp4', 'color=c=white:s=180x320:r=30:d=1');
    await createProject(fx.ws, { project_id: 'bl', name: 'bl' });
    await svc.editTimeline({ project_id: 'bl', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'video', media: green, start_ms: 2000, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'overlay', media: leak, start_ms: 0, duration_ms: 1000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0, blend: 'screen' } },
      { op: 'add_clip', track_kind: 'overlay', media: leak, start_ms: 1000, duration_ms: 600, overlay: { pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 1, blend: 'multiply' } },
      { op: 'place_stinger', media: flash, at_ms: 1900, duration_ms: 400 },
    ] as never });
    expect((await readProject(fx.ws, 'bl')).timeline.tracks.find((t) => t.kind === 'overlay')!.clips).toHaveLength(3);
    const res = await renderProject(fx.ws, { project_id: 'bl', output_name: 'bl.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'bl'))[0]!.rel);
    const at = (t: number, y: number) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      const i = (y * 180 + 90) * 3;
      return [b[i]!, b[i + 1]!, b[i + 2]!];
    };
    const top = at(0.5, 60); // screen: blue + red → magenta-ish
    const bottom = at(0.5, 260); // screen with black → blue unchanged
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeGreaterThan(150);
    expect(bottom[0]).toBeLessThan(70);
    expect(bottom[2]).toBeGreaterThan(150);
    const mul = at(1.3, 260); // multiply with black → black
    expect(Math.max(...mul)).toBeLessThan(40);
    const cut = at(2.0, 260); // the white stinger over the cut (screen) → near white
    expect(Math.min(...cut)).toBeGreaterThan(200);
    expect(at(2.6, 260)[1]).toBeGreaterThan(150); // after the stinger: the green clip
  }, 120_000);
});
