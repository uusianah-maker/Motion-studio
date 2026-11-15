// R22: the project list carries each project's feature (stored, or guessed for old projects);
// a feature page creates its project with `fitur`; Edit's create has none → editor.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createProject, initWorkspace, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r22-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const app = createApp({ ws, roleOf: () => 'editor', routes: apiRoutes({ tmpDir: dir }) });
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
  return { ws, call };
}

describe('R22 project feature over the API', () => {
  it('create with fitur stores it; without → editor; unknown → 400 and nothing made', async () => {
    const { ws, call } = await setup();
    const bs = await call('/api/projects', { name: 'Beat Spot Aysilla', fitur: 'beatspot' });
    expect(bs.json.project).toMatchObject({ fitur: 'beatspot' });
    expect((await readProject(ws, bs.json.project.project_id)).fitur).toBe('beatspot');
    expect((await call('/api/projects', { name: 'Promo' })).json.project).toMatchObject({ fitur: 'editor' });
    const bad = await call('/api/projects', { name: 'X', fitur: 'tiktok' });
    expect(bad.status).toBe(400);
    expect((await call('/api/projects')).json.projects).toHaveLength(2);
  });

  it('the list guesses old projects by name; a broken manifest still shows as an error row', async () => {
    const { ws, call } = await setup();
    await createProject(ws, { project_id: 'b1', name: 'Batch Sore · 15 Nov' });
    await createProject(ws, { project_id: 't1', name: 'Motion Transfer Gamis' });
    await createProject(ws, { project_id: 'e1', name: 'Promo Lebaran' });
    await fsp.mkdir(path.join(ws.root, 'PROJECTS', 'rusak'));
    const list = (await call('/api/projects')).json.projects as { project_id: string; fitur?: string; error?: string }[];
    expect(Object.fromEntries(list.map((p) => [p.project_id, p.fitur ?? p.error]))).toEqual({ b1: 'batch', e1: 'editor', rusak: 'PROJECT_INVALID', t1: 'transfer' });
  });

  it('hybrid: meta can set the feature by hand; an unknown one is refused', async () => {
    const { ws, call } = await setup();
    await createProject(ws, { project_id: 'e1', name: 'Promo' });
    const r = await call('/api/projects/e1/meta', { expected_revision: 0, fitur: 'iklan' });
    expect(r.status).toBe(200);
    expect(r.json.project.fitur).toBe('iklan');
    expect((await call('/api/projects/e1/meta', { expected_revision: r.json.project.revision, fitur: 'aneh' })).status).toBe(422);
    expect((await call('/api/projects')).json.projects[0]).toMatchObject({ fitur: 'iklan' });
  });
});
