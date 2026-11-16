/**
 * R23b (owner 16 Nov, alat edit gaya CapCut — teknik saja, angka & nama milik sendiri). Suara per
 * klip media, dipakai bersama oleh validator, render FFmpeg dan pratinjau (Web Audio):
 *  - `eq` sederhana: bass / mid / treble dalam dB (−12..12), dengan preset (Suara jelas, Bass,
 *    Treble, Radio) yang hanya mengisi tiga angka itu — tetap bisa digeser manual;
 *  - `voice: true` = "Perjelas suara": highpass + EQ suara + kompresor ringan + loudnorm.
 * Kecepatan klip audio memakai `speed` (clipMotion) — atempo berantai, sama dengan video.
 */
import { StorageError } from './errors.js';

export interface Eq {
  bass: number;
  mid: number;
  treble: number;
}
export const EQ_KEYS = ['bass', 'mid', 'treble'] as const;
export const EQ_RANGE: readonly [number, number] = [-12, 12];
export const FLAT_EQ: Eq = { bass: 0, mid: 0, treble: 0 };
/** Band centres (Hz) — the same in the render and the preview. */
export const EQ_FREQ = { bass: 100, mid: 1000, treble: 8000 } as const;

/** Own presets (own numbers). */
export const EQ_PRESETS = {
  jelas: { label: 'Suara jelas', eq: { bass: -3, mid: 3, treble: 4 } },
  bass: { label: 'Bass', eq: { bass: 6, mid: 0, treble: -1 } },
  treble: { label: 'Treble', eq: { bass: -1, mid: 0, treble: 6 } },
  radio: { label: 'Radio', eq: { bass: -12, mid: 5, treble: -10 } },
} as const satisfies Record<string, { label: string; eq: Eq }>;
export type EqPresetId = keyof typeof EQ_PRESETS;
export const EQ_PRESET_IDS = Object.keys(EQ_PRESETS) as EqPresetId[];
/** Which preset these exact numbers are (null = own mix). */
export const eqPresetOf = (e: Eq | undefined): EqPresetId | null => (e ? (EQ_PRESET_IDS.find((id) => EQ_KEYS.every((k) => EQ_PRESETS[id].eq[k] === e[k])) ?? null) : null);

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
export const isFlatEq = (e: Eq | undefined) => !e || EQ_KEYS.every((k) => e[k] === 0);

/** Partial in, full out (missing = 0). */
export function validateEq(raw: unknown, where = 'eq'): Eq {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${where} harus objek`);
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(EQ_KEYS as readonly string[]).includes(k));
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const out = { ...FLAT_EQ };
  for (const k of EQ_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < EQ_RANGE[0] || v > EQ_RANGE[1]) bad(`${where}.${k} harus angka ${EQ_RANGE[0]}–${EQ_RANGE[1]} dB`);
    out[k] = Math.round(v as number);
  }
  return out;
}

// ------------------------------------------------------------------ "Perjelas suara" (shared numbers)

export const VOICE = {
  highpass_hz: 80,
  /** Less "mud" around 250 Hz, more presence around 3 kHz. */
  mud: { hz: 250, db: -2 },
  presence: { hz: 3000, db: 3 },
  /** Light compression. */
  comp: { threshold_db: -20, ratio: 3, attack_ms: 10, release_ms: 150, makeup_db: 2 },
  /** Integrated loudness of the voice clip (render). */
  lufs: -16,
} as const;

// ------------------------------------------------------------------ FFmpeg (render)

/** Audio filters of a clip, in order: voice enhancement, then the EQ. Output stays 48 kHz stereo fltp. */
export function audioFxFilters(c: { eq?: Eq; voice?: boolean }, afmt: string): string[] {
  const f: string[] = [];
  if (c.voice) {
    const v = VOICE;
    f.push(
      `highpass=f=${v.highpass_hz}`,
      `equalizer=f=${v.mud.hz}:t=q:w=1:g=${v.mud.db}`,
      `equalizer=f=${v.presence.hz}:t=q:w=1:g=${v.presence.db}`,
      `acompressor=threshold=${v.comp.threshold_db}dB:ratio=${v.comp.ratio}:attack=${v.comp.attack_ms}:release=${v.comp.release_ms}:makeup=${v.comp.makeup_db}dB`,
      // loudnorm works at 192 kHz internally: back to the graph's format right after.
      `loudnorm=I=${v.lufs}:TP=-1.5:LRA=11`,
      afmt,
    );
  }
  if (c.eq && !isFlatEq(c.eq)) {
    if (c.eq.bass) f.push(`bass=g=${c.eq.bass}:f=${EQ_FREQ.bass}`);
    if (c.eq.mid) f.push(`equalizer=f=${EQ_FREQ.mid}:t=q:w=1:g=${c.eq.mid}`);
    if (c.eq.treble) f.push(`treble=g=${c.eq.treble}:f=${EQ_FREQ.treble}`);
  }
  return f;
}

// ------------------------------------------------------------------ preview (Web Audio)

export interface PreviewAudioFx {
  highpass: number | null;
  /** [type, frequency, gain dB, Q] for BiquadFilterNodes, in order. */
  bands: { type: 'lowshelf' | 'peaking' | 'highshelf'; hz: number; db: number; q: number }[];
  compressor: { threshold: number; ratio: number; attack: number; release: number; makeup: number } | null;
}

/** The same chain as Web Audio nodes (loudnorm is approximated by the compressor's make-up gain). */
export function previewAudioFx(c: { eq?: Eq; voice?: boolean }): PreviewAudioFx {
  const bands: PreviewAudioFx['bands'] = [];
  if (c.voice) bands.push({ type: 'peaking', hz: VOICE.mud.hz, db: VOICE.mud.db, q: 1 }, { type: 'peaking', hz: VOICE.presence.hz, db: VOICE.presence.db, q: 1 });
  const e = c.eq && !isFlatEq(c.eq) ? c.eq : null;
  if (e?.bass) bands.push({ type: 'lowshelf', hz: EQ_FREQ.bass, db: e.bass, q: 0.7 });
  if (e?.mid) bands.push({ type: 'peaking', hz: EQ_FREQ.mid, db: e.mid, q: 1 });
  if (e?.treble) bands.push({ type: 'highshelf', hz: EQ_FREQ.treble, db: e.treble, q: 0.7 });
  const v = VOICE.comp;
  return {
    highpass: c.voice ? VOICE.highpass_hz : null,
    bands,
    compressor: c.voice ? { threshold: v.threshold_db, ratio: v.ratio, attack: v.attack_ms / 1000, release: v.release_ms / 1000, makeup: v.makeup_db + 3 } : null,
  };
}
