/**
 * R35c "Lacak objek" (owner 16 Nov; KONTRAK-ENGINE §18.7 jalur-posisi/1). Browser-safe maths:
 *  - the box the team draws on the preview (canvas fractions) → the SOURCE box the engine tracks;
 *  - the tracked path → keyframes that make a text clip follow the object, or → a short series of
 *    blur areas (source fractions + source ms) that follow it.
 * Same placement rule as the preview/render (framing.placeOnCanvas: crop, then contain or cover).
 */
export type Box = { x: number; y: number; w: number; h: number };
export type PathPoint = { t: number; x: number; y: number; w: number; h: number };
type Geo = { src: { w: number; h: number }; canvas: { w: number; h: number }; crop?: Box | undefined; cover: boolean };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function frame(g: Geo) {
  const c = g.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = g.src.w * c.w;
  const ch = g.src.h * c.h;
  const k = g.cover ? Math.max(g.canvas.w / cw, g.canvas.h / ch) : Math.min(g.canvas.w / cw, g.canvas.h / ch);
  return { c, k, ox: (g.canvas.w - cw * k) / 2, oy: (g.canvas.h - ch * k) / 2 };
}

/** A box drawn on the preview (canvas fractions) → the same area in the source frame (fractions). */
export function canvasBoxToSource(b: Box, g: Geo): Box {
  const { c, k, ox, oy } = frame(g);
  const sx = (px: number) => clamp01((((px * g.canvas.w - ox) / k) + c.x * g.src.w) / g.src.w);
  const sy = (py: number) => clamp01((((py * g.canvas.h - oy) / k) + c.y * g.src.h) / g.src.h);
  const x0 = sx(b.x);
  const y0 = sy(b.y);
  const x1 = sx(b.x + b.w);
  const y1 = sy(b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** A source point (fractions) → canvas fractions. */
export function sourcePointToCanvas(p: { x: number; y: number }, g: Geo): { x: number; y: number } {
  const { c, k, ox, oy } = frame(g);
  return { x: (ox + (p.x - c.x) * g.src.w * k) / g.canvas.w, y: (oy + (p.y - c.y) * g.src.h * k) / g.canvas.h };
}

/** The longest path of a jalur-posisi/1 result (points sorted by time). */
export function longestPath(data: unknown): PathPoint[] {
  const jalur = ((data as { jalur?: unknown })?.jalur ?? []) as { titik?: unknown }[];
  let best: PathPoint[] = [];
  for (const j of Array.isArray(jalur) ? jalur : []) {
    const pts = (Array.isArray(j?.titik) ? (j.titik as Record<string, unknown>[]) : [])
      .filter((p) => [p.t, p.x, p.y, p.w, p.h].every((v) => typeof v === 'number' && Number.isFinite(v)))
      .map((p) => ({ t: p.t as number, x: clamp01(p.x as number), y: clamp01(p.y as number), w: clamp01(p.w as number), h: clamp01(p.h as number) }))
      .sort((a, b) => a.t - b.t);
    if (pts.length > best.length) best = pts;
  }
  return best;
}

/**
 * Keyframes (x, y = canvas-fraction offsets from the text's own position) so a text clip follows the
 * object's centre. Source time t (s) → timeline = video.start_ms + t·1000 − video.in_ms.
 */
export function followTextKeyframes(pts: readonly PathPoint[], o: { video: { start_ms: number; in_ms?: number }; text: { start_ms: number; end_ms: number }; base: { x: number; y: number }; geo: Geo }) {
  const len = o.text.end_ms - o.text.start_ms;
  const inside = pts
    .map((p) => {
      const at = Math.round(o.video.start_ms + p.t * 1000 - (o.video.in_ms ?? 0) - o.text.start_ms);
      const c = sourcePointToCanvas({ x: p.x + p.w / 2, y: p.y + p.h / 2 }, o.geo);
      return { at_ms: at, x: Math.max(-1, Math.min(1, Math.round((c.x - o.base.x) * 1000) / 1000)), y: Math.max(-1, Math.min(1, Math.round((c.y - o.base.y) * 1000) / 1000)), scale: 1, opacity: 1, ease: 'linear' as const };
    })
    .filter((k) => k.at_ms >= 0 && k.at_ms <= len)
    .filter((k, i, a) => i === 0 || k.at_ms > a[i - 1]!.at_ms);
  if (inside.length <= 20) return inside;
  const step = (inside.length - 1) / 19;
  return Array.from({ length: 20 }, (_, i) => inside[Math.round(i * step)]!);
}

/** Blur areas that follow the path: the time is cut into `n` windows, each one box (+ padding). */
export function followBlurRegions(pts: readonly PathPoint[], n: number, radius = 20, pad = 0.03) {
  if (!pts.length || n < 1) return [];
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const span = Math.max(0.001, t1 - t0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = t0 + (span * i) / n;
    const b = i === n - 1 ? t1 + 0.05 : t0 + (span * (i + 1)) / n;
    let win = pts.filter((p) => p.t >= a && p.t <= b);
    // A window between two path points: cover it from the neighbours (no gap in the blur).
    if (!win.length) win = [pts.filter((p) => p.t < a).at(-1), pts.find((p) => p.t > b)].filter((p): p is PathPoint => !!p);
    if (!win.length) continue;
    const x0 = clamp01(Math.min(...win.map((p) => p.x)) - pad);
    const y0 = clamp01(Math.min(...win.map((p) => p.y)) - pad);
    const x1 = clamp01(Math.max(...win.map((p) => p.x + p.w)) + pad);
    const y1 = clamp01(Math.max(...win.map((p) => p.y + p.h)) + pad);
    out.push({ x: Math.round(x0 * 1000) / 1000, y: Math.round(y0 * 1000) / 1000, w: Math.round((x1 - x0) * 1000) / 1000, h: Math.round((y1 - y0) * 1000) / 1000, dari_ms: Math.round(a * 1000), sampai_ms: Math.round(b * 1000), radius });
  }
  return out;
}
