import { StorageError } from './errors.js';
import { type BlurRegion, type Crop, validateBlur, validateCrop } from './framing.js';
import { type ClipEffect, validateEffect } from './effects.js';
import { type Word, validateWords } from './words.js';
import { type TextStyle, validateStyle } from './textStyle.js';
import { isSafeId } from './ids.js';

export const PROJECT_SCHEMA_VERSION = 1;

/** Exact media version a project depends on (`shared://media_id/version_id` in PRD terms). */
export interface MediaRef {
  media_id: string;
  version_id: string;
}

/**
 * U3: sound lanes mixed over the picture's own sound: `audio` (voice-over / any sound), `music`
 * (background music under the voice) and `sfx` (short effects). Each lane keeps its clips apart,
 * but the lanes play together.
 */
export type TrackKind = 'video' | 'broll' | 'text' | 'subtitle' | 'audio' | 'music' | 'sfx' | 'effects';
const TRACK_KINDS: readonly TrackKind[] = ['video', 'broll', 'text', 'subtitle', 'audio', 'music', 'sfx', 'effects'];

export interface Clip {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  /** Offset into the source media where this clip starts (trim-start / split). Default 0. */
  in_ms?: number;
  media?: MediaRef;
  /** Text of a text/subtitle clip (W07). Never on media clips. */
  text?: string;
  /** Look of a text/subtitle clip (X01); missing fields fall back to the track default. */
  style?: Partial<TextStyle>;
  /** Sound level of a media clip, 0..1 (X04). Missing = 1 (full). 0 = muted. */
  volume?: number;
  /** U3b: word timings of a caption (relative to the clip start); `text` = the words joined. */
  words?: Word[];
  /** U3c: picture effect of a clip on the `effects` track (zoom, zoom-through). */
  effect?: ClipEffect;
  /** U3d: part of the source shown (fractions of the source frame). */
  crop?: Crop;
  /** U3d: blurred areas of the source, timed in SOURCE ms. */
  blur?: BlurRegion[];
}

export const CANVAS_RATIOS = ['9:16', '3:4', '1:1', '16:9'] as const;
export type CanvasRatio = (typeof CANVAS_RATIOS)[number];
export const MAX_TEXT_LEN = 500;

/** Timeline = tracks + output canvas; both are part of undo/redo. */
export interface Timeline {
  tracks: Track[];
  /** Default 9:16 when absent. */
  canvas?: { ratio: CanvasRatio };
  /** X06: burn the Brand Kit logo onto this project's renders (and show it in the preview). */
  brand_logo?: boolean;
  /** U3: normalise the final mix to this integrated loudness (LUFS, e.g. -14). Missing = as is. */
  loudness_lufs?: number;
}

export interface Track {
  track_id: string;
  kind: TrackKind;
  clips: Clip[];
  /** Media tracks only (X04): the whole track is silent in preview and render. */
  muted?: boolean;
}

/** Retained history entry. `retained:true` snapshots/undo records hold their media (PRD v0.8 §B). */
export interface Snapshot {
  snapshot_id: string;
  /** `undo`/`redo` entries carry the full timeline to go back/forward to (W06). */
  kind: 'snapshot' | 'undo' | 'redo';
  retained: boolean;
  created_at: number;
  media: MediaRef[];
  timeline?: Timeline;
  label?: string;
}

export interface ProjectManifest {
  schema_version: typeof PROJECT_SCHEMA_VERSION;
  project_id: string;
  name: string;
  status: 'active' | 'archived';
  revision: number;
  created_at: number;
  updated_at: number;
  timeline: Timeline;
  snapshots: Snapshot[];
  /** X09: this project is a variant of a master (ratio / hook / CTA brief + approval). */
  variant?: VariantInfo;
  /** U1: the brand whose Brand Kit this project uses (missing = workspace default brand). */
  brand_id?: string;
}

export interface VariantBrief {
  ratio?: CanvasRatio;
  hook?: string;
  cta?: string;
}

export interface VariantInfo {
  master_id: string;
  /** 1, 2, 3… per master, in creation order (V1, V2, …). */
  number: number;
  label: string;
  brief: VariantBrief;
  /** Revision the user approved; any later edit means "changed since approval". */
  approved_revision: number | null;
}

export function mediaRefUri(ref: MediaRef): string {
  return `shared://${ref.media_id}/${ref.version_id}`;
}

export function parseMediaRefUri(uri: string): MediaRef {
  const m = /^shared:\/\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m || !isSafeId(m[1]) || !isSafeId(m[2])) {
    throw new StorageError('PROJECT_INVALID', 'Referensi media tidak valid', { uri });
  }
  return { media_id: m[1]!, version_id: m[2]! };
}

// ------------------------------------------------------------------ validation

type Obj = Record<string, unknown>;
const fail = (where: string, msg: string): never => {
  throw new StorageError('PROJECT_INVALID', `Manifest proyek tidak valid di ${where}: ${msg}`, { where });
};
const obj = (x: unknown, where: string): Obj =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Obj) : fail(where, 'harus object');
const arr = (x: unknown, where: string): unknown[] => (Array.isArray(x) ? x : fail(where, 'harus array'));
const str = (x: unknown, where: string): string => (typeof x === 'string' ? x : fail(where, 'harus string'));
const id = (x: unknown, where: string): string => (isSafeId(x) ? x : fail(where, 'ID tidak valid'));
const num = (x: unknown, where: string): number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fail(where, 'harus angka ≥ 0');
const bool = (x: unknown, where: string): boolean => (typeof x === 'boolean' ? x : fail(where, 'harus boolean'));

function mediaRef(x: unknown, where: string): MediaRef {
  const o = obj(x, where);
  return { media_id: id(o.media_id, `${where}.media_id`), version_id: id(o.version_id, `${where}.version_id`) };
}

export function validateProjectManifest(x: unknown): ProjectManifest {
  const o = obj(x, 'root');
  if (o.schema_version !== PROJECT_SCHEMA_VERSION) fail('schema_version', `harus ${PROJECT_SCHEMA_VERSION}`);
  const status = o.status;
  if (status !== 'active' && status !== 'archived') fail('status', 'harus active|archived');
  const timeline = validateTimeline(o.timeline, 'timeline');
  const snapshots = arr(o.snapshots, 'snapshots').map((s, i) => {
    const w = `snapshots[${i}]`;
    const so = obj(s, w);
    if (so.kind !== 'snapshot' && so.kind !== 'undo' && so.kind !== 'redo') fail(`${w}.kind`, 'harus snapshot|undo|redo');
    const snap: Snapshot = {
      snapshot_id: id(so.snapshot_id, `${w}.snapshot_id`),
      kind: so.kind as Snapshot['kind'],
      retained: bool(so.retained, `${w}.retained`),
      created_at: num(so.created_at, `${w}.created_at`),
      media: arr(so.media, `${w}.media`).map((m, j) => mediaRef(m, `${w}.media[${j}]`)),
    };
    if (so.label !== undefined) snap.label = str(so.label, `${w}.label`);
    if (so.timeline !== undefined) {
      snap.timeline = validateTimeline(so.timeline, `${w}.timeline`);
      // The GC must see every media the stored timeline would bring back (PRD: retained undo holds media).
      const held = new Set(snap.media.map((m) => m.version_id));
      for (const t of snap.timeline.tracks) for (const c of t.clips) if (c.media && !held.has(c.media.version_id)) fail(`${w}.media`, 'tidak memuat semua media timeline');
    }
    return snap;
  });
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: id(o.project_id, 'project_id'),
    name: str(o.name, 'name'),
    status: status as ProjectManifest['status'],
    revision: num(o.revision, 'revision'),
    created_at: num(o.created_at, 'created_at'),
    updated_at: num(o.updated_at, 'updated_at'),
    timeline,
    snapshots,
    ...(o.variant !== undefined ? { variant: validateVariantInfo(o.variant) } : {}),
    ...(o.brand_id !== undefined ? { brand_id: id(o.brand_id, 'brand_id') } : {}),
  };
}

function validateVariantInfo(x: unknown): VariantInfo {
  const v = obj(x, 'variant');
  const b = obj(v.brief, 'variant.brief');
  const brief: VariantBrief = {};
  if (b.ratio !== undefined) {
    if (!CANVAS_RATIOS.includes(b.ratio as CanvasRatio)) fail('variant.brief.ratio', 'rasio tidak dikenal');
    brief.ratio = b.ratio as CanvasRatio;
  }
  for (const k of ['hook', 'cta'] as const) {
    if (b[k] === undefined) continue;
    const t = str(b[k], `variant.brief.${k}`);
    if (!t.trim() || t.length > MAX_TEXT_LEN) fail(`variant.brief.${k}`, `1–${MAX_TEXT_LEN} karakter`);
    brief[k] = t;
  }
  const label = str(v.label, 'variant.label');
  if (!label.trim() || label.length > 60) fail('variant.label', '1–60 karakter');
  const ar = v.approved_revision;
  if (ar !== null && (typeof ar !== 'number' || !Number.isSafeInteger(ar) || ar < 0)) fail('variant.approved_revision', 'harus angka revisi atau null');
  if (typeof v.number !== 'number' || !Number.isSafeInteger(v.number) || v.number < 1) fail('variant.number', 'harus angka ≥ 1');
  return { master_id: id(v.master_id, 'variant.master_id'), number: v.number as number, label, brief, approved_revision: ar as number | null };
}

function validateTimeline(x: unknown, where: string): Timeline {
  const o = obj(x, where);
  const out: Timeline = { tracks: validateTracks(o, where) };
  if (o.canvas !== undefined) {
    const c = obj(o.canvas, `${where}.canvas`);
    if (!CANVAS_RATIOS.includes(c.ratio as CanvasRatio)) fail(`${where}.canvas.ratio`, `harus salah satu ${CANVAS_RATIOS.join(', ')}`);
    out.canvas = { ratio: c.ratio as CanvasRatio };
  }
  if (o.loudness_lufs !== undefined) {
    const l = o.loudness_lufs;
    if (typeof l !== 'number' || !Number.isFinite(l) || l < -30 || l > -6) fail(`${where}.loudness_lufs`, 'harus angka -30 sampai -6');
    out.loudness_lufs = l as number;
  }
  if (o.brand_logo !== undefined) {
    if (typeof o.brand_logo !== 'boolean') fail(`${where}.brand_logo`, 'harus true/false');
    if (o.brand_logo) out.brand_logo = true;
  }
  return out;
}

function validateTracks(timeline: Obj, where: string): Track[] {
  return arr(timeline.tracks, `${where}.tracks`).map((t, i) => {
    const w = `${where}.tracks[${i}]`;
    const to = obj(t, w);
    const kind = to.kind as TrackKind;
    if (!TRACK_KINDS.includes(kind)) fail(`${w}.kind`, 'jenis track tidak dikenal');
    const clips = arr(to.clips, `${w}.clips`).map((c, j) => {
      const cw = `${w}.clips[${j}]`;
      const co = obj(c, cw);
      const start = num(co.start_ms, `${cw}.start_ms`);
      const end = num(co.end_ms, `${cw}.end_ms`);
      if (end <= start) fail(cw, 'end_ms harus > start_ms');
      const clip: Clip = { clip_id: id(co.clip_id, `${cw}.clip_id`), start_ms: start, end_ms: end };
      if (co.in_ms !== undefined) clip.in_ms = num(co.in_ms, `${cw}.in_ms`);
      if (co.media !== undefined) clip.media = mediaRef(co.media, `${cw}.media`);
      if (co.text !== undefined) {
        const text = str(co.text, `${cw}.text`);
        if (text.length > MAX_TEXT_LEN) fail(`${cw}.text`, `maks ${MAX_TEXT_LEN} karakter`);
        if (clip.media) fail(`${cw}.text`, 'klip media tidak boleh punya teks');
        clip.text = text;
      }
      if (co.volume !== undefined) {
        const v = co.volume;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail(`${cw}.volume`, 'harus angka 0–1');
        if (!clip.media) fail(`${cw}.volume`, 'volume hanya untuk klip media');
        clip.volume = v as number;
      }
      if (co.effect !== undefined) {
        if (kind !== 'effects') fail(`${cw}.effect`, 'efek hanya di track efek');
        try {
          clip.effect = validateEffect(co.effect, `${cw}.effect`);
        } catch (e) {
          fail(`${cw}.effect`, e instanceof Error ? e.message : 'tidak valid');
        }
      }
      for (const k of ['crop', 'blur'] as const) {
        if (co[k] === undefined) continue;
        if (!clip.media) fail(`${cw}.${k}`, 'crop/blur hanya untuk klip media');
        try {
          if (k === 'crop') clip.crop = validateCrop(co.crop, `${cw}.crop`);
          else clip.blur = validateBlur(co.blur, `${cw}.blur`);
        } catch (e) {
          fail(`${cw}.${k}`, e instanceof Error ? e.message : 'tidak valid');
        }
      }
      if (co.words !== undefined) {
        if (kind !== 'text' && kind !== 'subtitle') fail(`${cw}.words`, 'kata hanya untuk klip teks/subtitle');
        try {
          clip.words = validateWords(co.words, end - start, `${cw}.words`);
        } catch (e) {
          fail(`${cw}.words`, e instanceof Error ? e.message : 'tidak valid');
        }
      }
      if (co.style !== undefined) {
        if (kind !== 'text' && kind !== 'subtitle') fail(`${cw}.style`, 'gaya hanya untuk klip teks/subtitle');
        try {
          clip.style = validateStyle(co.style, `${cw}.style`);
        } catch (e) {
          fail(`${cw}.style`, e instanceof Error ? e.message : 'tidak valid');
        }
      }
      return clip;
    });
    const track: Track = { track_id: id(to.track_id, `${w}.track_id`), kind, clips };
    if (to.muted !== undefined) {
      if (typeof to.muted !== 'boolean') fail(`${w}.muted`, 'harus true/false');
      if (!['video', 'broll', 'audio', 'music', 'sfx'].includes(kind)) fail(`${w}.muted`, 'mute hanya untuk track media');
      track.muted = to.muted as boolean;
    }
    return track;
  });
}

/** Every media version a manifest holds: timeline clips + retained snapshots/undo. */
export function manifestReferences(m: ProjectManifest): { ref: MediaRef; source: 'timeline' | 'snapshot' | 'undo'; detail: string }[] {
  const out: { ref: MediaRef; source: 'timeline' | 'snapshot' | 'undo'; detail: string }[] = [];
  for (const t of m.timeline.tracks) {
    for (const c of t.clips) if (c.media) out.push({ ref: c.media, source: 'timeline', detail: `${t.track_id}/${c.clip_id}` });
  }
  for (const s of m.snapshots) {
    if (!s.retained) continue;
    for (const ref of s.media) out.push({ ref, source: s.kind === 'redo' ? 'undo' : s.kind, detail: s.snapshot_id });
  }
  return out;
}
