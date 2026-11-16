import { StorageError } from './errors.js';
import { type ClipEffect, validateEffect } from './effects.js';
import { type BlurRegion, type Crop, validateBlur, validateCrop } from './framing.js';
import { type Word, cutWords, sliceWords, validateWords } from './words.js';
import { type TextStyle, effectiveStyle, validateStyle } from './textStyle.js';
import { isSafeId } from './ids.js';
import { type Keyframe, cutKeyframes, sliceKeyframes, validateKeyframes } from './keyframes.js';
import { needsAss } from './ass.js';
import { type Chroma, validateChroma } from './chroma.js';
import { OVERLAY_DEFAULT, type Overlay, contentEnd, patchOverlay, validateOverlay, validateOverlayPatch } from './overlay.js';
import { type Adjust, type ClipExtras, type Denoise, EXTRA_FIELDS, type FitMode, type LookId, type Transition, copyExtras, isNeutral, readExtras, validateAdjust, validateColor, validateDenoise, validateDuck, validateFadeMs, validateFit, validateLook, validateTransition } from './clipLook.js';
import { type Eq, validateEq } from './clipAudio.js';
import { FREEZE_MS, MAX_REVERSE_MS, type Rotation, type StabilLevel, type VDenoise, validateStabil, sliceIn, sourceAt, sourceLength, validateBool, validateRotate, validateSpeed, validateVDenoise } from './clipMotion.js';
import { CANVAS_RATIOS, type CanvasRatio, type Clip, MAX_TEXT_LEN, type MediaRef, type ProjectManifest, type Snapshot, type Track, type TrackKind } from './project.js';

/**
 * Timeline editing core (plan v2.0 W06, PRD: "action reducer, undo history; authoritative
 * version held server-side"). Pure functions over the project manifest: the same reducer is
 * used by the manual editor now and by approved AI edit plans later (W11).
 */

export const MIN_CLIP_MS = 100;
/** Retained undo steps per project. Older steps are dropped (and stop holding their media). */
export const UNDO_LIMIT = 50;
/** Media clips may live on these tracks; text/subtitle/effects carry no media. */
export const MEDIA_TRACKS: readonly TrackKind[] = ['video', 'broll', 'overlay', 'audio', 'music', 'sfx'];
/** Checkpoint E E10: bound the manifest (each edit stores up to UNDO_LIMIT full snapshots). */
export const MAX_TIMELINE_CLIPS = 2000;
/** Text clips (overlay / subtitle) carry `text` and never media. */
export const TEXT_TRACKS: readonly TrackKind[] = ['text', 'subtitle'];
const TRACK_ORDER: readonly TrackKind[] = ['video', 'broll', 'text', 'subtitle', 'overlay', 'audio', 'music', 'sfx', 'effects'];
/** R26: overlay layer moves. */
export const OVERLAY_LAYER_MOVES = ['depan', 'maju', 'mundur', 'belakang'] as const;
/** Tracks whose clips are sound only (mixed over the picture's sound). */
export const SOUND_TRACKS: readonly TrackKind[] = ['audio', 'music', 'sfx'];

export type EditOp =
  | ({ op: 'add_clip'; track_kind: TrackKind; media?: MediaRef; text?: string; style?: Partial<TextStyle>; start_ms: number; duration_ms: number; in_ms?: number; volume?: number; words?: Word[]; effect?: ClipEffect; crop?: Crop; blur?: BlurRegion[]; keyframes?: Keyframe[]; overlay?: Overlay } & ClipExtras)
  | { op: 'move_clip'; clip_id: string; start_ms: number }
  | { op: 'trim_clip'; clip_id: string; edge: 'start' | 'end'; to_ms: number }
  | { op: 'split_clip'; clip_id: string; at_ms: number }
  | { op: 'delete_clip'; clip_id: string }
  | { op: 'set_text'; clip_id: string; text: string }
  | { op: 'set_canvas'; ratio: CanvasRatio }
  | { op: 'set_brand_logo'; on: boolean }
  /** X07: ripple-delete [from_ms, to_ms) on EVERY track (cut a silence): later clips move left. */
  | { op: 'remove_range'; from_ms: number; to_ms: number }
  /** X07: split whatever clip covers `at_ms` on a track (scene change) — no clip id needed. */
  | { op: 'split_at'; track_kind: TrackKind; at_ms: number }
  | { op: 'set_style'; clip_id: string; style: Partial<TextStyle> }
  | { op: 'set_volume'; clip_id: string; volume: number }
  /** U3d: crop (null = whole frame) and/or blurred areas of a media clip. */
  | { op: 'set_framing'; clip_id: string; crop?: Crop | null; blur?: BlurRegion[] }
  | { op: 'set_track_mute'; track_kind: 'video' | 'broll' | 'audio' | 'music' | 'sfx'; muted: boolean }
  /** U3: final loudness (LUFS) or null = leave the mix as is. */
  | { op: 'set_loudness'; lufs: number | null }
  /** Malam 15 Nov: sound of a media clip — fades (0 = none) and noise reduction. */
  | { op: 'set_audio'; clip_id: string; fade_in_ms?: number; fade_out_ms?: number; denoise?: Denoise | 'off'; eq?: Eq | null; voice?: boolean }
  /** Malam 15 Nov: picture of a video/b-roll clip; null clears a field. */
  | { op: 'set_picture'; clip_id: string; fit?: FitMode | null; fit_color?: string | null; adjust?: Adjust | null; look?: LookId | 'none' | null; transition?: Transition | null }
  /** Malam 15 Nov: music ducking under speech; `level` = music gain while someone speaks. */
  | { op: 'set_ducking'; on: boolean; level?: number }
  /** Malam 15 Nov: keyframes of a video/b-roll/text/subtitle clip ([] = none). */
  | { op: 'set_keyframes'; clip_id: string; keyframes: Keyframe[] }
  /** R23a: direction / speed / reverse / picture noise of a video/b-roll clip. A new speed changes the
   * clip's length; later clips on the same track move with it. 0 / false / 'off' / 1 = off. */
  | { op: 'set_motion'; clip_id: string; rotate?: Rotation | 0; flip_h?: boolean; flip_v?: boolean; speed?: number; reverse?: boolean; vdenoise?: VDenoise | 'off'; stabil?: StabilLevel | 'off' }
  /** R23a: insert a still of the frame at `at_ms` for `duration_ms`; later clips on that track move right. */
  | { op: 'freeze_frame'; clip_id: string; at_ms: number; duration_ms: number }
  /** R33 multi-select: several clips at once — one op, one undo step. */
  | { op: 'delete_clips'; clip_ids: string[] }
  | { op: 'shift_clips'; clip_ids: string[]; delta_ms: number }
  | { op: 'set_style_many'; clip_ids: string[]; style: Partial<TextStyle> }
  /** R33: a copy right after the clip on its lane (or after the lane's last clip when that spot is taken). */
  | { op: 'duplicate_clip'; clip_id: string }
  /** R35: the same clip on another media version (AI result ↔ original: 'Perjelas', 'Hapus latar'). */
  | { op: 'set_media'; clip_id: string; media: MediaRef }
  /** R26: position / size / opacity / margin / whole-video of an overlay clip (only the given fields). */
  | { op: 'set_overlay'; clip_id: string; overlay: Partial<Omit<Overlay, 'sepanjang'>> & { sepanjang?: boolean } }
  /** R26: stacking order — to the very front/back or one step. */
  | { op: 'set_overlay_layer'; clip_id: string; to: (typeof OVERLAY_LAYER_MOVES)[number] }
  /** R23e: chroma key of an overlay clip (null = off). */
  | { op: 'set_chroma'; clip_id: string; chroma: Chroma | null }
  /** R38b: a transition stinger centred on the cut of the video lane nearest to `at_ms` (overlay clip). */
  | { op: 'place_stinger'; media: MediaRef; at_ms: number; duration_ms: number; alpha?: boolean };

/** Source length per media version (from the registry probe); unknown -> not enforced. */
export type SourceDuration = (ref: MediaRef) => number | undefined;

export type Timeline = ProjectManifest['timeline'];

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};
const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 24 * 3_600_000;
const ms = (n: unknown, what: string): number => (isMs(n) ? Math.round(n) : bad(`${what} harus angka ms 0–24 jam`, { [what]: n }));
/** Turn a plain validation Error into EDIT_INVALID. */
const guard = <T,>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StorageError) throw e;
    return bad(e instanceof Error ? e.message : 'tidak valid');
  }
};
const clipId = (x: unknown): string => (isSafeId(x) ? x : bad('clip_id tidak valid'));
const textOf = (x: unknown): string => (typeof x === 'string' && x.trim().length > 0 && x.length <= MAX_TEXT_LEN ? x : bad(`Teks wajib 1-${MAX_TEXT_LEN} karakter`));

/** Validate the shape of untrusted ops (HTTP / AI plans) before anything is applied. */
/** Ops per edit from the browser; server-made plans (transcript → subtitles, W14) may go up to MAX_SERVER_OPS. */
export const MAX_EDIT_OPS = 100;
export const MAX_SERVER_OPS = 1000;

export function validateOps(x: unknown, max = MAX_EDIT_OPS): EditOp[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > max) bad(`ops harus daftar 1–${max} operasi`);
  return (x as unknown[]).map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const keys = (allowed: string[]) => {
      const extra = Object.keys(o).filter((k) => !allowed.includes(k));
      if (extra.length) bad(`ops[${i}]: field tidak dikenal ${extra.join(', ')}`);
    };
    switch (o.op) {
      case 'add_clip': {
        keys(['op', 'track_kind', 'media', 'text', 'style', 'start_ms', 'duration_ms', 'in_ms', 'volume', 'words', 'effect', 'crop', 'blur', 'keyframes', 'overlay', ...EXTRA_FIELDS]);
        if (!TRACK_ORDER.includes(o.track_kind as TrackKind)) bad(`ops[${i}]: track_kind tidak dikenal`);
        let media: MediaRef | undefined;
        if (o.media !== undefined) {
          const m = o.media as Record<string, unknown>;
          if (!m || !isSafeId(m.media_id) || !isSafeId(m.version_id) || Object.keys(m).length !== 2) bad(`ops[${i}]: media tidak valid`);
          media = { media_id: m.media_id as string, version_id: m.version_id as string };
        }
        // Malam 15 Nov: fades / denoise / fit / adjust / look / transition set at creation.
        const extras = readExtras(o, `ops[${i}]`, o.track_kind as string, media !== undefined);
        return {
          op: 'add_clip',
          ...extras,
          ...(o.keyframes !== undefined ? { keyframes: validateKeyframes(o.keyframes, `ops[${i}].keyframes`) } : {}),
          ...(o.overlay !== undefined ? { overlay: guard(() => validateOverlay(o.overlay, `ops[${i}].overlay`)) } : {}),
          track_kind: o.track_kind as TrackKind,
          ...(media ? { media } : {}),
          ...(o.text !== undefined ? { text: textOf(o.text) } : {}),
          ...(o.style !== undefined ? { style: validateStyle(o.style, `ops[${i}].style`) } : {}),
          start_ms: ms(o.start_ms, 'start_ms'),
          duration_ms: ms(o.duration_ms, 'duration_ms'),
          ...(o.in_ms !== undefined ? { in_ms: ms(o.in_ms, 'in_ms') } : {}),
          // U3d: framing set at creation (a plan never refers to its own new clip).
          ...(o.crop !== undefined ? { crop: validateCrop(o.crop, `ops[${i}].crop`) } : {}),
          ...(o.blur !== undefined ? { blur: validateBlur(o.blur, `ops[${i}].blur`) } : {}),
          // U3c: zoom / zoom-through on the effects track.
          ...(o.effect !== undefined ? { effect: validateEffect(o.effect, `ops[${i}].effect`) } : {}),
          // U3b: per-word caption timings (relative to the clip start).
          ...(o.words !== undefined ? { words: validateWords(o.words, ms(o.duration_ms, 'duration_ms'), `ops[${i}].words`) } : {}),
          // U3 (contract §5.2): volume set at creation, so a plan never refers to its own new clip.
          ...(o.volume !== undefined ? { volume: typeof o.volume === 'number' && Number.isFinite(o.volume) && o.volume >= 0 && o.volume <= 1 ? Math.round(o.volume * 100) / 100 : bad(`ops[${i}]: volume harus angka 0–1`) } : {}),
        };
      }
      case 'move_clip':
        keys(['op', 'clip_id', 'start_ms']);
        return { op: 'move_clip', clip_id: clipId(o.clip_id), start_ms: ms(o.start_ms, 'start_ms') };
      case 'trim_clip':
        keys(['op', 'clip_id', 'edge', 'to_ms']);
        if (o.edge !== 'start' && o.edge !== 'end') bad(`ops[${i}]: edge harus start|end`);
        return { op: 'trim_clip', clip_id: clipId(o.clip_id), edge: o.edge as 'start' | 'end', to_ms: ms(o.to_ms, 'to_ms') };
      case 'split_clip':
        keys(['op', 'clip_id', 'at_ms']);
        return { op: 'split_clip', clip_id: clipId(o.clip_id), at_ms: ms(o.at_ms, 'at_ms') };
      case 'delete_clip':
        keys(['op', 'clip_id']);
        return { op: 'delete_clip', clip_id: clipId(o.clip_id) };
      case 'set_text':
        keys(['op', 'clip_id', 'text']);
        return { op: 'set_text', clip_id: clipId(o.clip_id), text: textOf(o.text) };
      case 'set_canvas':
        keys(['op', 'ratio']);
        if (!CANVAS_RATIOS.includes(o.ratio as CanvasRatio)) bad(`ops[${i}]: rasio harus ${CANVAS_RATIOS.join(', ')}`);
        return { op: 'set_canvas', ratio: o.ratio as CanvasRatio };
      case 'remove_range': {
        keys(['op', 'from_ms', 'to_ms']);
        const from = ms(o.from_ms, 'from_ms');
        const to = ms(o.to_ms, 'to_ms');
        if (to - from < MIN_CLIP_MS) bad(`ops[${i}]: rentang yang dihapus minimal ${MIN_CLIP_MS} ms`);
        return { op: 'remove_range', from_ms: from, to_ms: to };
      }
      case 'split_at':
        keys(['op', 'track_kind', 'at_ms']);
        if (!TRACK_ORDER.includes(o.track_kind as TrackKind)) bad(`ops[${i}]: track_kind tidak dikenal`);
        return { op: 'split_at', track_kind: o.track_kind as TrackKind, at_ms: ms(o.at_ms, 'at_ms') };
      case 'set_brand_logo':
        keys(['op', 'on']);
        if (typeof o.on !== 'boolean') bad(`ops[${i}]: on harus true/false`);
        return { op: 'set_brand_logo', on: o.on as boolean };
      case 'set_volume': {
        keys(['op', 'clip_id', 'volume']);
        const v = o.volume;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) bad(`ops[${i}]: volume harus angka 0–1`);
        return { op: 'set_volume', clip_id: clipId(o.clip_id), volume: Math.round((v as number) * 100) / 100 };
      }
      case 'set_framing': {
        keys(['op', 'clip_id', 'crop', 'blur']);
        if (o.crop === undefined && o.blur === undefined) bad(`ops[${i}]: isi crop dan/atau blur`);
        return {
          op: 'set_framing',
          clip_id: clipId(o.clip_id),
          ...(o.crop !== undefined ? { crop: o.crop === null ? null : validateCrop(o.crop, `ops[${i}].crop`) } : {}),
          ...(o.blur !== undefined ? { blur: validateBlur(o.blur, `ops[${i}].blur`) } : {}),
        };
      }
      case 'set_track_mute':
        keys(['op', 'track_kind', 'muted']);
        if (!['video', 'broll', 'audio', 'music', 'sfx'].includes(o.track_kind as string)) bad(`ops[${i}]: track_kind harus video | broll | audio | music | sfx`);
        if (typeof o.muted !== 'boolean') bad(`ops[${i}]: muted harus true/false`);
        return { op: 'set_track_mute', track_kind: o.track_kind as 'video' | 'broll' | 'audio' | 'music' | 'sfx', muted: o.muted as boolean };
      case 'set_loudness':
        keys(['op', 'lufs']);
        if (o.lufs !== null && (typeof o.lufs !== 'number' || !Number.isFinite(o.lufs) || o.lufs < -30 || o.lufs > -6)) bad(`ops[${i}]: lufs harus -30 sampai -6 atau null`);
        return { op: 'set_loudness', lufs: o.lufs === null ? null : Math.round((o.lufs as number) * 10) / 10 };
      case 'set_style': {
        keys(['op', 'clip_id', 'style']);
        const style = validateStyle(o.style, `ops[${i}].style`);
        if (!Object.keys(style).length) bad(`ops[${i}]: style kosong`);
        return { op: 'set_style', clip_id: clipId(o.clip_id), style };
      }
      case 'set_audio': {
        keys(['op', 'clip_id', 'fade_in_ms', 'fade_out_ms', 'denoise', 'eq', 'voice']);
        if (o.fade_in_ms === undefined && o.fade_out_ms === undefined && o.denoise === undefined && o.eq === undefined && o.voice === undefined) bad(`ops[${i}]: isi fade_in_ms, fade_out_ms, denoise, eq dan/atau voice`);
        if (o.voice !== undefined && typeof o.voice !== 'boolean') bad(`ops[${i}]: voice harus true/false`);
        return {
          op: 'set_audio',
          clip_id: clipId(o.clip_id),
          ...(o.fade_in_ms !== undefined ? { fade_in_ms: validateFadeMs(o.fade_in_ms, `ops[${i}].fade_in_ms`) } : {}),
          ...(o.fade_out_ms !== undefined ? { fade_out_ms: validateFadeMs(o.fade_out_ms, `ops[${i}].fade_out_ms`) } : {}),
          ...(o.denoise !== undefined ? { denoise: validateDenoise(o.denoise, `ops[${i}].denoise`) } : {}),
          ...(o.eq !== undefined ? { eq: o.eq === null ? null : validateEq(o.eq, `ops[${i}].eq`) } : {}),
          ...(o.voice !== undefined ? { voice: o.voice as boolean } : {}),
        };
      }
      case 'set_picture': {
        const fields = ['fit', 'fit_color', 'adjust', 'look', 'transition'] as const;
        keys(['op', 'clip_id', ...fields]);
        if (fields.every((k) => o[k] === undefined)) bad(`ops[${i}]: isi minimal satu dari ${fields.join(', ')}`);
        const opt = (k: string, fn: (v: unknown, w: string) => unknown) => (o[k] === undefined ? {} : { [k]: o[k] === null ? null : fn(o[k], `ops[${i}].${k}`) });
        return {
          op: 'set_picture',
          clip_id: clipId(o.clip_id),
          ...opt('fit', validateFit),
          ...opt('fit_color', validateColor),
          ...opt('adjust', validateAdjust),
          ...opt('look', validateLook),
          ...opt('transition', validateTransition),
        } as EditOp;
      }
      case 'set_keyframes':
        keys(['op', 'clip_id', 'keyframes']);
        return { op: 'set_keyframes', clip_id: clipId(o.clip_id), keyframes: validateKeyframes(o.keyframes, `ops[${i}].keyframes`) };
      case 'set_motion': {
        const fields = ['rotate', 'flip_h', 'flip_v', 'speed', 'reverse', 'vdenoise', 'stabil'] as const;
        keys(['op', 'clip_id', ...fields]);
        if (fields.every((k) => o[k] === undefined)) bad(`ops[${i}]: isi minimal satu dari ${fields.join(', ')}`);
        const w = (k: string) => `ops[${i}].${k}`;
        return {
          op: 'set_motion',
          clip_id: clipId(o.clip_id),
          ...(o.rotate !== undefined ? { rotate: validateRotate(o.rotate, w('rotate')) } : {}),
          ...(o.flip_h !== undefined ? { flip_h: validateBool(o.flip_h, w('flip_h')) } : {}),
          ...(o.flip_v !== undefined ? { flip_v: validateBool(o.flip_v, w('flip_v')) } : {}),
          ...(o.speed !== undefined ? { speed: validateSpeed(o.speed, w('speed')) } : {}),
          ...(o.reverse !== undefined ? { reverse: validateBool(o.reverse, w('reverse')) } : {}),
          ...(o.vdenoise !== undefined ? { vdenoise: validateVDenoise(o.vdenoise, w('vdenoise')) } : {}),
          ...(o.stabil !== undefined ? { stabil: validateStabil(o.stabil, w('stabil')) } : {}),
        };
      }
      case 'freeze_frame': {
        keys(['op', 'clip_id', 'at_ms', 'duration_ms']);
        const d = ms(o.duration_ms, 'duration_ms');
        if (d < FREEZE_MS[0] || d > FREEZE_MS[1]) bad(`ops[${i}]: lama bekukan ${FREEZE_MS[0] / 1000}–${FREEZE_MS[1] / 1000} detik`);
        return { op: 'freeze_frame', clip_id: clipId(o.clip_id), at_ms: ms(o.at_ms, 'at_ms'), duration_ms: d };
      }
      case 'set_media': {
        keys(['op', 'clip_id', 'media']);
        const m = (o.media ?? {}) as Record<string, unknown>;
        if (!isSafeId(m.media_id) || !isSafeId(m.version_id) || Object.keys(m).length !== 2) bad(`ops[${i}]: media tidak valid`);
        return { op: 'set_media', clip_id: clipId(o.clip_id), media: { media_id: m.media_id as string, version_id: m.version_id as string } };
      }
      case 'duplicate_clip':
        keys(['op', 'clip_id']);
        return { op: 'duplicate_clip', clip_id: clipId(o.clip_id) };
      case 'place_stinger': {
        keys(['op', 'media', 'at_ms', 'duration_ms', 'alpha']);
        const m = (o.media ?? {}) as Record<string, unknown>;
        if (!isSafeId(m.media_id) || !isSafeId(m.version_id) || Object.keys(m).length !== 2) bad(`ops[${i}]: media tidak valid`);
        const d = ms(o.duration_ms, 'duration_ms');
        if (d < MIN_CLIP_MS || d > 10_000) bad(`ops[${i}]: durasi stinger ${MIN_CLIP_MS / 1000}–10 detik`);
        if (o.alpha !== undefined && typeof o.alpha !== 'boolean') bad(`ops[${i}]: alpha harus true/false`);
        return { op: 'place_stinger', media: { media_id: m.media_id as string, version_id: m.version_id as string }, at_ms: ms(o.at_ms, 'at_ms'), duration_ms: d, ...(o.alpha !== undefined ? { alpha: o.alpha as boolean } : {}) };
      }
      case 'set_chroma':
        keys(['op', 'clip_id', 'chroma']);
        return { op: 'set_chroma', clip_id: clipId(o.clip_id), chroma: o.chroma === null ? null : guard(() => validateChroma(o.chroma, `ops[${i}].chroma`)) };
      case 'set_overlay': {
        keys(['op', 'clip_id', 'overlay']);
        const overlay = guard(() => validateOverlayPatch(o.overlay, `ops[${i}].overlay`));
        if (!Object.keys(overlay).length) bad(`ops[${i}]: overlay kosong`);
        return { op: 'set_overlay', clip_id: clipId(o.clip_id), overlay };
      }
      case 'set_overlay_layer':
        keys(['op', 'clip_id', 'to']);
        if (!(OVERLAY_LAYER_MOVES as readonly unknown[]).includes(o.to)) bad(`ops[${i}]: to harus ${OVERLAY_LAYER_MOVES.join(' | ')}`);
        return { op: 'set_overlay_layer', clip_id: clipId(o.clip_id), to: o.to as (typeof OVERLAY_LAYER_MOVES)[number] };
      case 'delete_clips':
      case 'shift_clips':
      case 'set_style_many': {
        keys(['op', 'clip_ids', ...(o.op === 'shift_clips' ? ['delta_ms'] : o.op === 'set_style_many' ? ['style'] : [])]);
        const raw = o.clip_ids;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIMELINE_CLIPS) bad(`ops[${i}]: clip_ids harus daftar 1–${MAX_TIMELINE_CLIPS} klip`);
        const clip_ids = [...new Set((raw as unknown[]).map(clipId))];
        if (o.op === 'delete_clips') return { op: 'delete_clips', clip_ids };
        if (o.op === 'shift_clips') {
          const d = o.delta_ms;
          if (typeof d !== 'number' || !Number.isFinite(d) || Math.abs(d) > 24 * 3_600_000) bad(`ops[${i}]: delta_ms harus angka ms`);
          return { op: 'shift_clips', clip_ids, delta_ms: Math.round(d as number) };
        }
        const style = validateStyle(o.style, `ops[${i}].style`);
        if (!Object.keys(style).length) bad(`ops[${i}]: style kosong`);
        return { op: 'set_style_many', clip_ids, style };
      }
      case 'set_ducking':
        keys(['op', 'on', 'level']);
        if (typeof o.on !== 'boolean') bad(`ops[${i}]: on harus true/false`);
        return { op: 'set_ducking', on: o.on as boolean, ...(o.level !== undefined ? { level: validateDuck(o.level, `ops[${i}].level`) } : {}) };
      default:
        return bad(`ops[${i}]: operasi tidak dikenal`);
    }
  });
}

/** Split track.clips[index] at `at` (strictly inside): the left keeps its id, the right is new. */
function splitInto(track: Track, index: number, at: number, newClipId: () => string): void {
  const clip = track.clips[index]!;
  const right: Clip = { clip_id: newClipId(), start_ms: at, end_ms: clip.end_ms };
  if (clip.text !== undefined) right.text = clip.text;
  if (clip.style) right.style = { ...clip.style };
  if (clip.volume !== undefined) right.volume = clip.volume;
  if (clip.effect) right.effect = { ...clip.effect };
  if (clip.crop) right.crop = { ...clip.crop };
  if (clip.blur) right.blur = clip.blur.map((b) => ({ ...b }));
  if (clip.overlay) right.overlay = { ...clip.overlay };
  if (clip.chroma) right.chroma = { ...clip.chroma };
  // Malam 15 Nov: the look/sound carry over; a fade-in and the incoming transition stay on the left
  // half (the clip's start), a fade-out moves to the right half (the clip's end).
  Object.assign(right, copyExtras(clip));
  // Keyframes: each half keeps its part of the curve (re-timed to its own start).
  if (clip.keyframes) {
    const rel = at - clip.start_ms;
    const r = sliceKeyframes(clip.keyframes, rel, clip.end_ms - clip.start_ms);
    const l = sliceKeyframes(clip.keyframes, 0, rel);
    if (r) right.keyframes = r;
    if (l) clip.keyframes = l;
    else delete clip.keyframes;
  }
  delete right.fade_in_ms;
  delete right.transition;
  delete clip.fade_out_ms;
  if (clip.media) {
    // R23a: with speed / reverse / freeze each half keeps its own part of the source span.
    const rel = at - clip.start_ms;
    const len = clip.end_ms - clip.start_ms;
    right.media = { ...clip.media };
    right.in_ms = sliceIn(clip, rel, len);
    clip.in_ms = sliceIn(clip, 0, rel);
  }
  if (clip.words) {
    // Each half keeps the words spoken in it (text follows the words).
    const rel = at - clip.start_ms;
    right.words = sliceWords(clip.words, rel, clip.end_ms - clip.start_ms);
    clip.words = sliceWords(clip.words, 0, rel);
    wordsAfterEdit(right);
  }
  clip.end_ms = at;
  if (clip.words) wordsAfterEdit(clip);
  track.clips.splice(index + 1, 0, right);
}

/** After an edit: words outside the clip are gone; the text is the remaining words. */
function wordsAfterEdit(c: Clip): void {
  if (!c.words) return;
  c.words = c.words.filter((w) => w.start_ms < c.end_ms - c.start_ms).map((w) => ({ ...w, end_ms: Math.min(w.end_ms, c.end_ms - c.start_ms) }));
  if (c.words.length) c.text = c.words.map((w) => w.text).join(' ');
  else delete c.words; // nothing spoken left: keep the text as plain text
}
const withWords = (c: Clip, words: Word[] | undefined): Clip => {
  if (words === undefined) return c;
  const out: Clip = { ...c, words };
  wordsAfterEdit(out);
  return out;
};

/** Replace a clip's keyframes (null = leave as is, undefined = none left). */
const withKeys = (c: Clip, k: Keyframe[] | undefined | null): Clip => {
  if (k === null) return c;
  const out = { ...c };
  if (k) out.keyframes = k;
  else delete out.keyframes;
  return out;
};

const EQ_FLAT = (e: Eq) => e.bass === 0 && e.mid === 0 && e.treble === 0;
const timelineEnd = (t: Timeline) => contentEnd(t.tracks);

const clone = (t: Timeline): Timeline => ({
  tracks: t.tracks.map((tr) => ({
    ...tr,
    clips: tr.clips.map((c) => ({
      ...c,
      ...(c.media ? { media: { ...c.media } } : {}),
      ...(c.style ? { style: { ...c.style, ...(c.style.highlight ? { highlight: { ...c.style.highlight, words: [...c.style.highlight.words] } } : {}) } } : {}),
      ...(c.words ? { words: c.words.map((w) => ({ ...w })) } : {}),
      ...(c.effect ? { effect: { ...c.effect } } : {}),
      ...(c.crop ? { crop: { ...c.crop } } : {}),
      ...(c.blur ? { blur: c.blur.map((b) => ({ ...b })) } : {}),
      ...(c.adjust ? { adjust: { ...c.adjust } } : {}),
      ...(c.eq ? { eq: { ...c.eq } } : {}),
      ...(c.transition ? { transition: { ...c.transition } } : {}),
      ...(c.keyframes ? { keyframes: c.keyframes.map((k) => ({ ...k })) } : {}),
      ...(c.overlay ? { overlay: { ...c.overlay } } : {}),
      ...(c.chroma ? { chroma: { ...c.chroma } } : {}),
    })),
  })),
  ...(t.canvas ? { canvas: { ...t.canvas } } : {}),
  ...(t.brand_logo ? { brand_logo: true } : {}),
  ...(t.loudness_lufs !== undefined ? { loudness_lufs: t.loudness_lufs } : {}),
});

function locate(t: Timeline, id: string): { track: Track; clip: Clip; index: number } {
  for (const track of t.tracks) {
    const index = track.clips.findIndex((c) => c.clip_id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return bad('Klip tidak ditemukan', { clip_id: id });
}

/** Every track: clips sorted, long enough, never overlapping (deterministic timeline). */
function assertConsistent(t: Timeline, sourceDuration?: SourceDuration): void {
  const ids = new Set<string>();
  const count = t.tracks.reduce((n, tr) => n + tr.clips.length, 0);
  if (count > MAX_TIMELINE_CLIPS) bad(`Linimasa maksimal ${MAX_TIMELINE_CLIPS} klip`, { clips: count });
  for (const track of t.tracks) {
    track.clips.sort((a, b) => a.start_ms - b.start_ms);
    let prevEnd = -1;
    for (const c of track.clips) {
      if (ids.has(c.clip_id)) bad('clip_id ganda', { clip_id: c.clip_id });
      ids.add(c.clip_id);
      if (c.end_ms - c.start_ms < MIN_CLIP_MS) bad(`Klip minimal ${MIN_CLIP_MS} ms`, { clip_id: c.clip_id });
      // R26: overlays may overlap in time (the layer decides which is in front).
      if (c.start_ms < prevEnd && track.kind !== 'overlay') bad('Klip saling tumpang tindih di track yang sama', { clip_id: c.clip_id, track_id: track.track_id });
      if (c.media && !MEDIA_TRACKS.includes(track.kind)) bad(`Media tidak boleh di track ${track.kind}`, { clip_id: c.clip_id });
      if (c.text !== undefined && !TEXT_TRACKS.includes(track.kind)) bad('Teks hanya di track teks/subtitle', { clip_id: c.clip_id });
      if (track.kind === 'overlay' && (!c.media || !c.overlay)) bad('Klip overlay wajib punya gambar/video dan pengaturan overlay', { clip_id: c.clip_id });
      if (c.overlay && track.kind !== 'overlay') bad('Pengaturan overlay hanya di track overlay', { clip_id: c.clip_id });
      // Malam 15 Nov: text keyframes are drawn with drawtext; captions word-by-word / animated / highlighted go through libass.
      if (c.keyframes && TEXT_TRACKS.includes(track.kind) && needsAss(effectiveStyle(track.kind as 'text' | 'subtitle', c.style), c)) bad('Keyframe teks belum bisa digabung dengan kata per kata, animasi, atau sorot kata. Matikan itu dulu atau hapus keyframe.', { clip_id: c.clip_id });
      // R23a: reverse keeps every frame of the piece in memory, so its source span is capped.
      if (c.reverse && sourceLength(c) > MAX_REVERSE_MS) bad(`Klip mundur maksimal ${MAX_REVERSE_MS / 1000} detik sumber (sekarang ${(sourceLength(c) / 1000).toFixed(1).replace('.', ',')} dtk). Potong klipnya dulu.`, { clip_id: c.clip_id });
      if (c.media && sourceDuration) {
        const total = sourceDuration(c.media);
        if (total !== undefined && (c.freeze ? (c.in_ms ?? 0) >= total : (c.in_ms ?? 0) + sourceLength(c) > total + 1)) {
          bad(`Klip melebihi panjang video sumber (${(total / 1000).toFixed(1)} dtk)`, { clip_id: c.clip_id });
        }
      }
      prevEnd = c.end_ms;
    }
  }
}

function trackFor(t: Timeline, kind: TrackKind): Track {
  let track = t.tracks.find((x) => x.kind === kind);
  if (!track) {
    track = { track_id: kind, kind, clips: [] };
    t.tracks.push(track);
    t.tracks.sort((a, b) => TRACK_ORDER.indexOf(a.kind) - TRACK_ORDER.indexOf(b.kind));
  }
  return track;
}

/**
 * Apply ops atomically: either every op succeeds and the result is consistent, or nothing
 * changes (EDIT_INVALID). `newClipId` is injected so tests and replays are deterministic.
 */
export function applyOps(timeline: Timeline, ops: EditOp[], newClipId: () => string, sourceDuration?: SourceDuration): Timeline {
  const t = clone(timeline);
  for (const op of ops) {
    switch (op.op) {
      case 'add_clip': {
        if (op.media && !MEDIA_TRACKS.includes(op.track_kind)) bad(`Media tidak boleh di track ${op.track_kind}`);
        if (op.media && op.text !== undefined) bad('Klip media tidak boleh punya teks');
        if (TEXT_TRACKS.includes(op.track_kind) && op.text === undefined) bad('Klip teks wajib berisi teks');
        const clip: Clip = { clip_id: newClipId(), start_ms: op.start_ms, end_ms: op.start_ms + op.duration_ms };
        if (op.text !== undefined) clip.text = op.text;
        if (op.style) {
          if (!TEXT_TRACKS.includes(op.track_kind)) bad('Gaya hanya untuk klip teks/subtitle');
          clip.style = { ...op.style };
        }
        if (op.media) {
          clip.media = { ...op.media };
          clip.in_ms = op.in_ms ?? 0;
        }
        if (op.volume !== undefined) {
          if (!op.media) bad('Volume hanya untuk klip video/audio');
          if (op.volume !== 1) clip.volume = op.volume;
        }
        if (op.effect) {
          if (op.track_kind !== 'effects') bad('Efek hanya di track efek');
          clip.effect = { ...op.effect };
        }
        if (op.crop || op.blur) {
          if (!op.media) bad('Crop/blur hanya untuk klip video/b-roll');
          if (op.crop) clip.crop = { ...op.crop };
          if (op.blur?.length) clip.blur = op.blur.map((b) => ({ ...b }));
        }
        Object.assign(clip, copyExtras(op));
        if (op.keyframes?.length) {
          if (!((op.track_kind === 'video' || op.track_kind === 'broll') && op.media) && !TEXT_TRACKS.includes(op.track_kind)) bad('Keyframe hanya untuk klip video, b-roll, teks, subtitle');
          clip.keyframes = op.keyframes.map((k) => ({ ...k }));
        }
        if (op.overlay && op.track_kind !== 'overlay') bad('Pengaturan overlay hanya di track overlay');
        if (op.track_kind === 'overlay') {
          if (!op.media) bad('Overlay wajib berisi gambar atau video');
          // New overlays go in front of the ones already there unless the op says otherwise.
          const top = Math.max(-1, ...(t.tracks.find((x) => x.kind === 'overlay')?.clips ?? []).map((c) => c.overlay?.layer ?? 0));
          clip.overlay = op.overlay ? { ...op.overlay } : { ...OVERLAY_DEFAULT, layer: Math.min(999, top + 1) };
        }
        if (op.track_kind === 'effects' && !op.effect) bad('Klip di track efek wajib punya efek (zoom / zoom_through)');
        if (op.words) {
          if (!TEXT_TRACKS.includes(op.track_kind)) bad('Kata per kata hanya untuk klip teks/subtitle');
          clip.words = op.words.map((w) => ({ ...w }));
          clip.text = op.words.map((w) => w.text).join(' '); // the caption IS its words
        }
        trackFor(t, op.track_kind).clips.push(clip);
        break;
      }
      case 'move_clip': {
        const { clip } = locate(t, op.clip_id);
        const len = clip.end_ms - clip.start_ms;
        clip.start_ms = op.start_ms;
        clip.end_ms = op.start_ms + len;
        break;
      }
      case 'trim_clip': {
        const { clip } = locate(t, op.clip_id);
        if (op.edge === 'end') {
          // R23a: a reversed clip's source start moves when its end is trimmed.
          if (clip.media && clip.reverse) {
            const nextIn = sliceIn(clip, 0, op.to_ms - clip.start_ms);
            if (nextIn < 0) bad('Tidak bisa memperpanjang klip mundur melewati awal sumbernya', { clip_id: clip.clip_id });
            clip.in_ms = nextIn;
          }
          clip.end_ms = op.to_ms;
        } else {
          const delta = op.to_ms - clip.start_ms;
          // Trimming the start also moves the source in-point, so the picture stays in place.
          if (clip.media) {
            const nextIn = sliceIn(clip, delta, clip.end_ms - clip.start_ms);
            if (nextIn < 0) bad('Tidak bisa memperpanjang klip sebelum awal sumbernya', { clip_id: clip.clip_id });
            clip.in_ms = nextIn;
          }
          if (clip.words) clip.words = sliceWords(clip.words, delta, clip.end_ms - clip.start_ms);
          if (clip.keyframes) {
            const k = sliceKeyframes(clip.keyframes, delta, clip.end_ms - clip.start_ms);
            if (k) clip.keyframes = k;
            else delete clip.keyframes;
          }
          clip.start_ms = op.to_ms;
        }
        if (clip.end_ms <= clip.start_ms) bad('Trim membuat klip kosong', { clip_id: clip.clip_id });
        if (clip.words) wordsAfterEdit(clip);
        break;
      }
      case 'split_clip': {
        const { track, clip, index } = locate(t, op.clip_id);
        if (op.at_ms <= clip.start_ms || op.at_ms >= clip.end_ms) bad('Titik split harus di dalam klip', { clip_id: clip.clip_id });
        splitInto(track, index, op.at_ms, newClipId);
        break;
      }
      case 'split_at': {
        const track = t.tracks.find((x) => x.kind === op.track_kind);
        const index = track ? track.clips.findIndex((c) => c.start_ms < op.at_ms && op.at_ms < c.end_ms) : -1;
        if (!track || index < 0) bad(`Tidak ada klip ${op.track_kind} di ${op.at_ms} ms untuk dipotong`, { at_ms: op.at_ms });
        splitInto(track!, index, op.at_ms, newClipId);
        break;
      }
      case 'remove_range': {
        // Cut [from, to) out of the whole timeline. Media clips crossing the cut become two pieces
        // that keep their source offsets; text/subtitle clips crossing it just get shorter.
        const { from_ms: from, to_ms: to } = op;
        const len = to - from;
        if (from >= timelineEnd(t)) bad('Rentang yang dihapus ada di luar linimasa', { from_ms: from });
        for (const tr of t.tracks) {
          const out: Clip[] = [];
          for (const c of tr.clips) {
            if (c.end_ms <= from) out.push(c);
            else if (c.start_ms >= to) out.push({ ...c, start_ms: c.start_ms - len, end_ms: c.end_ms - len });
            else if (c.start_ms >= from && c.end_ms <= to) continue; // entirely inside the cut
            else if (c.start_ms < from && c.end_ms > to) {
              if (c.media) {
                const right: Clip = { ...c, clip_id: newClipId(), start_ms: from, end_ms: c.end_ms - len, in_ms: sliceIn(c, to - c.start_ms, c.end_ms - c.start_ms) };
                if (c.style) right.style = { ...c.style };
                right.media = { ...c.media };
                if (c.crop) right.crop = { ...c.crop };
                if (c.blur) right.blur = c.blur.map((b) => ({ ...b }));
                if (c.adjust) right.adjust = { ...c.adjust };
                if (c.transition) delete right.transition;
                delete right.fade_in_ms;
                const left: Clip = { ...c, end_ms: from, in_ms: sliceIn(c, 0, from - c.start_ms) };
                delete left.fade_out_ms;
                if (c.keyframes) {
                  const lk = sliceKeyframes(c.keyframes, 0, from - c.start_ms);
                  const rk = sliceKeyframes(c.keyframes, to - c.start_ms, c.end_ms - c.start_ms);
                  if (lk) left.keyframes = lk;
                  else delete left.keyframes;
                  if (rk) right.keyframes = rk;
                  else delete right.keyframes;
                }
                out.push(left, right);
              } else out.push(withKeys(withWords({ ...c, end_ms: c.end_ms - len }, c.words ? cutWords(c.words, from - c.start_ms, to - c.start_ms) : undefined), c.keyframes ? cutKeyframes(c.keyframes, from - c.start_ms, to - c.start_ms, c.end_ms - c.start_ms) : null));
            } else if (c.start_ms < from) out.push(withWords({ ...c, end_ms: from, ...(c.media && c.reverse ? { in_ms: sliceIn(c, 0, from - c.start_ms) } : {}) }, c.words ? sliceWords(c.words, 0, from - c.start_ms) : undefined));
            else out.push(withKeys(withWords({ ...c, start_ms: from, end_ms: c.end_ms - len, ...(c.media ? { in_ms: sliceIn(c, to - c.start_ms, c.end_ms - c.start_ms) } : {}) }, c.words ? sliceWords(c.words, to - c.start_ms, c.end_ms - c.start_ms) : undefined), c.keyframes ? sliceKeyframes(c.keyframes, to - c.start_ms, c.end_ms - c.start_ms) : null));
          }
          tr.clips = out.filter((c) => c.end_ms - c.start_ms >= MIN_CLIP_MS);
        }
        break;
      }
      case 'delete_clip': {
        const { track, index } = locate(t, op.clip_id);
        track.clips.splice(index, 1);
        break;
      }
      case 'set_text': {
        const { track, clip } = locate(t, op.clip_id);
        if (!TEXT_TRACKS.includes(track.kind)) bad('Hanya klip teks/subtitle yang punya teks', { clip_id: op.clip_id });
        clip.text = op.text;
        delete clip.words; // new words, no timings any more
        break;
      }
      case 'set_canvas':
        t.canvas = { ratio: op.ratio };
        break;
      case 'set_brand_logo':
        if (op.on) t.brand_logo = true;
        else delete t.brand_logo;
        break;
      case 'set_loudness':
        if (op.lufs === null) delete t.loudness_lufs;
        else t.loudness_lufs = op.lufs;
        break;
      case 'set_volume': {
        const { clip } = locate(t, op.clip_id);
        if (!clip.media) bad('Volume hanya untuk klip video/audio', { clip_id: op.clip_id });
        if (op.volume === 1) delete clip.volume;
        else clip.volume = op.volume;
        break;
      }
      case 'set_framing': {
        const { clip } = locate(t, op.clip_id);
        if (!clip.media) bad('Crop/blur hanya untuk klip video/b-roll', { clip_id: op.clip_id });
        if (op.crop === null) delete clip.crop;
        else if (op.crop) clip.crop = { ...op.crop };
        if (op.blur) {
          if (op.blur.length) clip.blur = op.blur.map((b) => ({ ...b }));
          else delete clip.blur;
        }
        break;
      }
      case 'set_track_mute': {
        const track = trackFor(t, op.track_kind);
        if (op.muted) track.muted = true;
        else delete track.muted;
        break;
      }
      case 'set_audio': {
        const { clip } = locate(t, op.clip_id);
        if (!clip.media) bad('Fade/reduksi noise hanya untuk klip video/audio', { clip_id: op.clip_id });
        if (op.fade_in_ms !== undefined) {
          if (op.fade_in_ms) clip.fade_in_ms = op.fade_in_ms;
          else delete clip.fade_in_ms;
        }
        if (op.fade_out_ms !== undefined) {
          if (op.fade_out_ms) clip.fade_out_ms = op.fade_out_ms;
          else delete clip.fade_out_ms;
        }
        if (op.denoise !== undefined) {
          if (op.denoise === 'off') delete clip.denoise;
          else clip.denoise = op.denoise;
        }
        if (op.eq !== undefined) {
          if (op.eq === null || EQ_FLAT(op.eq)) delete clip.eq;
          else clip.eq = { ...op.eq };
        }
        if (op.voice !== undefined) {
          if (op.voice) clip.voice = true;
          else delete clip.voice;
        }
        break;
      }
      case 'set_picture': {
        const { track, clip } = locate(t, op.clip_id);
        if (!clip.media || (track.kind !== 'video' && track.kind !== 'broll')) bad('Tampilan gambar hanya untuk klip video/b-roll', { clip_id: op.clip_id });
        if (op.fit === null) delete clip.fit;
        else if (op.fit) clip.fit = op.fit;
        if (op.fit_color === null) delete clip.fit_color;
        else if (op.fit_color) clip.fit_color = op.fit_color;
        if (op.look === null) delete clip.look;
        else if (op.look) clip.look = op.look;
        if (op.transition === null) delete clip.transition;
        else if (op.transition) clip.transition = { ...op.transition };
        if (op.adjust === null || (op.adjust && isNeutral(op.adjust))) delete clip.adjust;
        else if (op.adjust) clip.adjust = { ...op.adjust };
        break;
      }
      case 'set_keyframes': {
        const { track, clip } = locate(t, op.clip_id);
        if (!((track.kind === 'video' || track.kind === 'broll') && clip.media) && !TEXT_TRACKS.includes(track.kind)) bad('Keyframe hanya untuk klip video, b-roll, teks, subtitle', { clip_id: op.clip_id });
        if (op.keyframes.length) clip.keyframes = op.keyframes.map((k) => ({ ...k }));
        else delete clip.keyframes;
        break;
      }
      case 'set_motion': {
        const { track, clip } = locate(t, op.clip_id);
        const visual = track.kind === 'video' || track.kind === 'broll';
        // R23b: a sound clip (audio / music / sfx) only has a speed.
        const onlySpeed = op.rotate === undefined && op.flip_h === undefined && op.flip_v === undefined && op.reverse === undefined && op.vdenoise === undefined && op.stabil === undefined;
        if (!clip.media || (!visual && !(SOUND_TRACKS.includes(track.kind) && onlySpeed))) bad(visual || !clip.media ? 'Putar, balik, kecepatan dan mundur hanya untuk klip video/b-roll' : 'Klip suara hanya bisa diubah kecepatannya', { clip_id: op.clip_id });
        if (clip.freeze && (op.speed !== undefined || op.reverse !== undefined)) bad('Potongan diam tidak punya kecepatan/mundur', { clip_id: op.clip_id });
        if (op.rotate !== undefined) {
          if (op.rotate) clip.rotate = op.rotate;
          else delete clip.rotate;
        }
        for (const k of ['flip_h', 'flip_v', 'reverse'] as const) {
          if (op[k] === undefined) continue;
          if (op[k]) clip[k] = true;
          else delete clip[k];
        }
        if (op.vdenoise !== undefined) {
          if (op.vdenoise === 'off') delete clip.vdenoise;
          else clip.vdenoise = op.vdenoise;
        }
        if (op.stabil !== undefined) {
          if (op.stabil === 'off') delete clip.stabil;
          else clip.stabil = op.stabil;
        }
        if (op.speed !== undefined && op.speed !== (clip.speed ?? 1)) {
          // Same source span, new length on the timeline; the clips after it on this track follow.
          const len = clip.end_ms - clip.start_ms;
          const next = Math.max(MIN_CLIP_MS, Math.round((len * (clip.speed ?? 1)) / op.speed));
          const delta = next - len;
          const k = next / len;
          for (const c of track.clips) {
            if (c === clip || c.start_ms < clip.end_ms) continue;
            c.start_ms += delta;
            c.end_ms += delta;
          }
          clip.end_ms = clip.start_ms + next;
          if (op.speed === 1) delete clip.speed;
          else clip.speed = op.speed;
          if (clip.keyframes) clip.keyframes = clip.keyframes.map((x) => ({ ...x, at_ms: Math.min(next, Math.round(x.at_ms * k)) }));
          if (clip.fade_in_ms) clip.fade_in_ms = Math.min(clip.fade_in_ms, next);
          if (clip.fade_out_ms) clip.fade_out_ms = Math.min(clip.fade_out_ms, next);
        }
        break;
      }
      case 'freeze_frame': {
        const { track, clip, index } = locate(t, op.clip_id);
        if (!clip.media || (track.kind !== 'video' && track.kind !== 'broll')) bad('Bekukan frame hanya untuk klip video/b-roll', { clip_id: op.clip_id });
        if (op.at_ms < clip.start_ms || op.at_ms >= clip.end_ms) bad('Playhead harus di dalam klip yang dibekukan', { clip_id: op.clip_id });
        // Snap to the clip's edge when a split there would leave a sliver.
        const at = op.at_ms - clip.start_ms < MIN_CLIP_MS ? clip.start_ms : clip.end_ms - op.at_ms < MIN_CLIP_MS ? clip.end_ms : op.at_ms;
        // The frame shown at the playhead (the last frame when snapped to the clip's end).
        const frameMs = Math.max(0, Math.round(sourceAt(clip, Math.min(at - clip.start_ms, clip.end_ms - clip.start_ms - 1))));
        const src = { ...clip };
        if (at > clip.start_ms && at < clip.end_ms) splitInto(track, index, at, newClipId);
        for (const c of track.clips) {
          if (c.start_ms < at) continue;
          c.start_ms += op.duration_ms;
          c.end_ms += op.duration_ms;
        }
        // Looks like the clip it came from (framing, look, direction); no sound, no motion.
        const still: Clip = { clip_id: newClipId(), start_ms: at, end_ms: at + op.duration_ms, media: { ...src.media! }, in_ms: frameMs, freeze: true, volume: 0 };
        if (src.crop) still.crop = { ...src.crop };
        if (src.blur) still.blur = src.blur.map((b) => ({ ...b }));
        if (src.adjust) still.adjust = { ...src.adjust };
        for (const k of ['fit', 'fit_color', 'look', 'rotate', 'flip_h', 'flip_v', 'vdenoise'] as const) if (src[k] !== undefined) (still as unknown as Record<string, unknown>)[k] = src[k];
        track.clips.push(still);
        break;
      }
      case 'set_media': {
        const { clip } = locate(t, op.clip_id);
        if (!clip.media) bad('Hanya klip media yang bisa diganti filenya', { clip_id: op.clip_id });
        clip.media = { ...op.media };
        break;
      }
      case 'duplicate_clip': {
        const { track, clip } = locate(t, op.clip_id);
        const len = clip.end_ms - clip.start_ms;
        const free = (a: number) => !track.clips.some((c) => c.start_ms < a + len && c.end_ms > a);
        const at = free(clip.end_ms) ? clip.end_ms : Math.max(...track.clips.map((c) => c.end_ms));
        const copy = JSON.parse(JSON.stringify(clip)) as Clip;
        copy.clip_id = newClipId();
        copy.start_ms = at;
        copy.end_ms = at + len;
        track.clips.push(copy);
        break;
      }
      case 'delete_clips': {
        const gone = new Set(op.clip_ids);
        for (const id of op.clip_ids) locate(t, id); // every id must exist
        for (const tr of t.tracks) tr.clips = tr.clips.filter((c) => !gone.has(c.clip_id));
        break;
      }
      case 'shift_clips': {
        const moved = op.clip_ids.map((id) => locate(t, id).clip);
        if (op.delta_ms < 0 && moved.some((c) => c.start_ms + op.delta_ms < 0)) bad('Klip yang dipilih tidak bisa digeser sebelum detik 0');
        for (const c of moved) {
          c.start_ms += op.delta_ms;
          c.end_ms += op.delta_ms;
        }
        break;
      }
      case 'set_style_many': {
        for (const id of op.clip_ids) {
          const { track, clip } = locate(t, id);
          if (!TEXT_TRACKS.includes(track.kind)) bad('Gaya bersama hanya untuk klip teks/subtitle', { clip_id: id });
          clip.style = { ...(clip.style ?? {}), ...op.style };
        }
        break;
      }
      case 'set_ducking': {
        const track = trackFor(t, 'music');
        if (op.on) track.duck = op.level ?? track.duck ?? 0.3;
        else delete track.duck;
        break;
      }
      case 'place_stinger': {
        // Cuts = where one video clip ends and the next one starts (not the very start).
        const cuts = (t.tracks.find((x) => x.kind === 'video')?.clips ?? []).map((c) => c.start_ms).filter((ms) => ms > 0);
        if (!cuts.length) bad('Belum ada titik potong di lajur video untuk transisi');
        const cut = cuts.reduce((a, b) => (Math.abs(b - op.at_ms) < Math.abs(a - op.at_ms) ? b : a));
        const start = Math.max(0, cut - Math.round(op.duration_ms / 2));
        const clip: Clip = {
          clip_id: newClipId(),
          start_ms: start,
          end_ms: start + op.duration_ms,
          media: { ...op.media },
          in_ms: 0,
          // Full canvas; a stinger without alpha is drawn with Screen (its black = transparent).
          overlay: { ...OVERLAY_DEFAULT, pos: 'c', skala: 100, margin: 0, layer: 900, stinger: true, ...(op.alpha ? {} : { blend: 'screen' as const }) },
        };
        trackFor(t, 'overlay').clips.push(clip);
        break;
      }
      case 'set_chroma': {
        const { track, clip } = locate(t, op.clip_id);
        if (track.kind !== 'overlay' || !clip.media) bad('Chroma key hanya untuk klip di track overlay', { clip_id: op.clip_id });
        if (op.chroma) clip.chroma = { ...op.chroma };
        else delete clip.chroma;
        break;
      }
      case 'set_overlay': {
        const { clip } = locate(t, op.clip_id);
        if (!clip.overlay) bad('Hanya klip overlay yang punya pengaturan overlay', { clip_id: op.clip_id });
        clip.overlay = patchOverlay(clip.overlay!, op.overlay);
        break;
      }
      case 'set_overlay_layer': {
        const { track, clip } = locate(t, op.clip_id);
        if (!clip.overlay || track.kind !== 'overlay') bad('Hanya klip overlay yang punya urutan lapisan', { clip_id: op.clip_id });
        // Renumber 0..n-1 back to front, move this one, renumber again (stable, never past 999).
        const order = [...track.clips].sort((a, b) => a.overlay!.layer - b.overlay!.layer || track.clips.indexOf(a) - track.clips.indexOf(b));
        const i = order.indexOf(clip);
        order.splice(i, 1);
        const j = op.to === 'depan' ? order.length : op.to === 'belakang' ? 0 : op.to === 'maju' ? Math.min(order.length, i + 1) : Math.max(0, i - 1);
        order.splice(j, 0, clip);
        order.forEach((c, k) => (c.overlay = { ...c.overlay!, layer: Math.min(999, k) }));
        break;
      }
      case 'set_style': {
        const { track, clip } = locate(t, op.clip_id);
        if (!TEXT_TRACKS.includes(track.kind)) bad('Hanya klip teks/subtitle yang punya gaya', { clip_id: op.clip_id });
        clip.style = { ...(clip.style ?? {}), ...op.style };
        break;
      }
    }
  }
  assertConsistent(t, sourceDuration);
  return t;
}

// ------------------------------------------------------------------ history (undo/redo)

/** Media a stored timeline would bring back: kept on the snapshot so the GC sees it. */
export function timelineMedia(t: Timeline): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const tr of t.tracks) for (const c of tr.clips) if (c.media) seen.set(c.media.version_id, { ...c.media });
  return [...seen.values()];
}

const historyEntry = (kind: 'undo' | 'redo', t: Timeline, label: string, at: number, id: string): Snapshot => ({
  snapshot_id: id,
  kind,
  retained: true,
  created_at: at,
  media: timelineMedia(t),
  timeline: clone(t),
  label,
});

export interface HistoryContext {
  now: number;
  newId: () => string;
}

/** Apply an edit: previous timeline becomes the newest undo step; the redo stack is cleared. */
export function editManifest(m: ProjectManifest, ops: EditOp[], label: string, ctx: HistoryContext & { newClipId: () => string; sourceDuration?: SourceDuration }): ProjectManifest {
  const timeline = applyOps(m.timeline, ops, ctx.newClipId, ctx.sourceDuration);
  const others = m.snapshots.filter((s) => s.kind !== 'undo' && s.kind !== 'redo');
  const undo = [...m.snapshots.filter((s) => s.kind === 'undo'), historyEntry('undo', m.timeline, label, ctx.now, ctx.newId())].slice(-UNDO_LIMIT);
  return { ...m, timeline, snapshots: [...others, ...undo] };
}

/** Step back/forward. Throws EDIT_INVALID when there is nothing to undo/redo. */
export function stepHistory(m: ProjectManifest, direction: 'undo' | 'redo', ctx: HistoryContext): ProjectManifest {
  const from = m.snapshots.filter((s) => s.kind === direction);
  const target = from[from.length - 1];
  if (!target?.timeline) bad(direction === 'undo' ? 'Tidak ada yang bisa di-undo' : 'Tidak ada yang bisa di-redo');
  const opposite: 'undo' | 'redo' = direction === 'undo' ? 'redo' : 'undo';
  const kept = m.snapshots.filter((s) => s !== target);
  const pushed = historyEntry(opposite, m.timeline, target!.label ?? '', ctx.now, ctx.newId());
  const otherStack = [...kept.filter((s) => s.kind === opposite), pushed].slice(-UNDO_LIMIT);
  return {
    ...m,
    timeline: clone(target!.timeline!),
    snapshots: [...kept.filter((s) => s.kind !== opposite), ...otherStack],
  };
}

export const historyCounts = (m: ProjectManifest) => ({
  undo: m.snapshots.filter((s) => s.kind === 'undo').length,
  redo: m.snapshots.filter((s) => s.kind === 'redo').length,
  undo_label: m.snapshots.filter((s) => s.kind === 'undo').at(-1)?.label ?? null,
  redo_label: m.snapshots.filter((s) => s.kind === 'redo').at(-1)?.label ?? null,
});
