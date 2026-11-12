import { promises as fsp } from 'node:fs';
import { MAX_WORDS_PER_CLIP, MAX_WORD_LEN } from './words.js';
import { StorageError } from './errors.js';
import { newId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { resolveInside } from './paths.js';
import { MAX_TEXT_LEN } from './project.js';
import type { EditOp, Timeline } from './timeline.js';
import { type Workspace, projectRel } from './workspace.js';

/**
 * Transcripts (W14, PRD: "STT word timestamps … caption style and transcript edit"; §10:
 * "Captions are editable, timestamped, and checked for overlap/out-of-bounds"). A transcript
 * belongs to one project and one media VERSION; times are in source-media milliseconds.
 * Stored as JSON next to the project manifest (`03_PROJECT/transcripts/`), never inside media.
 * Turning cues into subtitle clips goes through an edit plan (approve → apply → undo).
 */

export const TRANSCRIPT_SCHEMA_VERSION = 1;
export const MAX_CUES = 2000;
export const MIN_CUE_MS = 200;

export interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
}
export interface Cue {
  cue_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
}
export interface Transcript {
  schema_version: typeof TRANSCRIPT_SCHEMA_VERSION;
  transcript_id: string;
  project_id: string;
  media_id: string;
  version_id: string;
  language: string | null;
  provider: string;
  model: string;
  source_duration_ms: number;
  created_at: number;
  updated_at: number;
  /** Edit counter for optimistic concurrency (two tabs editing the same transcript). */
  rev: number;
  edited: boolean;
  words: Word[];
  cues: Cue[];
}

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};

/**
 * Group words into readable caption cues: break on sentence end, on a pause, or when a cue
 * would get too long (characters / duration). Times stay exactly on word boundaries.
 */
export function buildCues(words: Word[], opts: { max_chars?: number; max_ms?: number; gap_ms?: number; duration_ms?: number } = {}): Cue[] {
  const maxChars = opts.max_chars ?? 42;
  const maxMs = opts.max_ms ?? 3500;
  const gapMs = opts.gap_ms ?? 600;
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    const start = cur[0]!.start_ms;
    const end = Math.max(cur[cur.length - 1]!.end_ms, start + MIN_CUE_MS);
    if (text) cues.push({ cue_id: newId('cue'), start_ms: start, end_ms: end, text: text.slice(0, MAX_TEXT_LEN) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const len = cur.map((x) => x.text).join(' ').length + 1 + w.text.length;
      if (w.start_ms - prev.end_ms > gapMs || len > maxChars || w.end_ms - cur[0]!.start_ms > maxMs) flush();
    }
    cur.push(w);
    if (/[.!?…]$/.test(w.text)) flush();
  }
  flush();
  // Never overlap: a cue ends no later than the next one starts; never past the media.
  const dur = opts.duration_ms ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (i + 1 < cues.length && c.end_ms > cues[i + 1]!.start_ms) c.end_ms = cues[i + 1]!.start_ms;
    c.end_ms = Math.min(c.end_ms, dur);
  }
  // Checkpoint F F-6: every generated cue must pass validateCues (≥ MIN_CUE_MS, inside the media,
  // no overlap). A too-short cue joins the previous one, or grows into free space, or is dropped.
  const out: Cue[] = [];
  cues.forEach((c, i) => {
    if (c.start_ms >= dur) return;
    if (c.end_ms - c.start_ms >= MIN_CUE_MS) return void out.push(c);
    const prev = out[out.length - 1];
    if (prev && prev.text.length + 1 + c.text.length <= MAX_TEXT_LEN) {
      prev.text = `${prev.text} ${c.text}`;
      prev.end_ms = Math.max(prev.end_ms, c.end_ms);
      return;
    }
    const next = cues[i + 1];
    if (next && next.start_ms < dur && c.text.length + 1 + next.text.length <= MAX_TEXT_LEN) {
      // No room before: the words move into the next cue (never lost).
      next.text = `${c.text} ${next.text}`;
      next.start_ms = c.start_ms;
      return;
    }
    const end = Math.min(c.start_ms + MIN_CUE_MS, dur);
    if (end - c.start_ms >= MIN_CUE_MS) out.push({ ...c, end_ms: end });
  });
  return out;
}

/** Validate edited cues: shape, inside the media, minimum length, no overlap. Returns them sorted. */
export function validateCues(raw: unknown, durationMs: number): Cue[] {
  if (!Array.isArray(raw) || raw.length > MAX_CUES) bad(`Daftar cue wajib 0–${MAX_CUES} item`);
  const cues = (raw as unknown[]).map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['cue_id', 'start_ms', 'end_ms', 'text'].includes(k));
    if (extra.length) bad(`Cue #${i + 1}: field tidak dikenal ${extra.join(', ')}`);
    const n = (v: unknown, what: string) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : bad(`Cue #${i + 1}: ${what} harus angka ms`));
    const start = n(o.start_ms, 'start_ms');
    const end = n(o.end_ms, 'end_ms');
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LEN) bad(`Cue #${i + 1}: teks wajib 1–${MAX_TEXT_LEN} karakter`);
    if (end - start < MIN_CUE_MS) bad(`Cue #${i + 1}: minimal ${MIN_CUE_MS} ms (akhir harus setelah awal)`, { index: i });
    if (end > durationMs + 50) bad(`Cue #${i + 1} melewati panjang media (${(durationMs / 1000).toFixed(1)} dtk)`, { index: i });
    const id = typeof o.cue_id === 'string' && /^cue_[0-9a-f]{16}$/.test(o.cue_id) ? o.cue_id : newId('cue');
    return { cue_id: id, start_ms: start, end_ms: Math.min(end, durationMs), text };
  });
  cues.sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i]!.start_ms < cues[i - 1]!.end_ms) bad(`Cue "${cues[i - 1]!.text.slice(0, 30)}" dan "${cues[i]!.text.slice(0, 30)}" tumpang tindih`, { index: i });
  }
  return cues;
}

// ------------------------------------------------------------------ storage

const dirRel = (projectId: string) => `${projectRel(projectId, '03_PROJECT')}/transcripts`;
const ID_RE = /^tr_[0-9a-f]{16}$/;

function validateTranscript(x: unknown): Transcript {
  const t = x as Transcript;
  if (!t || t.schema_version !== TRANSCRIPT_SCHEMA_VERSION || !ID_RE.test(t.transcript_id) || !Array.isArray(t.cues) || !Array.isArray(t.words)) {
    throw new StorageError('PROJECT_INVALID', 'File transkrip rusak');
  }
  return t;
}

async function fileOf(ws: Workspace, projectId: string, id: string, allowMissing = false) {
  if (!ID_RE.test(id)) throw new StorageError('NOT_FOUND', 'Transkrip tidak ada');
  return resolveInside(ws.root, `${dirRel(projectId)}/${id}.json`, { allowMissing });
}

export async function saveNewTranscript(ws: Workspace, t: Omit<Transcript, 'transcript_id' | 'schema_version' | 'created_at' | 'updated_at' | 'rev' | 'edited'>): Promise<Transcript> {
  const now = ws.clock.now();
  const full: Transcript = { ...t, schema_version: TRANSCRIPT_SCHEMA_VERSION, transcript_id: newId('tr'), created_at: now, updated_at: now, rev: 0, edited: false };
  const dir = await resolveInside(ws.root, dirRel(t.project_id), { allowMissing: true });
  await fsp.mkdir(dir, { recursive: true });
  await writeJsonAtomic(await fileOf(ws, t.project_id, full.transcript_id, true), full);
  return full;
}

export async function readTranscript(ws: Workspace, projectId: string, id: string): Promise<Transcript> {
  const file = await fileOf(ws, projectId, id, true);
  try {
    await fsp.access(file);
  } catch {
    throw new StorageError('NOT_FOUND', 'Transkrip tidak ada');
  }
  const t = await readJson(file, validateTranscript, 'PROJECT_INVALID');
  if (t.project_id !== projectId) throw new StorageError('NOT_FOUND', 'Transkrip tidak ada');
  return t;
}

export async function listTranscripts(ws: Workspace, projectId: string): Promise<Transcript[]> {
  const dir = await resolveInside(ws.root, dirRel(projectId), { allowMissing: true });
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => /^tr_[0-9a-f]{16}\.json$/.test(n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const out: Transcript[] = [];
  for (const n of names) {
    try {
      out.push(await readTranscript(ws, projectId, n.slice(0, -5)));
    } catch {
      /* a damaged file must not hide the others */
    }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

/** Replace the cues (human edit). `expected_rev` guards against overwriting another tab's edit. */
export async function updateCues(ws: Workspace, projectId: string, id: string, expectedRev: number, cues: unknown): Promise<Transcript> {
  const t = await readTranscript(ws, projectId, id);
  if (t.rev !== expectedRev) throw new StorageError('CONFLICT', 'Transkrip sudah diubah di tempat lain; muat ulang dulu', { expected: expectedRev, actual: t.rev });
  const next: Transcript = { ...t, cues: validateCues(cues, t.source_duration_ms), rev: t.rev + 1, edited: true, updated_at: ws.clock.now() };
  await writeJsonAtomic(await fileOf(ws, projectId, id), next);
  return next;
}

/**
 * Subtitle clips for every place this media version sits on the timeline (video, b-roll or
 * audio track): cue times are mapped through each clip's in-point; cues outside the visible
 * part are skipped; parts that would overlap an existing subtitle are skipped with a warning.
 */
export function cuesToSubtitleOps(t: Transcript, timeline: Timeline, onlyClipId?: string): { ops: EditOp[]; warnings: string[]; placements: number } {
  const ops: EditOp[] = [];
  const warnings: string[] = [];
  const subs = (timeline.tracks.find((x) => x.kind === 'subtitle')?.clips ?? []).map((c) => [c.start_ms, c.end_ms] as const);
  const taken: (readonly [number, number])[] = [...subs];
  let placements = 0;
  let clashes = 0;
  for (const tr of timeline.tracks) {
    if (!['video', 'broll', 'audio'].includes(tr.kind)) continue;
    for (const c of tr.clips) {
      if (c.media?.version_id !== t.version_id) continue;
      if (onlyClipId && c.clip_id !== onlyClipId) continue;
      placements++;
      const inMs = c.in_ms ?? 0;
      const len = c.end_ms - c.start_ms;
      for (const cue of t.cues) {
        const s = Math.max(cue.start_ms, inMs);
        const e = Math.min(cue.end_ms, inMs + len);
        if (e - s < MIN_CUE_MS) continue;
        const start = c.start_ms + (s - inMs);
        const end = c.start_ms + (e - inMs);
        if (taken.some(([a, b]) => a < end && start < b)) {
          clashes++;
          continue;
        }
        taken.push([start, end]);
        // U3b: an unedited cue keeps its word timings, so it can be shown word by word.
        const spoken = (t.words ?? []).filter((w) => w.start_ms >= s && w.end_ms <= e);
        const same = spoken.length > 0 && spoken.length <= MAX_WORDS_PER_CLIP && spoken.every((w) => !/\s/.test(w.text.trim()) && w.text.trim().length <= MAX_WORD_LEN) && spoken.map((w) => w.text.trim()).join(' ') === cue.text.trim().replace(/\s+/g, ' ');
        const words = same ? spoken.map((w) => ({ text: w.text.trim(), start_ms: w.start_ms - s, end_ms: w.end_ms - s })) : null;
        ops.push({ op: 'add_clip', track_kind: 'subtitle', text: cue.text, start_ms: start, duration_ms: end - start, ...(words && words.every((w, i) => w.end_ms > w.start_ms && (i === 0 || w.start_ms >= words[i - 1]!.end_ms)) ? { words } : {}) });
      }
    }
  }
  if (!placements) bad('Media transkrip ini belum ada di linimasa. Tambahkan klipnya dulu.');
  if (clashes) warnings.push(`${clashes} cue dilewati karena bertabrakan dengan subtitle yang sudah ada.`);
  if (!ops.length) bad(clashes ? 'Semua cue bertabrakan dengan subtitle yang sudah ada. Hapus subtitle lama dulu.' : 'Tidak ada cue yang jatuh di bagian klip yang terlihat.');
  return { ops, warnings, placements };
}
