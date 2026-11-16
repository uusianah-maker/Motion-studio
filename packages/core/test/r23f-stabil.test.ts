import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { makeStabil, stabilArgs, stabilPath, stabilReady } from '../src/storage/stabil.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R23f: stabilisation (FFmpeg vid.stab, two passes, background, cached per version + strength). */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasVidstab = (() => {
  try {
    return execFileSync(FFMPEG, ['-hide_banner', '-filters'], { windowsHide: true }).toString().includes('vidstabdetect');
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

describe('R23f stabilisasi', () => {
  it('stabil is a video/b-roll clip field set with set_motion (off clears); commands per strength', () => {
    const t = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 1000, stabil: 'kuat' }]), ids);
    const c = t.tracks[0]!.clips[0]!;
    expect(c.stabil).toBe('kuat');
    expect(applyOps(t, validateOps([{ op: 'set_motion', clip_id: c.clip_id, stabil: 'off' }]), ids).tracks[0]!.clips[0]!.stabil).toBeUndefined();
    expect(code(() => validateOps([{ op: 'set_motion', clip_id: 'a', stabil: 'super' }]))).toMatch(/^EDIT_INVALID/);
    expect(code(() => validateOps([{ op: 'add_clip', track_kind: 'music', media: V, start_ms: 0, duration_ms: 500, stabil: 'ringan' }]))).toMatch(/^EDIT_INVALID/);
    const a = stabilArgs('in.mp4', 'out.mp4', 'kuat');
    expect(a.detect.join(' ')).toContain('vidstabdetect=shakiness=8:accuracy=15:result=transforms.trf');
    expect(a.transform.join(' ')).toContain('vidstabtransform=input=transforms.trf:smoothing=30:optzoom=1');
  });

  it.skipIf(!hasVidstab)('a shaky clip gets steadier; render refuses before the copy exists, then uses it', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    // A white square that jumps around ±12 px every frame (hand-held shake) on a textured background.
    const f = path.join(fx.src, 'goyang.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', "testsrc=s=360x640:r=30:d=3", '-vf', "crop=320:600:20+12*sin(n*2.1):20+12*cos(n*1.7)", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    const vid = r.version.version_id;
    await createProject(fx.ws, { project_id: 'st', name: 'st' });
    await svc.editTimeline({ project_id: 'st', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: r.media.media_id, version_id: vid }, start_ms: 0, duration_ms: 2000, stabil: 'kuat' }] });
    const before = await renderProject(fx.ws, { project_id: 'st', output_name: 'st.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } }).catch((e: unknown) => e);
    expect(isStorageError(before) && before.code === 'PRECONDITION' && /Stabilisasi .* belum selesai/.test(before.message)).toBe(true);

    expect(await makeStabil(fx.ws, vid, 'kuat')).toBe('dibuat');
    expect(await stabilReady(fx.ws, vid, 'kuat')).toBe(true);
    expect(await makeStabil(fx.ws, vid, 'kuat')).toBe('sudah_ada');
    // Shake = mean absolute frame-to-frame difference of a centre patch (less = steadier).
    const shake = (file: string) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'scale=90:160,format=gray', '-f', 'rawvideo', '-'], { windowsHide: true, maxBuffer: 1 << 26 });
      const px = 90 * 160;
      const frames = Math.floor(b.length / px);
      let acc = 0;
      for (let k = 10; k < frames - 10; k++) for (let y = 40; y < 120; y += 2) for (let x = 20; x < 70; x += 2) acc += Math.abs(b[k * px + y * 90 + x]! - b[(k - 1) * px + y * 90 + x]!);
      return acc / (frames - 20);
    };
    const raw = shake(f);
    const steady = shake(stabilPath(fx.ws, vid, 'kuat'));
    expect(steady).toBeLessThan(raw * 0.7);

    const res = await renderProject(fx.ws, { project_id: 'st', output_name: 'st2.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    expect((await listOutputs(fx.ws, 'st')).length).toBeGreaterThan(0);
  }, 180_000);
});
