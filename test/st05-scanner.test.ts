import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import type { MediaRef } from '../src/storage/project.js';
import { addVersion, loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { scanCandidates } from '../src/storage/scanner.js';
import type { Workspace } from '../src/storage/workspace.js';
import { commit, fixtureWorkspace, importShared } from './fixtures.js';
import { listTree } from './helpers.js';

async function oldAndCurrent(ws: Workspace, src: string, label: string): Promise<{ old: MediaRef; cur: MediaRef }> {
  const old = await importShared(ws, src, label);
  const p = path.join(src, `${label}-v2-${Math.random()}.mp4`);
  await fsp.writeFile(p, `${label}-v2-${Math.random()}`);
  const v2 = await addVersion(ws, { media_id: old.media_id, sourcePath: p, actor: 'user' });
  return { old, cur: { media_id: old.media_id, version_id: v2.version.version_id } };
}

async function snapshotTree(ws: Workspace): Promise<string> {
  const files = (await listTree(ws.root)).filter((f) => !f.endsWith('/') && !f.startsWith('.motionstudio/'));
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(await fsp.readFile(path.join(ws.root, f)));
  return `${files.length}:${h.digest('hex')}`;
}

/**
 * Fixture covering every category. Expected candidates: exactly `eligibleA` and `eligibleB`.
 */
async function bigFixture() {
  const fx = await fixtureWorkspace();
  const { ws, clock, src } = fx;
  const eligibleA = await oldAndCurrent(ws, src, 'eligA');
  const eligibleB = await oldAndCurrent(ws, src, 'eligB');
  const neverUsed = await oldAndCurrent(ws, src, 'never'); // old never referenced
  const waiting = await oldAndCurrent(ws, src, 'wait');
  const kept = await oldAndCurrent(ws, src, 'keep');
  const archived = await oldAndCurrent(ws, src, 'arch');
  const undo = await oldAndCurrent(ws, src, 'undo');
  const leased = await oldAndCurrent(ws, src, 'lease');
  const tampered = await oldAndCurrent(ws, src, 'tamper');

  const used = [eligibleA, eligibleB, kept, leased, tampered];
  await commit(ws, 'p1', { timeline: used.map((x) => x.old) });
  await commit(ws, 'p1', { timeline: [] }); // clock starts at T0 for all of them
  await commit(ws, 'arch', { timeline: [archived.old], status: 'archived' });
  await commit(ws, 'p2', { undo: [undo.old] });
  const svc = new StorageService(ws);
  await svc.setProtection({ version_id: kept.old.version_id, keep: true, actor: 'user' });
  await svc.createLease({ job: 'render', label: 'queued render', media: [leased.old], actor: 'user' });

  clock.advance(10 * DAY_MS);
  await commit(ws, 'p3', { timeline: [waiting.old] });
  await commit(ws, 'p3', { timeline: [] }); // clock starts at day 10
  clock.advance(25 * DAY_MS); // day 35: A/B/tampered past 30d, waiting only at 25d

  // Tamper bytes behind the registry's back (integrity flag still "ok").
  const reg = await loadRegistry(ws);
  const tabs = path.join(ws.root, reg.versions[tampered.old.version_id]!.rel_path);
  await fsp.chmod(tabs, 0o666);
  await fsp.writeFile(tabs, 'evil');

  return { ...fx, eligibleA, eligibleB, neverUsed, waiting, kept, archived, undo, leased, tampered };
}

describe('ST-05 candidate scanner (dry run)', () => {
  it('eligible set equals the fixture expectation exactly; nothing is moved', async () => {
    const fx = await bigFixture();
    const before = await snapshotTree(fx.ws);
    const r = await scanCandidates(fx.ws, { actor: 'scheduler' });
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.candidates.map((c) => c.version_id).sort()).toEqual([fx.eligibleA.old.version_id, fx.eligibleB.old.version_id].sort());
    expect(r.rejected).toEqual([{ version_id: fx.tampered.old.version_id, reason: 'CHANGED' }]);
    const state = (m: MediaRef) => r.evaluations.find((e) => e.version_id === m.version_id)!.state;
    expect(state(fx.neverUsed.old)).toBe('AVAILABLE_NEW_PROTECTED');
    expect(state(fx.waiting.old)).toBe('UNREFERENCED_WAIT_30D');
    expect(state(fx.kept.old)).toBe('PROTECTED');
    expect(state(fx.archived.old)).toBe('REFERENCED');
    expect(state(fx.undo.old)).toBe('REFERENCED');
    expect(state(fx.leased.old)).toBe('REFERENCED');
    // Current version never bound to a timeline: new-protected state, and CURRENT is still recorded as a reason.
    expect(state(fx.eligibleA.cur)).toBe('AVAILABLE_NEW_PROTECTED');
    expect(r.evaluations.find((e) => e.version_id === fx.eligibleA.cur.version_id)!.reasons).toContain('CURRENT');
    expect(r.summary.GC_ELIGIBLE).toBe(3); // A, B, tampered pass gates; tampered dropped by hash check
    expect(await snapshotTree(fx.ws)).toBe(before);
    expect((await loadRegistry(fx.ws)).versions[fx.tampered.old.version_id]!.integrity).toBe('changed');
    const log = await readAudit(fx.ws, (e) => e.op === 'gc.scan');
    expect(log.at(-1)).toMatchObject({ outcome: 'ok', dry_run: true, op_id: r.op_id });
    expect((log.at(-1)!.candidates as unknown[]).length).toBe(2);
  });

  it('busy versions (import/relink/move/export) are not candidates', async () => {
    const fx = await bigFixture();
    const r = await scanCandidates(fx.ws, { actor: 'user', busy: new Set([fx.eligibleA.old.version_id]) });
    expect(r.candidates.map((c) => c.version_id)).toEqual([fx.eligibleB.old.version_id]);
  });

  it('GC-07: corrupt/incomplete dependency data stops the scan safely with a logged reason', async () => {
    const fx = await bigFixture();
    await fsp.writeFile(path.join(fx.ws.root, 'PROJECTS/p2/03_PROJECT/project.json'), '{"schema_version":1');
    const r = await scanCandidates(fx.ws, { actor: 'scheduler' });
    expect(r.ok).toBe(false);
    expect(r.candidates).toEqual([]);
    expect(r.errors.join('\n')).toMatch(/p2/);
    const log = await readAudit(fx.ws, (e) => e.op === 'gc.scan' && e.outcome === 'blocked');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ reason: 'INDEX_INVALID' });

    await fsp.writeFile(path.join(fx.ws.root, '.motionstudio', 'registry.json'), 'nope');
    expect((await scanCandidates(fx.ws, { actor: 'user' })).ok).toBe(false);
  });

  it('a missing candidate file is rejected as unverifiable and flagged missing', async () => {
    const fx = await bigFixture();
    const reg = await loadRegistry(fx.ws);
    const abs = path.join(fx.ws.root, reg.versions[fx.eligibleB.old.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.rm(abs);
    const r = await scanCandidates(fx.ws, { actor: 'user' });
    expect(r.candidates.map((c) => c.version_id)).toEqual([fx.eligibleA.old.version_id]);
    expect(r.rejected.find((x) => x.version_id === fx.eligibleB.old.version_id)!.reason).toMatch(/UNVERIFIABLE/);
    expect((await loadRegistry(fx.ws)).versions[fx.eligibleB.old.version_id]!.integrity).toBe('missing');
  });

  it('GC-12 (read side): AI may scan but writes nothing except the audit entry', async () => {
    const fx = await bigFixture();
    const regPath = path.join(fx.ws.root, '.motionstudio', 'registry.json');
    const regBefore = await fsp.readFile(regPath, 'utf8');
    const treeBefore = await snapshotTree(fx.ws);
    const r = await scanCandidates(fx.ws, { actor: 'ai' });
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(2);
    expect(await fsp.readFile(regPath, 'utf8')).toBe(regBefore); // no clock or integrity writes
    expect(await snapshotTree(fx.ws)).toBe(treeBefore);
    expect((await readAudit(fx.ws, (e) => e.op === 'gc.scan')).at(-1)).toMatchObject({ actor: 'ai', dry_run: true });
  });

  it('unknown actors are rejected', async () => {
    const fx = await fixtureWorkspace();
    try {
      await scanCandidates(fx.ws, { actor: 'robot' as never });
      expect.unreachable();
    } catch (e) {
      expect(isStorageError(e, 'FORBIDDEN')).toBe(true);
    }
  });
});
