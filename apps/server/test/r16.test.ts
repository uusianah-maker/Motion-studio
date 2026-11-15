// R16 Beat Spot over HTTP: start with footage + sound, read the report, re-run with the team's
// choices, open the plan (Copilot path, approved = one undo step); a reviewer reads only.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace, readProject } from '../src/core.js';
import { engineRoutes } from '../src/engine.js';
import type { Role } from '../src/roles.js';
import { apiRoutes } from '../src/routes.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fake-engine.mjs');
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r16-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(root, { recursive: true });
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(ws, { project_id: 'b', name: 'Beat Spot' });
  const imp = async (name: string, args: string[]) => {
    const f = path.join(dir, name);
    execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'b' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  const sources = [
    { kunci: '$sumber:mall-1', ref: await imp('mall-1.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) },
    { kunci: '$sumber:mall-2', ref: await imp('mall-2.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) },
    { kunci: '$sumber:sound', ref: await imp('sound.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=8']) },
  ];
  const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  let role: Role = 'editor';
  const copilot = createCopilot(ws);
  const app = createApp({ ws, roleOf: () => role, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engineRoutes(ws, { copilot, config })] });
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
  const done = async (jid: string) => {
    for (let i = 0; i < 200; i++) {
      const j = (await call(`/api/projects/b/engine/jobs/${jid}`)).json.job;
      if (j.state !== 'menunggu' && j.state !== 'berjalan') return j;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('timeout');
  };
  return {
    ws,
    call,
    done,
    sources,
    asRole: (r: Role) => {
      role = r;
    },
  };
}

describe('R16 Beat Spot API', () => {
  it.skipIf(!hasFfmpeg)('start → report → re-run with the team’s choices → plan → applied as one step', async () => {
    const { ws, call, done, sources, asRole } = await setup();
    const start = await call('/api/projects/b/engine/jobs', { mode: 'beatspot', sources, beatspot: { sound: '$sumber:sound' } });
    expect(start.status).toBe(200);
    const j1 = await done(start.json.job.job_id);
    expect([j1.mode, j1.state]).toEqual(['beatspot', 'siap']);
    const v = (await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot`)).json.beatspot;
    expect(v.laporan.potongan).toHaveLength(4);
    expect(v.sumber.find((s: { sound: boolean }) => s.sound).nama).toBe('sound.wav');

    const re = await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot/ulang`, { beatspot: { ...v.pengaturan, kecualikan_shot: ['mall-1#00'], sumber_orang: { 'mall-2': 'kreator' } } });
    expect(re.status).toBe(200);
    const j2 = await done(re.json.job.job_id);
    const v2 = (await call(`/api/projects/b/engine/jobs/${j2.job_id}/beatspot`)).json.beatspot;
    expect(v2.laporan.potongan.map((p: { shot: string }) => p.shot)).not.toContain('mall-1#00');
    expect(v2.pengaturan.kecualikan_shot).toEqual(['mall-1#00']);
    expect((await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot/ulang`, { beatspot: { bpm: 999 } })).status).toBe(422);
    expect((await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot/ulang`, { beatspot: {}, x: 1 })).status).toBe(400);

    // The plan goes the Generate way: a Copilot plan labelled Beat Spot, approve = applied.
    const plan = await call(`/api/projects/b/engine/jobs/${j2.job_id}/plan`, {});
    expect([plan.status, plan.json.error?.message]).toEqual([200, undefined]);
    expect(plan.json.plan.prompt).toContain('Beat Spot');
    const rev = (await readProject(ws, 'b')).revision;
    const ap = await call(`/api/projects/b/copilot/plans/${plan.json.plan.plan_id}/apply`, { expected_revision: rev });
    expect([ap.status, ap.json.error?.message]).toEqual([200, undefined]);
    const p = await readProject(ws, 'b');
    expect(p.timeline.tracks.find((t) => t.kind === 'video')!.clips.length).toBe(3);
    expect(p.timeline.tracks.find((t) => t.kind === 'music')!.clips.length).toBe(1);

    asRole('reviewer');
    expect((await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot`)).status).toBe(200);
    expect((await call(`/api/projects/b/engine/jobs/${j1.job_id}/beatspot/ulang`, { beatspot: {} })).status).toBe(403);
  }, 90_000);
});
