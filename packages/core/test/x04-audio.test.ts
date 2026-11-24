import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan, planLocal } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
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
const meanVolume = (file: string, from: number, dur: number): number => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' }).stderr;
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r);
  return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : NaN;
};
let n = 0;
const ids = () => `c_${++n}`;
const M = { media_id: 'm_1', version_id: 'v_1' };

describe('X04 audio volume & mute', () => {
  const base: Timeline = applyOps(
    { tracks: [] },
    [
      { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 4000 },
      { op: 'add_clip', track_kind: 'text', text: 'Hai', start_ms: 0, duration_ms: 1000 },
    ],
    ids,
  );
  const vid = base.tracks.find((t) => t.kind === 'video')!.clips[0]!.clip_id;
  const txt = base.tracks.find((t) => t.kind === 'text')!.clips[0]!.clip_id;

  it('set_volume / set_track_mute: validated, pure, 1 = default (field removed), split keeps volume', () => {
    const t1 = applyOps(base, validateOps([{ op: 'set_volume', clip_id: vid, volume: 0.333 }]), ids);
    expect(t1.tracks.find((t) => t.kind === 'video')!.clips[0]!.volume).toBe(0.33);
    expect(base.tracks.find((t) => t.kind === 'video')!.clips[0]!.volume).toBeUndefined();
    const t2 = applyOps(t1, [{ op: 'split_clip', clip_id: vid, at_ms: 2000 }], ids);
    expect(t2.tracks.find((t) => t.kind === 'video')!.clips.map((c) => c.volume)).toEqual([0.33, 0.33]);
    const t3 = applyOps(t1, [{ op: 'set_volume', clip_id: vid, volume: 1 }], ids);
    expect('volume' in t3.tracks.find((t) => t.kind === 'video')!.clips[0]!).toBe(false);
    const m = applyOps(base, validateOps([{ op: 'set_track_mute', track_kind: 'video', muted: true }]), ids);
    expect(m.tracks.find((t) => t.kind === 'video')!.muted).toBe(true);
    const u = applyOps(m, [{ op: 'set_track_mute', track_kind: 'video', muted: false }], ids);
    expect('muted' in u.tracks.find((t) => t.kind === 'video')!).toBe(false);
    // Refusals.
    for (const bad of [{ volume: 1.5 }, { volume: -0.1 }, { volume: '0.5' }, { volume: Number.NaN }]) {
      expect(code(() => validateOps([{ op: 'set_volume', clip_id: vid, ...bad }])), JSON.stringify(bad)).toBe('EDIT_INVALID');
    }
    expect(code(() => validateOps([{ op: 'set_track_mute', track_kind: 'text', muted: true }]))).toBe('EDIT_INVALID');
    expect(code(() => validateOps([{ op: 'set_track_mute', track_kind: 'audio', muted: 'ya' }]))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(base, [{ op: 'set_volume', clip_id: txt, volume: 0.5 }], ids))).toBe('EDIT_INVALID');
  });

  it('stored manifests validate volume and muted', () => {
    const b = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    const mk = (clip: Record<string, unknown>, kind = 'video', extra: Record<string, unknown> = {}) => ({ ...b, timeline: { tracks: [{ track_id: kind, kind, ...extra, clips: [{ clip_id: 'c1', start_ms: 0, end_ms: 1000, ...clip }] }] } });
    expect(code(() => validateProjectManifest(mk({ media: M, volume: 0.4 }, 'video', { muted: true })))).toBe('OK');
    expect(code(() => validateProjectManifest(mk({ media: M, volume: 2 })))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest(mk({ text: 'a', volume: 0.5 }, 'text')))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest(mk({ text: 'a' }, 'text', { muted: true })))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest(mk({ media: M }, 'video', { muted: 1 })))).toBe('PROJECT_INVALID');
  });

  it('render plan: per-clip gain, muted video track = silence, muted audio track skipped', () => {
    const t: Timeline = {
      tracks: [
        { track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 1000, media: M, volume: 0.25 }] },
        { track_id: 'au', kind: 'audio', clips: [{ clip_id: 'b', start_ms: 0, end_ms: 1000, media: M, volume: 0.5 }] },
      ],
    };
    const inputs = new Map([['v_1', { path: 'C:/s.mp4', probe: { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' } }]]);
    const plan = (tl: Timeline) => buildRenderPlan(tl, inputs, { ...DEFAULT_RENDER, short_side: 360 }, 'C:/f/arialbd.ttf').graph;
    const g = plan(t);
    expect(g).toContain('volume=0.25,apad');
    expect(g).toContain('volume=0.50,afade=t=out:st=0.980:d=0.020,apad'); // trimmed from a longer source: 20 ms anti-click fade
    expect(g).toContain('amix=inputs=2');
    const muted = plan({ tracks: t.tracks.map((tr) => ({ ...tr, muted: true })) });
    expect(muted).not.toContain('volume=0.25');
    expect(muted).toContain('volume=0.00');
    expect(muted).not.toContain('amix'); // the audio track's clip is dropped, not mixed at 0
    const plain = plan({ tracks: [{ ...t.tracks[0]!, clips: [{ ...t.tracks[0]!.clips[0]!, volume: undefined }] }] });
    expect(plain).not.toContain('volume=');
  });

  it('Copilot: "volume 40%", "bisukan", "bisukan track video" — clear labels; refuses a text clip', () => {
    const run = (p: string, sel?: string[]) => {
      const r = planLocal(p, { timeline: base, selected_clip_ids: sel });
      if (!r.ok) throw new Error(r.message);
      return r.ops;
    };
    expect(run('volume 40%', [vid])).toEqual([{ op: 'set_volume', clip_id: vid, volume: 0.4 }]);
    expect(run('bisukan klip ini', [vid])).toEqual([{ op: 'set_volume', clip_id: vid, volume: 0 }]);
    expect(run('bisukan track video')).toEqual([{ op: 'set_track_mute', track_kind: 'video', muted: true }]);
    expect(run('nyalakan suara track musik')).toEqual([{ op: 'set_track_mute', track_kind: 'music', muted: false }]); // U3: music has its own track
    const r = planLocal('volume 40%', { timeline: base, selected_clip_ids: [txt] });
    expect(r.ok ? 'OK' : r.message).toMatch(/Volume hanya untuk klip video\/audio/);
    const c = checkPlan(base, run('volume 40%; bisukan track video', [vid]));
    expect(c.labels).toEqual(['Volume klip video (0:00–0:04) → 40%', 'Bisukan track video']);
    expect(c.diff.map((d) => d.summary)).toEqual(['~ video: volume 100% → 40%', '~ track video: dibisukan']);
  });

  it.skipIf(!hasFfmpeg)('real render: half volume is ~6 dB quieter, a muted track is silent', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const tone = path.join(fx.src, 'tone.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', tone], { windowsHide: true });
    const imp = await svc.importMedia({ sourcePath: tone, scope: { kind: 'shared' }, actor: 'user' });
    const media = { media_id: imp.media.media_id, version_id: imp.version.version_id };
    await createProject(fx.ws, { project_id: 'aud', name: 'A' });
    await svc.editTimeline({
      project_id: 'aud',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 1000 },
        { op: 'add_clip', track_kind: 'video', media, start_ms: 1000, duration_ms: 1000 },
      ],
    });
    const p = (await readProject(fx.ws, 'aud')).timeline;
    const [c1, c2] = p.tracks.find((t) => t.kind === 'video')!.clips;
    await svc.editTimeline({ project_id: 'aud', expected_revision: 1, actor: 'user', ops: [{ op: 'set_volume', clip_id: c2!.clip_id, volume: 0.5 }] });
    let r = await renderProject(fx.ws, { project_id: 'aud', output_name: 'vol.mp4', actor: 'user' }, { settings: { short_side: 240, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    const file = (name: string) => listOutputs(fx.ws, 'aud').then((o) => path.join(fx.ws.root, o.find((x) => x.name === name)!.rel));
    const vol = await file('vol.mp4');
    const full = meanVolume(vol, 0.2, 0.6);
    const half = meanVolume(vol, 1.2, 0.6);
    expect(full).toBeGreaterThan(-40);
    expect(full - half).toBeGreaterThan(4.5);
    expect(full - half).toBeLessThan(7.5);
    await svc.editTimeline({ project_id: 'aud', expected_revision: 2, actor: 'user', ops: [{ op: 'set_track_mute', track_kind: 'video', muted: true }] });
    r = await renderProject(fx.ws, { project_id: 'aud', output_name: 'mute.mp4', actor: 'user' }, { settings: { short_side: 240, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    expect(meanVolume(await file('mute.mp4'), 0.2, 1.6)).toBeLessThan(-80);
    expect(c1!.clip_id).toBeTruthy();
  }, 90_000);
});
