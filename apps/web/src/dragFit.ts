/** Pure helpers (no DOM, no network) so they can be unit-tested in Node. */

export interface Span {
  start_ms: number;
  end_ms: number;
}

/**
 * Where a dragged clip lands, made easy to place: the server refuses clips that overlap on one
 * track, so a drop onto a neighbour used to bounce back. Here the clip
 *  1. sticks to nearby edges (neighbour clips, playhead, 0) within `tolMs` (≈ 8 px), and
 *  2. never overlaps: it stops against the neighbour, at the nearest free spot to where it was dropped.
 * With no free spot at all it stays where it was (`original`).
 */
export function fitMove(want: Span, others: readonly Span[], magnets: readonly number[], tolMs: number, original: Span): Span {
  const len = want.end_ms - want.start_ms;
  let start = Math.max(0, want.start_ms);
  // 1. Magnet: the closest edge within reach, for the clip's start or its end.
  let best = tolMs;
  let snapped = start;
  for (const p of [0, ...magnets, ...others.flatMap((o) => [o.start_ms, o.end_ms])]) {
    if (Math.abs(start - p) < best) [best, snapped] = [Math.abs(start - p), p];
    if (Math.abs(start + len - p) < best && p - len >= 0) [best, snapped] = [Math.abs(start + len - p), p - len];
  }
  start = snapped;
  const free = (s: number) => s >= 0 && others.every((o) => s + len <= o.start_ms || s >= o.end_ms);
  if (free(start)) return { start_ms: start, end_ms: start + len };
  // 2. Overlap: slide to the nearest position that touches a neighbour without overlapping.
  const options = others.flatMap((o) => [o.end_ms, o.start_ms - len]).filter(free);
  if (!options.length) return original;
  const pick = options.reduce((a, b) => (Math.abs(b - want.start_ms) < Math.abs(a - want.start_ms) ? b : a));
  return { start_ms: pick, end_ms: pick + len };
}

/**
 * A trimmed edge stops against the neighbour instead of overlapping it (the drop used to bounce
 * back). Only ever shortens what `want` allows, so the source-length limits of dragSpan still hold.
 */
export function fitTrim(want: Span, edge: 'start' | 'end', others: readonly Span[], original: Span): Span {
  if (edge === 'end') {
    const limit = Math.min(Infinity, ...others.filter((o) => o.start_ms >= original.end_ms).map((o) => o.start_ms));
    return { start_ms: want.start_ms, end_ms: Math.max(want.start_ms + 1, Math.min(want.end_ms, limit)) };
  }
  const limit = Math.max(0, ...others.filter((o) => o.end_ms <= original.start_ms).map((o) => o.end_ms));
  return { start_ms: Math.min(want.end_ms - 1, Math.max(want.start_ms, limit)), end_ms: want.end_ms };
}

/**
 * The empty gap at `atMs` on one track (right-click → "Hapus jarak"): the clips after it and how far
 * to pull them left so the next clip touches the previous one. null = not in a gap before a clip.
 */
export function gapAt<C extends Span & { clip_id: string }>(clips: readonly C[], atMs: number): { clip_ids: string[]; delta_ms: number } | null {
  const sorted = [...clips].sort((a, b) => a.start_ms - b.start_ms);
  const next = sorted.find((c) => c.start_ms > atMs);
  if (!next || sorted.some((c) => c.start_ms <= atMs && c.end_ms > atMs)) return null;
  const prevEnd = Math.max(0, ...sorted.filter((c) => c.end_ms <= atMs).map((c) => c.end_ms));
  const gap = next.start_ms - prevEnd;
  if (gap <= 0) return null;
  return { clip_ids: sorted.filter((c) => c.start_ms >= next.start_ms).map((c) => c.clip_id), delta_ms: -gap };
}
