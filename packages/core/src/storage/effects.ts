/**
 * Picture effects on the `effects` track (U3c, the Remotion replacement for zoom shots). Pure
 * module: the preview computes the same zoom curve the render uses.
 *  - `zoom`: digital zoom / punch-in for the clip's span. `cut` jumps straight to `scale`,
 *    `smooth` eases in over `RAMP_MS` at the start and back out over `RAMP_MS` at the end (cosine
 *    ease-in-out, half the clip each when it is shorter). Centre (x, y) 0..1 of the canvas.
 *  - `zoom_through`: a fast push-in across the span (put a short clip on a cut point).
 * 25 Nov (keluhan owner "zoom in zoom out pergerakannya masih kasar"): the ramp was 250 ms (±7
 * frames). Default ramp now `RAMP_MS` = 600 ms, adjustable per effect (`ramp_ms` 100–3000), and
 * zoom_through eases in-out instead of a linear push.
 */
import { StorageError } from './errors.js';
import { easeOf } from './keyframes.js';

export type ClipEffect = { type: 'zoom'; scale: number; mode: 'cut' | 'smooth'; x: number; y: number; ramp_ms?: number } | { type: 'zoom_through'; scale: number; x: number; y: number };

export const RAMP_MS = 600;
export const RAMP_LIMITS = [100, 3000] as const;
export const EFFECT_LIMITS = { scale: [1.02, 2.5] as const };

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export function validateEffect(raw: unknown, where = 'effect'): ClipEffect {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o !== 'object' || Array.isArray(o)) return bad(`${where} harus objek`);
  const keys = o.type === 'zoom' ? ['type', 'scale', 'mode', 'x', 'y', 'ramp_ms'] : o.type === 'zoom_through' ? ['type', 'scale', 'x', 'y'] : bad(`${where}.type harus zoom | zoom_through`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const num = (k: string, min: number, max: number, dflt: number) => {
    const v = o[k];
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(`${where}.${k} harus angka ${min}–${max}`);
    return Math.round(v * 1000) / 1000;
  };
  const scale = num('scale', ...EFFECT_LIMITS.scale, o.type === 'zoom' ? 1.2 : 1.4);
  const x = num('x', 0, 1, 0.5);
  const y = num('y', 0, 1, 0.5);
  if (o.type === 'zoom') {
    const mode = o.mode === undefined ? 'smooth' : o.mode === 'cut' || o.mode === 'smooth' ? o.mode : bad(`${where}.mode harus cut | smooth`);
    if (o.ramp_ms === undefined) return { type: 'zoom', scale, mode, x, y };
    const r = o.ramp_ms;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < RAMP_LIMITS[0] || r > RAMP_LIMITS[1]) return bad(`${where}.ramp_ms harus angka ${RAMP_LIMITS[0]}–${RAMP_LIMITS[1]}`);
    return { type: 'zoom', scale, mode, x, y, ramp_ms: Math.round(r) };
  }
  return { type: 'zoom_through', scale, x, y };
}

/** Ramp length (ms) of a smooth zoom in a clip of `len` ms: in and out never overlap. */
export const rampOf = (len: number, ramp = RAMP_MS) => Math.max(1, Math.min(ramp, len / 2));

/** Zoom factor of one effect at `ms` (relative to its clip start). */
export function zoomAt(e: ClipEffect, ms: number, len: number): number {
  if (e.type === 'zoom') return e.mode === 'cut' ? e.scale : 1 + (e.scale - 1) * easeOf('ease', Math.min(1, Math.max(0, Math.min(ms, len - ms) / rampOf(len, e.ramp_ms))));
  return 1 + (e.scale - 1) * easeOf('ease', Math.min(1, Math.max(0, ms / Math.max(1, len))));
}

/** FFmpeg expression of the same curve in terms of `t` (seconds) for a clip at [s, e). */
export function zoomExpr(e: ClipEffect, s: number, end: number): string {
  const S = (s / 1000).toFixed(3);
  if (e.type === 'zoom') {
    if (e.mode === 'cut') return `${e.scale}`;
    const E = (end / 1000).toFixed(3);
    const R = (rampOf(end - s, e.ramp_ms) / 1000).toFixed(4);
    return `(1+${(e.scale - 1).toFixed(4)}*(0.5-0.5*cos(PI*clip(min(t-${S},${E}-t)/${R},0,1))))`;
  }
  return `(1+${(e.scale - 1).toFixed(4)}*(0.5-0.5*cos(PI*clip((t-${S})/${(Math.max(1, end - s) / 1000).toFixed(3)},0,1))))`;
}
