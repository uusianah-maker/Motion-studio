import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  commitProject,
  createLease,
  holdersOf,
  isIndexFresh,
  loadLeases,
  rebuildAndSaveIndex,
  releaseLease,
  setLeaseStatus,
} from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry, verifyVersion } from '../src/storage/registry.js';
import { readProject } from '../src/storage/workspace.js';
import { buildManifest, commit, fixtureWorkspace, importShared } from './fixtures.js';
import { tempDir, tryLink } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('ST-03 reverse index', () => {
  it('collects holders across active, archived, retained snapshot/undo and job leases', async () => {
    const { ws, src } = await fixtureWorkspace();
    const [a, b, c, d, e, f, g] = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((l) => importShared(ws, src, l)));
    await commit(ws, 'active1', { timeline: [a!], retained: [b!], dropped: [f!] });
    await commit(ws, 'arch1', { timeline: [c!], undo: [d!], status: 'archived' });
    const lease = await createLease(ws, { job: 'render', label: 'final', media: [e!], actor: 'user' });

    const r = await buildIndex(ws);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const idx = r.index;
    expect(holdersOf(idx, a!.version_id)).toEqual([{ kind: 'project', project_id: 'active1', status: 'active', source: 'timeline', detail: 'video/c0' }]);
    expect(holdersOf(idx, b!.version_id)[0]).toMatchObject({ source: 'snapshot', project_id: 'active1' });
    expect(holdersOf(idx, c!.version_id)[0]).toMatchObject({ status: 'archived', source: 'timeline' });
    expect(holdersOf(idx, d!.version_id)[0]).toMatchObject({ status: 'archived', source: 'undo' });
    expect(holdersOf(idx, e!.version_id)).toEqual([{ kind: 'lease', lease_id: lease.lease_id, job: 'render', status: 'queued' }]);
    expect(holdersOf(idx, f!.version_id)).toEqual([]); // non-retained snapshot does not hold
    expect(holdersOf(idx, g!.version_id)).toEqual([]); // never used
    expect(idx.projects).toEqual({ active1: { status: 'active', revision: 1 }, arch1: { status: 'archived', revision: 1 } });

    // ever_referenced only for project-bound versions (not leases, not dropped snapshots)
    const reg = await loadRegistry(ws);
    const ever = (id: string) => reg.versions[id]!.ever_referenced;
    expect([a, b, c, d].every((m) => ever(m!.version_id))).toBe(true);
    expect(ever(e!.version_id)).toBe(false);
    expect(ever(f!.version_id)).toBe(false);
    expect(ever(g!.version_id)).toBe(false);
  });

  it('rebuild from manifests is deterministic and independent of deps.json', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await importShared(ws, src);
    await commit(ws, 'p1', { timeline: [a, a] });
    const first = await rebuildAndSaveIndex(ws);
    await fsp.rm(path.join(ws.root, '.motionstudio', 'deps.json'));
    const second = await buildIndex(ws);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.index.by_version).toEqual(first.index.by_version);
      expect(second.index.fingerprint).toBe(first.index.fingerprint);
      expect(holdersOf(second.index, a.version_id)).toHaveLength(2);
      expect(await isIndexFresh(ws, second.index)).toBe(true);
      await commit(ws, 'p1', { timeline: [] });
      expect(await isIndexFresh(ws, second.index)).toBe(false);
    }
  });

  it('fails closed: corrupt manifest, dangling ref, folder without manifest, junction, bad leases', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await importShared(ws, src);
    const m = await commit(ws, 'p1', { timeline: [a] });
    const mf = path.join(ws.root, 'PROJECTS/p1/03_PROJECT/project.json');
    expect((await buildIndex(ws)).ok).toBe(true);

    await fsp.writeFile(mf, '{broken');
    let r = await buildIndex(ws);
    expect(r.ok).toBe(false);
    await fsp.writeFile(mf, JSON.stringify(buildManifest(m, { timeline: [{ media_id: a.media_id, version_id: 'v_doesnotexist0000' }] })));
    r = await buildIndex(ws);
    expect(r.ok === false && r.errors[0]).toMatch(/tidak ada di registry/);
    await fsp.writeFile(mf, JSON.stringify(buildManifest(m, { timeline: [{ media_id: 'm_other', version_id: a.version_id }] })));
    r = await buildIndex(ws);
    expect(r.ok === false && r.errors[0]).toMatch(/bukan milik media/);
    await fsp.writeFile(mf, JSON.stringify(m));
    expect((await buildIndex(ws)).ok).toBe(true);

    await fsp.mkdir(path.join(ws.root, 'PROJECTS', 'empty'));
    expect((await buildIndex(ws)).ok).toBe(false);
    await fsp.rm(path.join(ws.root, 'PROJECTS', 'empty'), { recursive: true });

    expect(await tryLink(await tempDir(), path.join(ws.root, 'PROJECTS', 'linked'), 'junction')).toBe(true);
    expect((await buildIndex(ws)).ok).toBe(false);
    await fsp.rm(path.join(ws.root, 'PROJECTS', 'linked'));

    await fsp.writeFile(path.join(ws.root, '.motionstudio', 'leases.json'), '{"schema_version":1,"leases":[{"lease_id":"x"}]}');
    expect((await buildIndex(ws)).ok).toBe(false);

    const saved = await rebuildAndSaveIndex(ws);
    expect(saved.ok).toBe(false);
    expect(JSON.parse(await fsp.readFile(path.join(ws.root, '.motionstudio', 'deps.json'), 'utf8')).status).toBe('invalid');
  });
});

describe('ST-03 commits & leases', () => {
  it('optimistic concurrency, unknown/changed refs rejected, AI cannot commit', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await importShared(ws, src);
    const m1 = await commit(ws, 'p1', { timeline: [a] });
    expect(m1.revision).toBe(1);
    expect(await code(commitProject(ws, { manifest: buildManifest(m1, {}), expected_revision: 0, actor: 'user' }))).toBe('CONFLICT');
    expect(await code(commitProject(ws, { manifest: buildManifest(m1, { timeline: [{ media_id: 'm_x', version_id: 'v_x' }] }), expected_revision: 1, actor: 'user' }))).toBe('PRECONDITION');
    expect(await code(commitProject(ws, { manifest: buildManifest(m1, {}), expected_revision: 1, actor: 'ai' }))).toBe('FORBIDDEN');
    expect((await readProject(ws, 'p1')).revision).toBe(1);

    // GC-11 follow-up: a CHANGED version cannot be bound into a new revision.
    const b = await importShared(ws, src);
    const reg = await loadRegistry(ws);
    const abs = path.join(ws.root, reg.versions[b.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'tampered');
    await verifyVersion(ws, b.version_id);
    expect(await code(commitProject(ws, { manifest: buildManifest(m1, { timeline: [b] }), expected_revision: 1, actor: 'user' }))).toBe('INTEGRITY');
  });

  it('lease lifecycle pins exact hashes and stops holding on release', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await importShared(ws, src);
    const lease = await createLease(ws, { job: 'ai', label: 'plan', media: [a], actor: 'scheduler' });
    const reg = await loadRegistry(ws);
    expect(lease.media[0]!.content_hash).toBe(reg.versions[a.version_id]!.content_hash);
    expect((await setLeaseStatus(ws, { lease_id: lease.lease_id, status: 'running', actor: 'user' })).status).toBe('running');
    let r = await buildIndex(ws);
    expect(r.ok && holdersOf(r.index, a.version_id)[0]).toMatchObject({ kind: 'lease', status: 'running' });
    await releaseLease(ws, { lease_id: lease.lease_id, outcome: 'completed', actor: 'user' });
    r = await buildIndex(ws);
    expect(r.ok && holdersOf(r.index, a.version_id)).toEqual([]);
    expect((await loadLeases(ws)).leases).toEqual([]);
    expect(await code(createLease(ws, { job: 'ai', label: 'x', media: [a], actor: 'ai' }))).toBe('FORBIDDEN');
    expect(await code(releaseLease(ws, { lease_id: 'lease_none', outcome: 'failed', actor: 'user' }))).toBe('NOT_FOUND');
  });
});
