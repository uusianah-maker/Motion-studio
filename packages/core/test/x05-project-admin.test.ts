import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry, saveRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, listProjectIds, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const ref = await importShared(fx.ws, fx.src, 'vid');
  await createProject(fx.ws, { project_id: 'promo', name: 'Promo Lebaran' });
  await svc.editTimeline({
    project_id: 'promo',
    expected_revision: 0,
    actor: 'user',
    ops: [
      { op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 3000 },
      { op: 'add_clip', track_kind: 'text', text: 'Diskon', style: { color: '#ff0000' }, start_ms: 0, duration_ms: 1000 },
    ],
  });
  return { ...fx, svc, ref };
}

describe('X05 project management', () => {
  it('rename + archive keep history; archived is read-only until activated', async () => {
    const { ws, svc } = await setup();
    const r = await svc.updateProjectMeta({ project_id: 'promo', expected_revision: 1, name: '  Promo Ramadan\n', actor: 'user' });
    expect(r.result).toMatchObject({ name: 'Promo Ramadan', revision: 2, status: 'active' });
    expect((await readProject(ws, 'promo')).snapshots.some((s) => s.kind === 'undo')).toBe(true); // undo history kept
    await svc.updateProjectMeta({ project_id: 'promo', expected_revision: 2, status: 'archived', actor: 'user' });
    expect(await code(() => svc.editTimeline({ project_id: 'promo', expected_revision: 3, actor: 'user', ops: [{ op: 'set_canvas', ratio: '1:1' }] }))).toBe('PRECONDITION');
    expect(await code(() => svc.undoTimeline({ project_id: 'promo', expected_revision: 3, actor: 'user' }))).toBe('PRECONDITION');
    await svc.updateProjectMeta({ project_id: 'promo', expected_revision: 3, status: 'active', actor: 'user' });
    expect(await code(() => svc.editTimeline({ project_id: 'promo', expected_revision: 4, actor: 'user', ops: [{ op: 'set_canvas', ratio: '1:1' }] }))).toBe('OK');
    // Refusals: stale revision, empty/long name, bad status, nothing to change.
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 1, name: 'X', actor: 'user' }))).toBe('CONFLICT');
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 5, name: '   ', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 5, name: 'x'.repeat(121), actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 5, status: 'deleted', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 5, actor: 'user' }))).toBe('EDIT_INVALID');
  });

  it('archived projects still protect their media (references unchanged)', async () => {
    const { ws, svc, ref } = await setup();
    await svc.updateProjectMeta({ project_id: 'promo', expected_revision: 1, status: 'archived', actor: 'user' });
    const v = (await loadRegistry(ws)).versions[ref.version_id]!;
    expect(v.ever_referenced).toBe(true);
    expect(v.unreferenced_since).toBeNull();
  });

  it('duplicate: new id, "(salinan)" name, same timeline, empty history, independent edits', async () => {
    const { ws, svc } = await setup();
    const d = (await svc.duplicateProject({ project_id: 'promo', actor: 'user' })).result;
    expect(d.project_id).toMatch(/^p-[0-9a-f]{12}$/);
    expect(d).toMatchObject({ name: 'Promo Lebaran (salinan)', revision: 1, status: 'active', snapshots: [] });
    const src = await readProject(ws, 'promo');
    expect(d.timeline).toEqual(src.timeline);
    await svc.editTimeline({ project_id: d.project_id, expected_revision: 1, actor: 'user', ops: [{ op: 'set_canvas', ratio: '16:9' }] });
    expect((await readProject(ws, 'promo')).timeline.canvas).toBeUndefined();
    const named = (await svc.duplicateProject({ project_id: 'promo', name: 'Versi B', actor: 'user' })).result;
    expect(named.name).toBe('Versi B');
    expect(await code(() => svc.duplicateProject({ project_id: 'nope', actor: 'user' }))).toBe('NOT_FOUND');
  });

  it('export → import round trip: no paths or history in the file; same workspace keeps ids', async () => {
    const { ws, svc, ref } = await setup();
    const exp = await svc.exportProject('promo');
    const json = JSON.stringify(exp);
    expect(exp).toMatchObject({ format: 'motion-studio-project', format_version: 1, project: { name: 'Promo Lebaran' } });
    expect(exp.media).toEqual([{ media_id: ref.media_id, version_id: ref.version_id, content_hash: expect.stringMatching(/^sha256:/), display_name: expect.any(String), duration_ms: null }]);
    expect(json).not.toMatch(/snapshots|rel_path|[A-Za-z]:\\\\|\/tmp\//);
    const imp = (await svc.importProject({ data: JSON.parse(json), actor: 'user' })).result;
    expect(imp.remapped).toBe(0);
    expect(imp.project.timeline).toEqual((await readProject(ws, 'promo')).timeline);
    expect(imp.project.name).toBe('Promo Lebaran');
  });

  it('import on another workspace: media matched by content hash, else refused with the missing names — nothing left behind', async () => {
    const a = await setup();
    const exp = await a.svc.exportProject('promo');
    // Workspace B has the same file bytes (re-imported → new ids), plus nothing else.
    const b = await setup();
    const regA = await loadRegistry(a.ws);
    const regB = await loadRegistry(b.ws);
    const vB = regB.versions[b.ref.version_id]!;
    vB.content_hash = regA.versions[a.ref.version_id]!.content_hash; // simulate identical bytes
    await saveRegistry(b.ws, regB);
    const before = await listProjectIds(b.ws);
    const r = (await b.svc.importProject({ data: exp, name: 'Dari PC lain', actor: 'user' })).result;
    expect(r.remapped).toBe(1);
    expect(r.project.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.media).toEqual(b.ref);
    expect(await listProjectIds(b.ws)).toHaveLength(before.length + 1);

    // A workspace without the file: refused, message names the file, no project created.
    const c = await setup();
    const cBefore = await listProjectIds(c.ws);
    let msg = '';
    try {
      await c.svc.importProject({ data: exp, actor: 'user' });
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toMatch(/Media belum ada di workspace ini: .+\. Impor file videonya dulu/);
    expect(await listProjectIds(c.ws)).toEqual(cBefore);

    // Media present but in Trash: the commit refuses and the half-made project folder is removed.
    const regA2 = await loadRegistry(a.ws);
    regA2.versions[a.ref.version_id]!.lifecycle = 'trashed';
    await saveRegistry(a.ws, regA2);
    const aBefore = await listProjectIds(a.ws);
    expect(await code(() => a.svc.importProject({ data: exp, actor: 'user' }))).toBe('PRECONDITION');
    expect(await code(() => a.svc.duplicateProject({ project_id: 'promo', actor: 'user' }))).toBe('PRECONDITION');
    expect(await listProjectIds(a.ws)).toEqual(aBefore);
  });

  it('import refuses junk: wrong format/version, invalid timeline, oversize name', async () => {
    const { svc } = await setup();
    const good = await svc.exportProject('promo');
    const bad = [
      null,
      'x',
      { ...good, format: 'capcut' },
      { ...good, format_version: 2 },
      { ...good, project: { name: 'X', timeline: { tracks: [{ track_id: 't', kind: 'text', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 10, text: 'a', style: { color: 'merah' } }] }] } } },
      { ...good, project: { name: 'X', timeline: '../../etc' } },
      { ...good, project: { name: 'x'.repeat(200), timeline: good.project.timeline } },
    ];
    for (const d of bad) expect(await code(() => svc.importProject({ data: d, actor: 'user' })), JSON.stringify(d)?.slice(0, 60)).toBe('EDIT_INVALID');
  });
});
