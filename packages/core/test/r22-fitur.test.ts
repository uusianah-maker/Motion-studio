// R22: a project remembers which feature made it (`fitur` in project.json) so each feature page's
// "Proyek" list shows only its own. Old projects are guessed when read, never rewritten.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineRel } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { guessFitur, resolveFitur } from '../src/storage/fitur.js';
import { markEngineOrigin } from '../src/storage/learning.js';
import { StorageService } from '../src/storage/service.js';
import { type Workspace, createProject, manifestRel, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const refused = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (isStorageError(e) ? e.code : `RAW:${String(e)}`));
const fakeJob = async (ws: Workspace, projectId: string, jobId: string, mode: string) => {
  const dir = path.join(ws.root, ...engineRel(projectId, jobId).split('/'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'status.json'), JSON.stringify({ schema: 'engine-status/1', job_id: jobId, project_id: projectId, mode, state: 'selesai' }));
};

describe('R22 project feature', () => {
  it('createProject stores the feature; an unknown one is refused; no feature = field absent', async () => {
    const { ws } = await fixtureWorkspace();
    expect((await createProject(ws, { project_id: 'bs', name: 'Sore', fitur: 'beatspot' })).fitur).toBe('beatspot');
    expect((await readProject(ws, 'bs')).fitur).toBe('beatspot');
    expect(await refused(createProject(ws, { project_id: 'x', name: 'X', fitur: 'tiktok' as never }))).toBe('EDIT_INVALID');
    expect('fitur' in (await createProject(ws, { project_id: 'lama', name: 'Lama' }))).toBe(false);
    // A hand-edited bad value makes the manifest invalid (not silently another feature).
    const file = path.join(ws.root, ...manifestRel('lama').split('/'));
    await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(await fsp.readFile(file, 'utf8')), fitur: 'aneh' }));
    expect(await refused(readProject(ws, 'lama'))).toBe('PROJECT_INVALID');
  });

  it('guess for old projects: name pattern, then newest engine job mode, then engine origin, else editor', () => {
    expect(guessFitur({ name: 'Batch Sore · 15 Nov 14.02' })).toBe('batch');
    expect(guessFitur({ name: 'Footage Sore' })).toBe('batch');
    expect(guessFitur({ name: 'Beat Spot Aysilla 15 Nov' })).toBe('beatspot');
    expect(guessFitur({ name: 'Motion Transfer Gamis 15 Nov' })).toBe('transfer');
    expect(guessFitur({ name: 'Generate Gamis 15 Nov' })).toBe('iklan');
    expect(guessFitur({ name: 'Promo Lebaran' })).toBe('editor');
    expect(guessFitur({ name: 'Promo', fitur: 'transfer' }, { master: 'batch' })).toBe('transfer');
    expect(guessFitur({ name: 'Beat Spot x' }, { master: 'iklan' })).toBe('iklan');
    expect(guessFitur({ name: 'Promo' }, { modes: ['ulang', 'beatspot', 'generate'] })).toBe('beatspot');
    expect(guessFitur({ name: 'Promo' }, { modes: ['ulang'], origin: 'generate' })).toBe('iklan');
    expect(guessFitur({ name: 'Promo' }, { origin: 'batch' })).toBe('batch');
  });

  it('resolveFitur reads engine jobs and origin marks, variants follow their master, files untouched', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    await createProject(ws, { project_id: 'a', name: 'Promo A' });
    await fakeJob(ws, 'a', 'AYS-20261114-001', 'generate');
    await fakeJob(ws, 'a', 'AYS-20261115-002', 'transfer');
    await createProject(ws, { project_id: 'b', name: 'Promo B' });
    await markEngineOrigin(ws, 'b', { kind: 'generate' });
    await createProject(ws, { project_id: 'c', name: 'Promo C' });
    await createProject(ws, { project_id: 'm', name: 'Batch Sore' });
    await svc.editTimeline({ project_id: 'm', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 1000 }] });
    const v = (await svc.createVariants({ master_id: 'm', briefs: [{ label: 'V1', hook: 'Hook B' }], actor: 'user' })).result[0]!;
    const before = await fsp.readFile(path.join(ws.root, ...manifestRel('a').split('/')), 'utf8');
    const list = await Promise.all(['a', 'b', 'c', 'm', v.project_id].map((id) => readProject(ws, id)));
    const f = await resolveFitur(ws, [...list].reverse());
    expect(Object.fromEntries(f)).toEqual({ a: 'transfer', b: 'iklan', c: 'editor', m: 'batch', [v.project_id]: 'batch' });
    expect(await fsp.readFile(path.join(ws.root, ...manifestRel('a').split('/')), 'utf8')).toBe(before);
  });

  it('variants, duplicates keep the stored feature; updateProjectMeta can set it by hand (hybrid)', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    await createProject(ws, { project_id: 'm', name: 'Master', fitur: 'iklan' });
    await svc.editTimeline({ project_id: 'm', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 1000 }] });
    const v = (await svc.createVariants({ master_id: 'm', briefs: [{ label: 'V1', hook: 'Hook B' }], actor: 'user' })).result[0]!;
    expect(v.fitur).toBe('iklan');
    expect((await svc.duplicateProject({ project_id: 'm', actor: 'user' })).result.fitur).toBe('iklan');
    await createProject(ws, { project_id: 'lama', name: 'Promo' });
    const r = await svc.updateProjectMeta({ project_id: 'lama', expected_revision: 0, fitur: 'beatspot', actor: 'user' });
    expect(r.result.fitur).toBe('beatspot');
    expect(await refused(svc.updateProjectMeta({ project_id: 'lama', expected_revision: r.result.revision, fitur: 'x', actor: 'user' }))).toBe('EDIT_INVALID');
  });
});
