/** R35 — the browser-safe part of Visual Tools (names, models, time estimate). */
import { KF_EASES, type KfEase } from './keyframes.js';

export const VISUAL_TOOLS = ['deteksi', 'reframe', 'lacak', 'hapus_latar', 'perjelas'] as const;
export type VisualTool = (typeof VISUAL_TOOLS)[number];
/** What the engine writes per tool (inside out/). */
export const VISUAL_RESULT: Record<VisualTool, string> = { deteksi: 'jalur.json', reframe: 'reframe.json', lacak: 'lacak.json', hapus_latar: 'hapus_latar/hapus_latar.json', perjelas: 'perjelas/perjelas.json' };
/** §18.8: background models — fast (default for video) / high quality (default for images, slow). */
export const BG_MODELS = { cepat: 'isnet-general-use', tinggi: 'birefnet-general-lite' } as const;
/** Seconds per frame on the office PC (§18.8 / §18.9), for the estimate shown before starting. */
export const SECONDS_PER_FRAME = { hapus_latar: { cepat: 1.3, tinggi: 13 }, perjelas: { cepat: 0.5, kualitas: 13 } } as const;
export const VISUAL_MAX_VIDEO_S = 15;

/** Rough time in seconds (estimate shown in the UI before the job starts). */
export function visualEstimate(alat: VisualTool, opts: { video: boolean; durasi_s: number; kualitas?: 'cepat' | 'tinggi'; mode?: 'cepat' | 'kualitas'; fps?: number }): number {
  const frames = opts.video ? Math.max(1, Math.min(VISUAL_MAX_VIDEO_S, opts.durasi_s) * (alat === 'perjelas' ? 30 : (opts.fps ?? 10))) : 1;
  if (alat === 'hapus_latar') return Math.round(frames * SECONDS_PER_FRAME.hapus_latar[opts.kualitas ?? (opts.video ? 'cepat' : 'tinggi')]);
  if (alat === 'perjelas') return Math.round(frames * SECONDS_PER_FRAME.perjelas[opts.mode ?? (opts.video ? 'cepat' : 'kualitas')]);
  return Math.round(opts.durasi_s * 0.25 + 3);
}


// ------------------------------------------------------------------ R23g / R35b auto reframe

const RATIO_PARTS: Record<string, [number, number]> = { '9:16': [9, 16], '3:4': [3, 4], '1:1': [1, 1], '16:9': [16, 9] };
/** Canvas pixels for a ratio at 1080 on the short side (what reframe's `kanvas` expects). */
export function reframeCanvas(ratio: string): [number, number] {
  const [a, b] = RATIO_PARTS[ratio] ?? [9, 16];
  return a <= b ? [1080, Math.round((1080 * b) / a / 2) * 2] : [Math.round((1080 * a) / b / 2) * 2, 1080];
}

type Kf = { at_ms: number; x: number; y: number; scale: number; opacity: number; ease: KfEase };
/**
 * The engine's `keyframe_app` (§18.2, times relative to the clip's in-point) → keyframes for a clip
 * of `lenMs`: a keyframe before 0 becomes the value at 0 (the last one before), those after the end
 * are dropped, times strictly rising, at most 20 (MAX_KEYFRAMES).
 */
export function reframeKeyframes(raw: unknown, lenMs: number): Kf[] {
  const list = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const kfs: Kf[] = list
    .filter((k) => k && typeof k.at_ms === 'number')
    .map((k) => ({ at_ms: Math.round(k.at_ms as number), x: num(k.x, -1, 1, 0), y: num(k.y, -1, 1, 0), scale: num(k.scale, 0.1, 4, 1), opacity: num(k.opacity, 0, 1, 1), ease: (KF_EASES.includes(k.ease as KfEase) ? k.ease : 'linear') as Kf['ease'] }))
    .sort((a, b) => a.at_ms - b.at_ms);
  const before = kfs.filter((k) => k.at_ms < 0).at(-1);
  const inside = kfs.filter((k) => k.at_ms >= 0 && k.at_ms <= lenMs);
  if (before && !inside.some((k) => k.at_ms === 0)) inside.unshift({ ...before, at_ms: 0 });
  const out = inside.filter((k, i, a) => i === 0 || k.at_ms > a[i - 1]!.at_ms);
  if (out.length <= 20) return out;
  // Too many: keep the first, the last and an even spread between.
  const step = (out.length - 1) / 19;
  return Array.from({ length: 20 }, (_, i) => out[Math.round(i * step)]!);
}
