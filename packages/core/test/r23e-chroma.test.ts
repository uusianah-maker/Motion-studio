import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromaAlpha, chromaFilter, chromaKeyUV, validateChroma } from '../src/storage/chroma.js';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R23e: chroma key / green screen on the R26 overlay track — render (FFmpeg chromakey) = preview maths. */
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
const M = { media_id: 'm', version_id: 'v' };
const BASE = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [] };

describe('R23e chroma key', () => {
  it('validation, filter, alpha (green → transparent, other colours stay)', () => {
    expect(validateChroma({})).toEqual({ warna: '#00ff00', toleransi: 0.15, halus: 0.05 });
    expect(() => validateChroma({ warna: 'green' })).toThrow();
    expect(() => validateChroma({ toleransi: 0.9 })).toThrow();
    expect(chromaFilter({ warna: '#00ff00', toleransi: 0.2, halus: 0.1 })).toBe('chromakey=color=0x00ff00:similarity=0.2:blend=0.1');
    const k = chromaKeyUV('#00ff00');
    expect(chromaAlpha(0, 255, 0, k, { toleransi: 0.15, halus: 0.05 })).toBe(0);
    expect(chromaAlpha(30, 230, 40, k, { toleransi: 0.15, halus: 0.05 })).toBe(0); // greenish too
    expect(chromaAlpha(220, 30, 30, k, { toleransi: 0.15, halus: 0.05 })).toBe(1);
    expect(chromaAlpha(128, 128, 128, k, { toleransi: 0.15, halus: 0 })).toBe(1);
  });
  it('set_chroma only on overlay clips; null clears; manifest keeps it', () => {
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'overlay', media: M, start_ms: 0, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 1000 },
    ]), ids);
    const ov = t.tracks.find((x) => x.kind === 'overlay')!.clips[0]!.clip_id;
    const vid = t.tracks.find((x) => x.kind === 'video')!.clips[0]!.clip_id;
    const t2 = applyOps(t, validateOps([{ op: 'set_chroma', clip_id: ov, chroma: { warna: '#0000ff', toleransi: 0.2, halus: 0 } }]), ids);
    expect(t2.tracks.find((x) => x.kind === 'overlay')!.clips[0]!.chroma).toEqual({ warna: '#0000ff', toleransi: 0.2, halus: 0 });
    expect(validateProjectManifest({ ...BASE, timeline: t2 }).timeline.tracks.find((x) => x.kind === 'overlay')!.clips[0]!.chroma?.warna).toBe('#0000ff');
    expect(code(() => applyOps(t, validateOps([{ op: 'set_chroma', clip_id: vid, chroma: { warna: '#00ff00' } }]), ids))).toMatch(/hanya untuk klip di track overlay/);
    expect(applyOps(t2, validateOps([{ op: 'set_chroma', clip_id: ov, chroma: null }]), ids).tracks.find((x) => x.kind === 'overlay')!.clips[0]!.chroma).toBeUndefined();
    expect(code(() => validateOps([{ op: 'set_chroma', clip_id: ov, chroma: { warna: '#zzzzzz' } }]))).toMatch(/^EDIT_INVALID/);
  });

  it.skipIf(!hasFfmpeg)('real render: a green-screen video on the overlay track — green gone (main video shows), subject stays', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, filter: string) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '8', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const blue = await gen('biru.mp4', 'color=c=blue:s=180x320:r=30:d=2');
    // Green screen with a red "subject" square in the middle.
    const gs = await gen('greenscreen.mp4', "color=c=0x00ff00:s=180x320:r=30:d=2,drawbox=x=60:y=120:w=60:h=80:color=red:t=fill");
    await createProject(fx.ws, { project_id: 'ck', name: 'ck' });
    await svc.editTimeline({ project_id: 'ck', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'overlay', media: gs, start_ms: 0, duration_ms: 2000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0 } },
    ] as never });
    const p = await (await import('../src/storage/workspace.js')).readProject(fx.ws, 'ck');
    const ov = p.timeline.tracks.find((t) => t.kind === 'overlay')!.clips[0]!.clip_id;
    await svc.editTimeline({ project_id: 'ck', expected_revision: p.revision, actor: 'user', ops: [{ op: 'set_chroma', clip_id: ov, chroma: { warna: '#00ff00', toleransi: 0.15, halus: 0.05 } }] as never });
    const res = await renderProject(fx.ws, { project_id: 'ck', output_name: 'ck.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'ck'))[0]!.rel);
    const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const px = (x: number, y: number) => [b[(y * 180 + x) * 3]!, b[(y * 180 + x) * 3 + 1]!, b[(y * 180 + x) * 3 + 2]!];
    const edge = px(20, 40); // was green screen
    expect(edge[2]).toBeGreaterThan(150); // the main (blue) video shows through
    expect(edge[1]).toBeLessThan(90);
    const subj = px(90, 160);
    expect(subj[0]).toBeGreaterThan(150); // the red subject stays
  }, 120_000);
});
