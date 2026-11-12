import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { type AiPlanner, createCopilot } from '../src/copilot.js';
import { StorageService, createProject, initWorkspace, readProject } from '../src/core.js';
import { cutRoutes } from '../src/cuts.js';
import { execFileSync } from 'node:child_process';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(ai?: AiPlanner, mode?: 'local' | 'auto' | 'ai') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x07-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'Promo' });
  await createProject(ws, { project_id: 'p2', name: 'Lain' });
  const copilot = createCopilot(ws, { ...(ai ? { ai } : {}), ...(mode ? { mode: () => mode } : {}) });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...cutRoutes(ws, { copilot })] });
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

describe('X07 silence/scene analysis API', () => {
  it.skipIf(!hasFfmpeg)('analyze → choose cuts → plan (analysis source, diff, no change) → apply = one undo step', async () => {
    const s = await setup();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x07-src-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const file = path.join(dir, 'talk.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'color=c=gray:s=160x288:r=30:d=3.5', '-filter_complex', '[1]atrim=0:1.5[s];[0][s][2]concat=n=3:v=0:a=1[a]', '-map', '3:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
    const imp = await new StorageService(s.ws).importMedia({ sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
    const vid = imp.version.version_id;
    const an = await s.call(`/api/media/${vid}/analyze`, { params: { min_silence_ms: 800 } });
    expect(an.status).toBe(200);
    expect(an.json.analysis).toMatchObject({ version_id: vid, params: { min_silence_ms: 800 }, cached: false });
    expect(an.json.analysis.silences).toHaveLength(1);
    expect(JSON.stringify(an.json)).not.toMatch(/[A-Za-z]:\\|msc-x07-src/); // no local paths
    expect((await s.call(`/api/media/${vid}/analyze`, { params: { noise_db: 5 } })).status).toBe(422);
    expect((await s.call(`/api/media/${vid}/analyze`, { params: {}, extra: 1 })).status).toBe(400);
    expect((await s.call('/api/media/v_nope/analyze', {})).status).toBe(404);

    const add = await s.call('/api/projects/p1/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: vid }, start_ms: 0, duration_ms: 3400 }, { op: 'add_clip', track_kind: 'text', text: 'Akhir', start_ms: 2600, duration_ms: 800 }] });
    const clip = add.json.project.timeline.tracks.find((t: { kind: string }) => t.kind === 'video').clips[0].clip_id;
    const plan = await s.call('/api/projects/p1/cuts/plan', { clip_id: clip, silences: an.json.analysis.silences, scenes: [], padding_ms: 150 });
    expect(plan.status).toBe(200);
    expect(plan.json.plan).toMatchObject({ source: 'analysis', project_revision: 1, requires_approval: true, cost_estimate: { usd: 0 } });
    expect(plan.json.plan.operations[0].label).toMatch(/^Hapus 0:01,\d–0:02,\d \(1,\d dtk\) di semua track$/);
    expect(plan.json.diff.length).toBeGreaterThan(0);
    expect((await readProject(s.ws, 'p1')).revision).toBe(1); // planning changes nothing
    const ap = await s.apply(plan.json.plan.plan_id, { expected_revision: 1 });
    expect(ap.status).toBe(200);
    const p = await readProject(s.ws, 'p1');
    expect(p.timeline.tracks.find((t) => t.kind === 'video')!.clips).toHaveLength(2);
    expect(p.timeline.tracks.find((t) => t.kind === 'text')!.clips[0]!.start_ms).toBeLessThan(2000); // text moved with the cut
    expect(ap.json.project.history.undo).toBe(2);
    // Junk requests.
    expect((await s.call('/api/projects/p1/cuts/plan', { clip_id: 'c_nope', silences: [], scenes: [] })).status).toBe(422);
    expect((await s.call('/api/projects/p1/cuts/plan', { clip_id: clip, silences: 'semua', scenes: [] })).status).toBe(422);
  }, 60_000);
});
