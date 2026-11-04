import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/storage/clock.js';
import { addVersion, loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { commit, fixtureWorkspace, importShared } from './fixtures.js';

describe('StorageService clock reconciliation', () => {
  it('starts the 30-day clock at the exact moment the last reference/protection disappears', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const old = await importShared(ws, src);
    const p = path.join(src, 'v2.mp4');
    await fsp.writeFile(p, 'v2');
    await addVersion(ws, { media_id: old.media_id, sourcePath: p, actor: 'user' });
    await commit(ws, 'p1', { timeline: [old] });

    clock.advance(3 * DAY_MS);
    const dropAt = clock.now();
    await commit(ws, 'p1', { timeline: [] }); // no explicit sync afterwards
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBe(dropAt);

    clock.advance(DAY_MS);
    await svc.setProtection({ version_id: old.version_id, keep: true, actor: 'user' });
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBeNull();
    clock.advance(DAY_MS);
    const unkeepAt = clock.now();
    await svc.setProtection({ version_id: old.version_id, keep: false, actor: 'user' });
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBe(unkeepAt);

    const lease = await svc.createLease({ job: 'ai', label: 'x', media: [old], actor: 'user' });
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBeNull();
    clock.advance(DAY_MS);
    await svc.releaseLease({ lease_id: lease.result.lease_id, outcome: 'completed', actor: 'user' });
    expect((await loadRegistry(ws)).versions[old.version_id]!.unreferenced_since).toBe(clock.now());
  });

  it('a mutation with an invalid index still reports clocks ok:false (fail closed, no clock writes)', async () => {
    const { ws, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const a = await importShared(ws, src);
    await commit(ws, 'p1', { timeline: [a] });
    await fsp.mkdir(path.join(ws.root, 'PROJECTS', 'broken'));
    const r = await svc.setProtection({ version_id: a.version_id, pin: true, actor: 'user' });
    expect(r.result.pin).toBe(true);
    expect(r.clocks.ok).toBe(false);
  });
});
