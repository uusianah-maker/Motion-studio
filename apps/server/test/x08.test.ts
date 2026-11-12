import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { type AiPlanner, createCopilot } from '../src/copilot.js';
import { createProject, initWorkspace, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(ai?: AiPlanner, mode?: 'local' | 'auto' | 'ai') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x08-'));
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

describe('X08 Brand guard API', () => {
  it('brand-check lists issues; Copilot refuses to write banned claims; render flag type-checked', async () => {
    const s = await setup();
    const kit = { name: 'Toko', colors: [], text_color: '#ffffff', font: null, logo: null, guard: { prices: [{ text: 'Rp99.000', valid_until: '2020-01-01' }], banned: ['paling murah'], banned_level: 'block' } };
    expect((await s.call('/api/brand', { expected_revision: 0, kit })).status).toBe(200);
    expect((await s.call('/api/brand', { expected_revision: 1, kit: { ...kit, guard: { banned: ['x'] } } })).status).toBe(422);

    // Copilot (local) refuses new text with a banned claim or an expired price.
    for (const prompt of ['tambah teks "Ini paling murah" detik 0-2', 'tambah teks "Cuma Rp 99.000" detik 0-2']) {
      const r = await s.plan(prompt);
      expect(r.status, prompt).toBe(422);
      expect(r.json.error.message).toMatch(/Rencana ditolak Brand guard/);
    }
    expect((await s.plan('tambah teks "Harga spesial" detik 0-2')).status).toBe(200);

    // Text already on the timeline (typed by hand) → brand-check shows it.
    await s.call('/api/projects/p1/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'text', text: 'Paling murah!', start_ms: 0, duration_ms: 1500 }] });
    const chk = await s.call('/api/projects/p1/brand-check');
    expect(chk.status).toBe(200);
    expect(chk.json.issues).toEqual([expect.objectContaining({ kind: 'BANNED_CLAIM', level: 'block', match: 'paling murah', start_ms: 0, text: 'Paling murah!' })]);
    expect(chk.json.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Render route: flag type-checked.
    expect((await s.call('/api/projects/p1/render', { accept_brand_warnings: 'ya' })).status).toBe(400);
    expect((await readProject(s.ws, 'p1')).revision).toBe(1);
  });
});
