/**
 * Malam 15 Nov (fitur pilihan owner dari audit CapCut — teknik saja, semua dibuat sendiri dengan
 * FFmpeg). Pure module shared by the timeline validator, the FFmpeg render and the editor preview:
 *  - suara per klip: `fade_in_ms`, `fade_out_ms`, `denoise` (ringan | sedang);
 *  - ducking di lajur musik (`track.duck` = level musik saat ada suara bicara, 0.1–0.8);
 *  - gambar per klip video/b-roll: `fit` (isi | blur | warna) + `fit_color`, `adjust`, `look`;
 *  - transisi masuk per klip video/b-roll: `transition` {type, ms}.
 * Every field is optional: old projects and old engine ops stay valid without them.
 */
import { StorageError } from './errors.js';
import { MOTION_FIELDS, type MotionFields, copyMotion, readMotion } from './clipMotion.js';
import { type Eq, isFlatEq, validateEq } from './clipAudio.js';

// ------------------------------------------------------------------ types

export const DENOISE_LEVELS = ['ringan', 'sedang'] as const;
export type Denoise = (typeof DENOISE_LEVELS)[number];

export const FIT_MODES = ['isi', 'blur', 'warna'] as const;
/** `warna` (default when absent) = fitted whole + coloured bars (black unless `fit_color`). */
export type FitMode = (typeof FIT_MODES)[number];

export interface Adjust {
  /** −100..100 */
  terang: number;
  kontras: number;
  saturasi: number;
  /** −100 (sejuk/biru) .. 100 (hangat/oranye) */
  suhu: number;
  /** 0..100 */
  tajam: number;
  vignette: number;
}
export const ADJUST_KEYS = ['terang', 'kontras', 'saturasi', 'suhu', 'tajam', 'vignette'] as const;
export const ADJUST_RANGE: Record<keyof Adjust, readonly [number, number]> = { terang: [-100, 100], kontras: [-100, 100], saturasi: [-100, 100], suhu: [-100, 100], tajam: [0, 100], vignette: [0, 100] };
export const NO_ADJUST: Adjust = { terang: 0, kontras: 0, saturasi: 0, suhu: 0, tajam: 0, vignette: 0 };

/** Own looks (own names, own numbers): an Adjust preset, plus black-and-white for `hitamputih`. */
export const LOOKS = {
  hangat: { label: 'Hangat', adjust: { suhu: 35, saturasi: 10, kontras: 5 } },
  sejuk: { label: 'Sejuk', adjust: { suhu: -35, saturasi: -5 } },
  cerah: { label: 'Cerah Natural', adjust: { terang: 10, saturasi: 15, kontras: 5 } },
  pastel: { label: 'Pastel', adjust: { terang: 8, kontras: -20, saturasi: -25 } },
  tegas: { label: 'Kontras Tegas', adjust: { kontras: 30, saturasi: 10, vignette: 30 } },
  hitamputih: { label: 'Hitam Putih', adjust: { kontras: 15 }, mono: true },
  senja: { label: 'Senja Keemasan', adjust: { suhu: 50, saturasi: 20, kontras: 10, vignette: 25 } },
  adem: { label: 'Adem Lembut', adjust: { suhu: -20, saturasi: -15, terang: 5, kontras: -10 } },
} as const satisfies Record<string, { label: string; adjust: Partial<Adjust>; mono?: boolean }>;
export type LookId = keyof typeof LOOKS;
export const LOOK_IDS = Object.keys(LOOKS) as LookId[];

export const TRANSITIONS = ['dissolve', 'geser_kiri', 'geser_kanan', 'wipe', 'flash'] as const;
export type TransitionType = (typeof TRANSITIONS)[number];
export interface Transition {
  type: TransitionType;
  ms: number;
}
export const TRANSITION_LABEL: Record<TransitionType, string> = { dissolve: 'Dissolve (larut)', geser_kiri: 'Geser ke kiri', geser_kanan: 'Geser ke kanan', wipe: 'Wipe (sapu)', flash: 'Flash putih' };
export const TRANSITION_MS: readonly [number, number] = [200, 1500];
/** FFmpeg xfade names. */
export const XFADE: Record<TransitionType, string> = { dissolve: 'fade', geser_kiri: 'slideleft', geser_kanan: 'slideright', wipe: 'wipeleft', flash: 'fadewhite' };

export const MAX_FADE_MS = 10_000;
export const DUCK_RANGE: readonly [number, number] = [0.1, 0.8];
export const DEFAULT_DUCK = 0.3;
/** Ducking ramps (music goes down just before speech, back up after). */
export const DUCK_RAMP_MS = 200;

// ------------------------------------------------------------------ validation

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const int = (v: unknown, where: string, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : bad(`${where} harus angka ${min}–${max}`));

export const validateFadeMs = (v: unknown, where: string): number => int(v, where, 0, MAX_FADE_MS);
export const validateDenoise = (v: unknown, where: string): Denoise | 'off' => (v === 'off' || DENOISE_LEVELS.includes(v as Denoise) ? (v as Denoise | 'off') : bad(`${where} harus off | ringan | sedang`));
export const validateFit = (v: unknown, where: string): FitMode => (FIT_MODES.includes(v as FitMode) ? (v as FitMode) : bad(`${where} harus isi | blur | warna`));
export const validateColor = (v: unknown, where: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : bad(`${where} harus warna #rrggbb`));
export const validateLook = (v: unknown, where: string): LookId | 'none' => (v === 'none' || LOOK_IDS.includes(v as LookId) ? (v as LookId | 'none') : bad(`${where} harus none | ${LOOK_IDS.join(' | ')}`));
export const validateDuck = (v: unknown, where: string): number => (typeof v === 'number' && Number.isFinite(v) && v >= DUCK_RANGE[0] && v <= DUCK_RANGE[1] ? Math.round(v * 100) / 100 : bad(`${where} harus angka ${DUCK_RANGE[0]}–${DUCK_RANGE[1]}`));

/** Partial adjust in, full adjust out (missing = 0). */
export function validateAdjust(raw: unknown, where = 'adjust'): Adjust {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${where} harus objek`);
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(ADJUST_KEYS as readonly string[]).includes(k));
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const out = { ...NO_ADJUST };
  for (const k of ADJUST_KEYS) if (o[k] !== undefined) out[k] = int(o[k], `${where}.${k}`, ...ADJUST_RANGE[k]);
  return out;
}
export const isNeutral = (a: Adjust | undefined) => !a || ADJUST_KEYS.every((k) => a[k] === 0);

export function validateTransition(raw: unknown, where = 'transition'): Transition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${where} harus objek`);
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'type' && k !== 'ms');
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
  if (!TRANSITIONS.includes(o.type as TransitionType)) bad(`${where}.type harus ${TRANSITIONS.join(' | ')}`);
  return { type: o.type as TransitionType, ms: o.ms === undefined ? 500 : int(o.ms, `${where}.ms`, ...TRANSITION_MS) };
}

// ------------------------------------------------------------------ picture (shared math)

/** What the picture of a clip finally gets: the look (or the brand's default look) + the clip's own adjust. */
export function effectiveLook(clip: { look?: LookId | 'none'; adjust?: Adjust }, brandDefault: LookId | null = null): { adjust: Adjust; mono: boolean } {
  const id = clip.look === 'none' ? null : (clip.look ?? brandDefault);
  const base = id ? LOOKS[id] : null;
  const a = { ...NO_ADJUST };
  for (const k of ADJUST_KEYS) {
    const v = ((base?.adjust as Partial<Adjust> | undefined)?.[k] ?? 0) + (clip.adjust?.[k] ?? 0);
    a[k] = Math.max(ADJUST_RANGE[k][0], Math.min(ADJUST_RANGE[k][1], v));
  }
  return { adjust: a, mono: !!(base && 'mono' in base && base.mono) };
}

/** Numbers both sides use: eq brightness/contrast/saturation, colour temperature (K), sharpen amount, vignette angle. */
export function adjustNumbers(a: Adjust, mono = false) {
  return {
    brightness: (a.terang / 100) * 0.2,
    contrast: 1 + (a.kontras / 100) * 0.5,
    saturation: mono ? 0 : 1 + a.saturasi / 100,
    kelvin: Math.round(6500 - a.suhu * 30),
    sharpen: (a.tajam / 100) * 1.5,
    vignette: a.vignette > 0 ? 0.15 + (a.vignette / 100) * 0.6 : 0,
  };
}

/** FFmpeg filters (comma chain, may be empty) for one clip's picture. Applied before fitting. */
export function lookFilters(a: Adjust, mono = false): string {
  if (isNeutral(a) && !mono) return '';
  const n = adjustNumbers(a, mono);
  const f: string[] = [];
  if (n.brightness !== 0 || n.contrast !== 1 || n.saturation !== 1) f.push(`eq=brightness=${n.brightness.toFixed(3)}:contrast=${n.contrast.toFixed(3)}:saturation=${n.saturation.toFixed(3)}`);
  if (n.kelvin !== 6500 && !mono) f.push(`colortemperature=temperature=${n.kelvin}:mix=1:pl=1`);
  if (n.sharpen > 0) f.push(`unsharp=5:5:${n.sharpen.toFixed(2)}:5:5:0`);
  if (n.vignette > 0) f.push(`vignette=angle=${n.vignette.toFixed(3)}`);
  return f.join(',');
}

/**
 * Same look as CSS for the preview (approximation, as allowed: sharpen is not shown). Temperature is
 * a soft-light colour wash, vignette a radial gradient — both drawn as overlays by the preview.
 */
export function lookCss(a: Adjust, mono = false): { filter: string; warmth: number; vignette: number } {
  const n = adjustNumbers(a, mono);
  const parts: string[] = [];
  if (n.brightness !== 0) parts.push(`brightness(${(1 + n.brightness * 1.4).toFixed(3)})`);
  if (n.contrast !== 1) parts.push(`contrast(${n.contrast.toFixed(3)})`);
  if (mono) parts.push('grayscale(1)');
  else if (n.saturation !== 1) parts.push(`saturate(${n.saturation.toFixed(3)})`);
  return { filter: parts.join(' '), warmth: mono ? 0 : a.suhu / 100, vignette: n.vignette };
}

/** Canvas fit filters: input = the (framed) source picture, output = exactly W×H. */
export function fitFilters(mode: FitMode | undefined, color: string | undefined, W: number, H: number, id: string, inLabel: string, outLabel: string): string[] {
  const c = (color ?? '#000000').replace('#', '0x');
  if (mode === 'isi') return [`[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${outLabel}]`];
  if (mode === 'blur') {
    const sigma = Math.max(8, Math.round(Math.min(W, H) / 27));
    return [
      `[${inLabel}]split=2[${id}fa][${id}fb]`,
      `[${id}fb]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${sigma},eq=brightness=-0.06[${id}bg]`,
      `[${id}fa]scale=${W}:${H}:force_original_aspect_ratio=decrease[${id}fg]`,
      `[${id}bg][${id}fg]overlay=x=(W-w)/2:y=(H-h)/2[${outLabel}]`,
    ];
  }
  return [`[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${c}[${outLabel}]`];
}

// ------------------------------------------------------------------ sound (shared math)

/** Gain 0..1 of a clip's fades at `ms` into the clip (clip length `len`). */
export function fadeGainAt(clip: { fade_in_ms?: number; fade_out_ms?: number }, ms: number, len: number): number {
  let g = 1;
  if (clip.fade_in_ms) g = Math.min(g, Math.max(0, ms / clip.fade_in_ms));
  if (clip.fade_out_ms) g = Math.min(g, Math.max(0, (len - ms) / clip.fade_out_ms));
  return Math.max(0, Math.min(1, g));
}

/** FFmpeg `volume` filter for the fades; `offMs` = where the piece starts inside the clip. Empty = no fade. */
export function fadeFilter(clip: { fade_in_ms?: number; fade_out_ms?: number }, len: number, offMs = 0): string {
  const T = `(t+${(offMs / 1000).toFixed(4)})`;
  const terms: string[] = [];
  if (clip.fade_in_ms) terms.push(`${T}/${(clip.fade_in_ms / 1000).toFixed(4)}`);
  if (clip.fade_out_ms) terms.push(`(${(len / 1000).toFixed(4)}-${T})/${(clip.fade_out_ms / 1000).toFixed(4)}`);
  if (!terms.length) return '';
  const e = terms.length === 1 ? terms[0]! : `min(${terms[0]},${terms[1]})`;
  return `volume='clip(${e},0,1)':eval=frame`;
}

export function denoiseFilter(d: Denoise | undefined): string {
  if (d === 'ringan') return 'highpass=f=70,afftdn=nr=12:nf=-40:tn=1';
  if (d === 'sedang') return 'highpass=f=90,afftdn=nr=24:nf=-30:tn=1';
  return '';
}

/** Speech ranges [from, to) the music ducks under: merged when the gap is short. */
export function mergeRanges(ranges: readonly [number, number][], gapMs = 400): [number, number][] {
  const s = [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= gapMs) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  // Keep the FFmpeg expression bounded: merge harder when there are very many pieces.
  return out.length > 60 ? mergeRanges(out, gapMs * 2) : out;
}

/**
 * Where speech is on the timeline (the music ducks under it): voice-over clips on the audio track and
 * the video track's own sound, when audible. Same rule for the preview and the render.
 */
export function speechRanges<C extends { start_ms: number; end_ms: number; media?: unknown; volume?: number }>(t: { tracks: readonly { kind: string; muted?: boolean; clips: readonly C[] }[] }, hasSound: (c: C) => boolean = () => true): [number, number][] {
  const out: [number, number][] = [];
  for (const tr of t.tracks) {
    if ((tr.kind !== 'audio' && tr.kind !== 'video') || tr.muted) continue;
    for (const c of tr.clips) if (c.media && (c.volume ?? 1) > 0 && hasSound(c)) out.push([c.start_ms, c.end_ms]);
  }
  return mergeRanges(out);
}

/** Music gain at timeline `ms` under ducking (`level` = gain while someone speaks). */
export function duckGainAt(ranges: readonly [number, number][], level: number, ms: number): number {
  let w = 0;
  for (const [a, b] of ranges) w = Math.max(w, Math.max(0, Math.min(1, (ms - a + DUCK_RAMP_MS) / DUCK_RAMP_MS, (b + DUCK_RAMP_MS - ms) / DUCK_RAMP_MS)));
  return 1 - (1 - level) * w;
}

/** The same curve as an FFmpeg volume filter; `startMs` = timeline time of the chain's t = 0. */
export function duckFilter(ranges: readonly [number, number][], level: number, startMs: number): string {
  if (!ranges.length) return '';
  const T = `(t+${(startMs / 1000).toFixed(4)})`;
  const R = (DUCK_RAMP_MS / 1000).toFixed(3);
  const one = ([a, b]: [number, number]) => `clip(min((${T}-${(a / 1000).toFixed(3)}+${R})/${R},(${(b / 1000).toFixed(3)}+${R}-${T})/${R}),0,1)`;
  const w = ranges.map(one).reduce((acc, x) => `max(${acc},${x})`);
  return `volume='1-${(1 - level).toFixed(3)}*${w}':eval=frame`;
}

// ------------------------------------------------------------------ transitions (preview)

/**
 * Preview approximation of an incoming transition at a cut (`p` 0..1 across the transition window,
 * 0.5 = the cut; before 0.5 the outgoing clip is on screen, after it the incoming one).
 */
export function transitionCss(type: TransitionType, p: number): { opacity?: number; transform?: string; clipPath?: string; flash?: number } {
  const q = Math.max(0, Math.min(1, p));
  switch (type) {
    case 'dissolve':
      return { opacity: 0.35 + 0.65 * Math.abs(2 * q - 1) };
    case 'flash':
      return { flash: 1 - Math.abs(2 * q - 1) };
    case 'geser_kiri':
      return { transform: q < 0.5 ? `translateX(${-q * 100}%)` : `translateX(${(1 - q) * 100}%)` };
    case 'geser_kanan':
      return { transform: q < 0.5 ? `translateX(${q * 100}%)` : `translateX(${-(1 - q) * 100}%)` };
    case 'wipe':
      return { clipPath: q < 0.5 ? `inset(0 ${q * 100}% 0 0)` : `inset(0 0 0 ${(1 - q) * 100}%)` };
  }
}

// ------------------------------------------------------------------ fields on a clip

/** The new optional clip fields (all additive). */
/** R23a: + motion fields (rotate/flip/speed/reverse/freeze/vdenoise, see clipMotion.ts). */
export interface ClipExtras extends MotionFields {
  /** Sound fades of a media clip (ms). */
  fade_in_ms?: number;
  fade_out_ms?: number;
  /** Voice noise reduction of a media clip (absent = off). */
  denoise?: Denoise;
  /** Video/b-roll: how the picture fills the canvas (absent = fitted + black bars). */
  fit?: FitMode;
  /** Bar colour for `fit: 'warna'`. */
  fit_color?: string;
  /** Video/b-roll colour adjustments. */
  adjust?: Adjust;
  /** Video/b-roll colour look; `none` = no look even when the brand has a default one. */
  look?: LookId | 'none';
  /** Video/b-roll: transition INTO this clip from the picture before it. */
  transition?: Transition;
  /** R23b: simple bass / mid / treble EQ (dB) of a media clip's sound. */
  eq?: Eq;
  /** R23b: "Perjelas suara" (highpass + voice EQ + light compressor + loudnorm). */
  voice?: boolean;
}
export const SOUND_FIELDS = ['fade_in_ms', 'fade_out_ms', 'denoise', 'eq', 'voice'] as const;
export const PICTURE_FIELDS = ['fit', 'fit_color', 'adjust', 'look', 'transition'] as const;
export const EXTRA_FIELDS = [...SOUND_FIELDS, ...PICTURE_FIELDS, ...MOTION_FIELDS] as const;

/**
 * Read the extra fields of an untrusted clip / add_clip op. `kind` is the track, `hasMedia` whether
 * the clip carries media. Throws EDIT_INVALID with a clear reason.
 */
export function readExtras(o: Record<string, unknown>, where: string, kind: string, hasMedia: boolean): ClipExtras {
  const out: ClipExtras = {};
  const visual = kind === 'video' || kind === 'broll';
  for (const k of SOUND_FIELDS) if (o[k] !== undefined && !hasMedia) bad(`${where}.${k}: hanya untuk klip media (video/audio)`);
  for (const k of PICTURE_FIELDS) if (o[k] !== undefined && !(visual && hasMedia)) bad(`${where}.${k}: hanya untuk klip video/b-roll`);
  if (o.fade_in_ms !== undefined) {
    const v = validateFadeMs(o.fade_in_ms, `${where}.fade_in_ms`);
    if (v) out.fade_in_ms = v;
  }
  if (o.fade_out_ms !== undefined) {
    const v = validateFadeMs(o.fade_out_ms, `${where}.fade_out_ms`);
    if (v) out.fade_out_ms = v;
  }
  if (o.denoise !== undefined) {
    const d = validateDenoise(o.denoise, `${where}.denoise`);
    if (d !== 'off') out.denoise = d;
  }
  if (o.eq !== undefined) {
    const e = validateEq(o.eq, `${where}.eq`);
    if (!isFlatEq(e)) out.eq = e;
  }
  if (o.voice !== undefined) {
    if (typeof o.voice !== 'boolean') bad(`${where}.voice harus true/false`);
    if (o.voice) out.voice = true;
  }
  if (o.fit !== undefined) out.fit = validateFit(o.fit, `${where}.fit`);
  if (o.fit_color !== undefined) out.fit_color = validateColor(o.fit_color, `${where}.fit_color`);
  if (o.adjust !== undefined) {
    const a = validateAdjust(o.adjust, `${where}.adjust`);
    if (!isNeutral(a)) out.adjust = a;
  }
  if (o.look !== undefined) out.look = validateLook(o.look, `${where}.look`);
  if (o.transition !== undefined) out.transition = validateTransition(o.transition, `${where}.transition`);
  Object.assign(out, readMotion(o, where, visual && hasMedia, hasMedia));
  return out;
}

/** Deep copy of the extras (for clones / splits). */
export function copyExtras(c: ClipExtras): ClipExtras {
  return {
    ...(c.fade_in_ms ? { fade_in_ms: c.fade_in_ms } : {}),
    ...(c.fade_out_ms ? { fade_out_ms: c.fade_out_ms } : {}),
    ...(c.denoise ? { denoise: c.denoise } : {}),
    ...(c.eq ? { eq: { ...c.eq } } : {}),
    ...(c.voice ? { voice: true } : {}),
    ...(c.fit ? { fit: c.fit } : {}),
    ...(c.fit_color ? { fit_color: c.fit_color } : {}),
    ...(c.adjust ? { adjust: { ...c.adjust } } : {}),
    ...(c.look ? { look: c.look } : {}),
    ...(c.transition ? { transition: { ...c.transition } } : {}),
    ...copyMotion(c),
  };
}
