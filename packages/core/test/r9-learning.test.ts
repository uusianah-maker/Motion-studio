// R9: learning notes per brand — the PIC's Revisi notes and an editor's corrections to an engine
// draft (words, hook, cuts), one JSON line each, in .motionstudio/brands/<brand_id>/belajar.jsonl.
import fsp from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { listBrands } from '../src/storage/brand.js';
import { appendLearning, correctionsFrom, engineOrigin, learnFile, markEngineOrigin, readLearning } from '../src/storage/learning.js';
import type { Timeline } from '../src/storage/project.js';
import { decideReview } from '../src/storage/review.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const asal = { kind: 'generate' as const, job_id: 'AYS-20261115-001', at: 1 };
const tl = (sub: string, hook: string, late: string, cut: { start_ms: number; end_ms: number; in_ms?: number }): Timeline => ({
  tracks: [
    { track_id: 'v', kind: 'video', clips: [{ clip_id: 'v1', ...cut, media: { media_id: 'm_1', version_id: 'v_1' } }] },
    { track_id: 't', kind: 'text', clips: [{ clip_id: 'h', start_ms: 0, end_ms: 2000, text: hook }, { clip_id: 'cta', start_ms: 9000, end_ms: 11000, text: late }] },
    { track_id: 's', kind: 'subtitle', clips: [{ clip_id: 's1', start_ms: 0, end_ms: 2000, text: sub }] },
  ],
});

describe('R9 learning notes', () => {
  it('classifies an editor change of an engine draft: words, hook, cuts (not a later text)', () => {
    const before = tl('celana adm banget', 'Diskon 50%', 'Cek keranjang', { start_ms: 0, end_ms: 5000 });
    const after = tl('celana adem banget', 'Diskon 50% hari ini', 'Cek keranjang kuning', { start_ms: 0, end_ms: 4200 });
    const notes = correctionsFrom(
      before,
      [
        { op: 'set_text', clip_id: 's1', text: 'celana adem banget' },
        { op: 'set_text', clip_id: 'h', text: 'Diskon 50% hari ini' },
        { op: 'set_text', clip_id: 'cta', text: 'Cek keranjang kuning' }, // a CTA at 9 s: not the hook
        { op: 'trim_clip', clip_id: 'v1', edge: 'end', to_ms: 4200 },
      ],
      after,
      asal,
    );
    expect(notes.map((n) => (n.jenis === 'koreksi' ? [n.bagian, n.sebelum, n.sesudah] : n.jenis))).toEqual([
      ['kata', 'celana adm banget', 'celana adem banget'],
      ['hook', 'Diskon 50%', 'Diskon 50% hari ini'],
      ['potongan', { start_ms: 0, end_ms: 5000, in_ms: 0 }, { start_ms: 0, end_ms: 4200, in_ms: 0 }],
    ]);
  });

  it('the PIC\'s Revisi note lands in the project\'s brand log; engine origin is a marker on the project', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const b = (await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS' }, actor: 'user' })).result;
    await createProject(ws, { project_id: 'p', name: 'Proyek' });
    await svc.updateProjectMeta({ project_id: 'p', expected_revision: (await readProject(ws, 'p')).revision, brand_id: b.brand_id, actor: 'user' });
    await svc.editTimeline({ project_id: 'p', expected_revision: (await readProject(ws, 'p')).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Hook', start_ms: 0, duration_ms: 1000 }] });
    expect(await engineOrigin(ws, 'p')).toBeNull();
    await markEngineOrigin(ws, 'p', { kind: 'batch', job_id: 'AYS-20261115-002', varian: 'varian-003' });
    expect(await engineOrigin(ws, 'p')).toMatchObject({ kind: 'batch', varian: 'varian-003' });
    await decideReview(ws, { project_id: 'p', expected_revision: (await readProject(ws, 'p')).revision, status: 'revisi', note: 'Logo menutupi produk', author: { email: 'pic@contoh.com', name: 'PIC' } });
    await decideReview(ws, { project_id: 'p', expected_revision: (await readProject(ws, 'p')).revision, status: 'lulus', note: '', author: { email: 'pic@contoh.com', name: 'PIC' } });
    const log = await readLearning(ws, b.brand_id);
    expect(log).toEqual([expect.objectContaining({ schema: 'belajar/1', jenis: 'revisi_pic', brand_id: b.brand_id, project_id: 'p', note: 'Logo menutupi produk', by: 'PIC' })]); // Lulus is no lesson
    expect(learnFile(ws, b.brand_id)).toMatch(/[\\/]brands[\\/][^\\/]+[\\/]belajar\.jsonl$/);
    // Appending never breaks the caller, even for an unknown project.
    expect(await appendLearning(ws, 'tidak-ada', { jenis: 'revisi_pic', revision: 1, note: 'x', by: null })).toBeNull();
    // The brand list still reads fine with the brand's folder next to its file.
    expect((await listBrands(ws)).map((k) => k.brand_id)).toContain(b.brand_id);
    await fsp.access(learnFile(ws, b.brand_id));
  });
});
