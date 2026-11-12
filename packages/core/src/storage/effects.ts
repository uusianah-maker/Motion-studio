/**
 * Picture effects on the `effects` track (U3c, the Remotion replacement for zoom shots). Pure
 * module: the preview computes the same zoom curve the render uses.
 *  - `zoom`: digital zoom / punch-in for the clip's span. `cut` jumps straight to `scale`,
 *    `smooth` eases in over `RAMP_MS`. Centre (x, y) 0..1 of the canvas.
 *  - `zoom_through`: a fast push-in across the span (put a short clip on a cut point).
 */
import { StorageError } from './errors.js';

export type ClipEffect = { type: 'zoom'; scale: number; mode: 'cut' | 'smooth'; x: number; y: number } | { type: 'zoom_through'; scale: number; x: number; y: number };

export const RAMP_MS = 250;
export const EFFECT_LIMITS = { scale: [1.02, 2.5] as const };

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export function validateEffect(raw: unknown, where = 'effect'): ClipEffect {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o !== 'object' || Array.isArray(o)) return bad(`${where} harus objek`);
  const keys = o.type === 'zoom' ? ['type', 'scale', 'mode', 'x', 'y'] : o.type === 'zoom_through' ? ['type', 'scale', 'x', 'y'] : bad(`${where}.type harus zoom | zoom_through`);
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
    return { type: 'zoom', scale, mode, x, y };
  }
  return { type: 'zoom_through', scale, x, y };
}

/** Zoom factor of one effect at `ms` (relative to its clip start). */
export function zoomAt(e: ClipEffect, ms: number, len: number): number {
  if (e.type === 'zoom') return e.mode === 'cut' ? e.scale : 1 + (e.scale - 1) * Math.min(1, Math.max(0, ms / RAMP_MS));
  return 1 + (e.scale - 1) * Math.min(1, Math.max(0, ms / Math.max(1, len)));
}

/** FFmpeg expression of the same curve in terms of `t` (seconds) for a clip at [s, e). */
export function zoomExpr(e: ClipEffect, s: number, end: number): string {
  const S = (s / 1000).toFixed(3);
  if (e.type === 'zoom') return e.mode === 'cut' ? `${e.scale}` : `(1+${(e.scale - 1).toFixed(4)}*min(1,(t-${S})/${(RAMP_MS / 1000).toFixed(3)}))`;
  return `(1+${(e.scale - 1).toFixed(4)}*min(1,(t-${S})/${(Math.max(1, end - s) / 1000).toFixed(3)}))`;
}
