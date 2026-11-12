import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { StorageService } from '../src/storage/service.js';
import { presetById } from '../src/storage/textPresets.js';
import { type Timeline, applyOps } from '../src/storage/timeline.js';
import { validateBriefs, variantOps, variantState } from '../src/storage/variants.js';
import { createProject, listProjectIds, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const M = { media_id: 'm_1', version_id: 'v_1' };
let n = 0;
const ids = () => `c_${++n}`;

describe('X09 variants', () => {
  const master: Timeline = applyOps(
    { tracks: [] },
    [
      { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 10_000 },
      { op: 'add_clip', track_kind: 'text', text: 'Hook lama', start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'text', text: 'Isi', start_ms: 4000, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'text', text: 'CTA lama', start_ms: 7000, duration_ms: 3000 },
    ],
    ids,
  );
  const [hook, , cta] = master.tracks.find((t) => t.kind === 'text')!.clips;

  it('briefs: ratio/hook/CTA, auto label, refusals', () => {
    expect(validateBriefs([{ ratio: '1:1', hook: '  Stop  scroll ' }])).toEqual([{ label: '1:1 · Hook “Stop  scroll”', ratio: '1:1', hook: 'Stop  scroll' }]);
    expect(validateBriefs([{ label: 'TOFU', cta: 'Beli sekarang' }])[0]).toEqual({ label: 'TOFU', cta: 'Beli sekarang' });
    for (const bad of [[], Array(9).fill({ ratio: '1:1' }), [{}], [{ ratio: '21:9' }], [{ hook: 5 }], [{ hook: 'x', owner: 1 }], 'semua']) {
      expect(() => validateBriefs(bad), JSON.stringify(bad).slice(0, 40)).toThrow();
    }
  });

  it('ops: replace the existing hook (first text ≤3 s) and CTA (text at the end); add preset clips when missing', () => {
    expect(variantOps(master, { ratio: '3:4', hook: 'Hook baru', cta: 'CTA baru' })).toEqual([
      { op: 'set_canvas', ratio: '3:4' },
      { op: 'set_text', clip_id: hook!.clip_id, text: 'Hook baru' },
      { op: 'set_text', clip_id: cta!.clip_id, text: 'CTA baru' },
    ]);
    const bare: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 8000 }], ids);
    const ops = variantOps(bare, { hook: 'H', cta: 'C' });
    expect(ops).toEqual([
      { op: 'add_clip', track_kind: 'text', text: 'H', style: presetById('hook')!.style, start_ms: 0, duration_ms: 2000 },
      { op: 'add_clip', track_kind: 'text', text: 'C', style: presetById('cta')!.style, start_ms: 5000, duration_ms: 3000 },
    ]);
    expect(() => applyOps(bare, ops, ids)).not.toThrow();
    // Short master (1.5 s, no text): new hook takes the first half, the new CTA the rest — no overlap.
    const short: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 1500 }], ids);
    const sops = variantOps(short, { hook: 'H', cta: 'C' });
    expect(sops.map((o) => o.op === 'add_clip' && [o.start_ms, o.duration_ms])).toEqual([
      [0, 750],
      [750, 750],
    ]);
    expect(() => applyOps(short, sops, ids)).not.toThrow();
    const tiny: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 800 }], ids);
    expect(() => variantOps(tiny, { hook: 'H', cta: 'C' })).toThrow(/terlalu pendek/);
  });

  it('create: one project per brief, master untouched, approval tied to the revision, render list = approved & unchanged', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const ref = await importShared(fx.ws, fx.src, 'v');
    await createProject(fx.ws, { project_id: 'master', name: 'Promo' });
    await svc.editTimeline({
      project_id: 'master',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 6000 },
        { op: 'add_clip', track_kind: 'text', text: 'Hook A', start_ms: 0, duration_ms: 2000 },
      ],
    });
    const before = await readProject(fx.ws, 'master');
    const made = (await svc.createVariants({ master_id: 'master', briefs: [{ label: 'V1', ratio: '1:1' }, { hook: 'Hook B', cta: 'Join live' }], actor: 'user' })).result;
    expect(made.map((p) => p.name)).toEqual(['Promo · V1', 'Promo · Hook “Hook B” · CTA “Join live”']);
    expect(made[0]!.timeline.canvas).toEqual({ ratio: '1:1' });
    expect(made[1]!.timeline.tracks.find((t) => t.kind === 'text')!.clips.map((c) => c.text)).toEqual(['Hook B', 'Join live']);
    expect(made.every((p) => p.variant?.master_id === 'master' && p.variant.approved_revision === null && p.revision === 1)).toBe(true);
    expect(made.map((p) => p.variant!.number)).toEqual([1, 2]);
    expect(await readProject(fx.ws, 'master')).toEqual(before); // master untouched
    expect((await svc.listVariants('master')).map((p) => p.project_id)).toEqual(made.map((p) => p.project_id));

    const v1 = made[0]!.project_id;
    const ap = (await svc.setVariantApproval({ project_id: v1, expected_revision: 1, approved: true, actor: 'user' })).result;
    expect(ap.variant!.approved_revision).toBe(2);
    expect(variantState(ap)).toBe('approved');
    await svc.editTimeline({ project_id: v1, expected_revision: 2, actor: 'user', ops: [{ op: 'set_canvas', ratio: '16:9' }] });
    const edited = await readProject(fx.ws, v1);
    expect(variantState(edited)).toBe('changed'); // edited after approval
    expect(edited.variant!.label).toBe('V1'); // the tag survives edits
    expect(variantState(made[1]!)).toBe('draft');

    // Refusals: variant of a variant, empty master, bad approval, AI actor, a brief that would collide.
    expect(await code(() => svc.createVariants({ master_id: v1, briefs: [{ ratio: '1:1' }], actor: 'user' }))).toBe('EDIT_INVALID');
    await createProject(fx.ws, { project_id: 'empty', name: 'E' });
    expect(await code(() => svc.createVariants({ master_id: 'empty', briefs: [{ ratio: '1:1' }], actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.setVariantApproval({ project_id: 'master', expected_revision: 1, approved: true, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.setVariantApproval({ project_id: v1, expected_revision: 3, approved: 'ya', actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => svc.createVariants({ master_id: 'master', briefs: [{ ratio: '1:1' }], actor: 'ai' }))).toBe('FORBIDDEN');
    const count = (await listProjectIds(fx.ws)).length;
    expect(await code(() => svc.createVariants({ master_id: 'master', briefs: [{ ratio: '1:1' }, { ratio: '42:1' }], actor: 'user' }))).toBe('EDIT_INVALID');
    expect((await listProjectIds(fx.ws)).length).toBe(count); // all-or-nothing on bad briefs
  });

  it('stored manifests validate the variant tag', () => {
    const base = { schema_version: 1, project_id: 'p', name: 'P', status: 'active', revision: 1, created_at: 1, updated_at: 1, snapshots: [], timeline: { tracks: [] } };
    const ok = { master_id: 'm', number: 1, label: 'L', brief: { ratio: '1:1' }, approved_revision: null };
    expect(validateProjectManifest({ ...base, variant: ok }).variant).toEqual(ok);
    for (const bad of [{ ...ok, master_id: '../x' }, { ...ok, brief: { ratio: '2:1' } }, { ...ok, approved_revision: -1 }, { ...ok, label: '' }, { ...ok, number: 0 }]) {
      expect(() => validateProjectManifest({ ...base, variant: bad })).toThrow();
    }
  });
});
