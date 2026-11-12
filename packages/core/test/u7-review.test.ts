import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { createWithTimeline } from '../src/storage/projectAdmin.js';
import { addComment, decideReview, readReview, resolveComment } from '../src/storage/review.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const REV = { email: 'rev@example.com', name: 'Rina' };
const ED = { email: 'ed@example.com', name: 'Edi' };

describe('U7 comments at a timecode + review Lulus / Revisi', () => {
  it('comments: validated, sorted by time, resolve / reopen; not an edit (no new revision)', async () => {
    const { ws } = await fixtureWorkspace();
    await createProject(ws, { project_id: 'p', name: 'P' });
    await addComment(ws, { project_id: 'p', at_ms: 4200, text: 'Logo ketutup caption', author: REV });
    const c = await addComment(ws, { project_id: 'p', at_ms: 1000, text: '  Hook terlalu pelan  ', author: ED });
    expect(c).toMatchObject({ at_ms: 1000, text: 'Hook terlalu pelan', author: ED, revision: 0, resolved_at: null });
    expect(c.comment_id).toMatch(/^cm_[0-9a-f]{16}$/);
    const r = await readReview(ws, 'p');
    expect(r.comments.map((x) => x.at_ms)).toEqual([1000, 4200]);
    expect(r.state).toBe('belum');
    expect((await readProject(ws, 'p')).revision).toBe(0);
    for (const bad of [{ at_ms: -1, text: 'x' }, { at_ms: 'a', text: 'x' }, { at_ms: 0, text: ' ' }, { at_ms: 0, text: 'x'.repeat(1001) }]) expect(await code(() => addComment(ws, { project_id: 'p', ...bad, author: ED }))).toBe('EDIT_INVALID');
    expect((await resolveComment(ws, { project_id: 'p', comment_id: c.comment_id, resolved: true, author: REV })).resolved_by).toEqual(REV);
    expect((await resolveComment(ws, { project_id: 'p', comment_id: c.comment_id, resolved: false, author: REV })).resolved_at).toBeNull();
    expect(await code(() => resolveComment(ws, { project_id: 'p', comment_id: 'cm_0000000000000000', resolved: true, author: REV }))).toBe('NOT_FOUND');
  });

  it('Lulus is tied to the revision; open comments, empty project, stale revision and UJI variants are refused', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    await createProject(ws, { project_id: 'p', name: 'P' });
    expect(await code(() => decideReview(ws, { project_id: 'p', expected_revision: 0, status: 'lulus', note: '', author: REV }))).toBe('EDIT_INVALID'); // empty
    await svc.editTimeline({ project_id: 'p', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 1000 }] });
    const c = await addComment(ws, { project_id: 'p', at_ms: 500, text: 'ganti kata', author: REV });
    expect(await code(() => decideReview(ws, { project_id: 'p', expected_revision: 1, status: 'lulus', note: '', author: REV }))).toBe('EDIT_INVALID'); // open comment
    expect(await code(() => decideReview(ws, { project_id: 'p', expected_revision: 1, status: 'revisi', note: '', author: REV }))).toBe('EDIT_INVALID'); // revisi needs a note
    expect((await decideReview(ws, { project_id: 'p', expected_revision: 1, status: 'revisi', note: 'ganti kata di 0,5 dtk', author: REV })).state).toBe('revisi');
    await resolveComment(ws, { project_id: 'p', comment_id: c.comment_id, resolved: true, author: ED });
    expect(await code(() => decideReview(ws, { project_id: 'p', expected_revision: 0, status: 'lulus', note: '', author: REV }))).toBe('CONFLICT');
    expect((await decideReview(ws, { project_id: 'p', expected_revision: 1, status: 'lulus', note: '', author: REV })).state).toBe('lulus');
    await svc.editTimeline({ project_id: 'p', expected_revision: 1, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Lagi', start_ms: 1000, duration_ms: 1000 }] });
    expect((await readReview(ws, 'p')).state).toBe('berubah'); // edited after the pass
    // A Batch Remix test variant (music without an ad licence) can never pass.
    const v = await createWithTimeline(ws, { project_id: 'v', name: 'V', timeline: { tracks: [{ track_id: 't', kind: 'text', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 1000, text: 'x' }] }] }, actor: 'user', variant: { master_id: 'p', number: 1, label: 'UJI · varian-003', brief: {}, approved_revision: null, bukan_iklan: true } });
    expect(await code(() => decideReview(ws, { project_id: 'v', expected_revision: v.revision, status: 'lulus', note: '', author: REV }))).toBe('EDIT_INVALID');
  });
});
