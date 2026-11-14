/**
 * Framing of a media clip (U3d, for Batch Remix): crop a part of the source and blur areas of it
 * (a competitor's logo, a face, burnt-in text). Pure module — the preview and the render share it.
 *  - `crop` {x, y, w, h}: part of the SOURCE frame, fractions 0..1. The cropped picture is then
 *    fitted onto the canvas like any clip (contain + pad).
 *  - `blur` [{x, y, w, h, dari_ms, sampai_ms, radius}]: areas of the SOURCE frame (fractions, before
 *    the crop) blurred between dari_ms and sampai_ms of SOURCE time. Source time means splits,
 *    trims and cut silences never need to move the regions.
 */
import { StorageError } from './errors.js';

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BlurRegion extends Crop {
  dari_ms: number;
  sampai_ms: number;
  /** Blur strength (gblur sigma at 1080 px short side). */
  radius: number;
}

export const MIN_CROP = 0.1;
export const MAX_BLUR_REGIONS = 8;
export const BLUR_RADIUS: readonly [number, number] = [2, 60];

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const frac = (o: Record<string, unknown>, k: string, where: string, min = 0) => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > 1) return bad(`${where}.${k} harus angka ${min}–1`);
  return Math.round(v * 10000) / 10000;
};
const box = (o: Record<string, unknown>, where: string, min: number): Crop => {
  const c = { x: frac(o, 'x', where), y: frac(o, 'y', where), w: frac(o, 'w', where, min), h: frac(o, 'h', where, min) };
  if (c.x + c.w > 1.0001 || c.y + c.h > 1.0001) bad(`${where}: area keluar dari bingkai (x+w dan y+h maksimal 1)`);
  return c;
};
const plain = (raw: unknown, where: string): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : bad(`${where} harus objek`));
const only = (o: Record<string, unknown>, keys: string[], where: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
};

export function validateCrop(raw: unknown, where = 'crop'): Crop {
  const o = plain(raw, where);
  only(o, ['x', 'y', 'w', 'h'], where);
  return box(o, where, MIN_CROP);
}

export function validateBlur(raw: unknown, where = 'blur'): BlurRegion[] {
  if (!Array.isArray(raw) || raw.length > MAX_BLUR_REGIONS) return bad(`${where} harus daftar 0–${MAX_BLUR_REGIONS} area`);
  return raw.map((r, i) => {
    const w = `${where}[${i}]`;
    const o = plain(r, w);
    only(o, ['x', 'y', 'w', 'h', 'dari_ms', 'sampai_ms', 'radius'], w);
    const b = box(o, w, 0.01);
    const ms = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= 24 * 3_600_000 ? Math.round(o[k] as number) : bad(`${w}.${k} harus angka ms`));
    const dari = ms('dari_ms');
    const sampai = ms('sampai_ms');
    if (sampai <= dari) bad(`${w}: sampai_ms harus > dari_ms`);
    const rad = o.radius === undefined ? 20 : typeof o.radius === 'number' && o.radius >= BLUR_RADIUS[0] && o.radius <= BLUR_RADIUS[1] ? Math.round(o.radius) : bad(`${w}.radius harus ${BLUR_RADIUS[0]}–${BLUR_RADIUS[1]}`);
    return { ...b, dari_ms: dari, sampai_ms: sampai, radius: rad };
  });
}

/** Regions active at source time `srcMs`. */
export const blurAt = (regions: readonly BlurRegion[] | undefined, srcMs: number) => (regions ?? []).filter((r) => srcMs >= r.dari_ms && srcMs < r.sampai_ms);

/**
 * Where a source area lands on the canvas: the (cropped) source is fitted with contain + centred,
 * exactly like the render's scale/pad. Returns pixels of the canvas.
 */
export function placeOnCanvas(src: { w: number; h: number }, crop: Crop | undefined, canvas: { w: number; h: number }, area: Crop, cover = false): { left: number; top: number; width: number; height: number } {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = src.w * c.w;
  const ch = src.h * c.h;
  // Malam 15 Nov: `cover` = clip fit 'isi' (fills the canvas, overflow cut off).
  const k = cover ? Math.max(canvas.w / cw, canvas.h / ch) : Math.min(canvas.w / cw, canvas.h / ch);
  const ox = (canvas.w - cw * k) / 2;
  const oy = (canvas.h - ch * k) / 2;
  // Area in source px, clipped to the crop.
  const ax0 = Math.max(area.x, c.x) * src.w;
  const ay0 = Math.max(area.y, c.y) * src.h;
  const ax1 = Math.min(area.x + area.w, c.x + c.w) * src.w;
  const ay1 = Math.min(area.y + area.h, c.y + c.h) * src.h;
  return { left: ox + (ax0 - c.x * src.w) * k, top: oy + (ay0 - c.y * src.h) * k, width: Math.max(0, ax1 - ax0) * k, height: Math.max(0, ay1 - ay0) * k };
}

const f4 = (n: number) => n.toFixed(4);

/**
 * FFmpeg chain for one segment's video: blur areas (timed on the segment's own clock: t = 0 is
 * source time `srcStartMs`), then the crop. `inLabel` → `outLabel`; `id` keeps labels unique.
 * Returns null when the clip has no framing (the caller keeps its plain chain).
 */
export function framingFilters(o: { crop?: Crop; blur?: readonly BlurRegion[]; srcStartMs: number; durMs: number; shortSide: number; inLabel: string; outLabel: string; id: string }): string[] | null {
  const regions = (o.blur ?? []).filter((r) => r.sampai_ms > o.srcStartMs && r.dari_ms < o.srcStartMs + o.durMs);
  if (!o.crop && !regions.length) return null;
  const out: string[] = [];
  let cur = o.inLabel;
  regions.forEach((r, i) => {
    const a = `${o.id}b${i}a`;
    const b = `${o.id}b${i}b`;
    const c = `${o.id}b${i}c`;
    const next = `${o.id}b${i}o`;
    const s = Math.max(0, (r.dari_ms - o.srcStartMs) / 1000).toFixed(3);
    const e = ((r.sampai_ms - o.srcStartMs) / 1000).toFixed(3);
    const sigma = Math.max(1, Math.round((r.radius * o.shortSide) / 1080));
    out.push(`[${cur}]split[${a}][${b}]`);
    out.push(`[${b}]crop=w=iw*${f4(r.w)}:h=ih*${f4(r.h)}:x=iw*${f4(r.x)}:y=ih*${f4(r.y)},gblur=sigma=${sigma}[${c}]`);
    out.push(`[${a}][${c}]overlay=x=main_w*${f4(r.x)}:y=main_h*${f4(r.y)}:enable='between(t,${s},${e})'[${next}]`);
    cur = next;
  });
  out.push(o.crop ? `[${cur}]crop=w=iw*${f4(o.crop.w)}:h=ih*${f4(o.crop.h)}:x=iw*${f4(o.crop.x)}:y=ih*${f4(o.crop.y)}[${o.outLabel}]` : `[${cur}]null[${o.outLabel}]`);
  return out;
}

/** Crop that fills a canvas of `ratio` (w/h) from the middle of the source (no black bars). */
export function fillCrop(src: { w: number; h: number }, ratio: number): Crop {
  const srcRatio = src.w / src.h;
  if (Math.abs(srcRatio - ratio) < 0.01) return { x: 0, y: 0, w: 1, h: 1 };
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  if (srcRatio > ratio) {
    const w = r4(ratio / srcRatio);
    return { x: r4((1 - w) / 2), y: 0, w, h: 1 };
  }
  const h = r4(srcRatio / ratio);
  return { x: 0, y: r4((1 - h) / 2), w: 1, h };
}
