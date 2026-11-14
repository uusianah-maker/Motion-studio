/**
 * Malam 15 Nov (fitur owner #13): keyframe posisi, skala dan opacity per klip (video, b-roll,
 * teks/subtitle). Pure module: the preview and the FFmpeg render evaluate the SAME curve.
 *  - `at_ms`: time inside the clip (0 = clip start). May lie outside the clip after a split/trim:
 *    the keyframe then only anchors the curve, so the part keeps exactly the same motion.
 *  - `x`, `y`: offset of the clip from its normal place, fractions of the canvas (−1..1).
 *  - `scale`: size multiplier around the clip's centre (0.1..4).
 *  - `opacity`: 0..1 (a picture fades to black; text fades out).
 *  - `ease`: curve from the PREVIOUS keyframe to this one: `linear` or `ease` (ease-in-out).
 * Before the first keyframe the first values hold; after the last, the last values hold.
 */
import { StorageError } from './errors.js';

export interface Keyframe {
  at_ms: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  ease: 'linear' | 'ease';
}
export interface KfValues {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}
export const KF_IDENTITY: KfValues = { x: 0, y: 0, scale: 1, opacity: 1 };
export const MAX_KEYFRAMES = 20;
export const KF_LIMITS = { x: [-1, 1], y: [-1, 1], scale: [0.1, 4], opacity: [0, 1] } as const;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export function validateKeyframes(raw: unknown, where = 'keyframes'): Keyframe[] {
  if (!Array.isArray(raw) || raw.length > MAX_KEYFRAMES) return bad(`${where} harus daftar 0–${MAX_KEYFRAMES} keyframe`);
  const out = raw.map((r, i) => {
    const w = `${where}[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return bad(`${w} harus objek`);
    const o = r as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['at_ms', 'x', 'y', 'scale', 'opacity', 'ease'].includes(k));
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
    const ease: Keyframe['ease'] = o.ease === undefined ? 'linear' : o.ease === 'linear' || o.ease === 'ease' ? o.ease : bad(`${w}.ease harus linear | ease`);
    return { at_ms: Math.round(at as number), x: num('x', 0), y: num('y', 0), scale: num('scale', 1), opacity: num('opacity', 1), ease };
  });
  out.sort((a, b) => a.at_ms - b.at_ms);
  for (let i = 1; i < out.length; i++) if (out[i]!.at_ms === out[i - 1]!.at_ms) bad(`${where}: dua keyframe di waktu yang sama (${out[i]!.at_ms} ms)`);
  return out;
}

/** Eased progress 0..1 (ease = ease-in-out cosine; the render uses the same formula). */
export const easeOf = (e: Keyframe['ease'], p: number) => (e === 'ease' ? 0.5 - 0.5 * Math.cos(Math.PI * p) : p);

/** Values at `ms` inside the clip. No keyframes = identity. */
export function keyframeAt(kfs: readonly Keyframe[] | undefined, ms: number): KfValues {
  if (!kfs?.length) return { ...KF_IDENTITY };
  const first = kfs[0]!;
  if (ms <= first.at_ms) return { x: first.x, y: first.y, scale: first.scale, opacity: first.opacity };
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i]!;
    if (ms < b.at_ms) {
      const a = kfs[i - 1]!;
      const p = easeOf(b.ease, (ms - a.at_ms) / (b.at_ms - a.at_ms));
      const mix = (u: number, v: number) => u + (v - u) * p;
      return { x: mix(a.x, b.x), y: mix(a.y, b.y), scale: mix(a.scale, b.scale), opacity: mix(a.opacity, b.opacity) };
    }
  }
  const last = kfs[kfs.length - 1]!;
  return { x: last.x, y: last.y, scale: last.scale, opacity: last.opacity };
}

const kfAt = (kfs: readonly Keyframe[], ms: number, ease: Keyframe['ease']): Keyframe => ({ at_ms: ms, ...keyframeAt(kfs, ms), ease });

const still = (ks: readonly Keyframe[]) => ks.every((k) => k.x === 0 && k.y === 0 && k.scale === 1 && k.opacity === 1);

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
  return dedup.every((k) => k.x === 0 && k.y === 0 && k.scale === 1 && k.opacity === 1) ? undefined : dedup;
}

/** Keyframes of a clip with [from, to) cut out (ripple delete inside a text clip). */
export function cutKeyframes(kfs: readonly Keyframe[] | undefined, from: number, to: number, len: number): Keyframe[] | undefined {
  if (!kfs?.length) return undefined;
  const left = sliceEdges(kfs, 0, from) ?? [kfAt(kfs, 0, 'linear')];
  const right = (sliceEdges(kfs, to, len) ?? [kfAt(kfs, to, 'linear')]).map((k) => ({ ...k, at_ms: k.at_ms + from }));
  const all = [...left, ...right].filter((k, i, a) => i === 0 || k.at_ms > a[i - 1]!.at_ms).slice(0, MAX_KEYFRAMES);
  return all.every((k) => k.x === 0 && k.y === 0 && k.scale === 1 && k.opacity === 1) ? undefined : all;
}

const n4 = (v: number) => (Math.round(v * 10000) / 10000).toString();

/**
 * FFmpeg expression of one property in terms of `T` (an expression for the clip time in SECONDS).
 * Commas are NOT escaped: put the result inside single quotes in the filtergraph.
 */
export function kfExpr(kfs: readonly Keyframe[], prop: keyof KfValues, T: string): string {
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  let e = n4(last[prop]);
  for (let i = kfs.length - 1; i >= 1; i--) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    const A = (a.at_ms / 1000).toFixed(4);
    const span = ((b.at_ms - a.at_ms) / 1000).toFixed(4);
    const p = `clip((${T}-${A})/${span},0,1)`;
    const pe = b.ease === 'ease' ? `(0.5-0.5*cos(PI*${p}))` : p;
    const seg = a[prop] === b[prop] ? n4(a[prop]) : `(${n4(a[prop])}+${n4(b[prop] - a[prop])}*${pe})`;
    e = `if(lt(${T},${(b.at_ms / 1000).toFixed(4)}),${seg},${e})`;
  }
  return `if(lt(${T},${(first.at_ms / 1000).toFixed(4)}),${n4(first[prop])},${e})`;
}

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
  const varies = (p: keyof KfValues) => kfs.some((k) => k[p] !== kfs[0]![p]);
  const f: string[] = [];
  // Even sizes (yuv420p); never below 2 px.
  f.push(`[${o.inLabel}]scale=w='max(2,trunc(${o.W}*${S}/2)*2)':h='max(2,trunc(${o.H}*${S}/2)*2)':eval=${varies('scale') ? 'frame' : 'init'}${kfs.some((k) => k.opacity < 1) ? `,eq=contrast='${A}':brightness='(0.0627-0.5)*(1-(${A}))':saturation='${A}':eval=${varies('opacity') ? 'frame' : 'init'}` : ''}[${o.id}kf]`);
  f.push(`color=c=black:s=${o.W}x${o.H}:r=${o.fps}:d=${(o.frames / o.fps).toFixed(4)},format=yuv420p[${o.id}kb]`);
  f.push(`[${o.id}kb][${o.id}kf]overlay=x='(W-w)/2+(${X})*W':y='(H-h)/2+(${Y})*H':eval=${varies('x') || varies('y') || varies('scale') ? 'frame' : 'init'}:shortest=1[${o.outLabel}]`);
  return f;
}

/** Same transform as CSS for the preview (canvas-sized element). */
export function keyframeCss(v: KfValues): { transform?: string; opacity?: number } {
  const out: { transform?: string; opacity?: number } = {};
  if (v.x !== 0 || v.y !== 0 || v.scale !== 1) out.transform = `translate(${(v.x * 100).toFixed(3)}%, ${(v.y * 100).toFixed(3)}%) scale(${v.scale.toFixed(4)})`;
  if (v.opacity !== 1) out.opacity = Math.round(v.opacity * 1000) / 1000;
  return out;
}
