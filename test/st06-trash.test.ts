import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS, type ManualClock } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { listJournal, readTrashManifest, runAutoTrash } from '../src/storage/trash.js';
import { commit, fixtureWorkspace, importShared, oldVersion } from './fixtures.js';

async function ageInto(clock: ManualClock, days = 30) {
  clock.advance(days * DAY_MS);
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

describe('ST-06 Auto Trash', () => {
  it('GC-03: eligible version moves to Trash with manifest, registry and audit all accurate', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const old = await oldVersion(ws, src);
    const reg0 = await loadRegistry(ws);
    const v0 = reg0.versions[old.version_id]!;
    const since = v0.unreferenced_since!;
    await ageInto(clock);

    const r = await new StorageService(ws).autoTrash({ actor: 'scheduler' });
    expect(r.ok).toBe(true);
    expect(r.moved).toHaveLength(1);
    const mv = r.moved[0]!;
    expect(mv.from).toBe(v0.rel_path);
    expect(mv.to).toMatch(new RegExp(`^\\.trash/${r.op_id}/${old.version_id}/`));
    expect(await exists(path.join(ws.root, mv.from))).toBe(false);
    expect(await exists(path.join(ws.root, mv.to))).toBe(true);

    const reg = await loadRegistry(ws);
    const v = reg.versions[old.version_id]!;
    expect(v).toMatchObject({ lifecycle: 'trashed', rel_path: mv.to, content_hash: v0.content_hash });
    expect(v.trash).toMatchObject({ op_id: r.op_id, original_rel_path: v0.rel_path, trashed_at: clock.now() });

    const m = await readTrashManifest(ws, mv.manifest);
    expect(m).toMatchObject({
      media_id: old.media_id,
      version_id: old.version_id,
      content_hash: v0.content_hash,
      size: v0.size,
      original_rel_path: v0.rel_path,
      trash_rel_path: mv.to,
      trashed_by: 'scheduler',
      unreferenced_since: since,
      eligible_since: since + 30 * DAY_MS,
    });
    expect(m.dependencies_checked.holders).toBe(0);

    const item = (await readAudit(ws, (e) => e.op === 'gc.auto_trash.item'))[0]!;
    expect(item).toMatchObject({ outcome: 'ok', version_id: old.version_id, old_path: v0.rel_path, new_path: mv.to, checksum: v0.content_hash, op_id: r.op_id });
    expect(await listJournal(ws)).toEqual([]);
  });

  it('GC-10: Trash on the same disk reports freed space = 0', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    await oldVersion(ws, src);
    await ageInto(clock);
    const r = await runAutoTrash(ws, { actor: 'user' });
    expect(r.moved[0]!.renamed).toBe(true);
    expect(r.moved_bytes).toBeGreaterThan(0);
    expect(r.freed_bytes).toBe(0);
  });

  it('never moves: never-used, waiting, current, referenced archived/undo, leased (GC-01/02/04/05)', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const neverUsed = await importShared(ws, src, 'never');
    const arch = await oldVersion(ws, src);
    await commit(ws, 'archived', { timeline: [arch], status: 'archived' });
    const undo = await oldVersion(ws, src);
    await commit(ws, 'undo', { undo: [undo] });
    const leased = await oldVersion(ws, src);
    await svc.createLease({ job: 'render', label: 'r', media: [leased], actor: 'user' });
    await ageInto(clock, 60);
    const waiting = await oldVersion(ws, src); // clock starts at day 60
    await ageInto(clock, 29);
    const r = await svc.autoTrash({ actor: 'scheduler' });
    expect(r.moved).toEqual([]);
    const reg = await loadRegistry(ws);
    for (const m of [neverUsed, arch, undo, leased, waiting]) expect(reg.versions[m.version_id]!.lifecycle).toBe('active');
    // Current versions are never touched either.
    for (const media of Object.values(reg.media)) expect(reg.versions[media.current_version_id]!.lifecycle).toBe('active');
  });

  it('GC-07: invalid dependency data → nothing moved, blocked + logged', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    await oldVersion(ws, src, 'pX');
    await ageInto(clock);
    await fsp.writeFile(path.join(ws.root, 'PROJECTS/pX/03_PROJECT/project.json'), '{');
    const r = await runAutoTrash(ws, { actor: 'scheduler' });
    expect(r.ok).toBe(false);
    expect(r.moved).toEqual([]);
    expect(await readAudit(ws, (e) => e.op === 'gc.auto_trash' && e.outcome === 'blocked')).toHaveLength(1);
  });

  it('GC-12: AI cannot trigger Auto Trash; the attempt is audited', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    await oldVersion(ws, src);
    await ageInto(clock);
    try {
      await runAutoTrash(ws, { actor: 'ai' });
      expect.unreachable();
    } catch (e) {
      expect(isStorageError(e, 'FORBIDDEN')).toBe(true);
    }
    expect(await readAudit(ws, (e) => e.op === 'gc.auto_trash' && e.actor === 'ai' && e.outcome === 'blocked')).toHaveLength(1);
    expect(Object.values((await loadRegistry(ws)).versions).every((v) => v.lifecycle === 'active')).toBe(true);
  });

  it('re-validates right before moving: changed bytes and hard links are skipped', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const changed = await oldVersion(ws, src);
    const linked = await oldVersion(ws, src);
    await ageInto(clock);
    const reg = await loadRegistry(ws);
    const cAbs = path.join(ws.root, reg.versions[changed.version_id]!.rel_path);
    await fsp.chmod(cAbs, 0o666);
    await fsp.writeFile(cAbs, 'swapped');
    const lAbs = path.join(ws.root, reg.versions[linked.version_id]!.rel_path);
    await fsp.link(lAbs, path.join(src, 'outside-hardlink.mp4'));
    const r = await runAutoTrash(ws, { actor: 'user' });
    expect(r.moved).toEqual([]);
    expect(r.skipped.map((s) => s.version_id).sort()).toEqual([changed.version_id, linked.version_id].sort());
    expect(r.skipped.find((s) => s.version_id === linked.version_id)!.reason).toMatch(/hard link/);
  });

  it('busy (live player/project) versions are not moved; rerun is idempotent', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src);
    const b = await oldVersion(ws, src);
    await ageInto(clock);
    const first = await runAutoTrash(ws, { actor: 'user', busy: new Set([a.version_id]) });
    expect(first.moved.map((m) => m.version_id)).toEqual([b.version_id]);
    const second = await runAutoTrash(ws, { actor: 'user', busy: new Set([a.version_id]) });
    expect(second.moved).toEqual([]);
    const third = await runAutoTrash(ws, { actor: 'user' });
    expect(third.moved.map((m) => m.version_id)).toEqual([a.version_id]);
    expect((await runAutoTrash(ws, { actor: 'user' })).moved).toEqual([]);
  });

  it('a trashed version cannot be committed into a project until restored', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const a = await oldVersion(ws, src, 'pZ');
    await ageInto(clock);
    await runAutoTrash(ws, { actor: 'user' });
    try {
      await commit(ws, 'pZ', { timeline: [a] });
      expect.unreachable();
    } catch (e) {
      expect(isStorageError(e, 'PRECONDITION')).toBe(true);
    }
  });
});
