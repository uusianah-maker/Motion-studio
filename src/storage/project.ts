import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';

export const PROJECT_SCHEMA_VERSION = 1;

/** Exact media version a project depends on (`shared://media_id/version_id` in PRD terms). */
export interface MediaRef {
  media_id: string;
  version_id: string;
}

export type TrackKind = 'video' | 'broll' | 'text' | 'subtitle' | 'audio' | 'effects';
const TRACK_KINDS: readonly TrackKind[] = ['video', 'broll', 'text', 'subtitle', 'audio', 'effects'];

export interface Clip {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  media?: MediaRef;
}

export interface Track {
  track_id: string;
  kind: TrackKind;
  clips: Clip[];
}

/** Retained history entry. `retained:true` snapshots/undo records hold their media (PRD v0.8 §B). */
export interface Snapshot {
  snapshot_id: string;
  kind: 'snapshot' | 'undo';
  retained: boolean;
  created_at: number;
  media: MediaRef[];
}

export interface ProjectManifest {
  schema_version: typeof PROJECT_SCHEMA_VERSION;
  project_id: string;
  name: string;
  status: 'active' | 'archived';
  revision: number;
  created_at: number;
  updated_at: number;
  timeline: { tracks: Track[] };
  snapshots: Snapshot[];
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
  const timeline = obj(o.timeline, 'timeline');
  const tracks = arr(timeline.tracks, 'timeline.tracks').map((t, i) => {
    const w = `timeline.tracks[${i}]`;
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
      if (co.media !== undefined) clip.media = mediaRef(co.media, `${cw}.media`);
      return clip;
    });
    return { track_id: id(to.track_id, `${w}.track_id`), kind, clips };
  });
  const snapshots = arr(o.snapshots, 'snapshots').map((s, i) => {
    const w = `snapshots[${i}]`;
    const so = obj(s, w);
    if (so.kind !== 'snapshot' && so.kind !== 'undo') fail(`${w}.kind`, 'harus snapshot|undo');
    return {
      snapshot_id: id(so.snapshot_id, `${w}.snapshot_id`),
      kind: so.kind as Snapshot['kind'],
      retained: bool(so.retained, `${w}.retained`),
      created_at: num(so.created_at, `${w}.created_at`),
      media: arr(so.media, `${w}.media`).map((m, j) => mediaRef(m, `${w}.media[${j}]`)),
    };
  });
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: id(o.project_id, 'project_id'),
    name: str(o.name, 'name'),
    status: status as ProjectManifest['status'],
    revision: num(o.revision, 'revision'),
    created_at: num(o.created_at, 'created_at'),
    updated_at: num(o.updated_at, 'updated_at'),
    timeline: { tracks },
    snapshots,
  };
}

/** Every media version a manifest holds: timeline clips + retained snapshots/undo. */
export function manifestReferences(m: ProjectManifest): { ref: MediaRef; source: 'timeline' | 'snapshot' | 'undo'; detail: string }[] {
  const out: { ref: MediaRef; source: 'timeline' | 'snapshot' | 'undo'; detail: string }[] = [];
  for (const t of m.timeline.tracks) {
    for (const c of t.clips) if (c.media) out.push({ ref: c.media, source: 'timeline', detail: `${t.track_id}/${c.clip_id}` });
  }
  for (const s of m.snapshots) {
    if (!s.retained) continue;
    for (const ref of s.media) out.push({ ref, source: s.kind, detail: s.snapshot_id });
  }
  return out;
}
