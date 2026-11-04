import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/storage/clock.js';
import { buildIndex, createLease, releaseLease } from '../src/storage/deps.js';
import { evaluateAll, evaluateVersion, syncClocks } from '../src/storage/eligibility.js';
import { type Registry, addVersion, loadRegistry, setProtection } from '../src/storage/registry.js';
import { readAudit } from '../src/storage/audit.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../src/storage/workspace.js';
import type { MediaRef } from '../src/storage/project.js';
import { commit, fixtureWorkspace, importShared } from './fixtures.js';

/** Media with a current v2 and an older v1 (only non-current versions can ever be eligible). */
async function twoVersions(ws: Workspace, src: string): Promise<{ old: MediaRef; cur: MediaRef }> {
  const old = await importShared(ws, src, 'look');
  const p = path.join(src, `recut-${Math.random()}.mp4`);
  await fsp.writeFile(p, `recut-${Math.random()}`);
  const v2 = await addVersion(ws, { media_id: old.media_id, sourcePath: p, actor: 'user' });
  return { old, cur: { media_id: old.media_id, version_id: v2.version.version_id } };
}

async function evalOf(ws: Workspace, versionId: string) {
  const r = await buildIndex(ws);
  const reg = await loadRegistry(ws);
  const v = reg.versions[versionId]!;
  return evaluateVersion(v, reg.media[v.media_id]!, { now: ws.clock.now(), index: r.ok ? r.index : null });
}

describe('ST-04 eligibility & 30-day clock', () => {
  it('GC-01: never-referenced media aged 60 days stays protected, clock never starts', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src); // old is non-current but never used
    clock.advance(60 * DAY_MS);
    await syncClocks(ws);
    const e = await evalOf(ws, old.version_id);
    expect(e.state).toBe('AVAILABLE_NEW_PROTECTED');
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain('NEVER_USED');
    expect(e.unreferenced_since).toBeNull();
  });

  it('GC-02 / GC-03: 29d23h not eligible, 30d eligible (old non-current previously referenced)', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old] });
    await syncClocks(ws);
    expect((await evalOf(ws, old.version_id)).state).toBe('REFERENCED');

    clock.advance(DAY_MS);
    const t = clock.now();
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    let e = await evalOf(ws, old.version_id);
    expect(e).toMatchObject({ state: 'UNREFERENCED_WAIT_30D', unreferenced_since: t, eligible_at: t + 30 * DAY_MS, eligible: false });

    clock.set(t + 30 * DAY_MS - 60 * 60 * 1000); // 29d23h
    await syncClocks(ws);
    e = await evalOf(ws, old.version_id);
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(['WAITING_30D']);

    clock.set(t + 30 * DAY_MS);
    await syncClocks(ws);
    e = await evalOf(ws, old.version_id);
    expect(e).toMatchObject({ state: 'GC_ELIGIBLE', eligible: true, reasons: [] });
  });

  it('GC-04: archived project or retained undo/snapshot keeps it referenced forever', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const a = await twoVersions(ws, src);
    const b = await twoVersions(ws, src);
    await commit(ws, 'arch', { timeline: [a.old], status: 'archived' });
    await commit(ws, 'live', { undo: [b.old] });
    clock.advance(400 * DAY_MS);
    await syncClocks(ws);
    for (const v of [a.old, b.old]) {
      const e = await evalOf(ws, v.version_id);
      expect(e.state).toBe('REFERENCED');
      expect(e.eligible).toBe(false);
      expect(e.unreferenced_since).toBeNull();
    }
  });

  it('GC-05: a queued/running job lease holds the version; release restarts the clock', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old] });
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    const lease = await createLease(ws, { job: 'render', label: 'r', media: [old], actor: 'user' });
    clock.advance(45 * DAY_MS);
    await syncClocks(ws);
    expect((await evalOf(ws, old.version_id)).state).toBe('REFERENCED');
    await releaseLease(ws, { lease_id: lease.lease_id, outcome: 'completed', actor: 'user' });
    await syncClocks(ws);
    const e = await evalOf(ws, old.version_id);
    expect(e.unreferenced_since).toBe(clock.now()); // fresh 30-day period
    expect(e.eligible).toBe(false);
  });

  it('GC-06: re-referenced on day 29 resets the clock; not moved on the old schedule', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old] });
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    const start = clock.now();
    clock.set(start + 29 * DAY_MS);
    await commit(ws, 'p2', { timeline: [old] });
    await syncClocks(ws);
    expect((await evalOf(ws, old.version_id)).unreferenced_since).toBeNull();
    clock.set(start + 29 * DAY_MS + 1);
    await commit(ws, 'p2', { timeline: [] });
    await syncClocks(ws);
    clock.set(start + 30 * DAY_MS + 1); // old schedule
    await syncClocks(ws);
    const e = await evalOf(ws, old.version_id);
    expect(e.eligible).toBe(false);
    expect(e.eligible_at).toBe(start + 29 * DAY_MS + 1 + 30 * DAY_MS);
  });

  it('CURRENT, KEEP, PIN and LEGAL_HOLD protect and reset the clock', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old, cur } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old, cur] });
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    clock.advance(31 * DAY_MS);
    await syncClocks(ws);
    const c = await evalOf(ws, cur.version_id);
    expect(c.state).toBe('PROTECTED');
    expect(c.reasons).toContain('CURRENT');
    expect(c.unreferenced_since).toBeNull();
    expect((await evalOf(ws, old.version_id)).eligible).toBe(true);

    for (const flag of ['keep', 'pin', 'legal_hold'] as const) {
      await setProtection(ws, { version_id: old.version_id, [flag]: true, actor: 'user' });
      await syncClocks(ws);
      const e = await evalOf(ws, old.version_id);
      expect(e.state).toBe('PROTECTED');
      expect(e.unreferenced_since).toBeNull(); // protection resets the clock
      await setProtection(ws, { version_id: old.version_id, [flag]: false, actor: 'user' });
      await syncClocks(ws);
      expect((await evalOf(ws, old.version_id)).reasons).toEqual(['WAITING_30D']);
    }
  });

  it('GC-07 (engine): invalid index → FAILED_AUDIT for everything, clocks untouched, audited', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old] });
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    clock.advance(40 * DAY_MS);
    const before = (await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since;
    await fsp.writeFile(path.join(ws.root, 'PROJECTS/p1/03_PROJECT/project.json'), 'garbage');
    const s = await syncClocks(ws);
    expect(s.ok).toBe(false);
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBe(before);
    const reg = await loadRegistry(ws);
    const all = evaluateAll(reg, { now: clock.now(), index: null });
    expect(all.every((e) => !e.eligible && e.state === 'FAILED_AUDIT')).toBe(true);
    expect((await readAudit(ws, (e) => e.op === 'gc.clock_sync' && e.outcome === 'blocked')).length).toBe(1);
  });

  it('integrity, lifecycle, busy and path gates', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const { old } = await twoVersions(ws, src);
    await commit(ws, 'p1', { timeline: [old] });
    await commit(ws, 'p1', { timeline: [] });
    await syncClocks(ws);
    clock.advance(31 * DAY_MS);
    const r = await buildIndex(ws);
    if (!r.ok) throw new Error('index');
    const reg: Registry = await loadRegistry(ws);
    const v = reg.versions[old.version_id]!;
    const m = reg.media[v.media_id]!;
    const ctx = { now: clock.now(), index: r.index };
    expect(evaluateVersion(v, m, ctx).eligible).toBe(true);
    expect(evaluateVersion({ ...v, integrity: 'changed' }, m, ctx)).toMatchObject({ state: 'CHANGED', eligible: false });
    expect(evaluateVersion({ ...v, integrity: 'missing' }, m, ctx)).toMatchObject({ state: 'MISSING', eligible: false });
    expect(evaluateVersion({ ...v, lifecycle: 'trashed' }, m, ctx)).toMatchObject({ state: 'TRASHED', eligible: false });
    expect(evaluateVersion({ ...v, lifecycle: 'purged' }, m, ctx)).toMatchObject({ state: 'PURGED_MANUALLY', eligible: false });
    expect(evaluateVersion(v, m, { ...ctx, busy: new Set([v.version_id]) }).reasons).toEqual(['BUSY']);
    expect(evaluateVersion({ ...v, rel_path: 'PROJECTS/p1/05_OUTPUT/x.mp4' }, m, ctx)).toMatchObject({ state: 'FAILED_AUDIT', eligible: false });
    expect(evaluateVersion({ ...v, rel_path: '../escape.mp4' }, m, ctx).eligible).toBe(false);
  });
});
