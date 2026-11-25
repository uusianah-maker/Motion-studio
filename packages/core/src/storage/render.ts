import { promises as fsp } from 'node:fs';
import { framingFilters } from './framing.js';
import { zoomExpr } from './effects.js';
import { DEFAULT_DUCK, type LookId, denoiseFilter, duckFilter, edgeFadeFilter, effectiveLook, effectiveLut, fadeFilter, fitFilters, lookFilters, pullOutFilter, speechRanges, xfadeTransition } from './clipLook.js';
export { speechRanges } from './clipLook.js';
import { cornerArgs, kfCorners, kfExpr, kfRotates, keyframeFilters } from './keyframes.js';
import { atempoChain, orientFilters, vdenoiseFilter } from './clipMotion.js';
import { stabilPath, stabilReady } from './stabil.js';
import { chromaFilter } from './chroma.js';
import { audioFxFilters } from './clipAudio.js';
import { type AssFonts, DEFAULT_FONT_INFO, buildAss, needsAss } from './ass.js';
import { readFontInfo } from './fontInfo.js';
import { type LogoCorner, brandRenderRefs, readBrandFor } from './brand.js';
import { contentEnd, overlayOrder, overlaySpan } from './overlay.js';
import os from 'node:os';
import path from 'node:path';
import { audit } from './audit.js';
import { setLeaseStatus } from './deps.js';
import { StorageError, isStorageError } from './errors.js';
import { guard } from './guard.js';
import { checkTools, findFont, measureLoudness, runFfmpeg, sourceMetadataMarkers, verifyCleanOutput } from './ffmpeg.js';
import type { Actor } from './permissions.js';
import { MEDIA_AREAS } from './permissions.js';
import { type PreflightResult, finishRender, startRender, verifyRenderSnapshot } from './preflight.js';
import { effectiveStyle, fontRef, layoutText } from './textStyle.js';
import { type MediaProbe, probeFile, probeImage } from './probe.js';
import { type CanvasRatio, type Clip, type Timeline, type Track } from './project.js';
import { loadRegistry } from './registry.js';
import { type Workspace, projectRel, readProject } from './workspace.js';

// ------------------------------------------------------------------ settings & geometry

export const RENDER_FPS = [24, 25, 30, 60] as const;
export type RenderFps = (typeof RENDER_FPS)[number];

export interface RenderSettings {
  /** Short side of the output in pixels (1080 = "1080p" for every ratio). */
  short_side: number;
  fps: RenderFps;
  /** x264 quality (lower = better/bigger). */
  crf: number;
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium';
}

const PRESETS: readonly RenderSettings['preset'][] = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];
export const DEFAULT_RENDER: RenderSettings = { short_side: 1080, fps: 30, crf: 20, preset: 'veryfast' };
const AUDIO_RATE = 48_000;

const RATIO_PARTS: Record<CanvasRatio, [number, number]> = { '9:16': [9, 16], '3:4': [3, 4], '1:1': [1, 1], '16:9': [16, 9] };

/** Output size for a canvas ratio; both sides even (H.264 4:2:0 needs it). */
export function canvasSize(ratio: CanvasRatio, shortSide: number): { width: number; height: number } {
  const [a, b] = RATIO_PARTS[ratio];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const short = even(shortSide);
  return a <= b ? { width: short, height: even((short * b) / a) } : { width: even((short * a) / b), height: short };
}

/** Same safe area as the preview (apps/web lib `safeInsets`): top, right, bottom, left in %. */
export const safeInsets = (ratio: CanvasRatio): [number, number, number, number] => (ratio === '9:16' ? [12, 14, 20, 6] : [5, 5, 5, 5]);

const clipsOf = (t: Timeline, kind: string): Clip[] => t.tracks.filter((x) => x.kind === kind).flatMap((x) => x.clips);
const clipAt = (clips: readonly Clip[], ms: number): Clip | null => clips.find((c) => ms >= c.start_ms && ms < c.end_ms) ?? null;

export const timelineEnd = (t: Timeline): number => contentEnd(t.tracks);

export interface VisualSegment {
  /** Frame range [from, to) on the output frame grid. */
  from_frame: number;
  to_frame: number;
  /** The clip on screen (b-roll over video, like the preview); null = black + silence. */
  clip: Clip | null;
}

/**
 * Split the timeline into runs where the same visual clip is on screen — exactly the preview's
 * rule: b-roll at time t, else the video track at t. The visual clip's own sound plays with it
 * (the preview plays the `<video>` element unmuted). Boundaries snap to the frame grid so audio
 * and video of every run have identical length and never drift.
 */
export function visualSegments(t: Timeline, fps: number): VisualSegment[] {
  const frame = (ms: number) => Math.round((ms * fps) / 1000);
  const total = frame(timelineEnd(t));
  const broll = clipsOf(t, 'broll');
  const video = clipsOf(t, 'video');
  const cuts = new Set<number>([0, total]);
  for (const c of [...broll, ...video]) for (const ms of [c.start_ms, c.end_ms]) cuts.add(Math.min(total, frame(ms)));
  const points = [...cuts].sort((a, b) => a - b);
  const out: VisualSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    if (b <= a) continue;
    const mid = ((a + 0.5) * 1000) / fps; // middle of the run's first frame
    const clip = clipAt(broll, mid) ?? clipAt(video, mid);
    const prev = out[out.length - 1];
    if (prev && prev.clip === clip && prev.to_frame === a) prev.to_frame = b;
    else out.push({ from_frame: a, to_frame: b, clip });
  }
  return out;
}

// ------------------------------------------------------------------ text layout

export { wrapText } from './textStyle.js';

// ------------------------------------------------------------------ FFmpeg plan

export interface PlanInput {
  /** Local path FFmpeg reads (a verified copy for remote backends). */
  path: string;
  probe: MediaProbe;
}

export interface RenderPlan {
  /** Arguments after the binary; the filter graph is read from `graph.txt` in the job folder. */
  args: string[];
  graph: string;
  /** Files to write into the job folder before running (text overlays). */
  files: { name: string; content: string }[];
  width: number;
  height: number;
  total_ms: number;
  total_frames: number;
}

const s6 = (n: number) => (Math.round(n * 1e6) / 1e6).toString();
const AFMT = `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`;

/** Output flags that strip every piece of metadata FFmpeg would copy or add (owner rule, W08). */
export const STRIP_METADATA_ARGS: readonly string[] = [
  '-map_metadata', '-1',
  '-map_chapters', '-1',
  '-fflags', '+bitexact',
  '-flags:v', '+bitexact',
  '-flags:a', '+bitexact',
  '-metadata:s:v', 'handler_name=',
  '-metadata:s:a', 'handler_name=',
  '-metadata:s:v', 'encoder=',
  '-metadata:s:a', 'encoder=',
  // x264 writes its version + full settings into an SEI NAL unit: drop SEI units.
  '-bsf:v', 'filter_units=remove_types=6',
];

/**
 * Timeline → one FFmpeg run. Visual runs (see `visualSegments`) are concatenated with their own
 * audio; audio-track clips are mixed on top at their timeline position; text/subtitle clips are
 * burned in with drawtext (text from files: no escaping, no `%` expansion). Pure function.
 */
/**
 * U3c: zoom effects (effects track) and frosted-glass text boxes, applied to the edited picture
 * BEFORE titles/captions are drawn, so text never zooms or blurs. `[vraw]` → `[vcat]`.
 */
function pictureEffects(t: Timeline, o: { W: number; H: number; fps: number; total_ms: number; ratio: string }): string[] {
  const { W, H } = o;
  const out: string[] = [];
  let label = 'vraw';
  const zooms = clipsOf(t, 'effects').filter((c) => c.effect && c.start_ms < o.total_ms);
  if (zooms.length) {
    // One expression for the whole video: the effect covering the frame's time (seconds), else 1
    // (effects never overlap). Commas inside expressions are escaped for the filtergraph.
    // Keluhan tim "zoom belum smooth": `zoompan` crops a whole-pixel window, so a slow zoom shook
    // (the window edge jumped ±1–2 px per frame). `perspective` maps the same window (same anchor
    // math as the preview's CSS transform-origin) with sub-pixel float coordinates + bicubic, and
    // only runs while an effect is on screen (`enable`). It has no `t`: its `in` counts every
    // input frame from 1 (also the disabled ones), and [vraw] is constant-rate from 0, so
    // t = (in−1)/fps.
    const T = `((in-1)/${o.fps})`;
    const when = (c: Clip, tv: string, sep = '\\,') => `between(${tv}${sep}${(c.start_ms / 1000).toFixed(3)}${sep}${(Math.min(c.end_ms, o.total_ms) / 1000 - 0.0005).toFixed(4)})`;
    const zz = zooms.reduceRight((acc, c) => `if(${when(c, T)}\\,${zoomExpr(c.effect!, c.start_ms, c.end_ms).replace(/\bt\b/g, T).replace(/,/g, '\\,')}\\,${acc})`, '1');
    const xx = zooms.reduceRight((acc, c) => `if(${when(c, T)}\\,${c.effect!.x}\\,${acc})`, '0.5');
    const yy = zooms.reduceRight((acc, c) => `if(${when(c, T)}\\,${c.effect!.y}\\,${acc})`, '0.5');
    // Visible window of the source: size W/z × H/z, left/top = (W − W/z)·x, (H − H/z)·y.
    const left = `(W-W/(${zz}))*(${xx})`;
    const top = `(H-H/(${zz}))*(${yy})`;
    const right = `${left}+W/(${zz})`;
    const bottom = `${top}+H/(${zz})`;
    const on = zooms.map((c) => when(c, 't', ',')).join('+');
    out.push(`[${label}]perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:sense=source:eval=frame:enable='${on}',setsar=1,format=yuv420p[vzoom]`);
    label = 'vzoom';
  }
  // Glass boxes: blur the picture under each text box that asks for it, for the clip's time.
  const short = Math.min(W, H);
  let k = 0;
  for (const kind of ['text', 'subtitle'] as const) {
    for (const c of clipsOf(t, kind)) {
      const s = effectiveStyle(kind, c.style);
      if (!s.bg_blur || !c.text?.trim() || c.start_ms >= o.total_ms) continue;
      const fs = Math.max(8, Math.round((short * s.size) / 100));
      const lines = layoutText(c.text, s, o.ratio).split('\n');
      const pad = Math.round(fs * 0.4);
      const bw = Math.min(W, Math.round(Math.max(...lines.map((l) => l.length)) * fs * 0.56 + 2 * pad));
      const bh = Math.min(H, Math.round(lines.length * fs * 1.2 + 2 * pad));
      const bx = Math.max(0, Math.min(W - bw, Math.round(s.x * W - bw / 2)));
      const by = Math.max(0, Math.min(H - bh, Math.round(s.y * H - bh / 2)));
      const sigma = Math.max(1, Math.round((s.bg_blur * short) / 1080));
      const en = `between(t,${(c.start_ms / 1000).toFixed(3)},${(Math.min(c.end_ms, o.total_ms) / 1000).toFixed(3)})`;
      out.push(`[${label}]split=2[gb${k}][gc${k}]`);
      out.push(`[gc${k}]crop=${bw}:${bh}:${bx}:${by},gblur=sigma=${sigma}[gl${k}]`);
      out.push(`[gb${k}][gl${k}]overlay=${bx}:${by}:enable='${en}'[g${k}]`);
      label = `g${k}`;
      k++;
    }
  }
  out.push(`[${label}]null[vcat]`);
  return out;
}

/** Upper bound on visual segments per render (Checkpoint E E4). */
export const MAX_RENDER_SEGMENTS = 200;

/** X06: Brand Kit pieces a render uses (local paths); `null` = not used / not set. */
export interface RenderBrand {
  font: string | null;
  /** U1: caption font (style `font: 'caption'`), copied as fontc<ext>. */
  font_caption?: string | null;
  logo: { path: string; corner: LogoCorner; size: number; opacity: number } | null;
  /** U3b: font families/metrics for libass captions (defaults: Arial metrics). */
  fonts?: Partial<AssFonts>;
  /** Malam 15 Nov: Brand Kit default colour look for video/b-roll clips without their own `look`. */
  look?: LookId | null;
  /** R38a: Aset fonts in the job folder by version id (file name there, e.g. `fonta_v_x.ttf`). */
  aset_fonts?: ReadonlyMap<string, string>;
  /** R38b: Brand default LUT + every LUT file copied into the job folder (version → file name). */
  lut?: { media_id: string; version_id: string } | null;
  luts?: ReadonlyMap<string, string>;
  /** R26: local file of each overlay media version; `still` = a picture (looped), else a video. */
  overlays?: ReadonlyMap<string, { path: string; still: boolean; w?: number; h?: number }>;
}

/** Frames of the incoming transition's half (h) per visual segment; 0 = hard cut. Total xfade = 2h. */
export function transitionHalves(segments: readonly VisualSegment[], fps: number, hasVideo: (c: Clip) => boolean): number[] {
  const half = segments.map(() => 0);
  for (let k = 1; k < segments.length; k++) {
    const seg = segments[k]!;
    const prev = segments[k - 1]!;
    const c = seg.clip;
    if (!c?.transition || !prev.clip || prev.clip === c || prev.to_frame !== seg.from_frame) continue;
    if (seg.from_frame !== Math.round((c.start_ms * fps) / 1000)) continue; // only at the clip's own start
    if (!hasVideo(c) || !hasVideo(prev.clip)) continue;
    const want = Math.round((c.transition.ms * fps) / 1000 / 2);
    const framesA = prev.to_frame - prev.from_frame - half[k - 1]!;
    const framesB = seg.to_frame - seg.from_frame;
    const h = Math.min(want, framesA, framesB);
    if (h >= 1) half[k] = h;
  }
  return half;
}

/** R23f: render input key of a stabilised copy. */
export const stabilKey = (versionId: string, level: string) => `${versionId}@stabil-${level}`;

export function buildRenderPlan(t: Timeline, inputs: ReadonlyMap<string, PlanInput>, settings: RenderSettings, font: string | null, regularFont: string | null = font, brand: RenderBrand = { font: null, logo: null }): RenderPlan {
  const fps = settings.fps;
  const ratio = t.canvas?.ratio ?? '9:16';
  const { width: W, height: H } = canvasSize(ratio, settings.short_side);
  const segments = visualSegments(t, fps);
  const total_frames = segments.length ? segments[segments.length - 1]!.to_frame : 0;
  if (total_frames < 1) throw new StorageError('PRECONDITION', 'Linimasa kosong, tidak ada yang dirender');
  // Checkpoint E E4: one FFmpeg input per visual segment; Windows caps a command line at 32,767
  // characters, so a very fragmented timeline is refused up front with a clear reason.
  if (segments.length > MAX_RENDER_SEGMENTS) {
    throw new StorageError('PRECONDITION', `Linimasa terlalu banyak potongan (${segments.length} segmen visual); maksimal ${MAX_RENDER_SEGMENTS} per render. Gabungkan sebagian klip dulu.`, { segments: segments.length });
  }
  const total_ms = Math.round((total_frames * 1000) / fps);
  const samplesPerFrame = AUDIO_RATE / fps;

  const args: string[] = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-n'];
  const graph: string[] = [];
  let inputCount = 0;
  const input = (src: PlanInput, fromMs: number, durMs: number) => {
    args.push('-ss', s6(Math.max(0, fromMs) / 1000), '-t', s6(durMs / 1000), '-i', src.path);
    return inputCount++;
  };
  const media = (c: Clip | null) => {
    if (!c?.media) return null;
    // R23f: a stabilised clip reads the stabilised copy of its media.
    const src = inputs.get(c.stabil ? stabilKey(c.media.version_id, c.stabil) : c.media.version_id);
    if (!src) throw new StorageError('PRECONDITION', 'Media klip tidak tersedia untuk render', { clip_id: c.clip_id });
    return src;
  };

  // X04: sound level per clip (0..1) and muted tracks.
  const trackOf = new Map<string, Track>();
  for (const tr of t.tracks) for (const c of tr.clips) trackOf.set(c.clip_id, tr);
  const gainOf = (c: Clip) => (trackOf.get(c.clip_id)?.muted ? 0 : (c.volume ?? 1));
  const gainFilter = (g: number) => (g === 1 ? '' : `,volume=${g.toFixed(2)}`);

  // Malam 15 Nov: transitions at cuts. The outgoing segment runs h frames longer and the incoming one
  // starts h frames earlier (more source, or its first frame held), so a 2h-frame xfade keeps the
  // total length — and the sound stays a plain cut, in sync.
  const half = transitionHalves(segments, fps, (c) => !!media(c)?.probe.video_codec);
  const extEnd = segments.map((_, k) => half[k + 1] ?? 0);
  const totals: number[] = [];
  segments.forEach((seg, k) => {
    const frames = seg.to_frame - seg.from_frame;
    const durMs = (frames * 1000) / fps;
    const samples = frames * samplesPerFrame;
    const src = media(seg.clip);
    const hasV = !!src?.probe.video_codec;
    const hasA = !!src?.probe.audio_codec;
    const startMs = (seg.from_frame * 1000) / fps;
    const pre = hasV ? half[k]! : 0;
    const post = hasV ? extEnd[k]! : 0;
    const total = frames + pre + post;
    totals.push(total);
    // Source position of the piece (with the pre-roll); before the source start = hold the first frame.
    // R23a: the source runs `speed` × faster; a reversed piece reads its span backwards and a frozen
    // one reads a single frame — both hold their first frame for the transition pre-roll.
    const c0 = seg.clip;
    const sp = c0?.speed ?? 1;
    const relStart = c0 ? startMs - c0.start_ms : 0;
    const inMs = c0?.in_ms ?? 0;
    let holdStart = 0;
    let srcFrom = 0;
    let srcDur = 0;
    if (c0?.freeze) {
      holdStart = pre;
      srcFrom = inMs;
      srcDur = Math.max(100, (3 * 1000) / fps);
    } else if (c0?.reverse) {
      holdStart = pre;
      const len = c0.end_ms - c0.start_ms;
      const relEnd = relStart + ((frames + post) * 1000) / fps;
      const to = inMs + (len - relStart) * sp;
      srcFrom = Math.max(0, inMs + (len - relEnd) * sp);
      srcDur = Math.max(0, to - srcFrom);
    } else if (c0) {
      srcFrom = inMs + (relStart - (pre * 1000) / fps) * sp;
      if (srcFrom < 0) {
        holdStart = Math.min(pre, Math.ceil((-srcFrom * fps) / (1000 * sp) - 1e-6));
        srcFrom = Math.max(0, srcFrom + ((holdStart * 1000) / fps) * sp);
      }
      srcDur = (((total - holdStart) * 1000) / fps) * sp;
    }
    const moving = !!c0 && (sp !== 1 || !!c0.reverse || !!c0.freeze);
    let idx = -1;
    if (src && seg.clip && (hasV || hasA)) idx = input(src, srcFrom, srcDur);
    // U3d: blur areas + crop of the source before it is fitted onto the canvas.
    const framing =
      hasV && seg.clip
        ? framingFilters({ crop: seg.clip.crop, blur: seg.clip.blur, srcStartMs: srcFrom, durMs: srcDur, shortSide: Math.min(src!.probe.width ?? 1080, src!.probe.height ?? 1080), inLabel: `fi${k}`, outLabel: `fo${k}`, id: `s${k}` })
        : null;
    if (framing) graph.push(`[${idx}:v:0]setpts=PTS-STARTPTS[fi${k}]`, ...framing);
    if (hasV) {
      const c = seg.clip!;
      // Malam 15 Nov: colour look (+ the brand's default look) on the source picture, then the fit.
      const lk = effectiveLook(c, brand.look ?? null);
      // R38b: colour LUT (clip > Brand default; look "none" switches the default off) after the look.
      const lutRef = effectiveLut(c, brand.lut ?? null);
      const lutFile = lutRef ? brand.luts?.get(lutRef.version_id) : undefined;
      const look = [lookFilters(lk.adjust, lk.mono, lk.tone), lutFile ? `lut3d=file=${lutFile}:interp=trilinear` : ''].filter(Boolean).join(',');
      // R23a: direction (after crop/blur, which are in source coordinates), reverse, speed, still, picture noise.
      const motion = [...orientFilters(c), ...(c.reverse ? ['reverse', 'setpts=PTS-STARTPTS'] : []), ...(sp !== 1 ? [`setpts=PTS/${s6(sp)}`] : [])].map((f) => `${f},`).join('');
      const vden = vdenoiseFilter(c.vdenoise);
      const head = `${framing ? `[fo${k}]` : `[${idx}:v:0]setpts=PTS-STARTPTS,`}${motion}fps=${fps}${c.freeze ? ',trim=end_frame=1' : ''}${vden ? `,${vden}` : ''}${look ? `,${look}` : ''}`;
      const tail = `setsar=1,format=yuv420p${holdStart ? `,tpad=start_mode=clone:start=${holdStart}` : ''},tpad=stop_mode=clone:stop=${total},trim=end_frame=${total},setpts=PTS-STARTPTS[v${k}]`;
      // Malam 15 Nov: keyframes move/scale/fade the fitted canvas picture (clip time at t = 0: srcFrom − in).
      const kf = c.keyframes?.length ? keyframeFilters(c.keyframes, { W, H, fps, frames: total - holdStart, offMs: relStart - ((pre - holdStart) * 1000) / fps, id: `s${k}`, inLabel: `kp${k}`, outLabel: `kq${k}` }) : null;
      const fitted = (label: string) => (kf ? [`[${label}]setsar=1[kp${k}]`, ...kf, `[kq${k}]${tail}`] : [`[${label}]${tail}`]);
      if (c.fit === 'isi' || c.fit === 'blur') {
        graph.push(`${head}[fp${k}]`, ...fitFilters(c.fit, c.fit_color, W, H, `s${k}`, `fp${k}`, `ff${k}`), ...fitted(`ff${k}`));
      } else {
        const bars = c.fit === 'warna' && c.fit_color ? `0x${c.fit_color.slice(1)}` : 'black';
        const fit = `${head},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bars}`;
        if (kf) graph.push(`${fit}[fz${k}]`, ...fitted(`fz${k}`));
        else graph.push(`${fit},${tail}`);
      }
    } else graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${s6(durMs / 1000)},format=yuv420p,setsar=1,trim=end_frame=${frames}[v${k}]`);
    if (hasA && !c0?.freeze) {
      const c = seg.clip!;
      const skip = (pre - holdStart) * samplesPerFrame;
      // R23b: voice enhancement + EQ after the noise reduction, before the fades.
      const fx = [denoiseFilter(c.denoise), ...audioFxFilters(c, AFMT), fadeFilter(c, c.end_ms - c.start_ms, startMs - c.start_ms)].filter(Boolean).map((f) => `,${f}`).join('');
      // R23a: reversed / sped-up sound (areverse + atempo chain), the pre-roll cut off afterwards.
      const head = moving ? `asetpts=PTS-STARTPTS,${AFMT}${c.reverse ? ',areverse' : ''}${atempoChain(sp).map((f) => `,${f}`).join('')}${skip ? `,atrim=start_sample=${skip}` : ''},asetpts=PTS-STARTPTS` : `${skip ? `atrim=start_sample=${skip},` : ''}asetpts=PTS-STARTPTS,${AFMT}`;
      graph.push(`[${idx}:a:0]${head}${gainFilter(gainOf(c))}${fx},apad,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${k}]`);
    } else graph.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,${AFMT},atrim=end_sample=${samples}[a${k}]`);
  });
  graph.push(`${segments.map((_, k) => `[a${k}]`).join('')}concat=n=${segments.length}:v=0:a=1[acat]`);
  // Hard cuts are concatenated; each transition joins two runs with one xfade.
  const groups: { labels: string[]; frames: number; into: number }[] = [];
  segments.forEach((_, k) => {
    if (k === 0 || half[k]! > 0) groups.push({ labels: [], frames: 0, into: k });
    const g = groups[groups.length - 1]!;
    g.labels.push(`[v${k}]`);
    g.frames += totals[k]!;
  });
  if (groups.length === 1) graph.push(`${groups[0]!.labels.join('')}concat=n=${segments.length}:v=1:a=0[vraw]`);
  else {
    let acc = '';
    let accFrames = 0;
    groups.forEach((g, i) => {
      const label = g.labels.length > 1 ? `vg${i}` : g.labels[0]!.slice(1, -1);
      if (g.labels.length > 1) graph.push(`${g.labels.join('')}concat=n=${g.labels.length}:v=1:a=0[${label}]`);
      if (i === 0) {
        acc = label;
        accFrames = g.frames;
        return;
      }
      const h = half[g.into]!;
      const tr = segments[g.into]!.clip!.transition!;
      const out = i === groups.length - 1 ? 'vraw' : `vx${i}`;
      // Keluhan tim: pull out zooms B (sub-pixel) before a plain fade, see pullOutFilter.
      const into = tr.type === 'pull_out' ? `${label}po` : label;
      if (tr.type === 'pull_out') graph.push(`[${label}]${pullOutFilter(2 * h)}[${into}]`);
      graph.push(`[${acc}][${into}]xfade=transition=${xfadeTransition(tr.type)}:duration=${s6((2 * h) / fps)}:offset=${s6((accFrames - 2 * h) / fps)}[${out}]`);
      acc = out;
      accFrames += g.frames - 2 * h;
    });
  }
  graph.push(...pictureEffects(t, { W, H, fps, total_ms, ratio }));

  // Audio track: mixed over the visual sound at its timeline position, like the preview.
  const mixes: string[] = [];
  // Malam 15 Nov: music ducking under speech (track.duck = music level while someone speaks).
  const musicTrack = t.tracks.find((x) => x.kind === 'music');
  const duckRanges = musicTrack?.duck !== undefined ? speechRanges(t, (c) => !!media(c)?.probe.audio_codec) : [];
  const duckLevel = musicTrack?.duck ?? DEFAULT_DUCK;
  for (const c of [...clipsOf(t, 'audio'), ...clipsOf(t, 'music'), ...clipsOf(t, 'sfx')]) {
    const src = media(c);
    const startFrame = Math.round((c.start_ms * fps) / 1000);
    const endFrame = Math.min(total_frames, Math.round((c.end_ms * fps) / 1000));
    if (!src?.probe.audio_codec || endFrame <= startFrame || gainOf(c) === 0) continue;
    const durMs = ((endFrame - startFrame) * 1000) / fps;
    // R23b: a sped-up / slowed-down sound clip reads speed × its length of source (atempo chain).
    const sp = c.speed ?? 1;
    const idx = input(src, c.in_ms ?? 0, durMs * sp);
    const delay = Math.round((startFrame * 1000) / fps);
    const isMusic = trackOf.get(c.clip_id)?.kind === 'music';
    // Keluhan tim "SFX terpotong kasar": a sound cut before its natural end (or started inside its
    // source) gets a 20 ms afade at that edge instead of a hard cut (a click), unless it has its own fade.
    const inMs = c.in_ms ?? 0;
    // A clip cut short by the end of the video never reaches its own fade-out: it gets the edge fade too.
    const cutByEnd = durMs < c.end_ms - c.start_ms - 1;
    const edge = edgeFadeFilter(cutByEnd ? { fade_in_ms: c.fade_in_ms } : c, { lenMs: durMs, cutStart: inMs > 0, cutEnd: cutByEnd || (src.probe.duration_ms - inMs) / sp > durMs + 5 });
    const fx = [denoiseFilter(c.denoise), ...audioFxFilters(c, AFMT), fadeFilter(c, c.end_ms - c.start_ms), edge, isMusic ? duckFilter(duckRanges, duckLevel, delay) : ''].filter(Boolean).map((f) => `,${f}`).join('');
    graph.push(`[${idx}:a:0]asetpts=PTS-STARTPTS,${AFMT}${atempoChain(sp).map((f) => `,${f}`).join('')}${gainFilter(gainOf(c))}${fx},apad,atrim=end_sample=${(endFrame - startFrame) * samplesPerFrame},adelay=delays=${delay}:all=1[m${mixes.length}]`);
    mixes.push(`[m${mixes.length}]`);
  }
  // U3: the final loudness (timeline.loudness_lufs) is applied after encoding, in two passes
  // (measure, then linear gain) — see `normalizeLoudness`; a single pass is inaccurate on short ads.
  graph.push(mixes.length ? `[acat]${mixes.join('')}amix=inputs=${mixes.length + 1}:duration=first:normalize=0:dropout_transition=0,${AFMT}[aout]` : `[acat]anull[aout]`);

  // Text + subtitles (X01): each clip's own style — the same layout function as the preview
  // (textStyle.ts), so line breaks, size and placement match what the editor shows.
  const files: { name: string; content: string }[] = [];
  const short = Math.min(W, H);
  /** Text filters in drawing order; a moving text (keyframes) is a picture layer overlaid in its place. */
  const draws: (string | { layer: string; enable: string })[] = [];
  const drawChain = (from: string, to: string): string[] => {
    const out: string[] = [];
    let cur = from;
    let run: string[] = [];
    let n = 0;
    for (const d of draws) {
      if (typeof d === 'string') {
        run.push(d);
        continue;
      }
      if (run.length) {
        out.push(`[${cur}]${run.join(',')}[td${n}]`);
        cur = `td${n++}`;
        run = [];
      }
      out.push(`[${cur}][${d.layer}]overlay=eof_action=pass:format=auto:enable='${d.enable}'[td${n}]`);
      cur = `td${n++}`;
    }
    out.push(`[${cur}]${run.length ? run.join(',') : 'null'}[${to}]`);
    return out;
  };
  const hex = (c: string) => `0x${c.slice(1)}`;
  const assClips: { kind: 'text' | 'subtitle'; clip: Clip }[] = [];
  for (const kind of ['text', 'subtitle'] as const) {
    for (const c of clipsOf(t, kind)) {
      if (!c.text?.trim() || c.start_ms >= total_ms) continue;
      if (!font) throw new StorageError('RENDER_UNAVAILABLE', 'Font untuk teks tidak ditemukan (set MOTION_FONT)');
      const s = effectiveStyle(kind, c.style);
      // U3b: captions with word timings / animation / keyword highlights go through libass.
      if (needsAss(s, c)) {
        assClips.push({ kind, clip: c });
        continue;
      }
      const fs = Math.max(8, Math.round((short * s.size) / 100));
      const name = `t${files.length}.txt`;
      files.push({ name, content: layoutText(c.text, s, ratio) });
      const look = [
        ...(s.bg ? [`box=1:boxcolor=${hex(s.bg)}@${s.bg_opacity}:boxborderw=${Math.round(fs * 0.4)}`] : []),
        ...(s.outline ? [`borderw=${Math.max(2, Math.round(fs * 0.06))}:bordercolor=black@0.8:shadowcolor=black@0.6:shadowy=${Math.round(fs * 0.08)}`] : []),
      ].join(':');
      const face = s.bold || !regularFont ? font : regularFont;
      // X06: the brand font when the style asks for it and the kit has one (else the default face).
      const aref = fontRef(s.font);
      const fontFile = aref && brand.aset_fonts?.get(aref.version_id)
        ? brand.aset_fonts.get(aref.version_id)!
        : s.font === 'brand' && brand.font
          ? `fontk${path.extname(brand.font).toLowerCase()}`
          : s.font === 'caption' && brand.font_caption
            ? `fontc${path.extname(brand.font_caption).toLowerCase()}`
            : `${s.bold || !regularFont ? 'fontb' : 'fontr'}${path.extname(face).toLowerCase()}`;
      // Malam 15 Nov: keyframes = moving/scaling/fading text (same curve as the preview).
      const kfs = c.keyframes?.length ? c.keyframes : null;
      const T = `(t-${s6(c.start_ms / 1000)})`;
      const kx = kfs ? `+(${kfExpr(kfs, 'x', T)})*${W}` : '';
      const ky = kfs ? `+(${kfExpr(kfs, 'y', T)})*${H}` : '';
      const size = kfs && kfs.some((k) => k.scale !== 1) ? `'max(4,${fs}*(${kfExpr(kfs, 'scale', T)}))'` : `${fs}`;
      const alpha = kfs && kfs.some((k) => k.opacity !== 1) ? `:alpha='${kfExpr(kfs, 'opacity', T)}'` : '';
      const moves = !!kfs && ((['x', 'y', 'scale'] as const).some((p) => kfs.some((k) => k[p] !== kfs[0]![p])) || kfRotates(kfs));
      if (moves) {
        // Keluhan tim "keyframe teks belum smooth": a per-frame `fontsize` jumps between whole font
        // sizes and drawtext x/y are whole pixels. Moving text is drawn ONCE at its normal size on a
        // transparent canvas layer, then scaled/moved as a picture with sub-pixel `perspective` (the
        // box/outline scale with it, like the preview's CSS transform) and laid over the video.
        const from = c.start_ms;
        const to = Math.min(c.end_ms, total_ms);
        const P = 4;
        const ax = Math.round(s.x * W) + P;
        const ay = Math.round(s.y * H) + P;
        const Tl = `((in-1)/${fps})`;
        const dx = `${ax}+(${kfExpr(kfs!, 'x', Tl)})*${W}`;
        const dy = `${ay}+(${kfExpr(kfs!, 'y', Tl)})*${H}`;
        const corners = cornerArgs(kfCorners(kfs!, Tl, dx, dy, [ax, W + P - ax + P, ay, H + P - ay + P]));
        const la = kfs!.some((k) => k.opacity !== 1) ? `:alpha='${kfExpr(kfs!, 'opacity', 't')}'` : '';
        const id = `tk${draws.length}`;
        graph.push(
          `color=c=black@0:s=${W}x${H}:r=${fps}:d=${s6((to - from) / 1000)},format=yuva420p,drawtext=fontfile=${fontFile}:textfile=${name}:expansion=none:fontsize=${fs}:fontcolor=${hex(s.color)}:line_spacing=${Math.round(fs * 0.15)}:text_align=${s.align === 'left' ? 'L' : s.align === 'right' ? 'R' : 'C'}:x=${Math.round(s.x * W)}-text_w/2:y=${Math.round(s.y * H)}-text_h/2${look ? `:${look}` : ''}${la},pad=${W + 2 * P}:${H + 2 * P}:${P}:${P}:color=black@0,perspective=${corners}:interpolation=cubic:sense=destination:eval=frame,crop=${W}:${H}:${P}:${P},setpts=PTS-STARTPTS+${s6(from / 1000)}/TB[${id}]`,
        );
        draws.push({ layer: id, enable: `gte(t,${s6(from / 1000)})*lt(t,${s6(to / 1000)})` });
        continue;
      }
      draws.push(
        `drawtext=fontfile=${fontFile}:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=${hex(s.color)}:line_spacing=${Math.round(fs * 0.15)}:text_align=${s.align === 'left' ? 'L' : s.align === 'right' ? 'R' : 'C'}:x=${kfs ? `'${Math.round(s.x * W)}-text_w/2${kx}'` : `${Math.round(s.x * W)}-text_w/2`}:y=${kfs ? `'${Math.round(s.y * H)}-text_h/2${ky}'` : `${Math.round(s.y * H)}-text_h/2`}${look ? `:${look}` : ''}${alpha}:enable='gte(t,${s6(c.start_ms / 1000)})*lt(t,${s6(c.end_ms / 1000)})'`,
      );
    }
  }
  if (assClips.length) {
    const f = brand.fonts ?? {};
    files.push({ name: 'captions.ass', content: buildAss({ clips: assClips, width: W, height: H, ratio, total_ms, fonts: { bold: f.bold ?? DEFAULT_FONT_INFO, regular: f.regular ?? { ...DEFAULT_FONT_INFO, bold: false }, brand: f.brand ?? null, caption: f.caption ?? null, ...(f.aset ? { aset: f.aset } : {}) } }) });
    // Fonts are looked up by family name among the files copied into the job folder.
    draws.push('ass=filename=captions.ass:fontsdir=.');
  }
  // R26: picture/video overlays over the text, back to front by layer (same box as the preview's
  // overlayBox: width % of W, height from the picture, preset corner + margin + nudge).
  const layers: { input: string; x: string; y: string; enable: string; blend?: string; opacity?: number }[] = [];
  // 25 Nov (objek di depan teks): the picture under the text (before any text) masked by the
  // engine's subject mask is laid back ON TOP of the text for the mask's span. A copy of [vcat] is
  // split off before the text is drawn, so the subject keeps every frame (the mask may be 15 fps).
  const depans = [...clipsOf(t, 'text'), ...clipsOf(t, 'subtitle')]
    .filter((c) => c.depan && c.text?.trim())
    .map((c) => {
      const d = c.depan!;
      const from = Math.max(d.dari_ms, c.start_ms);
      const to = Math.min(d.dari_ms + d.durasi_ms, c.end_ms, total_ms);
      return { c, d, from, to };
    })
    .filter((x) => x.to - x.from >= 40);
  let textIn = 'vcat';
  if (depans.length) {
    textIn = 'vcatT';
    graph.push(`[vcat]split=${depans.length + 1}[vcatT]${depans.map((_, i) => `[dp${i}]`).join('')}`);
    depans.forEach(({ d, from, to }, i) => {
      const src = brand.overlays?.get(d.masker.version_id);
      if (!src) throw new StorageError('PRECONDITION', 'Masker "objek di depan teks" tidak tersedia untuk render', { version_id: d.masker.version_id });
      const idx = inputCount++;
      // the mask file starts at d.dari_ms on the timeline
      args.push('-ss', s6((from - d.dari_ms) / 1000), '-t', s6((to - from) / 1000), '-i', src.path);
      const soft = d.halus > 0 ? `,boxblur=${Math.max(1, Math.round((d.halus * Math.min(W, H)) / 1080))}:1` : '';
      graph.push(`[dp${i}]trim=start=${s6(from / 1000)}:end=${s6(to / 1000)},setpts=PTS-STARTPTS,format=yuv420p[dpv${i}]`);
      graph.push(`[${idx}:v:0]setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:flags=bicubic,format=gray${soft}[dpm${i}]`);
      graph.push(`[dpv${i}][dpm${i}]alphamerge,setpts=PTS-STARTPTS+${s6(from / 1000)}/TB[dpo${i}]`);
      layers.push({ input: `dpo${i}`, x: '0', y: '0', enable: `between(t,${s6(from / 1000)},${s6(to / 1000)})` });
    });
  }
  overlayOrder(clipsOf(t, 'overlay')).forEach((c, k) => {
    const o = c.overlay;
    const src = c.media ? brand.overlays?.get(c.media.version_id) : undefined;
    if (!o || !src) throw new StorageError('PRECONDITION', 'Media overlay tidak tersedia untuk render', { clip_id: c.clip_id });
    const [from, to] = overlaySpan(c, total_ms);
    if (to <= from) return;
    const idx = inputCount++;
    if (src.still) args.push('-loop', '1', '-framerate', String(fps), '-t', s6(total_ms / 1000), '-i', src.path);
    else args.push('-ss', s6((c.in_ms ?? 0) / 1000), '-t', s6((to - from) / 1000), '-i', src.path);
    const ow = Math.max(2, Math.round((W * o.skala) / 100 / 2) * 2);
    const m = Math.round((short * o.margin) / 100);
    const nx = Math.round(o.dx * W);
    const ny = Math.round(o.dy * H);
    const off = (n: number) => (n ? (n > 0 ? `+${n}` : `${n}`) : '');
    const x = (o.pos === 'c' ? '(W-w)/2' : o.pos.endsWith('l') ? `${m}` : `W-w-${m}`) + off(nx);
    const y = (o.pos === 'c' ? '(H-h)/2' : o.pos.startsWith('t') ? `${m}` : `H-h-${m}`) + off(ny);
    // A video overlay starts at its clip's start (its own frames from in_ms); a picture is looped.
    const time = src.still ? '' : `setpts=PTS-STARTPTS+${s6(from / 1000)}/TB,fps=${fps},`;
    // R23e: chroma key before the scale (agreed with wawok, R26 chain).
    const key = c.chroma ? `${chromaFilter(c.chroma)},` : '';
    const enable = `between(t,${s6(from / 1000)},${s6(to / 1000)})`;
    if (o.blend && o.blend !== 'normal') {
      // R38b: a blend mode needs a full-canvas layer: pad with the mode's neutral colour (no change
      // where the effect is not), held from t = 0 so the blend never waits for it.
      const neutral = o.blend === 'multiply' ? 'white' : o.blend === 'overlay' ? '0x808080' : 'black';
      const px = (o.pos === 'c' ? '(ow-iw)/2' : o.pos.endsWith('l') ? `${m}` : `ow-iw-${m}`) + off(nx);
      const py = (o.pos === 'c' ? '(oh-ih)/2' : o.pos.startsWith('t') ? `${m}` : `oh-ih-${m}`) + off(ny);
      const hold = src.still ? '' : `setpts=PTS-STARTPTS,fps=${fps},tpad=start_duration=${s6(from / 1000)}:color=${neutral},`;
      graph.push(`[${idx}:v:0]${hold}${key}scale=${ow}:-2,format=rgb24,pad=${W}:${H}:${px}:${py}:color=${neutral},setsar=1,format=gbrp[ov${k}]`);
      layers.push({ input: `ov${k}`, x, y, enable, blend: o.blend, opacity: o.opasitas });
      return;
    }
    if (c.keyframes?.length && src.w && src.h) {
      // 25 Nov (keyframe manual): a moving overlay. The picture is padded onto a transparent canvas
      // with Q px to spare on every side (so it may leave the frame), moved/scaled/rotated around its
      // own centre with the same sub-pixel `perspective` as video keyframes, then cropped back to W×H.
      const kfs = c.keyframes;
      const oh = Math.max(2, Math.round((ow * src.h) / src.w / 2) * 2);
      const Q = Math.max(ow, oh) * 2;
      const bx = Math.round(o.pos === 'c' ? (W - ow) / 2 : o.pos.endsWith('l') ? m : W - ow - m) + nx;
      const by = Math.round(o.pos === 'c' ? (H - oh) / 2 : o.pos.startsWith('t') ? m : H - oh - m) + ny;
      const px = Math.max(0, Math.min(W + 2 * Q - ow, Q + bx));
      const py = Math.max(0, Math.min(H + 2 * Q - oh, Q + by));
      const ax = px + ow / 2;
      const ay = py + oh / 2;
      // `in` counts frames from 1: a looped picture starts at t = 0, a video overlay at `from`.
      const Tp = `((in-1)/${fps}+${s6(((src.still ? 0 : from) - c.start_ms) / 1000)})`;
      const dxe = `${ax}+(${kfExpr(kfs, 'x', Tp)})*${W}`;
      const dye = `${ay}+(${kfExpr(kfs, 'y', Tp)})*${H}`;
      const corners = cornerArgs(kfCorners(kfs, Tp, dxe, dye, [ax, W + 2 * Q - ax, ay, H + 2 * Q - ay]));
      const fadeKf = kfs.some((q) => q.opacity !== 1) ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${kfExpr(kfs, 'opacity', `(T-${s6(c.start_ms / 1000)})`)},0,1)'` : '';
      graph.push(`[${idx}:v:0]${time}${key}scale=${ow}:${oh},format=rgba,colorchannelmixer=aa=${o.opasitas.toFixed(2)},setsar=1,pad=${W + 2 * Q}:${H + 2 * Q}:${px}:${py}:color=black@0,perspective=${corners}:interpolation=cubic:sense=destination:eval=frame,crop=${W}:${H}:${Q}:${Q}${fadeKf}[ov${k}]`);
      layers.push({ input: `ov${k}`, x: '0', y: '0', enable });
      return;
    }
    graph.push(`[${idx}:v:0]${time}${key}scale=${ow}:-2,format=rgba,colorchannelmixer=aa=${o.opasitas.toFixed(2)},setsar=1[ov${k}]`);
    layers.push({ input: `ov${k}`, x, y, enable });
  });
  // X06: Brand Kit logo in a corner, over everything (text and overlays included), for the whole video.
  if (brand.logo) {
    const lg = brand.logo;
    const idx = inputCount++;
    args.push('-loop', '1', '-framerate', String(fps), '-t', s6(total_ms / 1000), '-i', lg.path);
    const lw = Math.max(2, Math.round((W * lg.size) / 100 / 2) * 2);
    const m = Math.round(short * 0.04);
    graph.push(`[${idx}:v:0]scale=${lw}:-2,format=rgba,colorchannelmixer=aa=${lg.opacity.toFixed(2)},setsar=1[logo]`);
    layers.push({ input: 'logo', x: lg.corner.endsWith('l') ? `${m}` : `W-w-${m}`, y: lg.corner.startsWith('t') ? `${m}` : `H-h-${m}`, enable: '' });
  }
  if (layers.length) {
    graph.push(...drawChain(textIn, 'vl0'));
    layers.forEach((l, i) => {
      const last = i === layers.length - 1;
      const tail = last ? `,format=yuv420p,trim=end_frame=${total_frames}[vout]` : `[vl${i + 1}]`;
      if (l.blend) {
        // R38b: picture below FIRST (CSS mix-blend-mode semantics, e.g. overlay keys on the backdrop).
        graph.push(`[vl${i}]format=gbrp[vb${i}]`);
        graph.push(`[vb${i}][${l.input}]blend=all_mode=${l.blend}:all_opacity=${(l.opacity ?? 1).toFixed(2)}:enable='${l.enable}',format=yuv420p${tail}`);
        return;
      }
      graph.push(`[vl${i}][${l.input}]overlay=x=${l.x}:y=${l.y}:eof_action=pass:format=auto${l.enable ? `:enable='${l.enable}'` : ''}${tail}`);
    });
  } else graph.push(...drawChain(textIn, 'vout'));

  args.push(
    '-/filter_complex', 'graph.txt',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2',
    ...STRIP_METADATA_ARGS,
    '-movflags', '+faststart',
    '-f', 'mp4', 'out.mp4',
  );
  return { args, graph: graph.join(';\n'), files, width: W, height: H, total_ms, total_frames };
}

/**
 * U3: two-pass EBU R128 loudness normalisation of `out.mp4` in `jobDir` (video stream copied).
 * Pass 1 measures the whole mix; pass 2 applies one linear gain (true peak limited to -1.5 dBTP),
 * so a 20-second ad lands on the target instead of drifting like single-pass dynamic mode.
 */
export async function normalizeLoudness(jobDir: string, lufs: number, signal?: AbortSignal): Promise<void> {
  const out = path.join(jobDir, 'out.mp4');
  const m = await measureLoudness(out, lufs);
  if (!m) throw new StorageError('RENDER_FAILED', 'Loudness hasil render tidak bisa diukur', { stage: 'loudness' });
  const filter = `loudnorm=I=${lufs}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,${AFMT}`;
  await runFfmpeg(
    ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', 'out.mp4', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2', ...STRIP_METADATA_ARGS, '-movflags', '+faststart', '-f', 'mp4', 'out_lufs.mp4'],
    { cwd: jobDir, ...(signal ? { signal } : {}) },
  );
  await fsp.rename(path.join(jobDir, 'out_lufs.mp4'), out);
}

/** Rough output size (bytes) for the disk check: generous bits-per-pixel + audio, ×2 for the staging copy. */
export function estimateRenderBytes(totalMs: number, size: { width: number; height: number }, fps: number): number {
  const secs = totalMs / 1000;
  return Math.ceil(2 * secs * ((size.width * size.height * fps * 0.15 + 192_000) / 8)) + 4 * 1024 * 1024;
}

// ------------------------------------------------------------------ job

export type RenderPhase = 'preflight' | 'preparing' | 'encoding' | 'verifying' | 'saving';

export interface RenderOutput {
  rel: string;
  name: string;
  size: number;
  hash: string;
  duration_ms: number;
  width: number;
  height: number;
  /** Always true for a completed render (otherwise it failed). */
  metadata_clean: true;
  kept_tags: string[];
}

export type RenderOutcome = { status: 'blocked'; preflight: PreflightResult } | { status: 'completed'; preflight: PreflightResult; output: RenderOutput };

export interface RenderHooks {
  onPhase?: (p: RenderPhase) => void;
  /** 0..1 while encoding. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Job folder parent (default: OS temp). Outside the workspace; cleaned after every run. */
  tmpRoot?: string;
  settings?: Partial<RenderSettings>;
  /** Pid stored on the lease so a crashed worker's lease is released at next start. */
  worker_pid?: number;
  /** Test seam: runs on the encoded temp file right before verification. */
  afterEncode?: (file: string) => Promise<void>;
  /**
   * 25 Nov (objek di depan teks): render only the PICTURE (video, b-roll, zoom effects — no text,
   * overlays, logo or sound) of [from_ms, to_ms) and hand the file to `deliver` instead of saving
   * an output. Used to make the source the engine's hapus_latar cuts the subject from.
   */
  pictureSpan?: { from_ms: number; to_ms: number; deliver: (file: string) => Promise<void> };
}

export const RENDER_TMP_PREFIX = 'motion-render-';

/** Nested `withLocalFile` for several blobs (Drive in W10: verified cache copies). */
async function withLocalFiles<T>(ws: Workspace, rels: string[], fn: (abs: string[]) => Promise<T>, acc: string[] = []): Promise<T> {
  if (acc.length === rels.length) return fn(acc);
  return ws.blobs.withLocalFile(rels[acc.length]!, (abs) => withLocalFiles(ws, rels, fn, [...acc, abs]));
}

function settingsFrom(partial: Partial<RenderSettings> | undefined): RenderSettings {
  const s = { ...DEFAULT_RENDER, ...partial };
  if (!Number.isInteger(s.short_side) || s.short_side < 144 || s.short_side > 2160) throw new StorageError('PRECONDITION', 'Resolusi render tidak valid (144–2160)');
  if (!RENDER_FPS.includes(s.fps)) throw new StorageError('PRECONDITION', 'FPS render tidak valid');
  if (!Number.isInteger(s.crf) || s.crf < 0 || s.crf > 51) throw new StorageError('PRECONDITION', 'CRF tidak valid');
  if (!PRESETS.includes(s.preset)) throw new StorageError('PRECONDITION', 'Preset render tidak valid');
  return s;
}

/**
 * Render a project to MP4 (W08):
 * tools check → preflight + lease (T15, one lock) → re-verify leased bytes → FFmpeg into a private
 * temp folder → **metadata verification (owner rule: failed = render failed)** → upload/commit into
 * 05_OUTPUT under the reserved versioned name (never overwrites) → audit → release lease.
 * Originals are only ever read.
 */
export async function renderProject(ws: Workspace, input: { project_id: string; output_name: string; actor: Actor; accept_brand_warnings?: boolean }, hooks: RenderHooks = {}): Promise<RenderOutcome> {
  await guard(ws, input.actor, 'render_preflight', { project_id: input.project_id }); // never AI (T15 matrix)
  const settings = settingsFrom(hooks.settings);
  hooks.onPhase?.('preflight');
  const tools = await checkTools();
  if (!tools.ok) {
    await audit(ws, { op: 'render.blocked', actor: input.actor, outcome: 'blocked', project_id: input.project_id, reason: tools.problems });
    throw new StorageError('RENDER_UNAVAILABLE', `Alat render belum siap: ${tools.problems.join(', ')}`, { problems: tools.problems });
  }
  const before = await readProject(ws, input.project_id);
  const hasText = [...clipsOf(before.timeline, 'text'), ...clipsOf(before.timeline, 'subtitle')].some((c) => c.text?.trim());
  const font = hasText ? findFont() : null;
  const regularFont = hasText ? findFont('regular') : null;
  if (hasText && !font) throw new StorageError('RENDER_UNAVAILABLE', 'Font untuk teks tidak ditemukan (set MOTION_FONT)');
  const size = canvasSize(before.timeline.canvas?.ratio ?? '9:16', settings.short_side);

  const { preflight, lease } = await startRender(ws, {
    project_id: input.project_id,
    output_name: input.output_name,
    estimated_bytes: estimateRenderBytes(timelineEnd(before.timeline), size, settings.fps),
    actor: input.actor,
    ...(input.accept_brand_warnings ? { accept_brand_warnings: true } : {}),
    ...(hooks.worker_pid !== undefined ? { worker_pid: hooks.worker_pid } : {}),
  });
  if (!lease) return { status: 'blocked', preflight };

  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  let tmp: string | null = null;
  try {
    await setLeaseStatus(ws, { lease_id: lease.lease_id, status: 'running', actor: input.actor });
    hooks.onPhase?.('preparing');
    // The timeline rendered is exactly the revision preflight checked.
    const project = await readProject(ws, input.project_id);
    if (project.revision !== preflight.project_revision) throw new StorageError('CONFLICT', 'Proyek berubah saat render dimulai; ulangi render');
    const check = await verifyRenderSnapshot(ws, lease.lease_id);
    if (!check.ok) throw new StorageError('INTEGRITY', 'Media berubah setelah preflight; render dibatalkan', { problems: check.problems });

    const reg = await loadRegistry(ws);
    // X06: the brand pieces this revision needs must be exactly the ones preflight checked + leased.
    const kit = await readBrandFor(ws, project.brand_id);
    const brandRefs = brandRenderRefs(project.timeline, kit);
    const leased = new Set(lease.media.map((m) => m.version_id));
    for (const r of [brandRefs.font, brandRefs.font_caption, brandRefs.logo?.ref, brandRefs.lut]) if (r && !leased.has(r.version_id)) throw new StorageError('CONFLICT', 'Brand Kit berubah saat render dimulai; ulangi render');
    const brandOnly = new Set([brandRefs.font?.version_id, brandRefs.font_caption?.version_id, brandRefs.logo?.ref.version_id].filter((x): x is string => !!x));
    const clipVersions = new Set(project.timeline.tracks.flatMap((tr) => (tr.kind === 'overlay' ? [] : tr.clips.flatMap((c) => (c.media ? [c.media.version_id] : [])))));
    const span = hooks.pictureSpan ?? null;
    const overlayVersions = new Set([...clipsOf(project.timeline, 'overlay').flatMap((c) => (c.media ? [c.media.version_id] : [])), ...(span ? [] : [...clipsOf(project.timeline, 'text'), ...clipsOf(project.timeline, 'subtitle')].flatMap((c) => (c.depan ? [c.depan.masker.version_id] : [])))]);
    // R38a: Aset fonts of texts and colour LUTs are leased with the clips but are not timeline media.
    const asetFontRefs = [...clipsOf(project.timeline, 'text'), ...clipsOf(project.timeline, 'subtitle')].flatMap((c) => (c.text?.trim() && fontRef(c.style?.font) ? [fontRef(c.style?.font)!] : []));
    const asetFontVersions = new Set(asetFontRefs.map((r) => r.version_id));
    const lutVersions = new Set([...project.timeline.tracks.flatMap((tr) => tr.clips.flatMap((c) => (c.lut ? [c.lut.version_id] : []))), ...(brandRefs.lut ? [brandRefs.lut.version_id] : [])]);
    const versions = lease.media.map((m) => reg.versions[m.version_id]!);
    const rels = await Promise.all(versions.map((v) => ws.blobs.resolve(v.rel_path, MEDIA_AREAS)));
    tmp = await fsp.mkdtemp(path.join(hooks.tmpRoot ?? os.tmpdir(), RENDER_TMP_PREFIX));
    const jobDir = tmp;

    const result = await withLocalFiles(ws, rels, async (abs) => {
      const inputs = new Map<string, PlanInput>();
      const markers = new Set<string>();
      const local = new Map(versions.map((v, i) => [v.version_id, abs[i]!]));
      const overlays = new Map<string, { path: string; still: boolean; w?: number; h?: number }>();
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i]!;
        if (overlayVersions.has(v.version_id)) {
          // R26: a picture has no video probe (null); a video overlay keeps its frames.
          const p = v.probe ?? (await probeFile(abs[i]!));
          const still = !p || !p.video_codec || p.duration_ms <= 100 || ['png', 'mjpeg', 'webp', 'bmp', 'gif'].includes(p.video_codec);
          const img = still ? await probeImage(abs[i]!) : null;
          if (still && !img) throw new StorageError('PRECONDITION', `Overlay "${v.original_name}" bukan gambar/video yang bisa dibaca`, { version_id: v.version_id });
          const dim = img ?? (p?.width && p.height ? { width: p.width, height: p.height } : null);
          overlays.set(v.version_id, { path: abs[i]!, still, ...(dim ? { w: dim.width, h: dim.height } : {}) });
          for (const m of await sourceMetadataMarkers(abs[i]!)) markers.add(m);
          if (!clipVersions.has(v.version_id)) continue;
        }
        if ((asetFontVersions.has(v.version_id) || lutVersions.has(v.version_id)) && !clipVersions.has(v.version_id) && !overlayVersions.has(v.version_id)) continue; // font / LUT file, copied below
        if (brandOnly.has(v.version_id) && !clipVersions.has(v.version_id)) {
          if (v.version_id === brandRefs.logo?.ref.version_id) for (const m of await sourceMetadataMarkers(abs[i]!)) markers.add(m);
          continue; // font / logo: not a timeline clip
        }
        const probe = v.probe ?? (await probeFile(abs[i]!));
        if (!probe) throw new StorageError('PRECONDITION', `Media "${v.original_name}" tidak bisa dibaca sebagai video/audio`, { version_id: v.version_id });
        inputs.set(v.version_id, { path: abs[i]!, probe });
        // R23f: clips of this version marked `stabil` read the stabilised copy (made beforehand).
        for (const level of new Set(project.timeline.tracks.flatMap((tr) => tr.clips.flatMap((c) => (c.media?.version_id === v.version_id && c.stabil ? [c.stabil] : []))))) {
          if (!(await stabilReady(ws, v.version_id, level))) throw new StorageError('PRECONDITION', `Stabilisasi "${v.original_name}" (${level}) belum selesai. Tunggu sampai siap di Inspector, atau matikan stabil.`, { version_id: v.version_id });
          inputs.set(stabilKey(v.version_id, level), { path: stabilPath(ws, v.version_id, level), probe });
        }
        for (const m of await sourceMetadataMarkers(abs[i]!)) markers.add(m);
      }
      const brandFont = brandRefs.font ? local.get(brandRefs.font.version_id)! : null;
      const brandLogo = brandRefs.logo ? { path: local.get(brandRefs.logo.ref.version_id)!, corner: brandRefs.logo.corner, size: brandRefs.logo.size, opacity: brandRefs.logo.opacity } : null;
      const fontExt = brandFont ? (/\.(ttf|otf)$/i.exec(reg.versions[brandRefs.font!.version_id]!.original_name)?.[0] ?? '.ttf').toLowerCase() : '';
      const capFont = brandRefs.font_caption ? local.get(brandRefs.font_caption.version_id)! : null;
      const capExt = capFont ? (/\.(ttf|otf)$/i.exec(reg.versions[brandRefs.font_caption!.version_id]!.original_name)?.[0] ?? '.ttf').toLowerCase() : '';
      const info = async (f: string | null) => (f ? await readFontInfo(f).catch(() => null) : null);
      const fonts: Partial<AssFonts> = {};
      const fb = await info(font);
      const fr = await info(regularFont);
      const fk = await info(brandFont);
      const fc = await info(capFont);
      if (fb) fonts.bold = fb;
      if (fr) fonts.regular = fr;
      if (fk) fonts.brand = fk;
      if (fc) fonts.caption = fc;
      // R38a: Aset fonts → job folder (drawtext by file, libass by family name in fontsdir).
      const asetFonts = new Map<string, string>();
      for (const r of asetFontRefs) {
        if (asetFonts.has(r.version_id)) continue;
        const file = local.get(r.version_id);
        if (!file) throw new StorageError('PRECONDITION', 'Font teks dari Aset tidak tersedia untuk render', { version_id: r.version_id });
        const e = (/\.(ttf|otf)$/i.exec(reg.versions[r.version_id]?.original_name ?? '')?.[0] ?? '.ttf').toLowerCase();
        const name = `fonta_${r.version_id}${e}`;
        await fsp.copyFile(file, path.join(jobDir, name));
        asetFonts.set(r.version_id, name);
        const fi = await info(file);
        if (fi) (fonts.aset ??= {})[r.version_id] = fi;
      }
      // R38b: LUT files → job folder (lut3d reads them by a plain relative name).
      const luts = new Map<string, string>();
      for (const vid of lutVersions) {
        const file = local.get(vid);
        if (!file) throw new StorageError('PRECONDITION', 'File LUT tidak tersedia untuk render', { version_id: vid });
        const name = `lut_${vid}.cube`;
        await fsp.copyFile(file, path.join(jobDir, name));
        luts.set(vid, name);
      }
      const picture: Timeline = span ? { ...project.timeline, tracks: project.timeline.tracks.filter((tr) => tr.kind === 'video' || tr.kind === 'broll' || tr.kind === 'effects'), brand_logo: false } : project.timeline;
      if (span) delete picture.loudness_lufs;
      const plan = buildRenderPlan(picture, inputs, settings, font, regularFont, { font: brandFont ? `brand${fontExt}` : null, font_caption: capFont ? `caption${capExt}` : null, logo: span ? null : brandLogo, fonts, look: kit.filter_bawaan ?? null, overlays, aset_fonts: asetFonts, lut: brandRefs.lut, luts });
      await fsp.writeFile(path.join(jobDir, 'graph.txt'), plan.graph, 'utf8');
      for (const f of plan.files) await fsp.writeFile(path.join(jobDir, f.name), f.content, 'utf8');
      if (font) await fsp.copyFile(font, path.join(jobDir, `fontb${path.extname(font).toLowerCase()}`));
      if (regularFont) await fsp.copyFile(regularFont, path.join(jobDir, `fontr${path.extname(regularFont).toLowerCase()}`));
      if (brandFont) await fsp.copyFile(brandFont, path.join(jobDir, `fontk${fontExt}`));
      if (capFont) await fsp.copyFile(capFont, path.join(jobDir, `fontc${capExt}`));

      hooks.onPhase?.('encoding');
      hooks.onProgress?.(0);
      await runFfmpeg(plan.args, {
        cwd: jobDir,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        onTime: (ms) => hooks.onProgress?.(Math.min(0.999, Math.max(0, ms / plan.total_ms))),
      });
      if (!span && project.timeline.loudness_lufs !== undefined) await normalizeLoudness(jobDir, project.timeline.loudness_lufs, hooks.signal);
      if (span) {
        // Only the span, picture only, a clean H.264 file for the engine.
        const cut = path.join(jobDir, 'span.mp4');
        await runFfmpeg(['-y', '-ss', s6(span.from_ms / 1000), '-t', s6((span.to_ms - span.from_ms) / 1000), '-i', 'out.mp4', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', ...STRIP_METADATA_ARGS, cut], { cwd: jobDir, ...(hooks.signal ? { signal: hooks.signal } : {}) });
        await span.deliver(cut);
      }
      return { plan, markers: [...markers] };
    });
    if (span) {
      outcome = 'completed';
      return { status: 'completed', preflight, output: { rel: '', name: '', size: 0, hash: '', duration_ms: span.to_ms - span.from_ms, width: result.plan.width, height: result.plan.height, metadata_clean: true, kept_tags: [] } };
    }

    hooks.onPhase?.('verifying');
    if (hooks.signal?.aborted) throw new StorageError('CANCELLED', 'Render dibatalkan');
    const out = path.join(jobDir, 'out.mp4');
    await hooks.afterEncode?.(out);
    const clean = await verifyCleanOutput(out, { width: result.plan.width, height: result.plan.height, duration_ms: result.plan.total_ms, source_markers: result.markers });
    if (!clean.ok) {
      await audit(ws, { op: 'render.verify', actor: input.actor, outcome: 'failed', project_id: project.project_id, output_rel: preflight.output_rel, problems: clean.problems });
      throw new StorageError('RENDER_FAILED', 'Hasil render tidak lolos verifikasi metadata; output tidak disimpan', { stage: 'verify', problems: clean.problems });
    }
    await audit(ws, { op: 'render.verify', actor: input.actor, outcome: 'ok', project_id: project.project_id, output_rel: preflight.output_rel, kept_tags: clean.kept_tags, hash: clean.hash });

    hooks.onPhase?.('saving');
    if (hooks.signal?.aborted) throw new StorageError('CANCELLED', 'Render dibatalkan');
    const staged = await ws.blobs.stage(projectRel(project.project_id, '05_OUTPUT'), out);
    if (staged.hash !== clean.hash) {
      await ws.blobs.discard(staged);
      throw new StorageError('INTEGRITY', 'Byte output berubah antara verifikasi dan penyimpanan', { stage: 'save' });
    }
    // Checkpoint E E5: a cancel that arrives while staging still wins — nothing is saved.
    if (hooks.signal?.aborted) {
      await ws.blobs.discard(staged);
      throw new StorageError('CANCELLED', 'Render dibatalkan');
    }
    let rel: string;
    try {
      rel = await ws.blobs.commit(staged, preflight.output_rel);
    } catch (e) {
      await ws.blobs.discard(staged);
      throw e;
    }
    const output: RenderOutput = {
      rel,
      name: path.posix.basename(rel),
      size: clean.size,
      hash: clean.hash,
      duration_ms: clean.duration_ms ?? result.plan.total_ms,
      width: result.plan.width,
      height: result.plan.height,
      metadata_clean: true,
      kept_tags: clean.kept_tags,
    };
    await audit(ws, { op: 'render.complete', actor: input.actor, outcome: 'ok', project_id: project.project_id, revision: project.revision, output, settings, lease_id: lease.lease_id });
    outcome = 'completed';
    return { status: 'completed', preflight, output };
  } catch (e) {
    if (isStorageError(e, 'CANCELLED')) outcome = 'cancelled';
    await audit(ws, {
      op: 'render.failed',
      actor: input.actor,
      outcome: 'failed',
      project_id: input.project_id,
      output_rel: preflight.output_rel,
      result: outcome,
      code: isStorageError(e) ? e.code : 'INTERNAL',
      message: e instanceof Error ? e.message : String(e),
      details: isStorageError(e) ? e.details : undefined,
    }).catch(() => undefined);
    throw e;
  } finally {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    // Checkpoint E E11: retry the lease release (a transient lock/EPERM must not pin media).
    for (let i = 0; i < 4; i++) {
      try {
        await finishRender(ws, { lease_id: lease.lease_id, outcome, actor: input.actor });
        break;
      } catch (e) {
        if (isStorageError(e, 'NOT_FOUND')) break;
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  }
}

/** Finished renders of a project (newest first). */
export async function listOutputs(ws: Workspace, projectId: string): Promise<{ name: string; rel: string; size: number; mtime_ms: number }[]> {
  await readProject(ws, projectId);
  const files = await ws.blobs.listFiles(projectRel(projectId, '05_OUTPUT'), 1);
  return files
    .filter((f) => !f.name.startsWith('.') && path.posix.dirname(f.rel) === projectRel(projectId, '05_OUTPUT'))
    .map((f) => ({ name: f.name, rel: f.rel, size: f.size, mtime_ms: f.mtimeMs }))
    .sort((a, b) => b.mtime_ms - a.mtime_ms);
}
