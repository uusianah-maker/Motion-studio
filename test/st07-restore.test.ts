import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { evaluateVersion } from '../src/storage/eligibility.js';
import { buildIndex } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry } from '../src/storage/registry.js';
import { restoreVersion } from '../src/storage/restore.js';
import { StorageService } from '../src/storage/service.js';
import { listJournal, runAutoTrash } from '../src/storage/trash.js';
import { commit, fixtureWorkspace, oldVersion } from './fixtures.js';

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

async function trashedFixture() {
  const fx = await fixtureWorkspace();
  const old = await oldVersion(fx.ws, fx.src, 'proj');
  const original = (await loadRegistry(fx.ws)).versions[old.version_id]!.rel_path;
  fx.clock.advance(30 * DAY_MS);
  const t = await runAutoTrash(fx.ws, { actor: 'scheduler' });
  if (t.moved.length !== 1) throw new Error('fixture: expected one trashed version');
  return { ...fx, old, original, trashRel: t.moved[0]!.to, svc: new StorageService(fx.ws) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('ST-07 restore', () => {
  it('restores to the original path, references work again, eligibility restarts from zero', async () => {
    const fx = await trashedFixture();
    const r = await fx.svc.restore({ version_id: fx.old.version_id, actor: 'user' });
    expect(r.result).toMatchObject({ status: 'restored', rel_path: fx.original, alternate: false });
    expect(await exists(path.join(fx.ws.root, fx.original))).toBe(true);
    expect(await exists(path.join(fx.ws.root, fx.trashRel))).toBe(false);
    await expect(fsp.writeFile(path.join(fx.ws.root, fx.original), 'x')).rejects.toThrow(); // read-only again
    const reg = await loadRegistry(fx.ws);
    const v = reg.versions[fx.old.version_id]!;
    expect(v).toMatchObject({ lifecycle: 'active', integrity: 'ok', trash: null, restored_at: fx.clock.now(), unreferenced_since: fx.clock.now() });
    // New full period: still not eligible 29 days later.
    fx.clock.advance(29 * DAY_MS);
    const idx = await buildIndex(fx.ws);
    expect(idx.ok && evaluateVersion(v, reg.media[v.media_id]!, { now: fx.clock.now(), index: idx.index }).eligible).toBe(false);
    // Existing media/version references are valid again.
    await commit(fx.ws, 'proj', { timeline: [fx.old] });
    expect(await listJournal(fx.ws)).toEqual([]);
    expect(await fsp.readdir(path.join(fx.ws.root, '.trash'))).toEqual([]); // manifest + empty dirs cleaned
    expect((await readAudit(fx.ws, (e) => e.op === 'trash.restore' && e.outcome === 'ok'))).toHaveLength(1);
  });

  it('GC-09: occupied destination is never overwritten; user picks alternate or explicit path', async () => {
    const fx = await trashedFixture();
    const occupant = path.join(fx.ws.root, fx.original);
    await fsp.writeFile(occupant, 'someone else');
    const c = await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user' });
    expect(c.status).toBe('conflict');
    if (c.status !== 'conflict') return;
    expect(c.wanted).toBe(fx.original);
    expect(c.suggested).toMatch(/\.restored-1\.mp4$/);
    expect(await fsp.readFile(occupant, 'utf8')).toBe('someone else');
    expect((await loadRegistry(fx.ws)).versions[fx.old.version_id]!.lifecycle).toBe('trashed');

    const alt = await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user', onConflict: 'alternate' });
    expect(alt).toMatchObject({ status: 'restored', rel_path: c.suggested, alternate: true });
    expect(await fsp.readFile(occupant, 'utf8')).toBe('someone else');
    expect((await loadRegistry(fx.ws)).versions[fx.old.version_id]!.rel_path).toBe(c.suggested);
  });

  it('explicit destination must stay inside a media area', async () => {
    const fx = await trashedFixture();
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user', destination: '.motionstudio/x.mp4' }))).toBe('FORBIDDEN');
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user', destination: 'PROJECTS/proj/05_OUTPUT/x.mp4' }))).toBe('FORBIDDEN');
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user', destination: '../escape.mp4' }))).toBe('PATH_INVALID');
    const ok = await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user', destination: 'SHARED_MEDIA/recovered/clip.mp4' });
    expect(ok).toMatchObject({ status: 'restored', rel_path: 'SHARED_MEDIA/recovered/clip.mp4' });
  });

  it('corrupt or missing Trash file → explicit failure, never claimed as restored', async () => {
    const fx = await trashedFixture();
    const abs = path.join(fx.ws.root, fx.trashRel);
    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'rotted');
    const r1 = await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user' });
    expect(r1).toMatchObject({ status: 'failed' });
    expect(r1.status === 'failed' && r1.reason).toMatch(/hash/);
    await fsp.rm(abs);
    const r2 = await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user' });
    expect(r2.status).toBe('failed');
    expect((await loadRegistry(fx.ws)).versions[fx.old.version_id]!.lifecycle).toBe('trashed');
    expect(await exists(path.join(fx.ws.root, fx.original))).toBe(false);
    expect(await readAudit(fx.ws, (e) => e.op === 'trash.restore' && e.outcome === 'failed')).toHaveLength(2);
  });

  it('restore is user-only and only for trashed versions', async () => {
    const fx = await trashedFixture();
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'ai' }))).toBe('FORBIDDEN');
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'scheduler' }))).toBe('FORBIDDEN');
    expect(await readAudit(fx.ws, (e) => e.op === 'trash.restore' && e.outcome === 'blocked')).toHaveLength(2);
    await restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user' });
    expect(await code(restoreVersion(fx.ws, { version_id: fx.old.version_id, actor: 'user' }))).toBe('PRECONDITION');
    expect(await code(restoreVersion(fx.ws, { version_id: 'v_nope', actor: 'user' }))).toBe('NOT_FOUND');
  });
});
