// R19 "Kirim ke PIC": one click renders the newest revision; once done it waits in the PIC's queue
// (3. Setujui) as "Revisi n"; the same revision is not sent twice; a Batch variant changed after
// its approval loses that approval and is still rendered for review. Real FFmpeg, tiny render.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { StorageService, createProject, initWorkspace, readProject, variantState } from '../src/core.js';
import { createRenderJobs } from '../src/render.js';
import { reviewRoutes } from '../src/review.js';
import type { Role } from '../src/roles.js';
import { apiRoutes } from '../src/routes.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r19-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const src = path.join(dir, 'klip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
  const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
  const media = { media_id: v.media.media_id, version_id: v.version.version_id };
  await createProject(ws, { project_id: 'p', name: 'Promo' });
  await svc.editTimeline({ project_id: 'p', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 1000 }] });
  const renderTmp = path.join(dir, 'rtmp');
  await fsp.mkdir(renderTmp);
  const jobs = createRenderJobs(ws, { tmpRoot: renderTmp, settings: { short_side: 240, preset: 'ultrafast' } });
  let role: Role = 'editor';
  const app = createApp({ ws, roleOf: () => role, routes: [...apiRoutes({ tmpDir: dir }, undefined, jobs), ...reviewRoutes(ws)] });
  const port = await app.listen(0);
  cleanup.push(async () => {
    await jobs.stopAll();
    await app.close();
  });
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
  const sent = async (pid: string) => {
    for (let i = 0; i < 300; i++) {
      const k = (await call(`/api/projects/${pid}/kirim-pic`)).json.kirim;
      if (k && k.state !== 'merender') return k;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('render timeout');
  };
  return { ws, svc, media, call, sent, asRole: (r: Role) => (role = r) };
}

describe('R19 Kirim ke PIC', () => {
  it.skipIf(!hasFfmpeg)('render → in the PIC queue as "Revisi 1"; same revision refused; after an edit → "Revisi 2"', async () => {
    const { ws, svc, call, sent, asRole } = await setup();
    const rev = (await readProject(ws, 'p')).revision;
    expect((await call('/api/projects/p/kirim-pic')).json.kirim).toBeNull();
    const k1 = await call('/api/projects/p/kirim-pic', { expected_revision: rev });
    expect(k1.status).toBe(200);
    expect(k1.json.kirim).toMatchObject({ revision: rev, kiriman: 1, state: 'merender' });
    // While it renders, a second click is refused (no double render).
    const busy = await call('/api/projects/p/kirim-pic', { expected_revision: rev });
    expect([409]).toContain(busy.status);
    expect((await sent('p')).state).toBe('terkirim');
    const q = (await call('/api/review/antrean')).json.items;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ project_id: 'p', revision: rev, kiriman: 1, state: 'belum' });
    // Nothing changed since: not sent again.
    const again = await call('/api/projects/p/kirim-pic', { expected_revision: rev });
    expect([again.status, again.json.error.code, again.json.error.message]).toEqual([409, 'SUDAH_DIKIRIM', 'Sudah dikirim ke PIC, tidak ada perubahan sejak kiriman terakhir']);
    // A stale page is told to reload.
    expect((await call('/api/projects/p/kirim-pic', { expected_revision: rev - 1 })).status).toBe(409);
    // Edit → send again → "Revisi 2".
    await svc.editTimeline({ project_id: 'p', expected_revision: rev, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 500 }] });
    const k2 = await call('/api/projects/p/kirim-pic', { expected_revision: rev + 1 });
    expect(k2.json.kirim).toMatchObject({ revision: rev + 1, kiriman: 2 });
    expect((await sent('p')).state).toBe('terkirim');
    expect((await call('/api/review/antrean')).json.items[0]).toMatchObject({ kiriman: 2, revision: rev + 1 });
    // Reviewer cannot send (role table: everything else is Owner / Editor).
    asRole('reviewer');
    expect((await call('/api/projects/p/kirim-pic', { expected_revision: rev + 1 })).status).toBe(403);
  }, 120_000);

  it.skipIf(!hasFfmpeg)('a variant changed after approval: approval withdrawn, rendered anyway for review; Lulus re-approves (PC-R4)', async () => {
    const { ws, svc, media, call, sent, asRole } = await setup();
    const vid = (await svc.createVariants({ master_id: 'p', briefs: [{ label: 'V1', hook: 'Hook B' }], actor: 'user' })).result[0]!.project_id;
    const p0 = await readProject(ws, vid);
    await svc.setVariantApproval({ project_id: vid, expected_revision: p0.revision, approved: true, actor: 'user' });
    const p1 = await readProject(ws, vid);
    await svc.editTimeline({ project_id: vid, expected_revision: p1.revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 1000, duration_ms: 500 }] });
    const p2 = await readProject(ws, vid);
    expect(variantState(p2)).toBe('changed');
    // A plain render of a changed variant is still refused…
    expect((await call(`/api/projects/${vid}/render`, {})).json.error.code).toBe('NOT_APPROVED');
    // …but "Kirim ke PIC" withdraws the old approval and renders it for review.
    const k = await call(`/api/projects/${vid}/kirim-pic`, { expected_revision: p2.revision });
    expect(k.status).toBe(200);
    const p3 = await readProject(ws, vid);
    expect([p3.variant!.approved_revision, variantState(p3)]).toEqual([null, 'draft']);
    expect(k.json.revision).toBe(p3.revision);
    expect((await sent(vid)).state).toBe('terkirim');
    const item = (await call('/api/review/antrean')).json.items.find((x: { project_id: string }) => x.project_id === vid);
    expect(item).toMatchObject({ revision: p3.revision, kiriman: 1 });
    // The PIC's Lulus approves it for mass render again (PC-R4).
    asRole('reviewer');
    const lulus = await call(`/api/projects/${vid}/review`, { expected_revision: p3.revision, status: 'lulus' });
    expect(lulus.json).toMatchObject({ state: 'lulus', variant_approved: true });
  }, 120_000);
});
