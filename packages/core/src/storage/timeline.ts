import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import type { Clip, MediaRef, ProjectManifest, Snapshot, Track, TrackKind } from './project.js';

/**
 * Timeline editing core (plan v2.0 W06, PRD: "action reducer, undo history; authoritative
 * version held server-side"). Pure functions over the project manifest: the same reducer is
 * used by the manual editor now and by approved AI edit plans later (W11).
 */

export const MIN_CLIP_MS = 100;
/** Retained undo steps per project. Older steps are dropped (and stop holding their media). */
export const UNDO_LIMIT = 50;
/** Media clips may live on these tracks; text/subtitle/effects carry no media. */
export const MEDIA_TRACKS: readonly TrackKind[] = ['video', 'broll', 'audio'];
const TRACK_ORDER: readonly TrackKind[] = ['video', 'broll', 'text', 'subtitle', 'audio', 'effects'];

export type EditOp =
  | { op: 'add_clip'; track_kind: TrackKind; media?: MediaRef; start_ms: number; duration_ms: number; in_ms?: number }
  | { op: 'move_clip'; clip_id: string; start_ms: number }
  | { op: 'trim_clip'; clip_id: string; edge: 'start' | 'end'; to_ms: number }
  | { op: 'split_clip'; clip_id: string; at_ms: number }
  | { op: 'delete_clip'; clip_id: string };

export type Timeline = ProjectManifest['timeline'];

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};
const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 24 * 3_600_000;
const ms = (n: unknown, what: string): number => (isMs(n) ? Math.round(n) : bad(`${what} harus angka ms 0–24 jam`, { [what]: n }));
const clipId = (x: unknown): string => (isSafeId(x) ? x : bad('clip_id tidak valid'));

/** Validate the shape of untrusted ops (HTTP / AI plans) before anything is applied. */
export function validateOps(x: unknown): EditOp[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > 100) bad('ops harus daftar 1–100 operasi');
  return (x as unknown[]).map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const keys = (allowed: string[]) => {
      const extra = Object.keys(o).filter((k) => !allowed.includes(k));
      if (extra.length) bad(`ops[${i}]: field tidak dikenal ${extra.join(', ')}`);
    };
    switch (o.op) {
      case 'add_clip': {
        keys(['op', 'track_kind', 'media', 'start_ms', 'duration_ms', 'in_ms']);
        if (!TRACK_ORDER.includes(o.track_kind as TrackKind)) bad(`ops[${i}]: track_kind tidak dikenal`);
        let media: MediaRef | undefined;
        if (o.media !== undefined) {
          const m = o.media as Record<string, unknown>;
          if (!m || !isSafeId(m.media_id) || !isSafeId(m.version_id) || Object.keys(m).length !== 2) bad(`ops[${i}]: media tidak valid`);
          media = { media_id: m.media_id as string, version_id: m.version_id as string };
        }
        return {
          op: 'add_clip',
          track_kind: o.track_kind as TrackKind,
          ...(media ? { media } : {}),
          start_ms: ms(o.start_ms, 'start_ms'),
          duration_ms: ms(o.duration_ms, 'duration_ms'),
          ...(o.in_ms !== undefined ? { in_ms: ms(o.in_ms, 'in_ms') } : {}),
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
      default:
        return bad(`ops[${i}]: operasi tidak dikenal`);
    }
  });
}

const clone = (t: Timeline): Timeline => ({ tracks: t.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => ({ ...c, ...(c.media ? { media: { ...c.media } } : {}) })) })) });

function locate(t: Timeline, id: string): { track: Track; clip: Clip; index: number } {
  for (const track of t.tracks) {
    const index = track.clips.findIndex((c) => c.clip_id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return bad('Klip tidak ditemukan', { clip_id: id });
}

/** Every track: clips sorted, long enough, never overlapping (deterministic timeline). */
function assertConsistent(t: Timeline): void {
  const ids = new Set<string>();
  for (const track of t.tracks) {
    track.clips.sort((a, b) => a.start_ms - b.start_ms);
    let prevEnd = -1;
    for (const c of track.clips) {
      if (ids.has(c.clip_id)) bad('clip_id ganda', { clip_id: c.clip_id });
      ids.add(c.clip_id);
      if (c.end_ms - c.start_ms < MIN_CLIP_MS) bad(`Klip minimal ${MIN_CLIP_MS} ms`, { clip_id: c.clip_id });
      if (c.start_ms < prevEnd) bad('Klip saling tumpang tindih di track yang sama', { clip_id: c.clip_id, track_id: track.track_id });
      if (c.media && !MEDIA_TRACKS.includes(track.kind)) bad(`Media tidak boleh di track ${track.kind}`, { clip_id: c.clip_id });
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
export function applyOps(timeline: Timeline, ops: EditOp[], newClipId: () => string): Timeline {
  const t = clone(timeline);
  for (const op of ops) {
    switch (op.op) {
      case 'add_clip': {
        if (op.media && !MEDIA_TRACKS.includes(op.track_kind)) bad(`Media tidak boleh di track ${op.track_kind}`);
        const clip: Clip = { clip_id: newClipId(), start_ms: op.start_ms, end_ms: op.start_ms + op.duration_ms };
        if (op.media) {
          clip.media = { ...op.media };
          clip.in_ms = op.in_ms ?? 0;
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
          clip.end_ms = op.to_ms;
        } else {
          const delta = op.to_ms - clip.start_ms;
          // Trimming the start also moves the source in-point, so the picture stays in place.
          if (clip.media) {
            const nextIn = (clip.in_ms ?? 0) + delta;
            if (nextIn < 0) bad('Tidak bisa memperpanjang klip sebelum awal sumbernya', { clip_id: clip.clip_id });
            clip.in_ms = nextIn;
          }
          clip.start_ms = op.to_ms;
        }
        if (clip.end_ms <= clip.start_ms) bad('Trim membuat klip kosong', { clip_id: clip.clip_id });
        break;
      }
      case 'split_clip': {
        const { track, clip, index } = locate(t, op.clip_id);
        if (op.at_ms <= clip.start_ms || op.at_ms >= clip.end_ms) bad('Titik split harus di dalam klip', { clip_id: clip.clip_id });
        const right: Clip = { clip_id: newClipId(), start_ms: op.at_ms, end_ms: clip.end_ms };
        if (clip.media) {
          right.media = { ...clip.media };
          right.in_ms = (clip.in_ms ?? 0) + (op.at_ms - clip.start_ms);
        }
        clip.end_ms = op.at_ms;
        track.clips.splice(index + 1, 0, right);
        break;
      }
      case 'delete_clip': {
        const { track, index } = locate(t, op.clip_id);
        track.clips.splice(index, 1);
        break;
      }
    }
  }
  assertConsistent(t);
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
export function editManifest(m: ProjectManifest, ops: EditOp[], label: string, ctx: HistoryContext & { newClipId: () => string }): ProjectManifest {
  const timeline = applyOps(m.timeline, ops, ctx.newClipId);
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
