// PC-R4: in the Setujui (R10) screen, Lulus on a VARIANT also approves it for mass render, and
// Revisi withdraws that approval. A refused decision changes nothing.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { StorageService, createProject, initWorkspace, readProject, variantState } from '../src/core.js';
import { reviewRoutes } from '../src/review.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-pcr4-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'm', name: 'Master' });
  const svc = new StorageService(ws);
  await svc.editTimeline({ project_id: 'm', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 1000 }] });
  const vid = (await svc.createVariants({ master_id: 'm', briefs: [{ label: 'V1', hook: 'Hook B' }], actor: 'user' })).result[0]!.project_id;
  const app = createApp({ ws, roleOf: () => 'reviewer', routes: [...apiRoutes({ tmpDir: dir }), ...reviewRoutes(ws)] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  return { ws, svc, vid, call };
}

describe('PC-R4 review decision drives variant approval', () => {
  it('Lulus on a variant approves it for mass render; the decision stays "lulus" on the new revision', async () => {
    const { ws, vid, call } = await setup();
    const before = await readProject(ws, vid);
    expect(variantState(before)).toBe('draft');
    const r = await call(`/api/projects/${vid}/review`, { expected_revision: before.revision, status: 'lulus' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'lulus', variant_approved: true, revision: before.revision + 1 });
    const after = await readProject(ws, vid);
    expect(variantState(after)).toBe('approved');
    expect((await call(`/api/projects/${vid}/review`)).json.review).toMatchObject({ state: 'lulus', revision: after.revision });
    // Lulus again on an already-approved variant does not bump the revision.
    const again = await call(`/api/projects/${vid}/review`, { expected_revision: after.revision, status: 'lulus' });
    expect(again.json).toMatchObject({ state: 'lulus' });
    expect((await readProject(ws, vid)).revision).toBe(after.revision);
    // Mass render now picks it up as approved (not "belum disetujui").
    const mass = await call('/api/projects/m/variants');
    expect(mass.json.variants[0]).toMatchObject({ state: 'approved' });
  });

  it('Revisi on an approved variant withdraws the approval; the revisi stays with the editor', async () => {
    const { ws, svc, vid, call } = await setup();
    const p = await readProject(ws, vid);
    await svc.setVariantApproval({ project_id: vid, expected_revision: p.revision, approved: true, actor: 'user' });
    const approved = await readProject(ws, vid);
    expect(variantState(approved)).toBe('approved');
    const r = await call(`/api/projects/${vid}/review`, { expected_revision: approved.revision, status: 'revisi', note: 'Hook kurang jelas' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'revisi', variant_approved: false });
    const after = await readProject(ws, vid);
    expect(variantState(after)).toBe('draft');
    // Recorded on the latest revision → not shown back in the PIC queue as "berubah".
    expect(r.json.decision.revision).toBe(after.revision);
  });

  it('a refused decision leaves the variant approval untouched (open comment, empty note, stale revision)', async () => {
    const { ws, vid, call } = await setup();
    const p = await readProject(ws, vid);
    expect((await call(`/api/projects/${vid}/comments`, { at_ms: 0, text: 'Ganti warna' })).status).toBe(200);
    expect((await call(`/api/projects/${vid}/review`, { expected_revision: p.revision, status: 'lulus' })).status).toBe(422);
    expect((await call(`/api/projects/${vid}/review`, { expected_revision: p.revision, status: 'revisi', note: ' ' })).status).toBe(422);
    expect((await call(`/api/projects/${vid}/review`, { expected_revision: p.revision - 1, status: 'lulus' })).status).toBe(409);
    const after = await readProject(ws, vid);
    expect([after.revision, variantState(after)]).toEqual([p.revision, 'draft']);
  });

  it('a normal (non-variant) project is unchanged: no approval commit', async () => {
    const { ws, call } = await setup();
    const m = await readProject(ws, 'm');
    const r = await call('/api/projects/m/review', { expected_revision: m.revision, status: 'lulus' });
    expect(r.json).toMatchObject({ state: 'lulus' });
    expect(r.json.variant_approved).toBeUndefined();
    expect((await readProject(ws, 'm')).revision).toBe(m.revision);
  });
});
