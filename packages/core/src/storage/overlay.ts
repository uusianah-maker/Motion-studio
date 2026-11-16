/**
 * R26: image overlays (logo, watermark, sticker, frame) on the `overlay` track. Pure module — the
 * preview and the render share the same placement, so "pratinjau = render".
 *
 * Each overlay clip carries an image `media` and an `overlay` spec: a preset position (corner or
 * centre) + manual nudge, width, opacity, margin from the edges, layer (higher = in front) and
 * `sepanjang` (shown for the whole video, whatever its clip times). Overlay clips may overlap in
 * time on their track: the layer decides which one is in front.
 */

export const OVERLAY_POS = ['tl', 'tr', 'bl', 'br', 'c'] as const;
/** R38b (ucok): blend modes of an overlay (video effects: light leak, dust…). Same names as CSS mix-blend-mode. */
export const OVERLAY_BLENDS = ['normal', 'screen', 'lighten', 'multiply', 'overlay'] as const;
export type OverlayBlend = (typeof OVERLAY_BLENDS)[number];
export const OVERLAY_BLEND_LABEL: Record<OverlayBlend, string> = { normal: 'Normal', screen: 'Screen (terangkan)', lighten: 'Lighten', multiply: 'Multiply (gelapkan)', overlay: 'Overlay (kontras)' };
export type OverlayPos = (typeof OVERLAY_POS)[number];
export const OVERLAY_POS_LABEL: Record<OverlayPos, string> = { tl: 'Kiri atas', tr: 'Kanan atas', bl: 'Kiri bawah', br: 'Kanan bawah', c: 'Tengah' };

/** Limits: width % of the canvas width, opacity, margin % of the short side, nudge as a canvas fraction. */
export const OVERLAY_LIMITS = { skala: [2, 100] as const, opasitas: [0.05, 1] as const, margin: [0, 20] as const, geser: [-1, 1] as const, layer: [0, 999] as const };

export interface Overlay {
  pos: OverlayPos;
  /** Manual nudge after the preset, as a fraction of the canvas width / height (−1..1). */
  dx: number;
  dy: number;
  /** Width as % of the canvas width (height follows the picture). */
  skala: number;
  opasitas: number;
  /** Distance from the canvas edges, % of the canvas short side (ignored by `c` except nothing). */
  margin: number;
  /** Stacking order: higher = in front. */
  layer: number;
  /** Whole video (0 → end), whatever the clip's own start/end. */
  sepanjang?: true;
  /** R38b: how it mixes with the picture below (absent = normal). */
  blend?: OverlayBlend;
  /** R38b: a transition stinger (placed centred on a cut; marker for the editor). */
  stinger?: true;
}

export const OVERLAY_DEFAULT: Overlay = { pos: 'tr', dx: 0, dy: 0, skala: 18, opasitas: 1, margin: 4, layer: 0 };

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

function num(x: unknown, where: string, [lo, hi]: readonly [number, number], digits: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${where} harus angka ${lo}–${hi}`);
  return round(x, digits);
}

/** Full spec from untrusted input (every field required except `sepanjang`). */
export function validateOverlay(x: unknown, where = 'overlay'): Overlay {
  const o = (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : null) as Record<string, unknown> | null;
  if (!o) throw new Error(`${where} harus object`);
  const extra = Object.keys(o).filter((k) => !['pos', 'dx', 'dy', 'skala', 'opasitas', 'margin', 'layer', 'sepanjang', 'blend', 'stinger'].includes(k));
  if (extra.length) throw new Error(`${where}: field tidak dikenal ${extra.join(', ')}`);
  return { ...OVERLAY_DEFAULT, ...validateOverlayPatch(o, where, true) } as Overlay;
}

/** Partial spec (set_overlay). `full` = every required field must be present. */
export function validateOverlayPatch(x: unknown, where = 'overlay', full = false): Partial<Overlay> & { sepanjang?: true } {
  const o = (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : null) as Record<string, unknown> | null;
  if (!o) throw new Error(`${where} harus object`);
  const extra = Object.keys(o).filter((k) => !['pos', 'dx', 'dy', 'skala', 'opasitas', 'margin', 'layer', 'sepanjang', 'blend', 'stinger'].includes(k));
  if (extra.length) throw new Error(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const out: Partial<Overlay> = {};
  const need = (k: string) => {
    if (full && o[k] === undefined) throw new Error(`${where}.${k} wajib`);
    return o[k] !== undefined;
  };
  if (need('pos')) {
    if (!(OVERLAY_POS as readonly unknown[]).includes(o.pos)) throw new Error(`${where}.pos harus ${OVERLAY_POS.join(' | ')}`);
    out.pos = o.pos as OverlayPos;
  }
  if (need('dx')) out.dx = num(o.dx, `${where}.dx`, OVERLAY_LIMITS.geser, 4);
  if (need('dy')) out.dy = num(o.dy, `${where}.dy`, OVERLAY_LIMITS.geser, 4);
  if (need('skala')) out.skala = num(o.skala, `${where}.skala`, OVERLAY_LIMITS.skala, 1);
  if (need('opasitas')) out.opasitas = num(o.opasitas, `${where}.opasitas`, OVERLAY_LIMITS.opasitas, 2);
  if (need('margin')) out.margin = num(o.margin, `${where}.margin`, OVERLAY_LIMITS.margin, 1);
  if (need('layer')) {
    if (!Number.isInteger(o.layer)) throw new Error(`${where}.layer harus bilangan bulat`);
    out.layer = num(o.layer, `${where}.layer`, OVERLAY_LIMITS.layer, 0);
  }
  if (o.blend !== undefined) {
    if (!(OVERLAY_BLENDS as readonly unknown[]).includes(o.blend)) throw new Error(`${where}.blend harus ${OVERLAY_BLENDS.join(' | ')}`);
    out.blend = o.blend as OverlayBlend;
  }
  if (o.stinger !== undefined) {
    if (typeof o.stinger !== 'boolean') throw new Error(`${where}.stinger harus true/false`);
    (out as Record<string, unknown>).stinger = o.stinger; // patch: false switches it off
  }
  if (o.sepanjang !== undefined) {
    if (typeof o.sepanjang !== 'boolean') throw new Error(`${where}.sepanjang harus true/false`);
    if (o.sepanjang) out.sepanjang = true;
    else (out as Record<string, unknown>).sepanjang = false; // patch: switch off
  }
  return out as Partial<Overlay> & { sepanjang?: true };
}

/** Apply a patch (`sepanjang: false` removes the flag). */
export function patchOverlay(cur: Overlay, patch: Partial<Overlay> | Record<string, unknown>): Overlay {
  const next = { ...cur, ...patch } as Overlay & { sepanjang?: boolean; stinger?: boolean };
  if (!next.sepanjang) delete next.sepanjang;
  if (!next.stinger) delete next.stinger;
  if (next.blend === 'normal') delete next.blend;
  return next as Overlay;
}

/**
 * Top-left corner + size of an overlay on a W×H canvas for a picture of iw×ih, in canvas pixels.
 * The same numbers drive the preview (CSS) and the render (FFmpeg overlay x/y).
 */
export function overlayBox(o: Overlay, W: number, H: number, iw: number, ih: number): { x: number; y: number; w: number; h: number } {
  const w = Math.max(2, Math.round((W * o.skala) / 100 / 2) * 2);
  const h = Math.max(2, Math.round((w * ih) / Math.max(1, iw) / 2) * 2);
  const m = Math.round((Math.min(W, H) * o.margin) / 100);
  const bx = o.pos === 'c' ? (W - w) / 2 : o.pos.endsWith('l') ? m : W - w - m;
  const by = o.pos === 'c' ? (H - h) / 2 : o.pos.startsWith('t') ? m : H - h - m;
  return { x: Math.round(bx + o.dx * W), y: Math.round(by + o.dy * H), w, h };
}

/** Time span an overlay is visible: whole video when `sepanjang`, else its clip. */
export const overlaySpan = (c: { start_ms: number; end_ms: number; overlay?: Overlay }, total_ms: number): [number, number] => (c.overlay?.sepanjang ? [0, total_ms] : [c.start_ms, Math.min(c.end_ms, total_ms)]);

/** Back-to-front drawing order: layer ascending, then timeline order. */
export function overlayOrder<T extends { overlay?: Overlay; start_ms: number }>(clips: readonly T[]): T[] {
  return clips
    .map((c, i) => [c, i] as const)
    .sort((a, b) => (a[0].overlay?.layer ?? 0) - (b[0].overlay?.layer ?? 0) || a[1] - b[1])
    .map(([c]) => c);
}

/**
 * Length of the video: the last clip end, where whole-video overlays do not count (they follow the
 * video instead of making it longer). Shared by the render, the reducer and the preview.
 */
export function contentEnd(tracks: readonly { kind: string; clips: readonly { end_ms: number; overlay?: Overlay }[] }[]): number {
  const all = tracks.flatMap((t) => t.clips.map((c) => ({ end: c.end_ms, follows: t.kind === 'overlay' && !!c.overlay?.sepanjang })));
  const own = all.filter((c) => !c.follows);
  return Math.max(0, ...(own.length ? own : all).map((c) => c.end));
}
