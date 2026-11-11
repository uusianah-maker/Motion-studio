import { describe, expect, it } from 'vitest';
import { planLocal } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { loadRegistry, saveRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { type Timeline, applyOps } from '../src/storage/timeline.js';
import { createProject, listProjectIds, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const ref = await importShared(fx.ws, fx.src, 'vid');
  await createProject(fx.ws, { project_id: 'promo', name: 'Promo' });
  await svc.editTimeline({ project_id: 'promo', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 3000 }] });
  return { ...fx, svc, ref };
}

describe('Checkpoint G regressions (X01–X05 review)', () => {
  it('G-1: a damaged media file does not block rename/archive (timeline unchanged), but still blocks edits', async () => {
    const { ws, svc, ref } = await setup();
    const reg = await loadRegistry(ws);
    reg.versions[ref.version_id]!.integrity = 'changed';
    await saveRegistry(ws, reg);
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 1, name: 'Promo rusak', actor: 'user' }))).toBe('OK');
    expect(await code(() => svc.updateProjectMeta({ project_id: 'promo', expected_revision: 2, status: 'archived', actor: 'user' }))).toBe('OK');
    expect((await readProject(ws, 'promo')).status).toBe('archived');
    await svc.updateProjectMeta({ project_id: 'promo', expected_revision: 3, status: 'active', actor: 'user' });
    // A real timeline change still needs usable media (relink first).
    expect(await code(() => svc.editTimeline({ project_id: 'promo', expected_revision: 4, actor: 'user', ops: [{ op: 'set_canvas', ratio: '1:1' }] }))).toBe('INTEGRITY');
    // A brand-new project with that media (duplicate) is refused too, and leaves nothing behind.
    const before = await listProjectIds(ws);
    expect(await code(() => svc.duplicateProject({ project_id: 'promo', actor: 'user' }))).toBe('INTEGRITY');
    expect(await listProjectIds(ws)).toEqual(before);
  });

  it('G-2: import remaps a known-but-trashed version to another active copy with the same bytes', async () => {
    const { ws, svc, src, ref } = await setup();
    const exp = await svc.exportProject('promo');
    const other = await importShared(ws, src, 'copy');
    const reg = await loadRegistry(ws);
    reg.versions[other.version_id]!.content_hash = reg.versions[ref.version_id]!.content_hash; // identical bytes
    reg.versions[ref.version_id]!.lifecycle = 'trashed';
    await saveRegistry(ws, reg);
    const r = (await svc.importProject({ data: exp, actor: 'user' })).result;
    expect(r.remapped).toBe(1);
    expect(r.project.timeline.tracks[0]!.clips[0]!.media).toEqual(other);
  });

  it('G-4: colour words never resolve to inherited object keys ("constructor", "__proto__")', () => {
    const t: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'text', text: 'A', start_ms: 0, duration_ms: 1000 }], () => 'c_1');
    for (const w of ['constructor', 'tostring', '__proto__', 'hasownproperty']) {
      const r = planLocal(`warna teks ${w}`, { timeline: t, selected_clip_ids: ['c_1'] });
      expect(r.ok ? 'OK' : r.message, w).toMatch(/Gaya apa yang mau diubah/);
    }
  });
});
