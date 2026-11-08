import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeGoogle } from '../../../scripts/fake-google.mjs';
import { HOST, createApp } from '../src/app.js';
import { createGoogleAuth } from '../src/auth.js';
import { type AiPlanner, createCopilot } from '../src/copilot.js';
import { createProject, initWorkspace } from '../src/core.js';
import { start } from '../src/main.js';
import { createRenderJobs } from '../src/render.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-cpE-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
function call(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
    const data = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const r = http.request({ host: HOST, port, path: p, method: o.method ?? (data ? 'POST' : 'GET'), headers: { host: `${HOST}:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(t || 'null');
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

describe('Checkpoint E regressions (server)', () => {
  it('E2: a public https URL without Google login refuses to start (no token-only public access)', async () => {
    const dir = await tmp();
    const ws = path.join(dir, 'ws');
    await initWorkspace(ws);
    await expect(start({ MOTION_WORKSPACE: ws, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_STATE_DIR: path.join(dir, 's'), MOTION_PUBLIC_URL: 'https://motion.example.com' }, () => undefined)).rejects.toThrow(/butuh login Google/);
  });

  it('E3: flooding /api/auth/login does not break a real login in progress', async () => {
    const dir = await tmp();
    const g = await startFakeGoogle({ clientId: 'c.apps.googleusercontent.com', clientSecret: 's' });
    cleanup.push(() => g.close());
    const ws = await initWorkspace(path.join(dir, 'ws'));
    let port = 0;
    const auth = createGoogleAuth({ ws, clientId: 'c.apps.googleusercontent.com', clientSecret: 's', allowedEmails: ['owner@example.com'], publicUrl: () => `http://${HOST}:${port}`, authEndpoint: g.authUrl, tokenEndpoint: g.tokenUrl });
    const app = createApp({ ws, auth });
    port = await app.listen(0);
    cleanup.push(() => app.close());
    const mine = await call(port, '/api/auth/login');
    const cookie = String((mine.headers['set-cookie'] as string[])[0]).split(';')[0]!;
    for (let i = 0; i < 700; i++) await call(port, '/api/auth/login'); // attacker
    const back = new URL((await fetch(mine.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    const done = await call(port, `${back.pathname}${back.search}`, { headers: { cookie } });
    expect(done.headers.location).toBe('/');
    expect(String(done.headers['set-cookie'])).toMatch(/motion_sid=[A-Za-z0-9_-]{43}/);
    // The sealed state cookie carries no readable verifier/nonce.
    expect(cookie).toMatch(/^motion_oauth=v1\./);
    expect(cookie).not.toContain(new URL(mine.headers.location!).searchParams.get('nonce')!);
  });

  it('E7 + E8: preview diff of the ticked subset; junk fields from an AI planner are sanitised', async () => {
    const dir = await tmp();
    const ws = await initWorkspace(path.join(dir, 'ws'));
    await createProject(ws, { project_id: 'p1', name: 'P' });
    const ai: AiPlanner = {
      unavailable: async () => null,
      plan: async () =>
        ({
          ops: [{ op: 'add_clip', track_kind: 'text', text: 'A', start_ms: 0, duration_ms: 1000 }],
          rationale: { evil: true },
          warnings: 'not-a-list',
          provider: { connection_id: 'x'.repeat(500), provider: 7, model: 'm' },
          cost_usd: -5,
        }) as unknown as Awaited<ReturnType<AiPlanner['plan']>>,
    };
    const copilot = createCopilot(ws, { ai, mode: () => 'auto' });
    const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes] });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const h = { authorization: `Bearer ${app.token}` };
    const r = await call(port, '/api/projects/p1/copilot/plan', { headers: h, body: { prompt: 'sesuatu yang aneh' } });
    expect(r.status).toBe(200);
    expect(r.json.plan).toMatchObject({ rationale: '', warnings: [], cost_estimate: { usd: 0 }, provider: { provider: '', model: 'm' } });
    expect(r.json.plan.provider.connection_id).toHaveLength(64);

    const two = await call(port, '/api/projects/p1/copilot/plan', { headers: h, body: { prompt: 'hook "A" 2 detik; subtitle "B" detik 2-4' } });
    const pid = two.json.plan.plan_id;
    const sub = await call(port, `/api/projects/p1/copilot/plans/${pid}/preview`, { headers: h, body: { accept: [1] } });
    expect(sub.json.diff.map((d: { summary: string }) => d.summary)).toEqual(['+ subtitle “B” 0:02–0:04']);
    await call(port, '/api/projects/p1/edit', { headers: h, body: { expected_revision: 0, ops: [{ op: 'set_canvas', ratio: '1:1' }] } });
    expect((await call(port, `/api/projects/p1/copilot/plans/${pid}/preview`, { headers: h, body: { accept: [0] } })).status).toBe(409);
  });

  it('E9: render jobs run as the caller, so an AI caller is refused by the core', async () => {
    const dir = await tmp();
    const ws = await initWorkspace(path.join(dir, 'ws'));
    await createProject(ws, { project_id: 'p1', name: 'P' });
    const jobs = createRenderJobs(ws, { tmpRoot: dir });
    cleanup.push(() => jobs.stopAll());
    const j = jobs.start({ project_id: 'p1', output_name: 'x.mp4', actor: 'ai' });
    for (let i = 0; i < 50 && jobs.get(j.job_id)?.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(jobs.get(j.job_id)).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
  });
});
