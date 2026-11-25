import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { depanSource } from '../src/storage/depan.js';
import { clipRefs } from '../src/storage/project.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** 25 Nov "Objek di depan teks" (auto masking): model, refs, picture source, real render. */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const M = { media_id: 'm_1', version_id: 'v_1' };
const P = { media_id: 'm_2', version_id: 'v_2' };
let n = 0;
const ids = () => `c_${++n}`;

describe('objek di depan teks: model', () => {
  it('set_depan only on text/subtitle, validated, held as media refs, kept by split', () => {
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'text', text: 'PROMO', start_ms: 0, duration_ms: 4000 },
      { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 4000 },
    ]), ids);
    const txt = t.tracks.find((x) => x.kind === 'text')!.clips[0]!;
    const vid = t.tracks.find((x) => x.kind === 'video')!.clips[0]!;
    const depan = { masker: M, potongan: P, dari_ms: 0, durasi_ms: 4000, halus: 3 };
    const t2 = applyOps(t, validateOps([{ op: 'set_depan', clip_id: txt.clip_id, depan }]), ids);
    const c = t2.tracks.find((x) => x.kind === 'text')!.clips[0]!;
    expect(c.depan).toEqual(depan);
    expect(clipRefs(c)).toEqual(expect.arrayContaining([M, P]));
    const t3 = applyOps(t2, validateOps([{ op: 'split_clip', clip_id: c.clip_id, at_ms: 2000 }]), ids);
    expect(t3.tracks.find((x) => x.kind === 'text')!.clips.every((x) => x.depan?.dari_ms === 0)).toBe(true);
    expect(() => applyOps(t, validateOps([{ op: 'set_depan', clip_id: vid.clip_id, depan }]), ids)).toThrow(/teks/);
    for (const bad of [{ ...depan, durasi_ms: 20_000 }, { ...depan, halus: 50 }, { ...depan, masker: { media_id: '../x', version_id: 'v' } }, { ...depan, lain: 1 }]) expect(() => validateOps([{ op: 'set_depan', clip_id: txt.clip_id, depan: bad }])).toThrow();
    expect(applyOps(t2, validateOps([{ op: 'set_depan', clip_id: txt.clip_id, depan: null }]), ids).tracks.find((x) => x.kind === 'text')!.clips[0]!.depan).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg)('objek di depan teks: render sungguhan', () => {
  it('picture source has no text; the subject is drawn in front of the text', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    // grey picture with a white "subject" square in the middle
    const vid = path.join(fx.src, 'subjek.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x404040:s=180x320:r=30:d=3', '-vf', 'drawbox=x=60:y=130:w=60:h=60:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], { windowsHide: true });
    // its mask: white where the square is
    const mask = path.join(fx.src, 'masker.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=15:d=3', '-vf', 'drawbox=x=60:y=130:w=60:h=60:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mask], { windowsHide: true });
    const v = await svc.importMedia({ sourcePath: vid, scope: { kind: 'shared' }, actor: 'user' });
    const m = await svc.importMedia({ sourcePath: mask, scope: { kind: 'shared' }, actor: 'user' });
    const vref = { media_id: v.media.media_id, version_id: v.version.version_id };
    const mref = { media_id: m.media.media_id, version_id: m.version.version_id };
    await createProject(fx.ws, { project_id: 'dp', name: 'DP' });
    await svc.editTimeline({
      project_id: 'dp',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: vref, start_ms: 0, duration_ms: 3000 },
        // a big red box of text across the middle (behind the subject once "depan" is on)
        { op: 'add_clip', track_kind: 'text', text: 'MMMMMMMM', style: { color: '#ff0000', bg: '#ff0000', size: 14, y: 0.5, outline: false }, start_ms: 0, duration_ms: 3000 },
      ],
    });
    const p0 = await readProject(fx.ws, 'dp');
    const txt = p0.timeline.tracks.find((x) => x.kind === 'text')!.clips[0]!;
    // step 1: the picture under the text, without the text
    const src = await depanSource(fx.ws, { project_id: 'dp', clip_id: txt.clip_id, actor: 'user' });
    expect(src).toMatchObject({ dari_ms: 0, durasi_ms: 3000 });
    // step 3: save the mask on the text, render for real
    await svc.editTimeline({ project_id: 'dp', expected_revision: p0.revision, actor: 'user', ops: [{ op: 'set_depan', clip_id: txt.clip_id, depan: { masker: mref, potongan: mref, dari_ms: 0, durasi_ms: 3000, halus: 0 } }] });
    const res = await renderProject(fx.ws, { project_id: 'dp', output_name: 'dp.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'dp'))[0]!.rel);
    const px = (x: number, y: number) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      const i = (y * 180 + x) * 3;
      return [b[i]!, b[i + 1]!, b[i + 2]!];
    };
    const centre = px(90, 160); // inside the subject AND inside the red text box
    expect(centre[0]! > 200 && centre[1]! > 200 && centre[2]! > 200).toBe(true); // white subject in front
    const side = px(30, 160); // text box, outside the subject
    expect(side[0]! > 180 && side[1]! < 90).toBe(true); // red text still there
  }, 180_000);
});
