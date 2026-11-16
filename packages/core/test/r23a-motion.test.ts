import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atempoChain, orientFilters, sliceIn, sourceAt, sourceLength } from '../src/storage/clipMotion.js';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, editManifest, stepHistory, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * R23a (owner 16 Nov, alat edit gaya CapCut): putar / balik, kecepatan 0,1×–10×, mundur, bekukan
 * frame, reduksi noise gambar — validasi di core, satu edit = satu undo, render FFmpeg = pratinjau.
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
const SRC = () => 8000;
const build = (ops: unknown[]) => applyOps({ tracks: [] }, validateOps(ops), ids, SRC);
const BASE = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
const vclips = (t: Timeline) => t.tracks.find((x) => x.kind === 'video')!.clips;

describe('R23a ops: validasi, panjang klip, peta sumber', () => {
  it('set_motion validates values and refuses non-video clips', () => {
    for (const bad of [
      { op: 'set_motion', clip_id: 'a' },
      { op: 'set_motion', clip_id: 'a', rotate: 45 },
      { op: 'set_motion', clip_id: 'a', speed: 0.05 },
      { op: 'set_motion', clip_id: 'a', speed: 12 },
      { op: 'set_motion', clip_id: 'a', vdenoise: 'kuat' },
      { op: 'set_motion', clip_id: 'a', flip_h: 'ya' },
      { op: 'freeze_frame', clip_id: 'a', at_ms: 0, duration_ms: 50 },
      { op: 'freeze_frame', clip_id: 'a', at_ms: 0, duration_ms: 20_000 },
      { op: 'add_clip', track_kind: 'music', media: V, start_ms: 0, duration_ms: 500, reverse: true }, // R23b: speed IS allowed on sound clips
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, freeze: true, speed: 2 },
    ]) expect(code(() => validateOps([bad])), JSON.stringify(bad)).toMatch(/^EDIT_INVALID/);
    const t = build([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'audio', media: V, start_ms: 0, duration_ms: 2000 },
    ]);
    const aud = t.tracks.find((x) => x.kind === 'audio')!.clips[0]!.clip_id;
    expect(code(() => applyOps(t, validateOps([{ op: 'set_motion', clip_id: aud, rotate: 90 }]), ids))).toMatch(/hanya bisa diubah kecepatannya/); // R23b: a sound clip only has a speed
  });

  it('speed changes the clip length (same source), later clips follow; 1 = off; undo restores', () => {
    const t0 = build([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000, keyframes: [{ at_ms: 0, x: 0, y: 0, scale: 1, opacity: 1, ease: 'linear' }, { at_ms: 2000, x: 0, y: 0, scale: 1.5, opacity: 1, ease: 'linear' }] },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 2000, duration_ms: 1000, in_ms: 3000 },
      { op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 2500, duration_ms: 500 },
    ]);
    const [a, b] = vclips(t0);
    const t1 = applyOps(t0, validateOps([{ op: 'set_motion', clip_id: a!.clip_id, speed: 2 }]), ids, SRC);
    const [a1, b1] = vclips(t1);
    expect([a1!.start_ms, a1!.end_ms, a1!.speed, sourceLength(a1!)]).toEqual([0, 1000, 2, 2000]);
    expect([b1!.start_ms, b1!.end_ms]).toEqual([1000, 2000]); // rippled on its own track
    expect(t1.tracks.find((x) => x.kind === 'text')!.clips[0]!.start_ms).toBe(2500); // other tracks stay
    expect(a1!.keyframes!.map((k) => k.at_ms)).toEqual([0, 1000]); // curve follows the new length
    const t2 = applyOps(t1, validateOps([{ op: 'set_motion', clip_id: a!.clip_id, speed: 0.5 }]), ids, SRC);
    expect(vclips(t2)[0]!.end_ms).toBe(4000);
    expect(vclips(t2)[1]!.start_ms).toBe(4000);
    const t3 = applyOps(t2, validateOps([{ op: 'set_motion', clip_id: a!.clip_id, speed: 1 }]), ids, SRC);
    expect(vclips(t3)[0]!.speed).toBeUndefined();
    expect(vclips(t3)[0]!.end_ms).toBe(2000);
    // Source too short for the slowed-down span? No: the span is the same. Too long when trimmed out → refused.
    expect(code(() => applyOps(t1, validateOps([{ op: 'trim_clip', clip_id: a!.clip_id, edge: 'end', to_ms: 4500 }]), ids, SRC))).toMatch(/melebihi panjang video sumber/);
    // One edit = one undo step.
    const m0 = validateProjectManifest({ ...BASE, timeline: t0, snapshots: [] });
    const ctx = { now: 1, newId: () => `s_${++n}`, newClipId: ids, sourceDuration: SRC };
    const m1 = editManifest(m0, validateOps([{ op: 'set_motion', clip_id: a!.clip_id, speed: 2, rotate: 90, flip_h: true, vdenoise: 'ringan' }]), 'Putar / kecepatan / mundur', ctx);
    expect(vclips(m1.timeline)[0]).toMatchObject({ speed: 2, rotate: 90, flip_h: true, vdenoise: 'ringan' });
    expect(vclips(stepHistory(m1, 'undo', ctx).timeline)[0]).toEqual(vclips(m0.timeline)[0]);
    expect(b).toBeTruthy();
  });

  it('split / trim / cut keep the right part of the source with speed and reverse', () => {
    const c = { start_ms: 1000, end_ms: 3000, in_ms: 500, speed: 2 };
    expect([sourceAt(c, 0), sourceAt(c, 1000), sliceIn(c, 1000, 2000)]).toEqual([500, 2500, 2500]);
    const r = { ...c, reverse: true };
    expect([sourceAt(r, 0), sourceAt(r, 2000), sliceIn(r, 0, 1000), sliceIn(r, 1000, 2000)]).toEqual([4500, 500, 2500, 500]);
    expect(sourceAt({ ...c, speed: undefined, freeze: true }, 1500)).toBe(500);

    const t0 = build([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000, in_ms: 1000, speed: 2, reverse: true }]);
    const id = vclips(t0)[0]!.clip_id;
    // Source span 1000–5000 shown backwards; split at 500: left shows 5000→4000, right 4000→1000.
    const t1 = applyOps(t0, validateOps([{ op: 'split_clip', clip_id: id, at_ms: 500 }]), ids, SRC);
    expect(vclips(t1).map((x) => [x.in_ms, sourceLength(x), x.reverse, x.speed])).toEqual([[4000, 1000, true, 2], [1000, 3000, true, 2]]);
    // Trim the end of a reversed clip: its source start moves up.
    const t2 = applyOps(t0, validateOps([{ op: 'trim_clip', clip_id: id, edge: 'end', to_ms: 1500 }]), ids, SRC);
    expect([vclips(t2)[0]!.in_ms, sourceLength(vclips(t2)[0]!)]).toEqual([2000, 3000]);
    // Forward + speed: trim start moves the in-point by speed × delta.
    const t3 = build([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 2000, in_ms: 1000, speed: 2 }]);
    const t4 = applyOps(t3, validateOps([{ op: 'trim_clip', clip_id: vclips(t3)[0]!.clip_id, edge: 'start', to_ms: 500 }]), ids, SRC);
    expect(vclips(t4)[0]!.in_ms).toBe(2000);
    // remove_range in the middle of a sped-up clip.
    const t5 = applyOps(t3, validateOps([{ op: 'remove_range', from_ms: 500, to_ms: 1000 }]), ids, SRC);
    expect(vclips(t5).map((x) => [x.start_ms, x.end_ms, x.in_ms])).toEqual([[0, 500, 1000], [500, 1500, 3000]]);
  });

  it('reverse is capped at 10 s of source with a clear message', () => {
    const t = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 6000 }]), ids);
    const id = vclips(t)[0]!.clip_id;
    expect(vclips(applyOps(t, validateOps([{ op: 'set_motion', clip_id: id, reverse: true }]), ids))[0]!.reverse).toBe(true);
    // Slowing down keeps the source span (6 s); a longer clip (12 s of source) is refused.
    const slow = applyOps(t, validateOps([{ op: 'set_motion', clip_id: id, speed: 0.5 }, { op: 'set_motion', clip_id: id, reverse: true }]), ids);
    expect(sourceLength(vclips(slow)[0]!)).toBe(6000);
    expect(code(() => applyOps(t, validateOps([{ op: 'trim_clip', clip_id: id, edge: 'end', to_ms: 12_000 }, { op: 'set_motion', clip_id: id, reverse: true }]), ids))).toMatch(/Klip mundur maksimal 10 detik sumber \(sekarang 12,0 dtk\)/);
  });

  it('freeze_frame inserts a silent still of the playhead frame; later clips move right', () => {
    const t0 = build([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 3000, in_ms: 1000, look: 'hangat', rotate: 90 },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 3000, duration_ms: 1000 },
    ]);
    const id = vclips(t0)[0]!.clip_id;
    const t1 = applyOps(t0, validateOps([{ op: 'freeze_frame', clip_id: id, at_ms: 1200, duration_ms: 2000 }]), ids, SRC);
    expect(vclips(t1).map((x) => [x.start_ms, x.end_ms, x.in_ms ?? 0, !!x.freeze])).toEqual([
      [0, 1200, 1000, false],
      [1200, 3200, 2200, true],
      [3200, 5000, 2200, false],
      [5000, 6000, 0, false],
    ]);
    expect(vclips(t1)[1]).toMatchObject({ volume: 0, look: 'hangat', rotate: 90 });
    // A still has no speed / reverse.
    expect(code(() => applyOps(t1, validateOps([{ op: 'set_motion', clip_id: vclips(t1)[1]!.clip_id, speed: 2 }]), ids))).toMatch(/Potongan diam/);
    // Splitting / trimming a still keeps its frame.
    const t2 = applyOps(t1, validateOps([{ op: 'split_clip', clip_id: vclips(t1)[1]!.clip_id, at_ms: 2000 }]), ids, SRC);
    expect(vclips(t2).filter((x) => x.freeze).map((x) => x.in_ms)).toEqual([2200, 2200]);
    // Playhead outside the clip → refused; near the start → before the clip.
    expect(code(() => applyOps(t0, validateOps([{ op: 'freeze_frame', clip_id: id, at_ms: 3500, duration_ms: 1000 }]), ids))).toMatch(/Playhead harus di dalam/);
    const t3 = applyOps(t0, validateOps([{ op: 'freeze_frame', clip_id: id, at_ms: 40, duration_ms: 1000 }]), ids, SRC);
    expect(vclips(t3).slice(0, 2).map((x) => [x.start_ms, x.end_ms, x.in_ms, !!x.freeze])).toEqual([[0, 1000, 1000, true], [1000, 4000, 1000, false]]);
  });

  it('manifest keeps the new fields; old manifests stay valid; bad stored values are refused', () => {
    const tl = build([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 1000, speed: 1.5, flip_v: true, vdenoise: 'sedang' }]);
    const m = validateProjectManifest({ ...BASE, timeline: tl, snapshots: [] });
    expect(vclips(m.timeline)[0]).toMatchObject({ speed: 1.5, flip_v: true, vdenoise: 'sedang' });
    const broken = JSON.parse(JSON.stringify(tl));
    broken.tracks[0].clips[0].rotate = 33;
    expect(code(() => validateProjectManifest({ ...BASE, timeline: broken, snapshots: [] }))).toMatch(/^PROJECT_INVALID|^EDIT_INVALID/);
  });
});

describe('R23a filter FFmpeg (sama dengan pratinjau)', () => {
  it('orientation, atempo chain, plan pieces', () => {
    expect(orientFilters({ rotate: 90, flip_h: true })).toEqual(['transpose=clock', 'hflip']);
    expect(orientFilters({ rotate: 270 })).toEqual(['transpose=cclock']);
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(0.1)).toEqual(['atempo=0.5', 'atempo=0.5', 'atempo=0.5', 'atempo=0.8']);
    expect(atempoChain(10)).toEqual(['atempo=2', 'atempo=2', 'atempo=2', 'atempo=1.25']);
    const probe = { duration_ms: 8000, width: 320, height: 180, video_codec: 'h264', audio_codec: 'aac' };
    const inputs = new Map([['v_1', { path: 'C:/a.mp4', probe }]]);
    const t = build([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 1000, speed: 2, rotate: 90, vdenoise: 'ringan' },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 1000, duration_ms: 1000, reverse: true },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 2000, duration_ms: 1000, freeze: true, in_ms: 500 },
    ]);
    const p = buildRenderPlan(t, inputs, { ...DEFAULT_RENDER, short_side: 180 }, null);
    expect(p.graph).toContain('transpose=clock,setpts=PTS/2,fps=30,hqdn3d=2:1.5:3:2.25');
    expect(p.graph).toContain('reverse,setpts=PTS-STARTPTS,fps=30');
    expect(p.graph).toContain('areverse');
    expect(p.graph).toContain('atempo=2');
    expect(p.graph).toContain('fps=30,trim=end_frame=1');
    // Source windows: 2 s read for the 1 s @2×; the still reads a few frames at 0.5 s.
    const ss = p.args.flatMap((a, i) => (a === '-ss' ? [[Number(p.args[i + 1]), Number(p.args[i + 3])]] : []));
    expect(ss[0]).toEqual([0, 2]);
    expect(ss[1]![0]).toBe(0);
    expect(ss[2]![0]).toBe(0.5);
    expect(p.total_frames).toBe(90);
  });
});

describe.skipIf(!hasFfmpeg)('R23a render nyata FFmpeg (kecil)', () => {
  const setup = async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const gen = async (name: string, args: string[]) => {
      const f = path.join(fx.src, name);
      execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const render = async (pid: string, ops: unknown[], short = 180) => {
      await createProject(fx.ws, { project_id: pid, name: pid });
      await svc.editTimeline({ project_id: pid, expected_revision: 0, actor: 'user', ops: ops as never });
      const res = await renderProject(fx.ws, { project_id: pid, output_name: `${pid}.mp4`, actor: 'user' }, { settings: { short_side: short, preset: 'ultrafast' } });
      expect(res.status).toBe('completed');
      return path.join(fx.ws.root, (await listOutputs(fx.ws, pid))[0]!.rel);
    };
    return { gen, render };
  };
  const frame = (file: string, t: number, w: number) => ({ b: execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 }), w });
  const px = (f: { b: Buffer; w: number }, x: number, y: number) => {
    const i = (y * f.w + x) * 3;
    return [f.b[i]!, f.b[i + 1]!, f.b[i + 2]!] as [number, number, number];
  };
  const dur = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true }).toString().trim());
  const pcm = (file: string) => {
    const b = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true, maxBuffer: 1 << 26 });
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  };
  const rms = (s: Int16Array, from: number, to: number) => {
    let acc = 0;
    const a = Math.floor(from * 8000);
    const b = Math.floor(to * 8000);
    for (let i = a; i < b; i++) acc += (s[i]! / 32768) ** 2;
    return Math.sqrt(acc / Math.max(1, b - a));
  };

  it('speed 2× / reverse / freeze: right frames at the right time, total length kept, sound follows', async () => {
    const { gen, render } = await setup();
    // Brightness = frame number × 2 (30 fps, 4 s): the picture tells which source frame is shown.
    // Sound: tone for the first second only, then silence.
    const ramp = await gen('ramp.mp4', ['-f', 'lavfi', '-i', "nullsrc=s=180x320:r=30:d=4,geq=lum='min(235\\,16+N*2)':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000,apad=whole_dur=4', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '8', '-c:a', 'aac']);
    const out = await render('motion', [
      { op: 'add_clip', track_kind: 'video', media: ramp, start_ms: 0, duration_ms: 1000, speed: 2 }, // source 0–2 s
      { op: 'add_clip', track_kind: 'video', media: ramp, start_ms: 1000, duration_ms: 1000, reverse: true }, // source 1→0 s backwards
      { op: 'add_clip', track_kind: 'video', media: ramp, start_ms: 2000, duration_ms: 1000, freeze: true, in_ms: 1000 }, // still of source 1 s
    ]);
    expect(dur(out)).toBeGreaterThan(2.95);
    expect(dur(out)).toBeLessThan(3.1);
    const lum = (t: number) => px(frame(out, t, 180), 90, 160)[1];
    // Source frame N shows as ≈ 2.33·N in RGB (Y = 16 + 2N, limited range).
    const near = (t: number, N: number) => expect(Math.abs(lum(t) - 2.33 * N), `t=${t} N=${N} lum=${lum(t)}`).toBeLessThan(12);
    // 2×: at 0.5 s the source is at 1 s (frame 30); without speed it would be frame 15.
    near(0.5, 30);
    near(0.9, 54);
    // Reverse: starts near source 1 s and goes down to frame ~0.
    near(1.05, 28);
    near(1.5, 15);
    near(1.9, 3);
    // Freeze: the same frame (source 1 s) for the whole second.
    expect(Math.abs(lum(2.1) - lum(2.9))).toBeLessThan(3);
    near(2.5, 30);
    // Sound: 2× plays the 1 s tone in the first 0.5 s; reverse plays silence first, tone at its end; still = silent.
    const s = pcm(out);
    expect(rms(s, 0.1, 0.4)).toBeGreaterThan(0.05);
    expect(rms(s, 0.6, 0.95)).toBeLessThan(0.02);
    expect(rms(s, 1.1, 1.9)).toBeGreaterThan(0.05); // reversed source 1→0 s is all tone
    expect(rms(s, 2.1, 2.9)).toBeLessThan(0.02);
  }, 120_000);

  it('rotate 90° and flip turn the picture like the preview', async () => {
    const { gen, render } = await setup();
    // Portrait source: red top half, blue bottom half; left quarter green.
    const src = await gen('tb.mp4', ['-f', 'lavfi', '-i', "nullsrc=s=180x320:r=30:d=2,geq=r='if(lt(Y\\,160)\\,220\\,30)':g='if(lt(X\\,45)\\,200\\,30)':b='if(lt(Y\\,160)\\,30\\,220)'", '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '8']);
    const out = await render('orient', [
      { op: 'add_clip', track_kind: 'video', media: src, start_ms: 0, duration_ms: 1000, rotate: 90, fit: 'isi' },
      { op: 'add_clip', track_kind: 'video', media: src, start_ms: 1000, duration_ms: 1000, flip_v: true },
    ]);
    // 90° clockwise: the top (red) ends up on the right, the bottom (blue) on the left.
    const r = frame(out, 0.5, 180);
    expect(px(r, 170, 160)[0]).toBeGreaterThan(150);
    expect(px(r, 10, 160)[2]).toBeGreaterThan(150);
    // Upside down: blue on top, red at the bottom.
    const f = frame(out, 1.5, 180);
    expect(px(f, 120, 40)[2]).toBeGreaterThan(150);
    expect(px(f, 120, 280)[0]).toBeGreaterThan(150);
  }, 120_000);
});
