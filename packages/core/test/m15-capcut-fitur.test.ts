import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { LOOKS, duckGainAt, effectiveLook, fadeFilter, fadeGainAt, lookCss, lookFilters, mergeRanges, readExtras, transitionCss, validateAdjust } from '../src/storage/clipLook.js';
import { validateBrandInput } from '../src/storage/brand.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject, speechRanges, transitionHalves, visualSegments } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps, editManifest, stepHistory, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/**
 * Malam 15 Nov — fitur pilihan owner dari audit CapCut (teknik saja, semua FFmpeg buatan sendiri):
 * fade + ducking, reduksi noise, latar blur / isi / warna, adjust, filter warna, transisi.
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
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
let n = 0;
const ids = () => `c_${++n}`;
const V = { media_id: 'm_1', version_id: 'v_1' };
const V2 = { media_id: 'm_2', version_id: 'v_2' };
const probe = { duration_ms: 8000, width: 640, height: 360, video_codec: 'h264', audio_codec: 'aac' };
const inputs = new Map([
  ['v_1', { path: 'C:/a.mp4', probe }],
  ['v_2', { path: 'C:/b.mp4', probe }],
]);

describe('validation + ops (aditif: proyek lama tetap valid)', () => {
  it('add_clip accepts the new fields only where they make sense', () => {
    const t = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 3000, fit: 'blur', adjust: { terang: 20 }, look: 'hangat', transition: { type: 'dissolve' }, fade_in_ms: 300, denoise: 'ringan' },
      { op: 'add_clip', track_kind: 'music', media: V2, start_ms: 0, duration_ms: 3000, fade_out_ms: 800 },
    ]), ids);
    const c = t.tracks.find((x) => x.kind === 'video')!.clips[0]!;
    expect(c).toMatchObject({ fit: 'blur', look: 'hangat', transition: { type: 'dissolve', ms: 500 }, fade_in_ms: 300, denoise: 'ringan' });
    expect(c.adjust).toEqual({ terang: 20, kontras: 0, saturasi: 0, suhu: 0, tajam: 0, vignette: 0 });
    // Picture fields are for video/b-roll, sound fields for media; bad values are refused.
    for (const bad of [
      { op: 'add_clip', track_kind: 'music', media: V2, start_ms: 0, duration_ms: 500, look: 'hangat' },
      { op: 'add_clip', track_kind: 'text', text: 'x', start_ms: 0, duration_ms: 500, fade_in_ms: 100 },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, look: 'clarendon' },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, adjust: { terang: 500 } },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, transition: { type: 'spin' } },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, transition: { type: 'wipe', ms: 50 } },
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 500, fit_color: 'red' },
      { op: 'set_audio', clip_id: 'a' },
      { op: 'set_picture', clip_id: 'a' },
      { op: 'set_ducking', on: true, level: 0.95 },
    ]) expect(code(() => validateOps([bad])), JSON.stringify(bad)).toBe('EDIT_INVALID');
    expect(validateAdjust({})).toEqual({ terang: 0, kontras: 0, saturasi: 0, suhu: 0, tajam: 0, vignette: 0 });
    expect(code(() => readExtras({ fit: 'isi' }, 'x', 'video', false))).toBe('EDIT_INVALID');
  });

  it('set_audio / set_picture / set_ducking set and clear; undo brings the old state back', () => {
    const t0 = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 3000 },
      { op: 'add_clip', track_kind: 'music', media: V2, start_ms: 0, duration_ms: 3000 },
    ]), ids);
    const vid = t0.tracks.find((x) => x.kind === 'video')!.clips[0]!.clip_id;
    const t1 = applyOps(t0, validateOps([
      { op: 'set_audio', clip_id: vid, fade_in_ms: 400, denoise: 'sedang' },
      { op: 'set_picture', clip_id: vid, fit: 'warna', fit_color: '#00FF00', look: 'sejuk', adjust: { kontras: 10 }, transition: { type: 'flash', ms: 300 } },
      { op: 'set_ducking', on: true, level: 0.25 },
    ]), ids);
    const c1 = t1.tracks.find((x) => x.kind === 'video')!.clips[0]!;
    expect(c1).toMatchObject({ fade_in_ms: 400, denoise: 'sedang', fit: 'warna', fit_color: '#00ff00', look: 'sejuk', transition: { type: 'flash', ms: 300 } });
    expect(t1.tracks.find((x) => x.kind === 'music')!.duck).toBe(0.25);
    const t2 = applyOps(t1, validateOps([
      { op: 'set_audio', clip_id: vid, fade_in_ms: 0, denoise: 'off' },
      { op: 'set_picture', clip_id: vid, fit: null, fit_color: null, look: null, adjust: { kontras: 0 }, transition: null },
      { op: 'set_ducking', on: false },
    ]), ids);
    const c2 = t2.tracks.find((x) => x.kind === 'video')!.clips[0]!;
    for (const k of ['fade_in_ms', 'denoise', 'fit', 'fit_color', 'look', 'adjust', 'transition']) expect(c2, k).not.toHaveProperty(k);
    expect(t2.tracks.find((x) => x.kind === 'music')!.duck).toBeUndefined();
    // Picture ops only for video/b-roll.
    const mus = t0.tracks.find((x) => x.kind === 'music')!.clips[0]!.clip_id;
    expect(code(() => applyOps(t0, validateOps([{ op: 'set_picture', clip_id: mus, look: 'hangat' }]), ids))).toBe('EDIT_INVALID');
    // Undo/redo via the history.
    const base = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [], timeline: t0 };
    const ctx = { now: 1, newId: ids, newClipId: ids };
    const m1 = editManifest(base, validateOps([{ op: 'set_picture', clip_id: vid, look: 'pastel' }]), 'Tampilan gambar', ctx);
    expect(m1.timeline.tracks.find((x) => x.kind === 'video')!.clips[0]!.look).toBe('pastel');
    const back = stepHistory(m1, 'undo', ctx);
    expect(back.timeline.tracks.find((x) => x.kind === 'video')!.clips[0]!.look).toBeUndefined();
    expect(stepHistory(back, 'redo', ctx).timeline.tracks.find((x) => x.kind === 'video')!.clips[0]!.look).toBe('pastel');
  });

  it('split: fade-in + transition stay at the start, fade-out goes to the end; look copied', () => {
    const t0 = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 4000, fade_in_ms: 500, fade_out_ms: 700, look: 'tegas', adjust: { suhu: 10 }, transition: { type: 'wipe', ms: 400 } }]), ids);
    const id = t0.tracks[0]!.clips[0]!.clip_id;
    const [l, r] = applyOps(t0, validateOps([{ op: 'split_clip', clip_id: id, at_ms: 2000 }]), ids).tracks[0]!.clips;
    expect([l!.fade_in_ms, l!.fade_out_ms, l!.transition?.type, l!.look]).toEqual([500, undefined, 'wipe', 'tegas']);
    expect([r!.fade_in_ms, r!.fade_out_ms, r!.transition, r!.look, r!.adjust?.suhu]).toEqual([undefined, 700, undefined, 'tegas', 10]);
    expect(r!.adjust).not.toBe(l!.adjust);
    const cut = applyOps(t0, validateOps([{ op: 'remove_range', from_ms: 1000, to_ms: 1500 }]), ids).tracks[0]!.clips;
    expect([cut[0]!.fade_out_ms, cut[1]!.fade_in_ms, cut[1]!.transition, cut[1]!.fade_out_ms]).toEqual([undefined, undefined, undefined, 700]);
  });

  it('manifest: old projects valid; new fields validated; engine plans with new fields pass checkPlan', () => {
    const base = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
    const tl = { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 500, media: V, look: 'adem', fit: 'isi', adjust: { terang: 5, kontras: 0, saturasi: 0, suhu: 0, tajam: 0, vignette: 0 } }] }, { track_id: 'm', kind: 'music', duck: 0.3, clips: [] }] };
    const m = validateProjectManifest({ ...base, timeline: tl });
    expect(m.timeline.tracks[0]!.clips[0]!.look).toBe('adem');
    expect(m.timeline.tracks[1]!.duck).toBe(0.3);
    expect(validateProjectManifest({ ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 500, media: V }] }] } }).timeline.tracks[0]!.clips[0]).toEqual({ clip_id: 'a', start_ms: 0, end_ms: 500, media: V });
    expect(code(() => validateProjectManifest({ ...base, timeline: { tracks: [{ track_id: 't', kind: 'text', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 500, text: 'x', look: 'hangat' }] }] } }))).toBe('PROJECT_INVALID');
    expect(code(() => validateProjectManifest({ ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', duck: 0.3, clips: [] }] } }))).toBe('PROJECT_INVALID');
    expect(checkPlan({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 1000, look: 'cerah', transition: { type: 'geser_kiri', ms: 600 } }, { op: 'set_ducking', on: true }]).labels).toHaveLength(2);
    // Brand Kit: default look, old kits valid.
    expect(validateBrandInput({ name: 'A' }).filter_bawaan).toBeNull();
    expect(validateBrandInput({ name: 'A', filter_bawaan: 'hangat' }).filter_bawaan).toBe('hangat');
    expect(code(() => validateBrandInput({ name: 'A', filter_bawaan: 'valencia' }))).not.toBe('OK');
  });
});

describe('shared math: preview = render', () => {
  it('fades, ducking curve, looks', () => {
    expect(fadeGainAt({ fade_in_ms: 1000 }, 250, 3000)).toBeCloseTo(0.25);
    expect(fadeGainAt({ fade_out_ms: 1000 }, 2500, 3000)).toBeCloseTo(0.5);
    expect(fadeGainAt({}, 10, 3000)).toBe(1);
    expect(fadeFilter({}, 1000)).toBe('');
    expect(fadeFilter({ fade_in_ms: 500, fade_out_ms: 500 }, 2000, 250)).toBe("volume='clip(min((t+0.2500)/0.5000,(2.0000-(t+0.2500))/0.5000),0,1)':eval=frame");
    const r = mergeRanges([[1000, 2000], [2200, 3000], [5000, 6000]]);
    expect(r).toEqual([[1000, 3000], [5000, 6000]]);
    expect(duckGainAt(r, 0.2, 0)).toBe(1);
    expect(duckGainAt(r, 0.2, 1500)).toBeCloseTo(0.2);
    expect(duckGainAt(r, 0.2, 900)).toBeCloseTo(0.6); // halfway down the 200 ms ramp
    expect(duckGainAt(r, 0.2, 4000)).toBe(1);
    // Looks: own presets; the brand default only when the clip has none; 'none' turns it off.
    expect(Object.keys(LOOKS)).toHaveLength(8);
    expect(effectiveLook({}, 'hangat').adjust.suhu).toBe(35);
    expect(effectiveLook({ look: 'none' }, 'hangat').adjust.suhu).toBe(0);
    expect(effectiveLook({ look: 'sejuk', adjust: { ...validateAdjust({ suhu: -80 }) } }).adjust.suhu).toBe(-100); // clamped
    expect(effectiveLook({ look: 'hitamputih' }).mono).toBe(true);
    expect(lookFilters(effectiveLook({}).adjust)).toBe('');
    expect(lookFilters(validateAdjust({ terang: 50, suhu: 50, tajam: 50, vignette: 50 }))).toBe('eq=brightness=0.100:contrast=1.000:saturation=1.000,colortemperature=temperature=5000:mix=1:pl=1,unsharp=5:5:0.75:5:5:0,vignette=angle=0.450');
    expect(lookCss(validateAdjust({ saturasi: -100 })).filter).toBe('saturate(0.000)');
    expect(lookCss(validateAdjust({}), true).filter).toBe('grayscale(1)');
    expect(transitionCss('flash', 0.5).flash).toBe(1);
    expect(transitionCss('geser_kiri', 0.25).transform).toBe('translateX(-25%)');
  });

  it('render plan: fit chains, brand look, ducking, transitions keep the total length', () => {
    const t: Timeline = {
      tracks: [
        { track_id: 'v', kind: 'video', clips: [
          { clip_id: 'a', start_ms: 0, end_ms: 1000, media: V, fit: 'blur' },
          { clip_id: 'b', start_ms: 1000, end_ms: 2000, media: V2, fit: 'isi', look: 'none', transition: { type: 'dissolve', ms: 400 } },
          { clip_id: 'c', start_ms: 2000, end_ms: 3000, media: V, fit: 'warna', fit_color: '#112233', transition: { type: 'flash', ms: 2000 } },
        ] },
        { track_id: 'm', kind: 'music', duck: 0.3, clips: [{ clip_id: 'm', start_ms: 0, end_ms: 3000, media: V2, fade_out_ms: 500 }] },
      ],
    };
    const plan = buildRenderPlan(t, inputs, { ...DEFAULT_RENDER, short_side: 360 }, null, null, { font: null, logo: null, look: 'hangat' });
    const g = plan.graph;
    expect(plan.total_frames).toBe(90);
    expect(g).toContain('gblur=sigma=13'); // blur background
    expect(g).toContain('force_original_aspect_ratio=increase,crop=360:640[ff1]'); // isi
    expect(g).toContain('color=0x112233');
    // Brand default look on a and c, not on b (look: none).
    expect(g.match(/colortemperature/g)).toHaveLength(2);
    // Dissolve 400 ms = 12 frames → h = 6: a runs 6 frames longer, b starts 6 frames earlier.
    expect(g).toContain('xfade=transition=fade:duration=0.4:offset=0.8[vx1]');
    // Flash wants 2 s but is limited by the clip lengths (b has 30 − 6 = 24 frames left).
    expect(g).toMatch(/xfade=transition=fadewhite:duration=1\.6:offset=1\.2\[vraw\]/);
    expect(transitionHalves(visualSegments(t, 30), 30, () => true)).toEqual([0, 6, 24]);
    expect(g).toContain("volume='1-0.700*"); // ducking under the video's own sound
    expect(speechRanges(t)).toEqual([[0, 3000]]);
    // Without transitions the graph is a plain concat.
    const plain = buildRenderPlan({ tracks: [t.tracks[0]!] .map((tr) => ({ ...tr, clips: tr.clips.map(({ transition: _, ...c }) => c) })) }, inputs, DEFAULT_RENDER, null).graph;
    expect(plain).not.toContain('xfade');
    expect(plain).toContain('concat=n=3:v=1:a=0[vraw]');
  });
});

describe.skipIf(!hasFfmpeg)('render nyata FFmpeg (kecil)', () => {
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
  const frame = (file: string, t: number, w: number, h: number) => ({ b: execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 }), w, h });
  const px = (f: { b: Buffer; w: number }, x: number, y: number) => {
    const i = (y * f.w + x) * 3;
    return [f.b[i]!, f.b[i + 1]!, f.b[i + 2]!] as [number, number, number];
  };
  const dur = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true }).toString().trim());

  it('fade in/out, ducking under speech, noise reduction', async () => {
    const { gen, render } = await setup();
    const tone = await gen('tone.m4a', ['-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000', '-c:a', 'aac']);
    const noise = await gen('noise.m4a', ['-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:a=0.05:r=48000', '-c:a', 'aac']);
    const talk = await gen('talk.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=160x288:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const out = await render('aud', [
      // 0–2 s: music fades in over 1 s; 2–4 s the "speaker" (silent video sound) is on screen → music ducks to 20 %.
      { op: 'add_clip', track_kind: 'music', media: tone, start_ms: 0, duration_ms: 4000, fade_in_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: talk, start_ms: 2000, duration_ms: 2000 },
      { op: 'set_ducking', on: true, level: 0.2 },
      // Noise: 4–5.5 s plain, 5.5–7 s with noise reduction.
      { op: 'add_clip', track_kind: 'audio', media: noise, start_ms: 4000, duration_ms: 1500 },
      { op: 'add_clip', track_kind: 'audio', media: noise, start_ms: 5500, duration_ms: 1500, in_ms: 1500, denoise: 'sedang', fade_out_ms: 300 },
    ]);
    const s = pcm(out);
    const full = rms(s, 1.3, 1.7);
    expect(rms(s, 0.05, 0.2)).toBeLessThan(full * 0.25); // fade in
    expect(rms(s, 0.45, 0.55)).toBeGreaterThan(full * 0.35);
    expect(rms(s, 0.45, 0.55)).toBeLessThan(full * 0.65);
    expect(rms(s, 2.5, 3.5)).toBeLessThan(full * 0.3); // ducked under speech
    expect(rms(s, 2.5, 3.5)).toBeGreaterThan(full * 0.1);
    expect(rms(s, 6.0, 6.5)).toBeLessThan(rms(s, 4.5, 5.0) * 0.6); // noise reduction
    expect(rms(s, 6.93, 7.0)).toBeLessThan(rms(s, 6.0, 6.5) * 0.5); // fade out at the end
  }, 120_000);

  it('fit isi / blur / warna, looks + adjust on the picture', async () => {
    const { gen, render } = await setup();
    // 16:9 source: red left half, blue right half, white square in the middle.
    const wide = await gen('wide.mp4', ['-f', 'lavfi', '-i', "nullsrc=s=320x180:r=30:d=6,geq=r='if(lt(X\\,160)\\,220\\,30)':g='30':b='if(lt(X\\,160)\\,30\\,220)'", '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '10']);
    const gray = await gen('gray.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    const out = await render('pic', [
      { op: 'add_clip', track_kind: 'video', media: wide, start_ms: 0, duration_ms: 1000, fit: 'isi' },
      { op: 'add_clip', track_kind: 'video', media: wide, start_ms: 1000, duration_ms: 1000, fit: 'blur' },
      { op: 'add_clip', track_kind: 'video', media: wide, start_ms: 2000, duration_ms: 1000, fit: 'warna', fit_color: '#00ff00' },
      { op: 'add_clip', track_kind: 'video', media: wide, start_ms: 3000, duration_ms: 1000, look: 'hitamputih' },
      { op: 'add_clip', track_kind: 'video', media: gray, start_ms: 4000, duration_ms: 1000, adjust: { suhu: 100 } },
      { op: 'add_clip', track_kind: 'video', media: gray, start_ms: 5000, duration_ms: 1000, adjust: { terang: 100 } },
    ]);
    // Canvas 180×320. Top band (y=20) is outside the fitted 180×101 picture.
    const isi = frame(out, 0.5, 180, 320);
    expect(px(isi, 40, 20)[0]).toBeGreaterThan(150); // filled: red reaches the top
    expect(px(isi, 140, 300)[2]).toBeGreaterThan(150);
    const blur = frame(out, 1.5, 180, 320);
    const top = px(blur, 40, 20);
    expect(top[0] + top[2]).toBeGreaterThan(80); // blurred copy behind, not black bars
    expect(px(blur, 40, 160)[0]).toBeGreaterThan(150); // sharp picture in the middle
    const bars = frame(out, 2.5, 180, 320);
    expect(px(bars, 90, 20)[1]).toBeGreaterThan(200); // green bars
    expect(px(bars, 90, 20)[0]).toBeLessThan(60);
    const mono = px(frame(out, 3.5, 180, 320), 40, 160);
    expect(Math.max(...mono) - Math.min(...mono)).toBeLessThan(12); // black and white
    const warm = px(frame(out, 4.5, 180, 320), 90, 160);
    expect(warm[0] - warm[2]).toBeGreaterThan(20); // warmer: more red than blue
    const bright = px(frame(out, 5.5, 180, 320), 90, 160);
    expect(bright[1]).toBeGreaterThan(150); // 128 → brighter
  }, 120_000);

  it('transisi dissolve / flash di titik potong; durasi total tetap', async () => {
    const { gen, render } = await setup();
    const red = await gen('red.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const blue = await gen('blue.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const out = await render('trans', [
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 1000, in_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 1000, duration_ms: 1000, transition: { type: 'dissolve', ms: 600 } },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 2000, duration_ms: 1000, transition: { type: 'flash', ms: 400 } },
    ]);
    expect(dur(out)).toBeGreaterThan(2.95);
    expect(dur(out)).toBeLessThan(3.1);
    const at = (t: number) => px(frame(out, t, 180, 320), 90, 160);
    expect(at(0.3)[0]).toBeGreaterThan(200); // red
    const mid = at(1.0); // middle of the dissolve: red and blue mixed
    expect(mid[0]).toBeGreaterThan(70);
    expect(mid[2]).toBeGreaterThan(70);
    expect(at(1.6)[2]).toBeGreaterThan(200); // blue
    const flash = at(2.0);
    expect(Math.min(...flash)).toBeGreaterThan(150); // white flash at the cut
    expect(at(2.6)[0]).toBeGreaterThan(200);
  }, 120_000);
});
