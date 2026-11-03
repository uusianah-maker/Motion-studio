// Regression tests for Checkpoint B review findings (H1, M1, M2, M3, M5, L1, L3).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { commitProject, createLease, releaseLease } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { writeJournal } from '../src/storage/journal.js';
import { importMedia, loadRegistry, setProtection, verifyVersion } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { listJournal, runAutoTrash } from '../src/storage/trash.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { buildManifest, fixtureWorkspace, oldVersion } from './fixtures.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

describe('H1: references made while the index is invalid still reset the clock', () => {
  it('reviewer scenario: no early trash after a reference during a broken-index window', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const old = await oldVersion(ws, src, 'pA'); // clock starts day 0
    await fsp.mkdir(path.join(ws.root, 'PROJECTS', 'broken')); // index invalid
    clock.advance(5 * DAY_MS);
    let base = await readProject(ws, 'pA');
    await svc.commitProject({ manifest: buildManifest(base, { timeline: [old] }), expected_revision: base.revision, actor: 'user' });
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBeNull();
    clock.advance(20 * DAY_MS); // day 25
    base = await readProject(ws, 'pA');
    await svc.commitProject({ manifest: buildManifest(base, { timeline: [] }), expected_revision: base.revision, actor: 'user' });
    await fsp.rmdir(path.join(ws.root, 'PROJECTS', 'broken')); // index fixed
    clock.advance(6 * DAY_MS); // day 31: only 6 days since the last reference
    const r = await runAutoTrash(ws, { actor: 'scheduler' });
    expect(r.moved).toEqual([]);
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBe(clock.now());
  });
});

describe('M1: direct module APIs reset the clock at the mutation point', () => {
  it('lease and KEEP via module functions block trash on the old schedule', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src);
    const b = await oldVersion(ws, src);
    clock.advance(20 * DAY_MS);
    const lease = await createLease(ws, { job: 'render', label: 'r', media: [a], actor: 'user' });
    await setProtection(ws, { version_id: b.version_id, keep: true, actor: 'user' });
    const reg = await loadRegistry(ws);
    expect(reg.versions[a.version_id]!.unreferenced_since).toBeNull();
    expect(reg.versions[b.version_id]!.unreferenced_since).toBeNull();
    clock.advance(5 * DAY_MS);
    await releaseLease(ws, { lease_id: lease.lease_id, outcome: 'completed', actor: 'user' });
    await setProtection(ws, { version_id: b.version_id, keep: false, actor: 'user' });
    clock.advance(6 * DAY_MS); // day 31
    expect((await runAutoTrash(ws, { actor: 'scheduler' })).moved).toEqual([]);
  });
});

describe('M2: failure after the move rolls back and stops the run', () => {
  it('registry write failure → file returns to original path, registry unchanged, journal cleared', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src);
    const b = await oldVersion(ws, src);
    clock.advance(30 * DAY_MS);
    await new StorageService(ws).scan({ actor: 'user' }); // settle clocks so the run needs no registry write first
    const regPath = path.join(ws.root, '.motionstudio', 'registry.json');
    const before = await loadRegistry(ws);
    await fsp.chmod(regPath, 0o444); // rename over a read-only target fails → saveRegistry throws
    let r;
    try {
      r = await runAutoTrash(ws, { actor: 'user' });
    } finally {
      await fsp.chmod(regPath, 0o666);
    }
    expect(r.ok).toBe(false);
    expect(r.moved).toEqual([]);
    const after = await loadRegistry(ws);
    for (const m of [a, b]) {
      expect(after.versions[m.version_id]!.lifecycle).toBe('active');
      expect(await exists(path.join(ws.root, before.versions[m.version_id]!.rel_path))).toBe(true);
    }
    expect(await listJournal(ws)).toEqual([]);
    const aborted = await readAudit(ws, (e) => e.op === 'gc.auto_trash.item' && e.phase === 'aborted');
    expect(aborted).toHaveLength(1); // stopped after the first failure
    expect(aborted[0]).toMatchObject({ rolled_back: true });
  });
});

describe('M3: versions with an unfinished move cannot be referenced or leased', () => {
  it('journal-busy version is rejected by commit and createLease', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src, 'pB');
    await writeJournal(ws, { schema_version: 1, op_id: 'op_crashed', kind: 'trash', version_id: a.version_id, from_rel: 'x', to_rel: 'y', manifest_rel: 'z', content_hash: 'h', started_at: 0 });
    const base = await readProject(ws, 'pB');
    expect(await code(commitProject(ws, { manifest: buildManifest(base, { timeline: [a] }), expected_revision: base.revision, actor: 'user' }))).toBe('PRECONDITION');
    expect(await code(createLease(ws, { job: 'render', label: 'r', media: [a], actor: 'user' }))).toBe('PRECONDITION');
  });
});

describe('M5: duplicate detection respects lifecycle and scope', () => {
  it('bytes in Trash are reported; other-project input is not shared; shared media is reused', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const old = await oldVersion(ws, src);
    const bytes = await fsp.readFile(path.join(ws.root, (await loadRegistry(ws)).versions[old.version_id]!.rel_path));
    clock.advance(30 * DAY_MS);
    await runAutoTrash(ws, { actor: 'user' });
    const again = path.join(src, 'again.mp4');
    await fsp.writeFile(again, bytes);
    const e = await importMedia(ws, { sourcePath: again, scope: { kind: 'shared' }, actor: 'user' }).catch((x: unknown) => x);
    expect(isStorageError(e, 'CONFLICT')).toBe(true);
    expect(isStorageError(e) && e.details?.version_id).toBe(old.version_id);

    await createProject(ws, { project_id: 'q1', name: 'q1' });
    await createProject(ws, { project_id: 'q2', name: 'q2' });
    const f = path.join(src, 'same.mov');
    await fsp.writeFile(f, 'project-bytes');
    const in1 = await importMedia(ws, { sourcePath: f, scope: { kind: 'project', project_id: 'q1' }, actor: 'user' });
    const in2 = await importMedia(ws, { sourcePath: f, scope: { kind: 'project', project_id: 'q2' }, actor: 'user' });
    expect(in1.duplicate).toBe(false);
    expect(in2.duplicate).toBe(false);
    expect(in2.version.rel_path.startsWith('PROJECTS/q2/')).toBe(true);
    const sh = path.join(src, 'shared.mov');
    await fsp.writeFile(sh, 'shared-bytes');
    const s1 = await importMedia(ws, { sourcePath: sh, scope: { kind: 'shared' }, actor: 'user' });
    const p1 = await importMedia(ws, { sourcePath: sh, scope: { kind: 'project', project_id: 'q1' }, actor: 'user' });
    expect(p1.duplicate).toBe(true);
    expect(p1.version.version_id).toBe(s1.version.version_id);
  });
});

describe('L1/L3: verify safety and audited denials', () => {
  it('AI verify never writes the registry', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src);
    const regPath = path.join(ws.root, '.motionstudio', 'registry.json');
    const abs = path.join(ws.root, (await loadRegistry(ws)).versions[a.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'tamper');
    const before = await fsp.readFile(regPath, 'utf8');
    expect(await verifyVersion(ws, a.version_id, 'ai')).toMatchObject({ integrity: 'changed', recorded: false });
    expect(await fsp.readFile(regPath, 'utf8')).toBe(before);
    expect(await verifyVersion(ws, a.version_id, 'user')).toMatchObject({ integrity: 'changed', recorded: true });
  });

  it('every denied AI operation leaves an audit entry', async () => {
    const { ws, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src, 'pC');
    const f = path.join(src, 'ai.mp4');
    await fsp.writeFile(f, 'ai');
    const base = await readProject(ws, 'pC');
    await code(importMedia(ws, { sourcePath: f, scope: { kind: 'shared' }, actor: 'ai' }));
    await code(setProtection(ws, { version_id: a.version_id, keep: true, actor: 'ai' }));
    await code(commitProject(ws, { manifest: buildManifest(base, {}), expected_revision: base.revision, actor: 'ai' }));
    await code(createLease(ws, { job: 'ai', label: 'x', media: [], actor: 'ai' }));
    const denied = await readAudit(ws, (e) => e.actor === 'ai' && e.outcome === 'blocked');
    expect(denied.map((d) => d.op).sort()).toEqual(['denied.commit_project', 'denied.import', 'denied.manage_lease', 'denied.set_protection']);
  });
});
