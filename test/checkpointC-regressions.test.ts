// Regression tests for Checkpoint C review findings (H1, H2, M1, M2, M3, M4).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { listJournal, writeJournal } from '../src/storage/journal.js';
import { startRender } from '../src/storage/preflight.js';
import { PURGE_PHRASE, executePurge, preparePurge } from '../src/storage/purge.js';
import { recoverOnStartup } from '../src/storage/recovery.js';
import { loadRegistry } from '../src/storage/registry.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { commit, fixtureWorkspace, importShared, oldVersion } from './fixtures.js';

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const roomy = { free_bytes: 100 * 1024 ** 3, total_bytes: 200 * 1024 ** 3 };

async function trashedOne() {
  const fx = await fixtureWorkspace();
  const old = await oldVersion(fx.ws, fx.src, 'proj');
  fx.clock.advance(30 * DAY_MS);
  const t = await runAutoTrash(fx.ws, { actor: 'scheduler' });
  const v = (await loadRegistry(fx.ws)).versions[old.version_id]!;
  return { ...fx, old, t, v, A: (rel: string) => path.join(fx.ws.root, rel) };
}

describe('C-H1: recovery never deletes the only copy of a trashed version', () => {
  it('completed trash + user put a file back at the original path → both kept', async () => {
    const fx = await trashedOne();
    const from = fx.v.trash!.original_rel_path;
    await writeJournal(fx.ws, { schema_version: 1, op_id: fx.t.op_id, kind: 'trash', version_id: fx.v.version_id, from_rel: from, to_rel: fx.v.rel_path, manifest_rel: fx.v.trash!.manifest_rel_path, content_hash: fx.v.content_hash, started_at: 0 });
    await fsp.writeFile(fx.A(from), 'user restored an old backup copy here');
    const r = await recoverOnStartup(fx.ws);
    expect(r.journal[0]!.action).toBe('completed-before-crash');
    expect(await exists(fx.A(fx.v.rel_path))).toBe(true); // Trash bytes survive
    expect(await fsp.readFile(fx.A(from), 'utf8')).toBe('user restored an old backup copy here');
    expect((await loadRegistry(fx.ws)).versions[fx.v.version_id]!.lifecycle).toBe('trashed');
  });
});

describe('C-H2: recovery never deletes a user file and ignores out-of-area journal paths', () => {
  it('restore crashed before the link; user later put a file at the destination → untouched', async () => {
    const fx = await trashedOne();
    const dest = fx.v.trash!.original_rel_path;
    await writeJournal(fx.ws, { schema_version: 1, op_id: 'op_r', kind: 'restore', version_id: fx.v.version_id, from_rel: fx.v.rel_path, to_rel: dest, manifest_rel: fx.v.trash!.manifest_rel_path, content_hash: fx.v.content_hash, started_at: 0 });
    await fsp.writeFile(fx.A(dest), 'the user\'s own new clip');
    const r = await recoverOnStartup(fx.ws);
    expect(r.journal[0]!.action).toBe('destination-left-untouched');
    expect(await fsp.readFile(fx.A(dest), 'utf8')).toBe('the user\'s own new clip');
    expect(await exists(fx.A(fx.v.rel_path))).toBe(true);
  });

  it('a tampered journal pointing at outputs/metadata is kept for review and touches nothing', async () => {
    const fx = await trashedOne();
    await commit(fx.ws, 'proj', {});
    const out = 'PROJECTS/proj/05_OUTPUT/final.mp4';
    await fsp.writeFile(fx.A(out), 'final render');
    await writeJournal(fx.ws, { schema_version: 1, op_id: 'op_evil', kind: 'trash', version_id: fx.v.version_id, from_rel: '.motionstudio/registry.json', to_rel: out, manifest_rel: 'x', content_hash: fx.v.content_hash, started_at: 0 });
    const r = await recoverOnStartup(fx.ws);
    expect(r.corrupt_journal).toEqual([`op_evil--${fx.v.version_id}.json`]);
    expect(await fsp.readFile(fx.A(out), 'utf8')).toBe('final render');
    expect((await listJournal(fx.ws)).length).toBe(1); // kept: GC stays blocked until resolved
  });
});

describe('C-M1/M2: purge vs corrupt journals and crashes', () => {
  it('an unreadable journal blocks every purge item', async () => {
    const fx = await trashedOne();
    await fsp.writeFile(path.join(fx.ws.root, '.motionstudio', 'journal', `op_x--${fx.v.version_id}.json`), '{oops');
    const p = await preparePurge(fx.ws, { version_ids: [fx.v.version_id], actor: 'user' });
    expect(p.items[0]!.blockers).toContain('JOURNAL_CORRUPT');
    const r = await executePurge(fx.ws, { request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(r.purged).toEqual([]);
    expect(await exists(fx.A(fx.v.rel_path))).toBe(true);
  });

  it('purge logs "started" before deleting; a crash after the delete is recorded by recovery', async () => {
    const fx = await trashedOne();
    const p = await preparePurge(fx.ws, { version_ids: [fx.v.version_id], actor: 'user' });
    await executePurge(fx.ws, { request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect((await readAudit(fx.ws, (e) => e.op === 'purge.item')).map((e) => e.phase)).toEqual(['started', 'done']);
    expect(await listJournal(fx.ws)).toEqual([]);

    // Simulate: file deleted, registry never saved, journal left behind.
    const fx2 = await trashedOne();
    const v = fx2.v;
    await writeJournal(fx2.ws, { schema_version: 1, op_id: 'pr_crash', kind: 'purge', version_id: v.version_id, from_rel: v.rel_path, to_rel: v.rel_path, manifest_rel: v.trash!.manifest_rel_path, content_hash: v.content_hash, started_at: 0 });
    await fsp.chmod(fx2.A(v.rel_path), 0o666);
    await fsp.rm(fx2.A(v.rel_path));
    const r = await recoverOnStartup(fx2.ws);
    expect(r.journal[0]!.action).toBe('purge-completed-recorded');
    expect((await loadRegistry(fx2.ws)).versions[v.version_id]!.lifecycle).toBe('purged');
    expect(await readAudit(fx2.ws, (e) => e.op === 'purge.item' && e.phase === 'recovered')).toHaveLength(1);

    // Purge journal whose file still exists = not started → nothing deleted.
    const fx3 = await trashedOne();
    await writeJournal(fx3.ws, { schema_version: 1, op_id: 'pr_ns', kind: 'purge', version_id: fx3.v.version_id, from_rel: fx3.v.rel_path, to_rel: fx3.v.rel_path, manifest_rel: fx3.v.trash!.manifest_rel_path, content_hash: fx3.v.content_hash, started_at: 0 });
    expect((await recoverOnStartup(fx3.ws)).journal[0]!.action).toBe('purge-not-started');
    expect(await exists(fx3.A(fx3.v.rel_path))).toBe(true);
  });
});

describe('C-M3/M4: render overwrite approval and output reservation', () => {
  it('only the user may approve overwriting a final', async () => {
    const fx = await fixtureWorkspace();
    const clip = await importShared(fx.ws, fx.src);
    await commit(fx.ws, 'promo', { timeline: [clip] });
    try {
      await startRender(fx.ws, { project_id: 'promo', output_name: 'final.mp4', estimated_bytes: 1, approve_overwrite: true, actor: 'scheduler', disk: roomy });
      expect.unreachable();
    } catch (e) {
      expect(isStorageError(e, 'FORBIDDEN')).toBe(true);
    }
    expect(await readAudit(fx.ws, (e) => e.reason === 'OVERWRITE_NOT_USER')).toHaveLength(1);
  });

  it('two queued renders never get the same output name (also concurrently)', async () => {
    const fx = await fixtureWorkspace();
    const clip = await importShared(fx.ws, fx.src);
    await commit(fx.ws, 'promo', { timeline: [clip] });
    const req = { project_id: 'promo', output_name: 'x.mp4', estimated_bytes: 1, actor: 'user' as const, disk: roomy };
    const [a, b] = await Promise.all([startRender(fx.ws, req), startRender(fx.ws, req)]);
    const names = [a.preflight.output_rel, b.preflight.output_rel].sort();
    expect(names).toEqual(['PROJECTS/promo/05_OUTPUT/x.mp4', 'PROJECTS/promo/05_OUTPUT/x_v2.mp4']);
    expect(a.lease && b.lease).toBeTruthy();
    // A user-approved overwrite of a name reserved by a running render is still refused.
    const c = await startRender(fx.ws, { ...req, approve_overwrite: true });
    expect(c.lease).toBeNull();
    expect(c.preflight.problems[0]).toMatchObject({ code: 'OUTPUT_NOT_WRITABLE' });
  });
});
