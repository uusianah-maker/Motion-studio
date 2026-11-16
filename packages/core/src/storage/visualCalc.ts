/** R35 — the browser-safe part of Visual Tools (names, models, time estimate). */

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

