/**
 * U7 (was X10): comments at a timecode + review decision per project.
 *
 *  03_PROJECT/review.json  { comments: [...], decision: { status, revision, by, at, note } | null }
 *
 * Kept next to the manifest but NOT in it: a comment or a review is not an edit (no new revision,
 * not in undo). A "lulus" (pass) is tied to the revision it was given for — any later edit makes
 * it "berubah" (changed since review), like variant approval (X09). Who may do what is enforced by
 * the server (roles); this module records the author it is given.
 */
import { appendLearning } from './learning.js';
import fsp from 'node:fs/promises';
import { StorageError } from './errors.js';
import { newId } from './ids.js';
import { writeJsonAtomic } from './jsonStore.js';
import { resolveInside } from './paths.js';
import { type Workspace, projectRel, readProject, withWorkspaceLock } from './workspace.js';

export const MAX_COMMENTS = 500;
export const MAX_COMMENT_LEN = 1000;

export interface Author {
  email: string | null;
  name: string;
}
export interface ReviewComment {
  comment_id: string;
  at_ms: number;
  text: string;
  author: Author;
  created_at: number;
  /** Project revision the comment was written on. */
  revision: number;
  resolved_at: number | null;
  resolved_by: Author | null;
}
export type ReviewStatus = 'lulus' | 'revisi';
export interface ReviewDecision {
  status: ReviewStatus;
  revision: number;
  by: Author;
  at: number;
  note: string;
}
interface ReviewFile {
  schema: 'review/1';
  comments: ReviewComment[];
  decision: ReviewDecision | null;
}
/** What the UI shows: `berubah` = passed earlier, edited since. */
export type ReviewState = 'belum' | 'lulus' | 'revisi' | 'berubah';

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const fileRel = (projectId: string) => `${projectRel(projectId, '03_PROJECT')}/review.json`;

async function load(ws: Workspace, projectId: string): Promise<ReviewFile> {
  const abs = await resolveInside(ws.root, fileRel(projectId), { allowMissing: true });
  let raw: string;
  try {
    raw = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'review/1', comments: [], decision: null };
    throw e;
  }
  const f = JSON.parse(raw) as ReviewFile;
  if (f?.schema !== 'review/1' || !Array.isArray(f.comments)) throw new StorageError('PROJECT_INVALID', 'File review rusak');
  return f;
}
const save = async (ws: Workspace, projectId: string, f: ReviewFile) => writeJsonAtomic(await resolveInside(ws.root, fileRel(projectId), { allowMissing: true }), f);

const cleanAuthor = (a: Author): Author => ({ email: a.email ? a.email.slice(0, 200) : null, name: (a.name || a.email || 'Pengguna').slice(0, 100) });

export function reviewState(decision: ReviewDecision | null, revision: number): ReviewState {
  if (!decision) return 'belum';
  if (decision.status === 'revisi') return 'revisi';
  return decision.revision === revision ? 'lulus' : 'berubah';
}

export async function readReview(ws: Workspace, projectId: string): Promise<{ comments: ReviewComment[]; decision: ReviewDecision | null; state: ReviewState; revision: number }> {
  const p = await readProject(ws, projectId);
  const f = await load(ws, projectId);
  return { comments: f.comments, decision: f.decision, state: reviewState(f.decision, p.revision), revision: p.revision };
}

export async function addComment(ws: Workspace, input: { project_id: string; at_ms: unknown; text: unknown; author: Author }): Promise<ReviewComment> {
  if (typeof input.at_ms !== 'number' || !Number.isFinite(input.at_ms) || input.at_ms < 0 || input.at_ms > 24 * 3_600_000) bad('at_ms harus angka ms ≥ 0');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_COMMENT_LEN) bad(`Komentar 1–${MAX_COMMENT_LEN} karakter`);
  return withWorkspaceLock(ws, 'review.comment', async () => {
    const p = await readProject(ws, input.project_id);
    const f = await load(ws, input.project_id);
    if (f.comments.length >= MAX_COMMENTS) bad(`Maksimal ${MAX_COMMENTS} komentar per proyek`);
    const c: ReviewComment = { comment_id: newId('op').replace(/^op_/, 'cm_'), at_ms: Math.round(input.at_ms as number), text: (input.text as string).trim(), author: cleanAuthor(input.author), created_at: ws.clock.now(), revision: p.revision, resolved_at: null, resolved_by: null };
    f.comments.push(c);
    f.comments.sort((a, b) => a.at_ms - b.at_ms || a.created_at - b.created_at);
    await save(ws, input.project_id, f);
    return c;
  });
}

export async function resolveComment(ws: Workspace, input: { project_id: string; comment_id: string; resolved: unknown; author: Author }): Promise<ReviewComment> {
  if (typeof input.resolved !== 'boolean') bad('resolved harus true/false');
  return withWorkspaceLock(ws, 'review.resolve', async () => {
    const f = await load(ws, input.project_id);
    const c = f.comments.find((x) => x.comment_id === input.comment_id);
    if (!c) throw new StorageError('NOT_FOUND', 'Komentar tidak ada');
    c.resolved_at = input.resolved ? ws.clock.now() : null;
    c.resolved_by = input.resolved ? cleanAuthor(input.author) : null;
    await save(ws, input.project_id, f);
    return c;
  });
}

/**
 * Lulus / Revisi for the project's CURRENT revision. Lulus is refused while a comment is still open
 * and for a test variant (Batch Remix music without an ad licence, contract §3).
 */
export async function decideReview(ws: Workspace, input: { project_id: string; expected_revision: unknown; status: unknown; note: unknown; author: Author }): Promise<{ decision: ReviewDecision; state: ReviewState }> {
  if (input.status !== 'lulus' && input.status !== 'revisi') bad('status harus lulus | revisi');
  const note = input.note === undefined ? '' : typeof input.note === 'string' && input.note.length <= MAX_COMMENT_LEN ? input.note.trim() : bad(`catatan maks ${MAX_COMMENT_LEN} karakter`);
  if (input.status === 'revisi' && !note) bad('Tulis apa yang perlu direvisi');
  return withWorkspaceLock(ws, 'review.decide', async () => {
    const p = await readProject(ws, input.project_id);
    if (p.revision !== input.expected_revision) throw new StorageError('CONFLICT', 'Proyek sudah berubah; muat ulang lalu periksa lagi', { expected: input.expected_revision, actual: p.revision });
    const f = await load(ws, input.project_id);
    if (input.status === 'lulus') {
      if (p.variant?.bukan_iklan) bad('Varian UJI (musik tanpa lisensi iklan) tidak boleh Lulus');
      const open = f.comments.filter((c) => c.resolved_at === null).length;
      if (open) bad(`Masih ada ${open} komentar terbuka; selesaikan dulu`);
      if (!p.timeline.tracks.some((t) => t.clips.length)) bad('Proyek masih kosong');
    }
    f.decision = { status: input.status as ReviewStatus, revision: p.revision, by: cleanAuthor(input.author), at: ws.clock.now(), note: note as string };
    await save(ws, input.project_id, f);
    // R9: what the PIC asked to change is a lesson for this brand.
    if (f.decision.status === 'revisi') await appendLearning(ws, input.project_id, { jenis: 'revisi_pic', revision: p.revision, note: f.decision.note, by: f.decision.by.name });
    return { decision: f.decision, state: reviewState(f.decision, p.revision) };
  });
}
