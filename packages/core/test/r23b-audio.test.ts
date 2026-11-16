import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EQ_PRESETS, audioFxFilters, eqPresetOf, previewAudioFx, validateEq } from '../src/storage/clipAudio.js';
import { isStorageError } from '../src/storage/errors.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, editManifest, stepHistory, validateOps } from '../src/storage/timeline.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R23b (owner 16 Nov): kecepatan klip suara, EQ sederhana (preset + 3 slider), "Perjelas suara" —
 * validasi di core, satu edit = satu undo, filter render = angka pratinjau.
 */
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
const V = { media_id: 'm_1', version_id: 'v_1' };
const BASE = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
const clipsOf = (t: Timeline, kind: string) => t.tracks.find((x) => x.kind === kind)!.clips;

describe('R23b validasi + edit', () => {
  it('eq / voice on media clips only; speed allowed on sound clips, other motion not', () => {
    expect(validateEq({ bass: 3.4 })).toEqual({ bass: 3, mid: 0, treble: 0 });
    for (const bad of [
      { op: 'set_audio', clip_id: 'a', eq: { bass: 20 } },
      { op: 'set_audio', clip_id: 'a', eq: { presence: 2 } },
      { op: 'set_audio', clip_id: 'a', voice: 'ya' },
      { op: 'add_clip', track_kind: 'text', text: 'x', start_ms: 0, duration_ms: 500, voice: true },
      { op: 'add_clip', track_kind: 'music', media: V, start_ms: 0, duration_ms: 500, rotate: 90 },
    ]) expect(code(() => validateOps([bad])), JSON.stringify(bad)).toMatch(/^EDIT_INVALID/);
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'music', media: V, start_ms: 0, duration_ms: 2000, speed: 0.5, eq: { bass: 6 } },
      { op: 'add_clip', track_kind: 'audio', media: V, start_ms: 0, duration_ms: 2000, voice: true },
    ]), ids);
    expect(clipsOf(t, 'music')[0]).toMatchObject({ speed: 0.5, eq: { bass: 6, mid: 0, treble: 0 } });
    expect(clipsOf(t, 'audio')[0]).toMatchObject({ voice: true });
    const a = clipsOf(t, 'audio')[0]!.clip_id;
    expect(code(() => applyOps(t, validateOps([{ op: 'set_motion', clip_id: a, rotate: 90 }]), ids))).toMatch(/hanya bisa diubah kecepatannya/);
    const t2 = applyOps(t, validateOps([{ op: 'set_motion', clip_id: a, speed: 2 }]), ids);
    expect([clipsOf(t2, 'audio')[0]!.end_ms, clipsOf(t2, 'audio')[0]!.speed]).toEqual([1000, 2]);
  });

  it('preset fills the sliders; flat / null clears; voice toggles; undo restores; manifest keeps it', () => {
    const t0 = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000 }]), ids);
    const id = clipsOf(t0, 'video')[0]!.clip_id;
    const m0 = validateProjectManifest({ ...BASE, timeline: t0 });
    const ctx = { now: 1, newId: () => `s_${++n}`, newClipId: ids };
    const m1 = editManifest(m0, validateOps([{ op: 'set_audio', clip_id: id, eq: EQ_PRESETS.radio.eq, voice: true }]), 'Suara', ctx);
    const c1 = clipsOf(m1.timeline, 'video')[0]!;
    expect([eqPresetOf(c1.eq), c1.voice]).toEqual(['radio', true]);
    expect(eqPresetOf({ bass: 1, mid: 0, treble: 0 })).toBeNull();
    expect(clipsOf(validateProjectManifest({ ...BASE, timeline: m1.timeline }).timeline, 'video')[0]).toMatchObject({ eq: EQ_PRESETS.radio.eq, voice: true });
    const m2 = editManifest(m1, validateOps([{ op: 'set_audio', clip_id: id, eq: { bass: 0, mid: 0, treble: 0 }, voice: false }]), 'Suara', ctx);
    expect(clipsOf(m2.timeline, 'video')[0]!.eq).toBeUndefined();
    expect(clipsOf(m2.timeline, 'video')[0]!.voice).toBeUndefined();
    expect(clipsOf(stepHistory(m2, 'undo', ctx).timeline, 'video')[0]).toMatchObject({ eq: EQ_PRESETS.radio.eq, voice: true });
    // Split keeps the sound settings on both halves.
    const t3 = applyOps(m1.timeline, validateOps([{ op: 'split_clip', clip_id: id, at_ms: 1000 }]), ids);
    expect(clipsOf(t3, 'video').map((c) => [eqPresetOf(c.eq), c.voice])).toEqual([['radio', true], ['radio', true]]);
  });

  it('render filters and preview nodes use the same numbers', () => {
    const f = audioFxFilters({ eq: { bass: 6, mid: -2, treble: 4 }, voice: true }, 'AFMT');
    expect(f).toEqual(['highpass=f=80', 'equalizer=f=250:t=q:w=1:g=-2', 'equalizer=f=3000:t=q:w=1:g=3', 'acompressor=threshold=-20dB:ratio=3:attack=10:release=150:makeup=2dB', 'loudnorm=I=-16:TP=-1.5:LRA=11', 'AFMT', 'bass=g=6:f=100', 'equalizer=f=1000:t=q:w=1:g=-2', 'treble=g=4:f=8000']);
    const p = previewAudioFx({ eq: { bass: 6, mid: -2, treble: 4 }, voice: true });
    expect(p.highpass).toBe(80);
    expect(p.bands.map((b) => [b.type, b.hz, b.db])).toEqual([['peaking', 250, -2], ['peaking', 3000, 3], ['lowshelf', 100, 6], ['peaking', 1000, -2], ['highshelf', 8000, 4]]);
    expect(audioFxFilters({}, 'AFMT')).toEqual([]);
    const probe = { duration_ms: 8000, width: 320, height: 180, video_codec: 'h264', audio_codec: 'aac' };
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 1000, voice: true },
      { op: 'add_clip', track_kind: 'music', media: V, start_ms: 0, duration_ms: 1000, speed: 2, eq: { bass: -6 } },
    ]), ids);
    const plan = buildRenderPlan(t, new Map([['v_1', { path: 'C:/a.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 180 }, null);
    expect(plan.graph).toContain('loudnorm=I=-16');
    expect(plan.graph).toMatch(/atempo=2,.*bass=g=-6:f=100/);
    const ss = plan.args.flatMap((a, i) => (a === '-ss' ? [Number(plan.args[i + 3])] : []));
    expect(ss[1]).toBe(2); // the 1 s music clip at 2× reads 2 s of source
  });
});

describe.skipIf(!hasFfmpeg)('R23b render nyata', () => {
  const setup = async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[]) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const render = async (pid: string, ops: unknown[]) => {
      await createProject(fx.ws, { project_id: pid, name: pid });
      await svc.editTimeline({ project_id: pid, expected_revision: 0, actor: 'user', ops: ops as never });
      const res = await renderProject(fx.ws, { project_id: pid, output_name: `${pid}.mp4`, actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
      expect(res.status).toBe('completed');
      return path.join(fx.ws.root, (await listOutputs(fx.ws, pid))[0]!.rel);
    };
    return { gen, render };
  };
  const pcm = (file: string) => {
    const b = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { windowsHide: true, maxBuffer: 1 << 26 });
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  };
  const rms = (s: Int16Array, from: number, to: number) => {
    let acc = 0;
    const a = Math.floor(from * 48000);
    const b = Math.floor(to * 48000);
    for (let i = a; i < b; i++) acc += (s[i]! / 32768) ** 2;
    return Math.sqrt(acc / Math.max(1, b - a));
  };
  /** Rough pitch: zero crossings / 2 per second. */
  const pitch = (s: Int16Array, from: number, to: number) => {
    let z = 0;
    for (let i = Math.floor(from * 48000) + 1; i < Math.floor(to * 48000); i++) if ((s[i - 1]! < 0) !== (s[i]! < 0)) z++;
    return z / 2 / (to - from);
  };

  it('sound clip at 2×: twice as fast, same pitch; EQ bass / radio; "Perjelas suara" lifts a quiet voice', async () => {
    const { gen, render } = await setup();
    // 0–1 s: 440 Hz for 1 s then silence (2 s source) at 2×; 1–4 s: 100 Hz flat / Bass / Radio; 4–6 s quiet voice plain / enhanced.
    const tone = await gen('tone.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000,apad=whole_dur=2']);
    const low = await gen('low.wav', ['-f', 'lavfi', '-i', 'sine=f=100:d=1:sample_rate=48000', '-af', 'volume=0.3']);
    const quiet = await gen('quiet.wav', ['-f', 'lavfi', '-i', 'sine=f=300:d=1:sample_rate=48000', '-af', 'volume=0.02']);
    const silent = await gen('bisu.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    const out = await render('aud', [
      { op: 'add_clip', track_kind: 'video', media: silent, start_ms: 0, duration_ms: 6000 },
      { op: 'add_clip', track_kind: 'audio', media: tone, start_ms: 0, duration_ms: 1000, speed: 2 },
      { op: 'add_clip', track_kind: 'audio', media: low, start_ms: 1000, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'audio', media: low, start_ms: 2000, duration_ms: 1000, eq: EQ_PRESETS.bass.eq },
      { op: 'add_clip', track_kind: 'audio', media: low, start_ms: 3000, duration_ms: 1000, eq: EQ_PRESETS.radio.eq },
      { op: 'add_clip', track_kind: 'audio', media: quiet, start_ms: 4000, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'audio', media: quiet, start_ms: 5000, duration_ms: 1000, voice: true },
    ]);
    const s = pcm(out);
    expect(rms(s, 0.05, 0.45)).toBeGreaterThan(0.04); // the 1 s tone fills the first half second
    expect(rms(s, 0.55, 0.95)).toBeLessThan(0.01); // then the source's silence
    expect(Math.abs(pitch(s, 0.05, 0.45) - 440)).toBeLessThan(25); // atempo keeps the pitch
    const flat = rms(s, 1.2, 1.8);
    expect(rms(s, 2.2, 2.8)).toBeGreaterThan(flat * 1.4); // Bass +6 dB at 100 Hz
    expect(rms(s, 3.2, 3.8)).toBeLessThan(flat * 0.6); // Radio cuts the low end (shelf corner = −6 dB)
    expect(rms(s, 5.2, 5.8)).toBeGreaterThan(rms(s, 4.2, 4.8) * 3); // loudnorm + compressor make-up
  }, 120_000);
});
