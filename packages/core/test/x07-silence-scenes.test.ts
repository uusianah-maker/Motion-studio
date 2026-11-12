import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeMedia, cutOps, parseDetectLog, validateParams } from '../src/storage/analysis.js';
import { checkPlan } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
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
const M = { media_id: 'm_1', version_id: 'v_1' };
const span = (t: Timeline, kind: string) => t.tracks.find((x) => x.kind === kind)!.clips.map((c) => [c.start_ms, c.end_ms, c.in_ms ?? null, c.text ?? null]);

describe('X07 silence & scene detection → review cuts', () => {
  const base: Timeline = applyOps(
    { tracks: [] },
    [
      { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 10_000 },
      { op: 'add_clip', track_kind: 'audio', media: { media_id: 'm_2', version_id: 'v_2' }, start_ms: 0, duration_ms: 10_000 },
      { op: 'add_clip', track_kind: 'text', text: 'Judul', start_ms: 2000, duration_ms: 4000 },
      { op: 'add_clip', track_kind: 'subtitle', text: 'Sub', start_ms: 7000, duration_ms: 2000 },
    ],
    ids,
  );

  it('remove_range ripples every track: media split with source offsets kept, text shortened, later clips moved; pure', () => {
    const t = applyOps(base, validateOps([{ op: 'remove_range', from_ms: 3000, to_ms: 4000 }]), ids);
    expect(span(t, 'video')).toEqual([
      [0, 3000, 0, null],
      [3000, 9000, 4000, null],
    ]);
    expect(span(t, 'audio')).toEqual([
      [0, 3000, 0, null],
      [3000, 9000, 4000, null],
    ]);
    expect(span(t, 'text')).toEqual([[2000, 5000, null, 'Judul']]);
    expect(span(t, 'subtitle')).toEqual([[6000, 8000, null, 'Sub']]);
    expect(span(base, 'video')).toEqual([[0, 10_000, 0, null]]); // undo-safe: input untouched
    // A cut covering a whole text clip removes it; a cut starting inside a clip trims it.
    const t2 = applyOps(base, [{ op: 'remove_range', from_ms: 1500, to_ms: 6500 }], ids);
    expect(span(t2, 'text')).toEqual([]);
    expect(span(t2, 'subtitle')).toEqual([[2000, 4000, null, 'Sub']]);
    expect(code(() => validateOps([{ op: 'remove_range', from_ms: 3000, to_ms: 3050 }]))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(base, [{ op: 'remove_range', from_ms: 20_000, to_ms: 21_000 }], ids))).toBe('EDIT_INVALID');
  });

  it('split_at splits whatever clip covers the time; refuses empty spots', () => {
    const t = applyOps(base, validateOps([{ op: 'split_at', track_kind: 'video', at_ms: 2500 }]), ids);
    expect(span(t, 'video')).toEqual([
      [0, 2500, 0, null],
      [2500, 10_000, 2500, null],
    ]);
    expect(code(() => applyOps(base, [{ op: 'split_at', track_kind: 'subtitle', at_ms: 1000 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => validateOps([{ op: 'split_at', track_kind: 'stage', at_ms: 1 }]))).toBe('EDIT_INVALID');
  });

  it('parses FFmpeg silencedetect/showinfo output; silence running to the end is closed', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: 1.002',
      '[silencedetect @ 0x1] silence_end: 2.498 | silence_duration: 1.496',
      '[Parsed_showinfo_2 @ 0x2] n:   0 pts:  52 pts_time:1.733 duration: 1',
      '[Parsed_showinfo_2 @ 0x2] n:   1 pts:  52 pts_time:1.733 duration: 1',
      '[silencedetect @ 0x1] silence_start: 9.5',
    ].join('\n');
    expect(parseDetectLog(log, 10_000)).toEqual({
      silences: [
        { from_ms: 1002, to_ms: 2498 },
        { from_ms: 9500, to_ms: 10_000 },
      ],
      scenes: [1733],
    });
    expect(validateParams({ noise_db: -40 })).toEqual({ noise_db: -40, min_silence_ms: 600, scene_threshold: 0.3 });
    for (const bad of [{ noise_db: 0 }, { min_silence_ms: 50 }, { scene_threshold: 2 }, { shell: 'rm' }, { noise_db: '-30' }]) expect(code(() => validateParams(bad)), JSON.stringify(bad)).toBe('EDIT_INVALID');
  });

  it('cutOps: maps source time through the clip trim/position, pads, merges, drops slivers, splits at scenes', () => {
    // Clip placed at 1 s on the timeline, showing source 2 s–12 s.
    const t: Timeline = { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'c', start_ms: 1000, end_ms: 11_000, in_ms: 2000, media: M }] }] };
    const r = cutOps(t, {
      clip_id: 'c',
      silences: [
        { from_ms: 4000, to_ms: 5000 }, // → timeline 3000–4000, padded 3150–3850
        { from_ms: 5000, to_ms: 5600 }, // overlaps after padding? 5150–5450 → timeline 4150–4450 (separate)
        { from_ms: 9000, to_ms: 9250 }, // too short after padding → dropped
        { from_ms: 0, to_ms: 1500 }, // outside the trimmed source → ignored
      ],
      scenes: [7000, 4500, 20_000],
      padding_ms: 150,
    });
    expect(r.ops).toEqual([
      { op: 'remove_range', from_ms: 4150, to_ms: 4450 },
      { op: 'remove_range', from_ms: 3150, to_ms: 3850 },
      // Scene at source 7 s = timeline 6 s, minus 1 s removed before it; source 4.5 s falls inside a cut.
      { op: 'split_at', track_kind: 'video', at_ms: 5000 },
    ]);
    expect(r.removed_ms).toBe(1000);
    expect(r.warnings).toEqual(['2 potongan adegan dilewati (di dalam jeda yang dihapus, di luar klip, atau terlalu dekat dengan potongan lain).']);
    const after = applyOps(t, r.ops, ids);
    expect(after.tracks[0]!.clips.map((c) => [c.start_ms, c.end_ms, c.in_ms])).toEqual([
      [1000, 3150, 2000],
      [3150, 3450, 4850],
      [3450, 5000, 5450],
      [5000, 10_000, 7000],
    ]);
    // The plan is a normal reviewed plan: valid, labelled, diffed.
    expect(checkPlan(t, r.ops, undefined, 1000).labels[0]).toMatch(/^Hapus 0:04,2–0:04,5 \(0,3 dtk\) di semua track$/);
    // Refusals.
    expect(code(() => cutOps(t, { clip_id: 'nope', silences: [], scenes: [] }))).toBe('EDIT_INVALID');
    expect(code(() => cutOps(t, { clip_id: 'c', silences: [], scenes: [] }))).toBe('EDIT_INVALID');
    expect(code(() => cutOps(t, { clip_id: 'c', silences: [{ from_ms: -1, to_ms: 5 }], scenes: [] }))).toBe('EDIT_INVALID');
    expect(code(() => cutOps(t, { clip_id: 'c', silences: [], scenes: [], padding_ms: 5000 }))).toBe('EDIT_INVALID');
    expect(code(() => cutOps(t, { clip_id: 'c', silences: [], scenes: [], hack: 1 }))).toBe('EDIT_INVALID');
    const textOnly: Timeline = { tracks: [{ track_id: 't', kind: 'text', clips: [{ clip_id: 'x', start_ms: 0, end_ms: 1000, text: 'a' }] }] };
    expect(code(() => cutOps(textOnly, { clip_id: 'x', silences: [], scenes: [] }))).toBe('EDIT_INVALID');
  });

  it.skipIf(!hasFfmpeg)('real media: finds the pause and the scene change; approved cuts render shorter; result cached', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const file = path.join(fx.src, 'talk.mp4');
    // tone 1 s · silence 1.5 s · tone 1 s ; red 1.75 s → blue 1.75 s
    execFileSync(
      FFMPEG,
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=160x288:r=30:d=1.75', '-f', 'lavfi', '-i', 'color=c=blue:s=160x288:r=30:d=1.75',
        '-filter_complex', '[1]atrim=0:1.5[s];[0][s][2]concat=n=3:v=0:a=1[a];[3][4]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', file],
      { windowsHide: true },
    );
    const imp = await svc.importMedia({ sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
    const a = await analyzeMedia(fx.ws, { version_id: imp.version.version_id });
    expect(a.cached).toBe(false);
    expect(a.has_audio && a.has_video).toBe(true);
    expect(a.silences).toHaveLength(1);
    expect(Math.abs(a.silences[0]!.from_ms - 1000)).toBeLessThan(120);
    expect(Math.abs(a.silences[0]!.to_ms - 2500)).toBeLessThan(120);
    expect(a.scenes).toHaveLength(1);
    expect(Math.abs(a.scenes[0]! - 1750)).toBeLessThan(80);
    expect((await analyzeMedia(fx.ws, { version_id: imp.version.version_id })).cached).toBe(true);
    expect((await analyzeMedia(fx.ws, { version_id: imp.version.version_id, params: { noise_db: -40 } })).cached).toBe(false);
    expect(await analyzeMedia(fx.ws, { version_id: 'v_nope' }).then(() => 'OK', (e) => e.code)).toBe('NOT_FOUND');

    await createProject(fx.ws, { project_id: 'cut', name: 'Cut' });
    const media = { media_id: imp.media.media_id, version_id: imp.version.version_id };
    await svc.editTimeline({ project_id: 'cut', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 3500 }] });
    const clip = (await readProject(fx.ws, 'cut')).timeline.tracks[0]!.clips[0]!;
    const plan = cutOps((await readProject(fx.ws, 'cut')).timeline, { clip_id: clip.clip_id, silences: a.silences, scenes: [], padding_ms: 150 });
    await svc.editTimeline({ project_id: 'cut', expected_revision: 1, actor: 'user', ops: plan.ops, max_ops: 1000 });
    const p = await readProject(fx.ws, 'cut');
    expect(p.timeline.tracks[0]!.clips).toHaveLength(2);
    const r = await renderProject(fx.ws, { project_id: 'cut', output_name: 'cut.mp4', actor: 'user' }, { settings: { short_side: 144, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'cut'))[0]!.rel);
    const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8', windowsHide: true }));
    expect(Math.abs(dur - (3.5 - plan.removed_ms / 1000))).toBeLessThan(0.15);
    expect(dur).toBeLessThan(2.5);
  }, 90_000);
});
