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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x06-'));
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

describe('X06 Brand Kit API', () => {
  it.skipIf(!hasFfmpeg)('GET/POST /api/brand, logo streams as an image, Copilot uses the kit', async () => {
    const s = await setup();
    const empty = await s.call('/api/brand');
    expect(empty.json.brand).toMatchObject({ revision: 0, colors: [], font: null, logo: null });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x06-src-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const png = path.join(dir, 'logo.png');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', png], { windowsHide: true });
    const imp = await new StorageService(s.ws).importMedia({ sourcePath: png, scope: { kind: 'shared' }, actor: 'user' });
    const logo = { media_id: imp.media.media_id, version_id: imp.version.version_id };
    const kit = { name: 'Toko', colors: ['#123456'], text_color: '#ffffff', font: null, logo: { ref: logo, corner: 'br', size: 15, opacity: 1 } };
    const saved = await s.call('/api/brand', { expected_revision: 0, kit });
    expect(saved.status).toBe(200);
    expect(saved.json.brand).toMatchObject({ revision: 1, name: 'Toko', logo: { corner: 'br' } });
    expect((await s.call('/api/brand', { expected_revision: 0, kit })).status).toBe(409);
    expect((await s.call('/api/brand', { expected_revision: 1, kit, owner: 'x' })).status).toBe(400);
    expect((await s.call('/api/brand', { expected_revision: 1, kit: { ...kit, colors: ['ungu'] } })).status).toBe(422);
    expect((await s.call(`/api/media/${logo.version_id}/stream-url`)).json.mime).toBe('image/png');

    // Copilot (local): brand words read the saved kit.
    const add = await s.call('/api/projects/p1/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'text', text: 'Promo', start_ms: 0, duration_ms: 2000 }] });
    const clip = add.json.project.timeline.tracks.find((t: { kind: string }) => t.kind === 'text').clips[0].clip_id;
    const p1 = await s.plan('pakai brand; tampilkan logo', { selected_clip_ids: [clip] });
    expect(p1.status).toBe(200);
    expect(p1.json.plan.operations.map((o: { label: string }) => o.label)).toEqual([expect.stringMatching(/kotak #123456/), 'Tampilkan logo brand']);
    const a = await s.apply(p1.json.plan.plan_id, { expected_revision: 1 });
    expect(a.status).toBe(200);
    expect((await readProject(s.ws, 'p1')).timeline.brand_logo).toBe(true);
  });
});
