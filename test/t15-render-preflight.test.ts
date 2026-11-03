import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { finishRender, renderPreflight, startRender, verifyRenderSnapshot } from '../src/storage/preflight.js';
import { addVersion, loadRegistry } from '../src/storage/registry.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { syncClocks } from '../src/storage/eligibility.js';
import { commit, fixtureWorkspace, importShared, oldVersion } from './fixtures.js';

const GB = 1024 ** 3;
const roomy = { free_bytes: 100 * GB, total_bytes: 200 * GB };

async function projectWithClip() {
  const fx = await fixtureWorkspace();
  const clip = await importShared(fx.ws, fx.src, 'clip');
  await commit(fx.ws, 'promo', { timeline: [clip] });
  return { ...fx, clip };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('T15 render preflight & dependency snapshot', () => {
  it('ok path: exact snapshot with hashes, versioned output path in 05_OUTPUT, audited', async () => {
    const fx = await projectWithClip();
    const reg = await loadRegistry(fx.ws);
    const r = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'final.mp4', estimated_bytes: 1000, actor: 'user', disk: roomy });
    expect(r).toMatchObject({ ok: true, output_rel: 'PROJECTS/promo/05_OUTPUT/final.mp4', output_versioned: false, problems: [] });
    expect(r.snapshot).toEqual([{ ...fx.clip, content_hash: reg.versions[fx.clip.version_id]!.content_hash }]);
    await fsp.writeFile(path.join(fx.ws.root, r.output_rel), 'previous final');
    const r2 = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'final.mp4', estimated_bytes: 1000, actor: 'user', disk: roomy });
    expect(r2).toMatchObject({ ok: true, output_rel: 'PROJECTS/promo/05_OUTPUT/final_v2.mp4', output_versioned: true });
    const r3 = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'final.mp4', estimated_bytes: 1000, approve_overwrite: true, actor: 'user', disk: roomy });
    expect(r3.output_rel).toBe('PROJECTS/promo/05_OUTPUT/final.mp4');
    expect(r3.notes.join()).toMatch(/Overwrite output disetujui/);
    expect(await readAudit(fx.ws, (e) => e.op === 'render.preflight')).toHaveLength(3);
  });

  it('missing / changed media → explicit failure + relink proposal, never a silent replacement', async () => {
    const fx = await projectWithClip();
    const p = path.join(fx.src, 'v2.mp4');
    await fsp.writeFile(p, 'newer');
    const v2 = await addVersion(fx.ws, { media_id: fx.clip.media_id, sourcePath: p, actor: 'user' });
    const abs = path.join(fx.ws.root, (await loadRegistry(fx.ws)).versions[fx.clip.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'swapped');
    let r = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'a.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ code: 'MEDIA_CHANGED', ref: fx.clip, relink_options: [{ media_id: fx.clip.media_id, version_id: v2.version.version_id }] }]);
    expect(r.snapshot).toEqual([]); // nothing silently substituted
    await fsp.rm(abs);
    r = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'a.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    expect(r.problems[0]).toMatchObject({ code: 'MEDIA_MISSING' });
  });

  it('newer version available is reported but NOT used (no automatic upgrade)', async () => {
    const fx = await projectWithClip();
    const p = path.join(fx.src, 'v2.mp4');
    await fsp.writeFile(p, 'newer');
    await addVersion(fx.ws, { media_id: fx.clip.media_id, sourcePath: p, actor: 'user' });
    const r = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'a.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    expect(r.ok).toBe(true);
    expect(r.snapshot[0]!.version_id).toBe(fx.clip.version_id);
    expect(r.notes.join()).toMatch(/Versi lebih baru tersedia/);
  });

  it('trashed media, low disk, empty timeline and bad output names are caught', async () => {
    const fx = await fixtureWorkspace();
    const old = await oldVersion(fx.ws, fx.src, 'promo');
    fx.clock.advance(30 * DAY_MS);
    await runAutoTrash(fx.ws, { actor: 'user' });
    const raw = JSON.parse(await fsp.readFile(path.join(fx.ws.root, 'PROJECTS/promo/03_PROJECT/project.json'), 'utf8'));
    raw.timeline.tracks = [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'c', start_ms: 0, end_ms: 1, media: old }] }];
    await fsp.writeFile(path.join(fx.ws.root, 'PROJECTS/promo/03_PROJECT/project.json'), JSON.stringify(raw)); // externally edited
    let r = await renderPreflight(fx.ws, { project_id: 'promo', output_name: 'a.mp4', estimated_bytes: 6 * GB, actor: 'user', disk: { free_bytes: 10 * GB, total_bytes: 50 * GB } });
    expect(r.problems.map((x) => x.code).sort()).toEqual(['INSUFFICIENT_DISK', 'MEDIA_TRASHED']);
    const fx2 = await fixtureWorkspace();
    await commit(fx2.ws, 'empty', {});
    r = await renderPreflight(fx2.ws, { project_id: 'empty', output_name: 'a.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    expect(r.problems).toEqual([{ code: 'NO_MEDIA' }]);
    expect(await code(renderPreflight(fx2.ws, { project_id: 'empty', output_name: '../../escape.mp4', estimated_bytes: 1, actor: 'user', disk: roomy }))).toBe('PATH_INVALID');
    expect(await code(renderPreflight(fx2.ws, { project_id: 'empty', output_name: 'sub/a.mp4', estimated_bytes: 1, actor: 'user', disk: roomy }))).toBe('PATH_INVALID');
    expect(await code(renderPreflight(fx2.ws, { project_id: 'empty', output_name: 'a.mp4', estimated_bytes: 1, actor: 'ai', disk: roomy }))).toBe('FORBIDDEN');
  });

  it('GC-05: a queued/running render lease is never trashed; snapshot stays verifiable; release restarts clock', async () => {
    const fx = await fixtureWorkspace();
    const old = await oldVersion(fx.ws, fx.src, 'promo');
    await commit(fx.ws, 'promo', { timeline: [old] });
    const { preflight, lease } = await startRender(fx.ws, { project_id: 'promo', output_name: 'final.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    expect(preflight.ok).toBe(true);
    expect(lease!.media).toEqual(preflight.snapshot);
    await commit(fx.ws, 'promo', { timeline: [] }); // project no longer uses it; only the render lease holds it
    fx.clock.advance(60 * DAY_MS);
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved).toEqual([]);
    expect(await verifyRenderSnapshot(fx.ws, lease!.lease_id)).toEqual({ ok: true, problems: [] });
    await finishRender(fx.ws, { lease_id: lease!.lease_id, outcome: 'completed', actor: 'user' });
    await syncClocks(fx.ws);
    expect((await loadRegistry(fx.ws)).versions[old.version_id]!.unreferenced_since).toBe(fx.clock.now());
    expect(await verifyRenderSnapshot(fx.ws, lease!.lease_id)).toEqual({ ok: false, problems: ['LEASE_UNKNOWN'] });
  });

  it('snapshot check catches bytes changed after the lease was taken', async () => {
    const fx = await projectWithClip();
    const { lease } = await startRender(fx.ws, { project_id: 'promo', output_name: 'x.mp4', estimated_bytes: 1, actor: 'user', disk: roomy });
    const abs = path.join(fx.ws.root, (await loadRegistry(fx.ws)).versions[fx.clip.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'changed mid-render');
    expect(await verifyRenderSnapshot(fx.ws, lease!.lease_id)).toEqual({ ok: false, problems: [`${fx.clip.version_id}: CHANGED`] });
  });
});
