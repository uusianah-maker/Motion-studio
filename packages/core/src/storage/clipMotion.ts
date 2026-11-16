/**
 * R23a (owner 16 Nov, alat edit gaya CapCut — teknik saja, semua dibuat sendiri dengan FFmpeg).
 * Pure module shared by the timeline reducer, the FFmpeg render and the editor preview:
 *  - arah gambar per klip video/b-roll: `rotate` (90 | 180 | 270), `flip_h`, `flip_v`;
 *  - kecepatan `speed` 0,1×–10× (gambar + suara; durasi klip di linimasa ikut berubah);
 *  - `reverse` (gambar + suara diputar mundur; sumber maks MAX_REVERSE_MS);
 *  - `freeze`: potongan diam (satu frame sumber di `in_ms`, tanpa suara);
 *  - `vdenoise`: reduksi noise gambar (ringan | sedang, hqdn3d).
 * Source mapping: a media clip always uses the source span [in_ms, in_ms + length × speed); a
 * reversed clip shows that span backwards; a frozen clip shows the frame at in_ms.
 */
import { StorageError } from './errors.js';

export const ROTATIONS = [90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];
export const VDENOISE_LEVELS = ['ringan', 'sedang'] as const;
/** R23f: stabilisation strength (the copy is made in the background, see stabil.ts). */
export const STABIL_LEVELS = ['ringan', 'kuat'] as const;
export type StabilLevel = (typeof STABIL_LEVELS)[number];
export type VDenoise = (typeof VDENOISE_LEVELS)[number];
export const SPEED_RANGE: readonly [number, number] = [0.1, 10];
/** Reverse keeps every frame of the piece in memory: the source span is capped. */
export const MAX_REVERSE_MS = 10_000;
export const FREEZE_MS: readonly [number, number] = [200, 10_000];
/** Speeds outside this range sound odd: the UI offers "tanpa suara". */
export const NATURAL_SPEED: readonly [number, number] = [0.5, 2];

export interface MotionFields {
  rotate?: Rotation;
  flip_h?: boolean;
  flip_v?: boolean;
  speed?: number;
  reverse?: boolean;
  freeze?: boolean;
  vdenoise?: VDenoise;
  /** R23f: play/render the stabilised copy of the media (made in the background). */
  stabil?: StabilLevel;
}
export const MOTION_FIELDS = ['rotate', 'flip_h', 'flip_v', 'speed', 'reverse', 'freeze', 'vdenoise', 'stabil'] as const;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

export const validateRotate = (v: unknown, where: string): Rotation | 0 => (v === 0 || ROTATIONS.includes(v as Rotation) ? (v as Rotation | 0) : bad(`${where} harus 0 | 90 | 180 | 270`));
export const validateBool = (v: unknown, where: string): boolean => (typeof v === 'boolean' ? v : bad(`${where} harus true/false`));
export const validateSpeed = (v: unknown, where: string): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= SPEED_RANGE[0] && v <= SPEED_RANGE[1] ? Math.round(v * 100) / 100 : bad(`${where} harus angka ${SPEED_RANGE[0]}–${SPEED_RANGE[1]}`);
export const validateStabil = (v: unknown, where: string): StabilLevel | 'off' => (v === 'off' || STABIL_LEVELS.includes(v as StabilLevel) ? (v as StabilLevel | 'off') : bad(`${where} harus off | ringan | kuat`));
export const validateVDenoise = (v: unknown, where: string): VDenoise | 'off' => (v === 'off' || VDENOISE_LEVELS.includes(v as VDenoise) ? (v as VDenoise | 'off') : bad(`${where} harus off | ringan | sedang`));

/** Read the motion fields of an untrusted clip / add_clip op: video/b-roll media clips; R23b: `speed` on any media clip. */
export function readMotion(o: Record<string, unknown>, where: string, visualMedia: boolean, hasMedia = visualMedia): MotionFields {
  const out: MotionFields = {};
  for (const k of MOTION_FIELDS) if (o[k] !== undefined && !visualMedia && !(k === 'speed' && hasMedia)) bad(`${where}.${k}: hanya untuk klip video/b-roll`);
  if (o.rotate !== undefined) {
    const r = validateRotate(o.rotate, `${where}.rotate`);
    if (r) out.rotate = r;
  }
  for (const k of ['flip_h', 'flip_v', 'reverse', 'freeze'] as const) if (o[k] !== undefined && validateBool(o[k], `${where}.${k}`)) out[k] = true;
  if (o.speed !== undefined) {
    const s = validateSpeed(o.speed, `${where}.speed`);
    if (s !== 1) out.speed = s;
  }
  if (o.vdenoise !== undefined) {
    const d = validateVDenoise(o.vdenoise, `${where}.vdenoise`);
    if (d !== 'off') out.vdenoise = d;
  }
  if (o.stabil !== undefined) {
    const d = validateStabil(o.stabil, `${where}.stabil`);
    if (d !== 'off') out.stabil = d;
  }
  if (out.freeze && (out.speed || out.reverse)) bad(`${where}: potongan diam tidak punya kecepatan/mundur`);
  return out;
}

export function copyMotion(c: MotionFields): MotionFields {
  const out: MotionFields = {};
  for (const k of MOTION_FIELDS) if (c[k] !== undefined && c[k] !== false) (out as Record<string, unknown>)[k] = c[k];
  return out;
}

// ------------------------------------------------------------------ source mapping (shared)

type Span = { start_ms: number; end_ms: number; in_ms?: number } & Pick<MotionFields, 'speed' | 'reverse' | 'freeze'>;

export const speedOf = (c: Pick<MotionFields, 'speed' | 'freeze'>): number => (c.freeze ? 0 : (c.speed ?? 1));

/** Source ms the clip uses in all: [in_ms, in_ms + sourceLength). 0 for a frozen clip. */
export const sourceLength = (c: Span): number => Math.round((c.end_ms - c.start_ms) * speedOf(c));

/** Source position (ms) shown at `rel` ms into the clip. */
export function sourceAt(c: Span, rel: number): number {
  const inMs = c.in_ms ?? 0;
  if (c.freeze) return inMs;
  const s = c.speed ?? 1;
  return c.reverse ? inMs + ((c.end_ms - c.start_ms) - rel) * s : inMs + rel * s;
}

/** in_ms of the piece [relA, relB) of a clip (split, trim, cut): the start of its own source span. */
export function sliceIn(c: Span, relA: number, relB: number): number {
  const inMs = c.in_ms ?? 0;
  if (c.freeze) return inMs;
  const s = c.speed ?? 1;
  return Math.round(c.reverse ? inMs + ((c.end_ms - c.start_ms) - relB) * s : inMs + relA * s);
}

// ------------------------------------------------------------------ FFmpeg (render)

/** Picture orientation (applied after crop/blur, which are in source coordinates). */
export function orientFilters(c: Pick<MotionFields, 'rotate' | 'flip_h' | 'flip_v'>): string[] {
  const f: string[] = [];
  if (c.rotate === 90) f.push('transpose=clock');
  else if (c.rotate === 180) f.push('hflip', 'vflip');
  else if (c.rotate === 270) f.push('transpose=cclock');
  if (c.flip_h) f.push('hflip');
  if (c.flip_v) f.push('vflip');
  return f;
}

export function vdenoiseFilter(d: VDenoise | undefined): string {
  if (d === 'ringan') return 'hqdn3d=2:1.5:3:2.25';
  if (d === 'sedang') return 'hqdn3d=4:3:6:4.5';
  return '';
}

/** atempo chain for a speed (each step 0.5–2, so every FFmpeg build accepts it). */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2 + 1e-9) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${(Math.round(s * 1e6) / 1e6).toString()}`);
  return out;
}

// ------------------------------------------------------------------ preview

/** CSS transform (innermost) for the orientation; `swap` = the picture's width/height trade places. */
export function orientCss(c: Pick<MotionFields, 'rotate' | 'flip_h' | 'flip_v'>): { transform: string; swap: boolean } {
  const parts: string[] = [];
  if (c.rotate) parts.push(`rotate(${c.rotate}deg)`);
  if (c.flip_h) parts.push('scaleX(-1)');
  if (c.flip_v) parts.push('scaleY(-1)');
  return { transform: parts.join(' '), swap: c.rotate === 90 || c.rotate === 270 };
}

/** Short Indonesian summary for labels ("2× · mundur · putar 90°"). */
export function motionSummary(c: MotionFields): string {
  return [
    c.freeze ? 'diam' : '',
    c.speed && c.speed !== 1 ? `${String(c.speed).replace('.', ',')}×` : '',
    c.reverse ? 'mundur' : '',
    c.rotate ? `putar ${c.rotate}°` : '',
    c.flip_h ? 'balik kiri-kanan' : '',
    c.flip_v ? 'balik atas-bawah' : '',
    c.vdenoise ? `noise gambar ${c.vdenoise}` : '',
    c.stabil ? `stabil ${c.stabil}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
