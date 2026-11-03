import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { writeJournal } from '../src/storage/journal.js';
import { recoverOnStartup } from '../src/storage/recovery.js';
import { loadRegistry } from '../src/storage/registry.js';
import { restoreVersion } from '../src/storage/restore.js';
import { GcScheduler, type Timers } from '../src/storage/scheduler.js';
import { listJournal, runAutoTrash } from '../src/storage/trash.js';
import type { Workspace } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared, oldVersion } from './fixtures.js';

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

/** Eligible old version + the paths a Trash move would use (simulating a crash mid-way). */
async function crashSetup() {
  const fx = await fixtureWorkspace();
  const old = await oldVersion(fx.ws, fx.src);
  fx.clock.advance(30 * DAY_MS);
  const v = (await loadRegistry(fx.ws)).versions[old.version_id]!;
  const from = v.rel_path;
  const to = `.trash/op_crash/${old.version_id}/${path.basename(from)}`;
  const entry = { schema_version: 1 as const, op_id: 'op_crash', kind: 'trash' as const, version_id: old.version_id, from_rel: from, to_rel: to, manifest_rel: `.trash/op_crash/${old.version_id}/manifest.json`, content_hash: v.content_hash, started_at: fx.clock.now() };
  const A = (rel: string) => path.join(fx.ws.root, rel);
  return { ...fx, old, from, to, entry, A };
}

describe('ST-09 crash recovery', () => {
  it('crash after the move, before the registry update → rolled back to the original state', async () => {
    const fx = await crashSetup();
    await writeJournal(fx.ws, fx.entry);
    await fsp.mkdir(path.dirname(fx.A(fx.to)), { recursive: true });
    await fsp.rename(fx.A(fx.from), fx.A(fx.to));
    const r = await recoverOnStartup(fx.ws);
    expect(r.journal).toEqual([{ file: `op_crash--${fx.old.version_id}.json`, version_id: fx.old.version_id, kind: 'trash', action: 'rolled-back' }]);
    expect(await exists(fx.A(fx.from))).toBe(true);
    expect(await exists(fx.A(fx.to))).toBe(false);
    expect((await loadRegistry(fx.ws)).versions[fx.old.version_id]).toMatchObject({ lifecycle: 'active', rel_path: fx.from });
    expect(await listJournal(fx.ws)).toEqual([]);
    // The next cycle re-decides from fresh data and completes normally.
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved).toHaveLength(1);
  });

  it('crash before the move → nothing to undo; interrupted copy → partial destination removed', async () => {
    const fx = await crashSetup();
    await writeJournal(fx.ws, fx.entry);
    expect((await recoverOnStartup(fx.ws)).journal[0]!.action).toBe('not-started');

    await writeJournal(fx.ws, fx.entry);
    await fsp.mkdir(path.dirname(fx.A(fx.to)), { recursive: true });
    await fsp.writeFile(fx.A(fx.to), 'half-copied');
    expect((await recoverOnStartup(fx.ws)).journal[0]!.action).toBe('partial-destination-removed');
    expect(await exists(fx.A(fx.to))).toBe(false);
    expect(await exists(fx.A(fx.from))).toBe(true);
  });

  it('crash after completion (journal left behind) → just cleared; bytes gone → flagged missing', async () => {
    const fx = await crashSetup();
    const t = await runAutoTrash(fx.ws, { actor: 'user' });
    await writeJournal(fx.ws, { ...fx.entry, op_id: t.op_id, to_rel: t.moved[0]!.to });
    expect((await recoverOnStartup(fx.ws)).journal[0]!.action).toBe('completed-before-crash');
    expect((await loadRegistry(fx.ws)).versions[fx.old.version_id]!.lifecycle).toBe('trashed');

    const fx2 = await crashSetup();
    await writeJournal(fx2.ws, fx2.entry);
    await fsp.chmod(fx2.A(fx2.from), 0o666);
    await fsp.rm(fx2.A(fx2.from));
    expect((await recoverOnStartup(fx2.ws)).journal[0]!.action).toBe('bytes-missing');
    expect((await loadRegistry(fx2.ws)).versions[fx2.old.version_id]!.integrity).toBe('missing');
  });

  it('interrupted restore is rolled back into Trash', async () => {
    const fx = await crashSetup();
    const t = await runAutoTrash(fx.ws, { actor: 'user' });
    const trashRel = t.moved[0]!.to;
    const v = (await loadRegistry(fx.ws)).versions[fx.old.version_id]!;
    await writeJournal(fx.ws, { schema_version: 1, op_id: 'op_rs', kind: 'restore', version_id: v.version_id, from_rel: trashRel, to_rel: fx.from, manifest_rel: v.trash!.manifest_rel_path, content_hash: v.content_hash, started_at: 0 });
    await fsp.rename(fx.A(trashRel), fx.A(fx.from));
    expect((await recoverOnStartup(fx.ws)).journal[0]!.action).toBe('rolled-back');
    expect(await exists(fx.A(trashRel))).toBe(true);
    expect((await loadRegistry(fx.ws)).versions[v.version_id]).toMatchObject({ lifecycle: 'trashed', rel_path: trashRel });
    expect((await restoreVersion(fx.ws, { version_id: v.version_id, actor: 'user' })).status).toBe('restored');
  });

  it('corrupt journal blocks Auto Trash (fail closed) and is reported, not guessed', async () => {
    const fx = await crashSetup();
    await fsp.writeFile(path.join(fx.ws.root, '.motionstudio', 'journal', 'op_x--v_x.json'), '{oops');
    const r = await recoverOnStartup(fx.ws);
    expect(r.corrupt_journal).toEqual(['op_x--v_x.json']);
    const t = await runAutoTrash(fx.ws, { actor: 'scheduler' });
    expect(t).toMatchObject({ ok: false, moved: [] });
    expect(await readAudit(fx.ws, (e) => e.reason === 'JOURNAL_CORRUPT')).toHaveLength(1);
  });

  it('sweeps temp files, reports (never deletes) orphan media files; idempotent', async () => {
    const { ws, src } = await fixtureWorkspace();
    await importShared(ws, src);
    const tmp = path.join(ws.root, 'SHARED_MEDIA', '.importing-op_dead');
    const orphanDir = path.join(ws.root, 'SHARED_MEDIA', 'm_aaaaaaaaaaaaaaaa');
    await fsp.writeFile(tmp, 'partial');
    await fsp.mkdir(orphanDir);
    await fsp.writeFile(path.join(orphanDir, 'v_bbbbbbbbbbbbbbbb.mp4'), 'orphan bytes');
    await fsp.writeFile(path.join(ws.root, '.motionstudio', 'registry.json.123.abcd.tmp'), '{');
    const r = await recoverOnStartup(ws);
    expect(r.removed_temp_files.sort()).toEqual(['.motionstudio/registry.json.123.abcd.tmp', 'SHARED_MEDIA/.importing-op_dead']);
    expect(r.orphan_files).toEqual(['SHARED_MEDIA/m_aaaaaaaaaaaaaaaa/v_bbbbbbbbbbbbbbbb.mp4']);
    expect(await exists(path.join(orphanDir, 'v_bbbbbbbbbbbbbbbb.mp4'))).toBe(true);
    const again = await recoverOnStartup(ws);
    expect(again.removed_temp_files).toEqual([]);
    expect(again.journal).toEqual([]);
  });
});

class FakeTimers implements Timers {
  fns: (() => void)[] = [];
  intervals: number[] = [];
  cleared = 0;
  setInterval(fn: () => void, ms: number) {
    this.fns.push(fn);
    this.intervals.push(ms);
    return this.fns.length;
  }
  clearInterval() {
    this.cleared++;
  }
  tick() {
    this.fns.forEach((f) => f());
  }
}

describe('ST-09 scheduler', () => {
  async function eligibleWs(): Promise<{ ws: Workspace; clock: { advance(ms: number): void } }> {
    const fx = await fixtureWorkspace();
    await oldVersion(fx.ws, fx.src);
    return fx;
  }

  it('launch: recovery → immediate cycle → interval from policy; ticks run later cycles', async () => {
    const { ws, clock } = await eligibleWs();
    const timers = new FakeTimers();
    const s = new GcScheduler(ws, { timers });
    const first = await s.start();
    expect(first.status).toBe('ok');
    expect(first.trash).toBeUndefined(); // nothing eligible yet
    expect(timers.intervals).toEqual([360 * 60_000]);
    expect(s.lastRecovery).not.toBeNull();
    clock.advance(30 * DAY_MS);
    const second = await s.runCycle();
    expect(second.trash!.moved).toHaveLength(1);
    expect((await s.runCycle()).trash).toBeUndefined(); // idempotent: nothing left to move
    s.stop();
    expect(timers.cleared).toBe(1);
    expect(s.active).toBe(false);
  });

  it('cycles never overlap; locked workspace skips; errors never escape', async () => {
    const { ws } = await eligibleWs();
    const s = new GcScheduler(ws, { timers: new FakeTimers() });
    const [a, b] = await Promise.all([s.runCycle(), s.runCycle()]);
    expect([a.status, b.status].sort()).toEqual(['ok', 'skipped-overlap']);
    await fsp.writeFile(path.join(ws.root, '.motionstudio', 'registry.json'), 'broken');
    const c = await s.runCycle();
    expect(c.status).toBe('blocked');
  });

  it('busy provider protects the live player/project; autoTrash:false only scans', async () => {
    const fx = await fixtureWorkspace();
    const a = await oldVersion(fx.ws, fx.src);
    fx.clock.advance(30 * DAY_MS);
    const busy = new GcScheduler(fx.ws, { timers: new FakeTimers(), busy: () => new Set([a.version_id]) });
    expect((await busy.runCycle()).trash).toBeUndefined();
    const scanOnly = new GcScheduler(fx.ws, { timers: new FakeTimers(), autoTrash: false });
    const r = await scanOnly.runCycle();
    expect(r.scan!.candidates).toHaveLength(1);
    expect(r.trash).toBeUndefined();
    expect((await loadRegistry(fx.ws)).versions[a.version_id]!.lifecycle).toBe('active');
  });
});
