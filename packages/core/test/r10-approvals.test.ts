// R10: the PIC's approval queue — rendered videos waiting for Lulus / Revisi, per brand.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalQueue } from '../src/storage/approvals.js';
import { decideReview } from '../src/storage/review.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const PIC = { email: 'pic@contoh.com', name: 'PIC' };

describe('R10 approval queue', () => {
  it('lists projects with a render that are not Lulus for their current revision; oldest render first; brand filter', async () => {
    const { ws } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const ays = (await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS' }, actor: 'user' })).result;
    const bln = (await svc.createBrand({ kit: { name: 'Brand Lain', kode: 'BLN' }, actor: 'user' })).result;
    const render = async (id: string, name: string, at: number) => {
      const f = path.join(ws.root, 'PROJECTS', id, '05_OUTPUT', name);
      await fsp.writeFile(f, 'mp4');
      await fsp.utimes(f, at / 1000, at / 1000);
    };
    const project = async (id: string, brand: string | null, withClip = true) => {
      await createProject(ws, { project_id: id, name: `Proyek ${id}` });
      if (brand) await svc.updateProjectMeta({ project_id: id, expected_revision: (await readProject(ws, id)).revision, brand_id: brand, actor: 'user' });
      if (withClip) await svc.editTimeline({ project_id: id, expected_revision: (await readProject(ws, id)).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Hook', start_ms: 0, duration_ms: 1000 }] });
    };
    const t0 = Date.now() - 100_000;
    await project('baru', ays.brand_id);
    await render('baru', 'baru.mp4', t0 + 2000);
    await project('lulus', ays.brand_id);
    await render('lulus', 'lulus.mp4', t0 + 1000);
    await decideReview(ws, { project_id: 'lulus', expected_revision: (await readProject(ws, 'lulus')).revision, status: 'lulus', note: '', author: PIC });
    await project('revisi', ays.brand_id);
    await render('revisi', 'revisi.mp4', t0);
    await decideReview(ws, { project_id: 'revisi', expected_revision: (await readProject(ws, 'revisi')).revision, status: 'revisi', note: 'Hook terlalu pelan', author: PIC });
    await project('tanpa-render', ays.brand_id);
    await project('lain', bln.brand_id);
    await render('lain', 'lain.mp4', t0 + 500);

    const all = await approvalQueue(ws);
    expect(all.map((i) => [i.project_id, i.state])).toEqual([
      ['lain', 'belum'],
      ['baru', 'belum'],
    ]);
    expect(all[1]).toMatchObject({ brand_id: ays.brand_id, brand_name: 'Aysilla', output: { name: 'baru.mp4' }, outputs: 1, open_comments: 0, last: null });
    expect((await approvalQueue(ws, { brand_id: ays.brand_id })).map((i) => i.project_id)).toEqual(['baru']);

    // The editor fixes the "Revisi" one and re-renders: it is back in the queue as "berubah",
    // with the PIC's earlier note; a Lulus project that changes after approval comes back too.
    for (const id of ['revisi', 'lulus']) await svc.editTimeline({ project_id: id, expected_revision: (await readProject(ws, id)).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Lagi', start_ms: 1000, duration_ms: 500 }] });
    const again = await approvalQueue(ws, { brand_id: ays.brand_id });
    expect(again.map((i) => [i.project_id, i.state])).toEqual([
      ['revisi', 'berubah'],
      ['lulus', 'berubah'],
      ['baru', 'belum'],
    ]);
    expect(again[0]!.last).toEqual({ status: 'revisi', note: 'Hook terlalu pelan', by: 'PIC' });

    // Archived projects are not waiting for anyone.
    await svc.updateProjectMeta({ project_id: 'baru', expected_revision: (await readProject(ws, 'baru')).revision, status: 'archived', actor: 'user' });
    expect((await approvalQueue(ws, { brand_id: ays.brand_id })).map((i) => i.project_id)).toEqual(['revisi', 'lulus']);
  });
});
