import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { buildIndex, holdersOf } from '../src/storage/deps.js';
import { evaluateVersion } from '../src/storage/eligibility.js';
import { isStorageError } from '../src/storage/errors.js';
import { type ProjectManifest, validateProjectManifest } from '../src/storage/project.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { MIN_CLIP_MS, UNDO_LIMIT, type Timeline, applyOps, editManifest, historyCounts, stepHistory, validateOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const acode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

const M = { media_id: 'm_1', version_id: 'v_1' };
let n = 0;
const ids = () => `c_${++n}`;
const empty: Timeline = { tracks: [] };
const clipsOf = (t: Timeline, kind = 'video') => t.tracks.find((x) => x.kind === kind)?.clips ?? [];

describe('W06 timeline reducer', () => {
  it('add creates the track, clips get an in-point; move keeps length', () => {
    const t1 = applyOps(empty, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 5000 }], ids);
    const c = clipsOf(t1)[0]!;
    expect(c).toMatchObject({ start_ms: 0, end_ms: 5000, in_ms: 0, media: M });
    const t2 = applyOps(t1, [{ op: 'move_clip', clip_id: c.clip_id, start_ms: 2000 }], ids);
    expect(clipsOf(t2)[0]).toMatchObject({ start_ms: 2000, end_ms: 7000, in_ms: 0 });
    expect(clipsOf(t1)[0]!.start_ms).toBe(0); // input never mutated
  });

  it('trim start moves the source in-point; trim end only the end; cannot extend before source start', () => {
    const t1 = applyOps(empty, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 1000, duration_ms: 5000 }], ids);
    const id = clipsOf(t1)[0]!.clip_id;
    const t2 = applyOps(t1, [{ op: 'trim_clip', clip_id: id, edge: 'start', to_ms: 2500 }], ids);
    expect(clipsOf(t2)[0]).toMatchObject({ start_ms: 2500, end_ms: 6000, in_ms: 1500 });
    const t3 = applyOps(t2, [{ op: 'trim_clip', clip_id: id, edge: 'end', to_ms: 4000 }], ids);
    expect(clipsOf(t3)[0]).toMatchObject({ start_ms: 2500, end_ms: 4000, in_ms: 1500 });
    const t4 = applyOps(t3, [{ op: 'trim_clip', clip_id: id, edge: 'start', to_ms: 1000 }], ids);
    expect(clipsOf(t4)[0]).toMatchObject({ start_ms: 1000, in_ms: 0 }); // back to the source start is fine
    expect(code(() => applyOps(t4, [{ op: 'trim_clip', clip_id: id, edge: 'start', to_ms: 500 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t4, [{ op: 'trim_clip', clip_id: id, edge: 'end', to_ms: 1000 }], ids))).toBe('EDIT_INVALID');
  });

  it('split makes two clips whose right half continues the source', () => {
    const t1 = applyOps(empty, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 6000, in_ms: 500 }], ids);
    const id = clipsOf(t1)[0]!.clip_id;
    const t2 = applyOps(t1, [{ op: 'split_clip', clip_id: id, at_ms: 2000 }], ids);
    const [a, b] = clipsOf(t2);
    expect(a).toMatchObject({ clip_id: id, start_ms: 0, end_ms: 2000, in_ms: 500 });
    expect(b).toMatchObject({ start_ms: 2000, end_ms: 6000, in_ms: 2500, media: M });
    expect(b!.clip_id).not.toBe(id);
    expect(code(() => applyOps(t2, [{ op: 'split_clip', clip_id: id, at_ms: 2000 }], ids))).toBe('EDIT_INVALID'); // edge, not inside
  });

  it('rules: no overlap, minimum length, media only on media tracks, unknown clip; all-or-nothing', () => {
    const t1 = applyOps(empty, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 3000 }], ids);
    const id = clipsOf(t1)[0]!.clip_id;
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 2000, duration_ms: 3000 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 5000, duration_ms: MIN_CLIP_MS - 1 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'text', media: M, start_ms: 0, duration_ms: 1000 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t1, [{ op: 'move_clip', clip_id: 'c_none', start_ms: 0 }], ids))).toBe('EDIT_INVALID');
    // Second op invalid → first op must not leak.
    expect(code(() => applyOps(t1, [{ op: 'move_clip', clip_id: id, start_ms: 9000 }, { op: 'delete_clip', clip_id: 'c_none' }], ids))).toBe('EDIT_INVALID');
    expect(clipsOf(t1)[0]!.start_ms).toBe(0);
    // Same clip on another track is fine; text clips have no media.
    const t2 = applyOps(t1, [{ op: 'add_clip', track_kind: 'audio', media: M, start_ms: 1000, duration_ms: 3000 }, { op: 'add_clip', track_kind: 'text', text: 'Hook', start_ms: 0, duration_ms: 1000 }], ids);
    expect(t2.tracks.map((t) => t.kind)).toEqual(['video', 'text', 'audio']);
  });

  it('untrusted ops are shape-checked', () => {
    expect(validateOps([{ op: 'move_clip', clip_id: 'c_1', start_ms: 12.4 }])).toEqual([{ op: 'move_clip', clip_id: 'c_1', start_ms: 12 }]);
    for (const bad of [[], 'x', [{ op: 'explode' }], [{ op: 'move_clip', clip_id: '../x', start_ms: 1 }], [{ op: 'move_clip', clip_id: 'c_1', start_ms: -5 }], [{ op: 'move_clip', clip_id: 'c_1', start_ms: 1, extra: 1 }], [{ op: 'trim_clip', clip_id: 'c_1', edge: 'middle', to_ms: 1 }], [{ op: 'add_clip', track_kind: 'video', media: { media_id: 'm', version_id: 'v', x: 1 }, start_ms: 0, duration_ms: 1 }], Array.from({ length: 101 }, () => ({ op: 'delete_clip', clip_id: 'c_1' }))]) {
      expect(code(() => validateOps(bad)), JSON.stringify(bad).slice(0, 60)).toBe('EDIT_INVALID');
    }
  });
});

describe('W06 undo/redo history', () => {
  const base = (): ProjectManifest => ({ schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 0, created_at: 0, updated_at: 0, timeline: { tracks: [] }, snapshots: [] });
  const ctx = () => ({ now: 1, newId: () => `snap_${++n}`, newClipId: ids });

  it('edit → undo → redo; a new edit clears redo; stored entries are valid manifests holding their media', () => {
    const m1 = editManifest(base(), [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 4000 }], 'Tambah klip', ctx());
    const id = clipsOf(m1.timeline)[0]!.clip_id;
    const m2 = editManifest(m1, [{ op: 'move_clip', clip_id: id, start_ms: 1000 }], 'Geser klip', ctx());
    expect(historyCounts(m2)).toMatchObject({ undo: 2, redo: 0, undo_label: 'Geser klip' });
    const u1 = stepHistory(m2, 'undo', ctx());
    expect(clipsOf(u1.timeline)[0]!.start_ms).toBe(0);
    expect(historyCounts(u1)).toMatchObject({ undo: 1, redo: 1, redo_label: 'Geser klip' });
    const r1 = stepHistory(u1, 'redo', ctx());
    expect(clipsOf(r1.timeline)[0]!.start_ms).toBe(1000);
    const u2 = stepHistory(stepHistory(r1, 'undo', ctx()), 'undo', ctx());
    expect(u2.timeline.tracks).toEqual([]); // back to the empty project
    expect(code(() => stepHistory(u2, 'undo', ctx()))).toBe('EDIT_INVALID');
    const fresh = editManifest(u2, [{ op: 'add_clip', track_kind: 'audio', media: M, start_ms: 0, duration_ms: 1000 }], 'x', ctx());
    expect(historyCounts(fresh).redo).toBe(0);
    for (const m of [m1, m2, u1, r1, u2, fresh]) expect(() => validateProjectManifest(m)).not.toThrow();
    expect(u1.snapshots.find((s) => s.kind === 'redo')!.media).toEqual([M]);
  });

  it(`keeps at most ${UNDO_LIMIT} undo steps`, () => {
    let m = editManifest(base(), [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 1000 }], 'a', ctx());
    const id = clipsOf(m.timeline)[0]!.clip_id;
    for (let i = 1; i <= UNDO_LIMIT + 10; i++) m = editManifest(m, [{ op: 'move_clip', clip_id: id, start_ms: i * 10 }], `m${i}`, ctx());
    expect(historyCounts(m).undo).toBe(UNDO_LIMIT);
  });

  it('a stored undo timeline must list its media (the GC relies on it)', () => {
    const m = editManifest(base(), [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 1000 }], 'a', ctx());
    const id = clipsOf(m.timeline)[0]!.clip_id;
    const m2 = editManifest(m, [{ op: 'delete_clip', clip_id: id }], 'del', ctx());
    const tampered = structuredClone(m2);
    tampered.snapshots.at(-1)!.media = [];
    expect(code(() => validateProjectManifest(tampered))).toBe('PROJECT_INVALID');
  });
});

describe('W06 service: edits commit server-side', () => {
  it('edit/undo/redo bump the revision, mark media referenced, reject stale revisions and AI', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    const ref = await importShared(fx.ws, fx.src);
    const r1 = await svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 5000 }], actor: 'user' });
    expect(r1.result.revision).toBe(1);
    expect((await loadRegistry(fx.ws)).versions[ref.version_id]!.ever_referenced).toBe(true);
    expect(await acode(svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'delete_clip', clip_id: 'c_x' }], actor: 'user' }))).toBe('CONFLICT');
    expect(await acode(svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: 'm_nope', version_id: 'v_nope' }, start_ms: 9000, duration_ms: 1000 }], actor: 'user' }))).not.toBe('OK');
    expect(await acode(svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: 'c_x' }], actor: 'ai' }))).toBe('FORBIDDEN');
    expect((await readAudit(fx.ws, (e) => e.op === 'denied.commit_project')).length).toBe(1);
    const clip = (await readProject(fx.ws, 'p')).timeline.tracks[0]!.clips[0]!;
    const r2 = await svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: clip.clip_id }], actor: 'user' });
    expect(r2.result.timeline.tracks[0]!.clips).toEqual([]);
    const u = await svc.undoTimeline({ project_id: 'p', expected_revision: 2, actor: 'user' });
    expect(u.result.timeline.tracks[0]!.clips).toHaveLength(1);
    const r = await svc.redoTimeline({ project_id: 'p', expected_revision: 3, actor: 'user' });
    expect(r.result.timeline.tracks[0]!.clips).toEqual([]);
    expect(r.result.revision).toBe(4);
  });

  it('a clip removed from the timeline is still held by its undo step: never eligible for Auto Trash', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    const ref = await importShared(fx.ws, fx.src);
    await svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 5000 }], actor: 'user' });
    const clip = (await readProject(fx.ws, 'p')).timeline.tracks[0]!.clips[0]!;
    await svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: clip.clip_id }], actor: 'user' });
    fx.clock.advance(60 * DAY_MS);
    const idx = await buildIndex(fx.ws);
    expect(idx.ok).toBe(true);
    if (!idx.ok) return;
    expect(holdersOf(idx.index, ref.version_id).map((h) => (h.kind === 'project' ? h.source : h.kind))).toContain('undo');
    const reg = await loadRegistry(fx.ws);
    const v = reg.versions[ref.version_id]!;
    expect(evaluateVersion(v, reg.media[v.media_id]!, { now: fx.clock.now(), index: idx.index }).eligible).toBe(false);
  });
});

describe('PC-10 (A): damaged media in undo history never locks the project', () => {
  it('editing continues; undoing back to the damaged step is refused with a clear error', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    const a = await importShared(fx.ws, fx.src, 'a');
    const b = await importShared(fx.ws, fx.src, 'b');
    await svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: a, start_ms: 0, duration_ms: 2000 }], actor: 'user' });
    const clip = (await readProject(fx.ws, 'p')).timeline.tracks[0]!.clips[0]!;
    await svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: clip.clip_id }], actor: 'user' });
    // The bytes of `a` change outside the app (GC-11): registry marks it CHANGED.
    const reg = await loadRegistry(fx.ws);
    reg.versions[a.version_id]!.integrity = 'changed';
    const { saveRegistry } = await import('../src/storage/registry.js');
    await saveRegistry(fx.ws, reg);
    const r = await svc.editTimeline({ project_id: 'p', expected_revision: 2, ops: [{ op: 'add_clip', track_kind: 'video', media: b, start_ms: 0, duration_ms: 2000 }], actor: 'user' });
    expect(r.result.revision).toBe(3); // not locked
    await svc.undoTimeline({ project_id: 'p', expected_revision: 3, actor: 'user' }); // back to the empty timeline: fine
    expect(await acode(svc.undoTimeline({ project_id: 'p', expected_revision: 4, actor: 'user' }))).toBe('INTEGRITY'); // would bring `a` back
    // `a` is still held by the history: never an Auto Trash candidate.
    const idx = await buildIndex(fx.ws);
    expect(idx.ok && holdersOf(idx.index, a.version_id).length).toBeGreaterThan(0);
  });
});
