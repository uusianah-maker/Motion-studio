import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
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
const MUSIC = { media_id: 'm_2', version_id: 'v_2' };
const POP = { media_id: 'm_3', version_id: 'v_3' };

describe('U3a: sfx track, volume on add_clip, final loudness', () => {
  it('SFX play over music (own track), never over each other; volume set at creation; loudness op', () => {
    const t = applyOps(
      { tracks: [] },
      validateOps([
        { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 4000 },
        { op: 'add_clip', track_kind: 'audio', media: MUSIC, start_ms: 0, duration_ms: 4000, volume: 0.2 },
        { op: 'add_clip', track_kind: 'sfx', media: POP, start_ms: 500, duration_ms: 300 },
        { op: 'add_clip', track_kind: 'sfx', media: POP, start_ms: 2000, duration_ms: 300, volume: 0.8 },
        { op: 'set_loudness', lufs: -14 },
      ]),
      ids,
    );
    expect(t.tracks.map((x) => x.kind)).toEqual(['video', 'audio', 'sfx']);
    expect(t.tracks.find((x) => x.kind === 'audio')!.clips[0]!.volume).toBe(0.2);
    expect(t.tracks.find((x) => x.kind === 'sfx')!.clips.map((c) => c.volume ?? 1)).toEqual([1, 0.8]);
    expect(t.loudness_lufs).toBe(-14);
    expect('loudness_lufs' in applyOps(t, [{ op: 'set_loudness', lufs: null }], ids)).toBe(false);
    expect(applyOps(t, [{ op: 'set_canvas', ratio: '1:1' }], ids).loudness_lufs).toBe(-14); // survives other edits
    // Refusals.
    expect(code(() => applyOps(t, [{ op: 'add_clip', track_kind: 'sfx', media: POP, start_ms: 600, duration_ms: 300 }], ids))).toBe('EDIT_INVALID'); // overlaps another SFX
    expect(code(() => validateOps([{ op: 'add_clip', track_kind: 'sfx', media: POP, start_ms: 0, duration_ms: 300, volume: 2 }]))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t, validateOps([{ op: 'add_clip', track_kind: 'text', text: 'x', start_ms: 0, duration_ms: 300, volume: 0.5 }]), ids))).toBe('EDIT_INVALID');
    expect(code(() => validateOps([{ op: 'set_loudness', lufs: -3 }]))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t, validateOps([{ op: 'set_track_mute', track_kind: 'sfx', muted: true }]), ids))).toBe('OK');
    expect(checkPlan(t, [{ op: 'set_loudness', lufs: -14 }]).labels).toEqual(['Loudness akhir -14 LUFS']);
    const m = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    expect(() => validateProjectManifest({ ...m, timeline: { tracks: [], loudness_lufs: 0 } })).toThrow();
  });

  it('render plan: SFX mixed with music; muted SFX track left out', () => {
    const t: Timeline = {
      tracks: [
        { track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 2000, media: V }] },
        { track_id: 'au', kind: 'audio', clips: [{ clip_id: 'b', start_ms: 0, end_ms: 2000, media: MUSIC, volume: 0.2 }] },
        { track_id: 'sfx', kind: 'sfx', clips: [{ clip_id: 'c', start_ms: 500, end_ms: 800, media: POP }] },
      ],
    };
    const probe = { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' };
    const inputs = new Map([V, MUSIC, POP].map((r) => [r.version_id, { path: `C:/${r.version_id}.mp4`, probe }]));
    const plan = (tl: Timeline) => buildRenderPlan(tl, inputs, { ...DEFAULT_RENDER, short_side: 360 }, 'C:/f/arialbd.ttf').graph;
    const g = plan(t);
    expect(g).toContain('amix=inputs=3');
    expect(g).toContain('adelay=delays=500');
    // Loudness is a second pass after encoding (normalizeLoudness), never inside the main graph.
    expect(plan({ ...t, loudness_lufs: -14 })).not.toContain('loudnorm');
    expect(plan({ ...t, tracks: t.tracks.map((x) => (x.kind === 'sfx' ? { ...x, muted: true } : x)) })).toContain('amix=inputs=2');
  });

  it.skipIf(!hasFfmpeg)('real render: quiet music + SFX together, final mix measured at -14 LUFS', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[]) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const video = await gen('v.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-af', 'volume=0.05', '-c:v', 'libx264', '-c:a', 'aac', '-shortest']);
    const music = await gen('m.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', 'volume=0.05']);
    const pop = await gen('pop.wav', ['-f', 'lavfi', '-i', 'sine=f=1200:d=0.3']);
    await createProject(fx.ws, { project_id: 'mix', name: 'Mix' });
    await svc.editTimeline({
      project_id: 'mix',
      expected_revision: 0,
      actor: 'user',
      max_ops: 1000,
      ops: [
        { op: 'add_clip', track_kind: 'video', media: video, start_ms: 0, duration_ms: 4000 },
        { op: 'add_clip', track_kind: 'audio', media: music, start_ms: 0, duration_ms: 4000 },
        { op: 'add_clip', track_kind: 'sfx', media: pop, start_ms: 1000, duration_ms: 300 },
        { op: 'add_clip', track_kind: 'sfx', media: pop, start_ms: 2500, duration_ms: 300 },
        { op: 'set_loudness', lufs: -14 },
      ],
    });
    const r = await renderProject(fx.ws, { project_id: 'mix', output_name: 'mix.mp4', actor: 'user' }, { settings: { short_side: 144, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'mix'))[0]!.rel);
    const log = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr;
    const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf('Summary')))?.[1]);
    expect(Math.abs(integrated - -14)).toBeLessThan(1.5);
    // The SFX is there: the 1,2 kHz beep window is louder than the window before it.
    const vol = (from: number) => Number(/mean_volume: (-?[\d.]+)/.exec(spawnSync(FFMPEG, ['-hide_banner', '-ss', String(from), '-t', '0.25', '-i', out, '-af', 'highpass=f=1000,volumedetect', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr)?.[1]);
    expect(vol(1.02) - vol(0.5)).toBeGreaterThan(15);
  }, 90_000);
});
