/**
 * Malam 15 Nov (fitur owner #13): keyframe posisi, skala dan opacity per klip (video, b-roll,
 * teks/subtitle). Pure module: the preview and the FFmpeg render evaluate the SAME curve.
 *  - `at_ms`: time inside the clip (0 = clip start). May lie outside the clip after a split/trim:
 *    the keyframe then only anchors the curve, so the part keeps exactly the same motion.
 *  - `x`, `y`: offset of the clip from its normal place, fractions of the canvas (−1..1).
 *  - `scale`: size multiplier around the clip's centre (0.1..4).
 *  - `opacity`: 0..1 (a picture fades to black; text fades out).
 *  - `rot` (25 Nov, keyframe manual): rotation in degrees (−360..360, clockwise), optional = 0.
 *  - `ease`: curve from the PREVIOUS keyframe to this one (see `KF_EASES`): `linear`, `ease`
 *    (ease-in-out, cosine), `in` (mulai pelan), `out` (berhenti pelan), `lembut` (cepat lalu
 *    melambat panjang). 25 Nov (keluhan owner "zoom in zoom out masih kasar"): in/out/lembut.
 * Before the first keyframe the first values hold; after the last, the last values hold.
 */
import { StorageError } from './errors.js';

export interface Keyframe {
  at_ms: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rot?: number;
  ease: KfEase;
}
export type KfEase = 'linear' | 'ease' | 'in' | 'out' | 'lembut';
export const KF_EASES: readonly KfEase[] = ['linear', 'ease', 'in', 'out', 'lembut'];
export interface KfValues {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rot: number;
}
export const KF_IDENTITY: KfValues = { x: 0, y: 0, scale: 1, opacity: 1, rot: 0 };
export const MAX_KEYFRAMES = 20;
export const KF_LIMITS = { x: [-1, 1], y: [-1, 1], scale: [0.1, 4], opacity: [0, 1], rot: [-360, 360] } as const;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export function validateKeyframes(raw: unknown, where = 'keyframes'): Keyframe[] {
  if (!Array.isArray(raw) || raw.length > MAX_KEYFRAMES) return bad(`${where} harus daftar 0–${MAX_KEYFRAMES} keyframe`);
  const out = raw.map((r, i) => {
    const w = `${where}[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return bad(`${w} harus objek`);
    const o = r as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['at_ms', 'x', 'y', 'scale', 'opacity', 'rot', 'ease'].includes(k));
    if (extra.length) bad(`${w}: field tidak dikenal ${extra.join(', ')}`);
    const num = (k: keyof typeof KF_LIMITS, dflt: number) => {
      const v = o[k];
      if (v === undefined) return dflt;
      const [lo, hi] = KF_LIMITS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return bad(`${w}.${k} harus angka ${lo}–${hi}`);
      return Math.round(v * 1000) / 1000;
    };
    const at = o.at_ms;
    if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at) > 24 * 3_600_000) bad(`${w}.at_ms harus angka ms (−24 jam … 24 jam)`);
    const ease: KfEase = o.ease === undefined ? 'linear' : KF_EASES.includes(o.ease as KfEase) ? (o.ease as KfEase) : bad(`${w}.ease harus ${KF_EASES.join(' | ')}`);
    const rot = num('rot', 0);
    return { at_ms: Math.round(at as number), x: num('x', 0), y: num('y', 0), scale: num('scale', 1), opacity: num('opacity', 1), ...(rot ? { rot } : {}), ease };
  });
  out.sort((a, b) => a.at_ms - b.at_ms);
  for (let i = 1; i < out.length; i++) if (out[i]!.at_ms === out[i - 1]!.at_ms) bad(`${where}: dua keyframe di waktu yang sama (${out[i]!.at_ms} ms)`);
  return out;
}

/** Eased progress 0..1. `easeExpr` is the SAME formula for FFmpeg (preview = render). */
export function easeOf(e: KfEase, p: number): number {
  switch (e) {
    case 'ease':
      return 0.5 - 0.5 * Math.cos(Math.PI * p);
    case 'in':
      return p * p * p;
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'lembut':
      return 1 - (1 - p) ** 5;
    default:
      return p;
  }
}

/** FFmpeg expression of `easeOf(e, p)`; `p` must already be clipped to 0..1. */
export function easeExpr(e: KfEase, p: string): string {
  switch (e) {
    case 'ease':
      return `(0.5-0.5*cos(PI*${p}))`;
    case 'in':
      return `pow(${p},3)`;
    case 'out':
      return `(1-pow(1-${p},3))`;
    case 'lembut':
      return `(1-pow(1-${p},5))`;
    default:
      return p;
  }
}

/** Values at `ms` inside the clip. No keyframes = identity. */
export function keyframeAt(kfs: readonly Keyframe[] | undefined, ms: number): KfValues {
  if (!kfs?.length) return { ...KF_IDENTITY };
  const first = kfs[0]!;
  if (ms <= first.at_ms) return vals(first);
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i]!;
    if (ms < b.at_ms) {
      const a = kfs[i - 1]!;
      const p = easeOf(b.ease, (ms - a.at_ms) / (b.at_ms - a.at_ms));
      const mix = (u: number, v: number) => u + (v - u) * p;
      return { x: mix(a.x, b.x), y: mix(a.y, b.y), scale: mix(a.scale, b.scale), opacity: mix(a.opacity, b.opacity), rot: mix(a.rot ?? 0, b.rot ?? 0) };
    }
  }
  return vals(kfs[kfs.length - 1]!);
}

const vals = (k: Keyframe): KfValues => ({ x: k.x, y: k.y, scale: k.scale, opacity: k.opacity, rot: k.rot ?? 0 });
/** A keyframe at `ms` with the curve's values there (`rot` only when not 0, like validateKeyframes). */
const kfAt = (kfs: readonly Keyframe[], ms: number, ease: KfEase): Keyframe => {
  const { rot, ...v } = keyframeAt(kfs, ms);
  const r = Math.round(rot * 1000) / 1000;
  return { at_ms: ms, ...v, ...(r ? { rot: r } : {}), ease };
};

const isId = (k: Keyframe) => k.x === 0 && k.y === 0 && k.scale === 1 && k.opacity === 1 && !k.rot;
const still = (ks: readonly Keyframe[]) => ks.every(isId);

/**
 * Keyframes of the part [from, to) of a clip, re-timed so `from` is 0 (split, trim): the keyframe
 * just before and just after the part stay (outside it) as anchors, so the motion is EXACTLY the same.
 */
export function sliceKeyframes(kfs: readonly Keyframe[] | undefined, from: number, to: number): Keyframe[] | undefined {
  if (!kfs?.length) return undefined;
  const before = [...kfs].reverse().find((k) => k.at_ms <= from)?.at_ms ?? -Infinity;
  const after = kfs.find((k) => k.at_ms >= to)?.at_ms ?? Infinity;
  const out = kfs.filter((k) => k.at_ms >= before && k.at_ms <= after).map((k) => ({ ...k, at_ms: k.at_ms - from }));
  return still(out) ? undefined : out;
}

/** Part of the curve with its edge values as keyframes (used where two parts are joined). */
function sliceEdges(kfs: readonly Keyframe[] | undefined, from: number, to: number): Keyframe[] | undefined {
  if (!kfs?.length) return undefined;
  const inside = kfs.filter((k) => k.at_ms > from && k.at_ms < to).map((k) => ({ ...k, at_ms: k.at_ms - from }));
  const out = [kfAt(kfs, from, 'linear'), ...inside];
  if (kfs.some((k) => k.at_ms >= to) || inside.length) out.push({ ...kfAt(kfs, to, kfs.find((k) => k.at_ms >= to)?.ease ?? 'linear'), at_ms: to - from });
  // Drop a duplicate end when nothing moves after `from`.
  const dedup = out.filter((k, i) => i === 0 || k.at_ms !== out[i - 1]!.at_ms);
  return dedup.every(isId) ? undefined : dedup;
}

/** Keyframes of a clip with [from, to) cut out (ripple delete inside a text clip). */
export function cutKeyframes(kfs: readonly Keyframe[] | undefined, from: number, to: number, len: number): Keyframe[] | undefined {
  if (!kfs?.length) return undefined;
  const left = sliceEdges(kfs, 0, from) ?? [kfAt(kfs, 0, 'linear')];
  const right = (sliceEdges(kfs, to, len) ?? [kfAt(kfs, to, 'linear')]).map((k) => ({ ...k, at_ms: k.at_ms + from }));
  const all = [...left, ...right].filter((k, i, a) => i === 0 || k.at_ms > a[i - 1]!.at_ms).slice(0, MAX_KEYFRAMES);
  return all.every(isId) ? undefined : all;
}

const n4 = (v: number) => (Math.round(v * 10000) / 10000).toString();

/**
 * FFmpeg expression of one property in terms of `T` (an expression for the clip time in SECONDS).
 * Commas are NOT escaped: put the result inside single quotes in the filtergraph.
 */
export function kfExpr(kfs: readonly Keyframe[], prop: keyof KfValues, T: string): string {
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  const v = (k: Keyframe) => (prop === 'rot' ? (k.rot ?? 0) : k[prop]);
  let e = n4(v(last));
  for (let i = kfs.length - 1; i >= 1; i--) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    const A = (a.at_ms / 1000).toFixed(4);
    const span = ((b.at_ms - a.at_ms) / 1000).toFixed(4);
    const p = `clip((${T}-${A})/${span},0,1)`;
    const pe = easeExpr(b.ease, p);
    const seg = v(a) === v(b) ? n4(v(a)) : `(${n4(v(a))}+${n4(v(b) - v(a))}*${pe})`;
    e = `if(lt(${T},${(b.at_ms / 1000).toFixed(4)}),${seg},${e})`;
  }
  return `if(lt(${T},${(first.at_ms / 1000).toFixed(4)}),${n4(v(first))},${e})`;
}

/** Any keyframe rotates (a rotation forces the sub-pixel `perspective` path). */
export const kfRotates = (kfs: readonly Keyframe[]) => kfs.some((k) => !!k.rot);

/**
 * `perspective` corner expressions (x0..y3 = top-left, top-right, bottom-left, bottom-right) of a
 * picture whose anchor — in padded-canvas pixels — moves to (dx, dy), scaled by S and rotated by
 * the keyframe `rot` around that anchor. ext = [left, right, top, bottom] distances from the anchor
 * to the padded picture's edges. Without rotation: the same plain expressions as before.
 */
export function kfCorners(kfs: readonly Keyframe[], T: string, dx: string, dy: string, ext: [number, number, number, number]): Record<'x0' | 'y0' | 'x1' | 'y1' | 'x2' | 'y2' | 'x3' | 'y3', string> {
  const S = kfExpr(kfs, 'scale', T);
  const [L, R, Tp, B] = ext;
  if (!kfRotates(kfs)) {
    const l = `${dx}-(${S})*${L}`;
    const r = `${dx}+(${S})*${R}`;
    const t = `${dy}-(${S})*${Tp}`;
    const b = `${dy}+(${S})*${B}`;
    return { x0: l, y0: t, x1: r, y1: t, x2: l, y2: b, x3: r, y3: b };
  }
  const A = `((${kfExpr(kfs, 'rot', T)})*PI/180)`;
  const pt = (ox: number, oy: number): [string, string] => [`${dx}+(${S})*(${ox}*cos(${A})-(${oy})*sin(${A}))`, `${dy}+(${S})*(${ox}*sin(${A})+(${oy})*cos(${A}))`];
  const [x0, y0] = pt(-L, -Tp);
  const [x1, y1] = pt(R, -Tp);
  const [x2, y2] = pt(-L, B);
  const [x3, y3] = pt(R, B);
  return { x0, y0, x1, y1, x2, y2, x3, y3 };
}

/** `x0='…':y0='…':…` for a perspective filter. */
export const cornerArgs = (c: Record<string, string>) => (['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'] as const).map((k) => `${k}='${c[k]}'`).join(':');

/**
 * Filters that move/scale/fade a W×H picture by its keyframes, over black (`inLabel` → `outLabel`).
 * `offMs` = clip time at the chain's t = 0. `frames` = length of the piece (for the black base).
 */
export function keyframeFilters(kfs: readonly Keyframe[], o: { W: number; H: number; fps: number; frames: number; offMs: number; id: string; inLabel: string; outLabel: string }): string[] {
  const T = `(t+${(o.offMs / 1000).toFixed(4)})`;
  const S = kfExpr(kfs, 'scale', T);
  const X = kfExpr(kfs, 'x', T);
  const Y = kfExpr(kfs, 'y', T);
  const A = kfExpr(kfs, 'opacity', T);
  const varies = (p: Exclude<keyof KfValues, 'rot'>) => kfs.some((k) => k[p] !== kfs[0]![p]);
  const f: string[] = [];
  const fade = kfs.some((k) => k.opacity < 1) ? `eq=contrast='${A}':brightness='(0.0627-0.5)*(1-(${A}))':saturation='${A}':eval=${varies('opacity') ? 'frame' : 'init'}` : '';
  if (varies('x') || varies('y') || varies('scale') || kfRotates(kfs)) {
    // Keluhan tim "keyframe belum smooth": a per-frame `scale` (even whole-pixel sizes) + integer
    // `overlay` position stepped 1–2 px per frame. `perspective` places the picture with sub-pixel
    // float corners (bicubic) instead: the canvas picture, padded with P px of black (perspective
    // repeats the edge pixels outside the source, so the edge is black), scaled by S around its
    // centre and moved by (X·W, Y·H) — the same transform as the preview's CSS — then the padding is
    // cropped off. `in` counts this chain's frames from 1, so the clip time is (in−1)/fps + offset.
    const P = 4;
    const Tp = `((in-1)/${o.fps}+${(o.offMs / 1000).toFixed(4)})`;
    const cx = `(${o.W / 2 + P}+(${kfExpr(kfs, 'x', Tp)})*${o.W})`;
    const cy = `(${o.H / 2 + P}+(${kfExpr(kfs, 'y', Tp)})*${o.H})`;
    const hw = o.W / 2 + P;
    const hh = o.H / 2 + P;
    const corners = cornerArgs(kfCorners(kfs, Tp, cx, cy, [hw, hw, hh, hh]));
    f.push(`[${o.inLabel}]${fade ? `${fade},` : ''}pad=${o.W + 2 * P}:${o.H + 2 * P}:${P}:${P}:color=black,perspective=${corners}:interpolation=cubic:sense=destination:eval=frame,crop=${o.W}:${o.H}:${P}:${P}[${o.outLabel}]`);
    return f;
  }
  // Still picture (only opacity moves, or a fixed scale/offset): one fixed scale + overlay, as before.
  // Even sizes (yuv420p); never below 2 px.
  f.push(`[${o.inLabel}]scale=w='max(2,trunc(${o.W}*${S}/2)*2)':h='max(2,trunc(${o.H}*${S}/2)*2)':eval=init${fade ? `,${fade}` : ''}[${o.id}kf]`);
  f.push(`color=c=black:s=${o.W}x${o.H}:r=${o.fps}:d=${(o.frames / o.fps).toFixed(4)},format=yuv420p[${o.id}kb]`);
  f.push(`[${o.id}kb][${o.id}kf]overlay=x='(W-w)/2+(${X})*W':y='(H-h)/2+(${Y})*H':eval=init:shortest=1[${o.outLabel}]`);
  return f;
}

/** Same transform as CSS for the preview (canvas-sized element). */
export function keyframeCss(v: KfValues): { transform?: string; opacity?: number } {
  const out: { transform?: string; opacity?: number } = {};
  if (v.x !== 0 || v.y !== 0 || v.scale !== 1 || v.rot) out.transform = `translate(${(v.x * 100).toFixed(3)}%, ${(v.y * 100).toFixed(3)}%)${v.rot ? ` rotate(${v.rot.toFixed(3)}deg)` : ''} scale(${v.scale.toFixed(4)})`;
  if (v.opacity !== 1) out.opacity = Math.round(v.opacity * 1000) / 1000;
  return out;
}
