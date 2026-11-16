/**
 * R23e chroma key / green screen (owner 16 Nov, alat edit gaya CapCut — teknik saja, FFmpeg
 * `chromakey`). For a video/picture on the R26 overlay track: the key colour becomes transparent,
 * so the subject sits on top of the main video. Browser-safe (no Node modules): the same maths for
 * the render's filter and the preview's canvas.
 */
export interface Chroma {
  /** Key colour #rrggbb (green screen #00ff00 / blue screen #0000ff / picked from the picture). */
  warna: string;
  /** How close a colour must be to the key to vanish, 0.01–0.6 (FFmpeg `similarity`). */
  toleransi: number;
  /** Soft edge, 0–0.5 (FFmpeg `blend`; 0 = hard edge). */
  halus: number;
}
export const CHROMA_DEFAULT: Chroma = { warna: '#00ff00', toleransi: 0.15, halus: 0.05 };
export const CHROMA_LIMITS = { toleransi: [0.01, 0.6] as const, halus: [0, 0.5] as const };
export const CHROMA_PRESETS = { hijau: '#00ff00', biru: '#0000ff' } as const;

/** Untrusted input → chroma (throws a plain Error with the reason; callers wrap it). */
export function validateChroma(x: unknown, where = 'chroma'): Chroma {
  const o = (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : null) as Record<string, unknown> | null;
  if (!o) throw new Error(`${where} harus object`);
  const extra = Object.keys(o).filter((k) => !['warna', 'toleransi', 'halus'].includes(k));
  if (extra.length) throw new Error(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const warna = o.warna === undefined ? CHROMA_DEFAULT.warna : typeof o.warna === 'string' && /^#[0-9a-f]{6}$/i.test(o.warna) ? o.warna.toLowerCase() : null;
  if (!warna) throw new Error(`${where}.warna harus warna #rrggbb`);
  const num = (v: unknown, k: string, [lo, hi]: readonly [number, number], d: number) => {
    if (v === undefined) return d;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${where}.${k} harus ${lo}–${hi}`);
    return Math.round(v * 1000) / 1000;
  };
  return { warna, toleransi: num(o.toleransi, 'toleransi', CHROMA_LIMITS.toleransi, CHROMA_DEFAULT.toleransi), halus: num(o.halus, 'halus', CHROMA_LIMITS.halus, CHROMA_DEFAULT.halus) };
}

/** FFmpeg filter (before the overlay's scale). */
export const chromaFilter = (c: Chroma): string => `chromakey=color=0x${c.warna.slice(1)}:similarity=${c.toleransi}:blend=${c.halus}`;

const uv = (r: number, g: number, b: number): [number, number] => [-0.168736 * r - 0.331264 * g + 0.5 * b + 128, 0.5 * r - 0.418688 * g - 0.081312 * b + 128];

/**
 * Alpha 0..1 of one pixel — FFmpeg chromakey's rule (vf_chromakey.c): the distance between the
 * pixel's and the key's chroma (U, V), normalised; under `similarity` = transparent, then a soft
 * ramp of width `blend`. Used by the preview canvas.
 */
export function chromaAlpha(r: number, g: number, b: number, key: readonly [number, number], c: Pick<Chroma, 'toleransi' | 'halus'>): number {
  const [u, v] = uv(r, g, b);
  const du = u - key[0];
  const dv = v - key[1];
  const diff = Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
  if (c.halus > 0.0001) return Math.max(0, Math.min(1, (diff - c.toleransi) / c.halus));
  return diff > c.toleransi ? 1 : 0;
}
export function chromaKeyUV(hex: string): [number, number] {
  const n = parseInt(hex.slice(1), 16);
  return uv((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
