import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPlan, planLocal } from '../src/storage/copilot.js';
import { loadLeases } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import type { Timeline } from '../src/storage/project.js';
import { DEFAULT_RENDER, MAX_RENDER_SEGMENTS, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { MAX_TIMELINE_CLIPS, applyOps } from '../src/storage/timeline.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.MOTION_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const M = { media_id: 'm_1', version_id: 'v_1' };
let n = 0;
const ids = () => `c_${++n}`;

describe('Checkpoint E regressions', () => {
  const base: Timeline = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 10_000 }], ids);

  it('E1: plans may only reference clips that exist now (no plan-internal ids that break on apply)', () => {
    const r = planLocal('potong di detik 3; potong di detik 6', { timeline: base });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toMatch(/Jalankan perintah pertama dulu/);
    const r2 = planLocal('tambah teks "Baru" detik 12-14 lalu hapus semua teks', { timeline: base });
    expect(r2.ok).toBe(false);
    expect(code(() => checkPlan(base, [{ op: 'add_clip', track_kind: 'text', text: 'x', start_ms: 0, duration_ms: 1000 }, { op: 'delete_clip', clip_id: 'plan_new_1' }]))).toBe('EDIT_INVALID');
    // Single-step plans on existing clips still work.
    expect(planLocal('potong di detik 3', { timeline: base }).ok).toBe(true);
  });

  it('E4: a very fragmented timeline is refused up front with a clear reason (Windows command-line limit)', () => {
    const clips = Array.from({ length: MAX_RENDER_SEGMENTS }, (_, i) => ({ clip_id: `c${i}`, start_ms: i * 200, end_ms: i * 200 + 100, in_ms: 0, media: M }));
    const t: Timeline = { tracks: [{ track_id: 'video', kind: 'video', clips }] };
    const inputs = new Map([['v_1', { path: 'src.mp4', probe: { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' } }]]);
    let msg = '';
    try {
      buildRenderPlan(t, inputs, DEFAULT_RENDER, null);
    } catch (e) {
      msg = isStorageError(e) ? `${e.code}:${e.message}` : String(e);
    }
    expect(msg).toMatch(/^PRECONDITION:Linimasa terlalu banyak potongan \(\d+ segmen visual\); maksimal 200/);
    const few: Timeline = { tracks: [{ track_id: 'video', kind: 'video', clips: clips.slice(0, 50) }] };
    expect(buildRenderPlan(few, inputs, DEFAULT_RENDER, null).args.join(' ').length).toBeLessThan(32_767);
  });

  it('E10: clips per timeline are capped', () => {
    const many: Timeline = { tracks: [{ track_id: 'text', kind: 'text', clips: Array.from({ length: MAX_TIMELINE_CLIPS }, (_, i) => ({ clip_id: `t${i}`, start_ms: i * 200, end_ms: i * 200 + 100, text: 'x' })) }] };
    expect(code(() => applyOps(many, [{ op: 'add_clip', track_kind: 'text', text: 'y', start_ms: MAX_TIMELINE_CLIPS * 200 + 1000, duration_ms: 500 }], ids))).toBe('EDIT_INVALID');
  });

  it.skipIf(!hasFfmpeg)('E5: a cancel that lands while the output is being staged still saves nothing', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const r = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'promo', name: 'P' });
    const p = await readProject(fx.ws, 'promo');
    await svc.editTimeline({ project_id: 'promo', expected_revision: p.revision, ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: r.media.media_id, version_id: r.version.version_id }, start_ms: 0, duration_ms: 1000 }], actor: 'user' });
    const ac = new AbortController();
    const stage = fx.ws.blobs.stage.bind(fx.ws.blobs);
    (fx.ws.blobs as { stage: typeof stage }).stage = async (...a: Parameters<typeof stage>) => {
      const s = await stage(...a);
      ac.abort(); // the user clicks "Batalkan" right now
      return s;
    };
    let c = 'OK';
    try {
      await renderProject(fx.ws, { project_id: 'promo', output_name: 'late.mp4', actor: 'user' }, { settings: { short_side: 240, preset: 'ultrafast' }, signal: ac.signal });
    } catch (e) {
      c = isStorageError(e) ? e.code : String(e);
    }
    expect(c).toBe('CANCELLED');
    expect(await listOutputs(fx.ws, 'promo')).toEqual([]);
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
  }, 60_000);
});
