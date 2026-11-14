import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { type AiPlanner, createCopilot } from '../src/copilot.js';
import { StorageService, createProject, initWorkspace, readProject } from '../src/core.js';
import { execFileSync } from 'node:child_process';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(ai?: AiPlanner, mode?: 'local' | 'auto' | 'ai') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x09-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'Promo' });
  await createProject(ws, { project_id: 'p2', name: 'Lain' });
  const copilot = createCopilot(ws, { ...(ai ? { ai } : {}), ...(mode ? { mode: () => mode } : {}) });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown, method?: string) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: method ?? (data ? 'POST' : 'GET'), headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  const plan = (prompt: string, extra: Record<string, unknown> = {}, project = 'p1') => call(`/api/projects/${project}/copilot/plan`, { prompt, ...extra });
  const apply = (planId: string, body: Record<string, unknown>, project = 'p1') => call(`/api/projects/${project}/copilot/plans/${planId}/apply`, body);
  return { ws, call, plan, apply, copilot };
}

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const FIX = path.resolve(__dirname, '../../../audit/T01/fixtures/sample_3s_16x9.mp4');

describe('X09 variants API', () => {
  it.skipIf(!hasFfmpeg)('create → list → approve → render only approved & unchanged → outputs per variant', async () => {
    const s = await setup();
    const imp = await new StorageService(s.ws).importMedia({ sourcePath: FIX, scope: { kind: 'shared' }, actor: 'user' });
    await s.call('/api/projects/p1/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 1500 }] });
    const made = await s.call('/api/projects/p1/variants', { briefs: [{ label: 'Kotak', ratio: '1:1' }, { hook: 'Stop scroll', cta: 'Beli sekarang' }, { ratio: '16:9' }] });
    expect(made.status).toBe(200);
    expect(made.json.variants.map((v: { number: number; state: string; ratio: string }) => [v.number, v.state, v.ratio])).toEqual([
      [1, 'draft', '1:1'],
      [2, 'draft', '9:16'],
      [3, 'draft', '16:9'],
    ]);
    const [v1, v2, v3] = made.json.variants;
    // The project list marks variants.
    const list = (await s.call('/api/projects')).json.projects;
    expect(list.find((p: { project_id: string }) => p.project_id === v1.project_id).variant).toEqual({ master_id: 'p1', number: 1, state: 'draft' });

    expect((await s.call(`/api/projects/${v1.project_id}/variant-approval`, { expected_revision: 1, approved: true })).status).toBe(200);
    expect((await s.call(`/api/projects/${v2.project_id}/variant-approval`, { expected_revision: 1, approved: true })).status).toBe(200);
    await s.call(`/api/projects/${v2.project_id}/edit`, { expected_revision: 2, ops: [{ op: 'set_canvas', ratio: '3:4' }] }); // changed after approval
    expect((await s.call(`/api/projects/${v3.project_id}/variant-approval`, { expected_revision: 1, approved: 'ya' })).status).toBe(422);
    expect((await s.call('/api/projects/p1/variant-approval', { expected_revision: 1, approved: true })).status).toBe(422);

    const r = await s.call('/api/projects/p1/variants/render', { short_side: 720 });
    expect(r.status).toBe(200);
    expect(r.json.jobs.map((j: { project_id: string }) => j.project_id)).toEqual([v1.project_id]);
    expect(r.json.skipped).toEqual([
      { project_id: v2.project_id, reason: 'diubah setelah disetujui' },
      { project_id: v3.project_id, reason: 'belum disetujui' },
    ]);
    // Audit Jenius #1: a single render of a variant follows the same rule (no way around approval).
    for (const [v, why] of [[v3, 'belum disetujui'], [v2, 'diubah setelah disetujui']] as const) {
      const single = await s.call(`/api/projects/${v.project_id}/render`, {});
      expect(single.status).toBe(409);
      expect(single.json.error).toMatchObject({ code: 'NOT_APPROVED' });
      expect(single.json.error.message).toContain(why);
    }
    let rows: { project_id: string; render: { status: string } | null; outputs: number; state: string }[] = [];
    for (let i = 0; i < 200; i++) {
      rows = (await s.call('/api/projects/p1/variants')).json.variants;
      if (rows[0]!.render?.status === 'completed') break;
      await new Promise((res) => setTimeout(res, 150));
    }
    expect(rows.map((v) => [v.state, v.render?.status ?? null, v.outputs])).toEqual([
      ['approved', 'completed', 1],
      ['changed', null, 0],
      ['draft', null, 0],
    ]);
    // A second run continues the numbering.
    const more = await s.call('/api/projects/p1/variants', { briefs: [{ ratio: '3:4' }] });
    expect(more.json.variants[0].number).toBe(4);
    expect((await s.call('/api/projects/p1/variants', { briefs: [] })).status).toBe(422);
    expect((await readProject(s.ws, 'p1')).revision).toBe(1); // master never touched
  }, 90_000);
});
