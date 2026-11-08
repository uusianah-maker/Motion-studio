import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { type AiPlanner, createCopilot } from '../src/copilot.js';
import { createProject, initWorkspace, readAudit, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(ai?: AiPlanner, mode?: 'local' | 'auto' | 'ai') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w11-'));
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

describe('W11 Copilot API', () => {
  it('prompt → plan + diff (no change) → approve → one undo step → undo restores; retry never applies twice', async () => {
    const s = await setup();
    const r = await s.plan('hook "Diskon 50%" 2 detik; subtitle "Cek keranjang" detik 2-5; ubah rasio ke 1:1');
    expect(r.status).toBe(200);
    const plan = r.json.plan;
    expect(plan).toMatchObject({ schema_version: 1, project_id: 'p1', project_revision: 0, source: 'local', requires_approval: true, cost_estimate: { usd: 0 }, provider: null });
    expect(plan.operations.map((o: { label: string }) => o.label)).toEqual(['Tambah teks “Diskon 50%” di 0:00–0:02', 'Tambah subtitle “Cek keranjang” di 0:02–0:05', 'Ubah rasio ke 1:1']);
    expect(r.json.diff.map((d: { summary: string }) => d.summary)).toEqual(['+ teks “Diskon 50%” 0:00–0:02', '+ subtitle “Cek keranjang” 0:02–0:05', 'Rasio 9:16 → 1:1']);
    expect((await readProject(s.ws, 'p1')).revision).toBe(0); // planning changes nothing

    const a = await s.apply(plan.plan_id, { expected_revision: 0 });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ status: 'applied', applied_revision: 1, already_applied: false });
    expect(a.json.project.timeline.canvas).toEqual({ ratio: '1:1' });
    expect(a.json.project.history.undo).toBe(1);
    expect(a.json.project.history.undo_label).toMatch(/^Copilot: hook "Diskon 50%" 2 detik; subtitle/);
    expect(a.json.project.history.undo_label.length).toBeLessThanOrEqual(80);

    const again = await s.apply(plan.plan_id, { expected_revision: 0 });
    expect(again.json).toMatchObject({ status: 'applied', already_applied: true });
    expect((await readProject(s.ws, 'p1')).revision).toBe(1);

    const undo = await s.call('/api/projects/p1/undo', { expected_revision: 1 });
    expect(undo.json.project.timeline.tracks.flatMap((t: { clips: unknown[] }) => t.clips)).toEqual([]);
    expect(undo.json.project.timeline.canvas).toBeUndefined();

    const log = await readAudit(s.ws, (e) => e.op.startsWith('copilot.'));
    expect(log.map((e) => [e.op, e.actor])).toEqual([
      ['copilot.plan', 'ai'],
      ['copilot.apply', 'user'],
    ]);
  });

  it('approve only some operations', async () => {
    const s = await setup();
    const plan = (await s.plan('hook "A" 2 detik; subtitle "B" detik 2-4; ubah rasio ke 16:9')).json.plan;
    const a = await s.apply(plan.plan_id, { expected_revision: 0, accept: [1] });
    expect(a.json.accepted).toEqual([1]);
    const tl = a.json.project.timeline;
    expect(tl.tracks.map((t: { kind: string; clips: unknown[] }) => [t.kind, t.clips.length])).toEqual([['subtitle', 1]]);
    expect(tl.canvas).toBeUndefined();
    expect((await s.apply((await s.plan('hook "C" 1 detik')).json.plan.plan_id, { expected_revision: 1, accept: [5] })).status).toBe(422);
  });

  it('stale, rejected, foreign and unknown plans are refused; bad input is a clear 400', async () => {
    const s = await setup();
    const stale = (await s.plan('hook "A" 2 detik')).json.plan;
    await s.call('/api/projects/p1/edit', { expected_revision: 0, ops: [{ op: 'set_canvas', ratio: '3:4' }] });
    const r1 = await s.apply(stale.plan_id, { expected_revision: 1 });
    expect(r1.status).toBe(409);
    expect(r1.json.error.message).toMatch(/Buat rencana baru/);
    expect((await s.apply(stale.plan_id, { expected_revision: 0 })).status).toBe(409); // project moved on

    const rej = (await s.plan('hook "B" 2 detik')).json.plan;
    expect((await s.call(`/api/projects/p1/copilot/plans/${rej.plan_id}/reject`, {})).json.status).toBe('rejected');
    expect((await s.apply(rej.plan_id, { expected_revision: 1 })).status).toBe(409);

    expect((await s.apply(rej.plan_id, { expected_revision: 1 }, 'p2')).status).toBe(404); // other project
    expect((await s.apply('plan_nope', { expected_revision: 1 })).status).toBe(404);
    expect((await s.plan('')).status).toBe(400);
    expect((await s.plan('hook "A"', { actor: 'user' })).status).toBe(400); // the client never picks the actor
    expect((await s.plan('hook "A"', { mode: 'magic' })).status).toBe(400);
    expect((await s.call('/api/projects/p1/copilot/plan', { prompt: 'hook "A"', selected_clip_ids: 'all' })).status).toBe(400);
  });

  it('unknown or impossible commands: no plan, a reason and examples (never faked)', async () => {
    const s = await setup();
    const r = await s.plan('bikin video ini viral');
    expect(r.json.plan).toBeNull();
    expect(r.json.unsupported.message).toMatch(/belum dikenali/);
    expect(r.json.unsupported.examples.length).toBeGreaterThan(5);
    const clash = await s.plan('hook "A" 2 detik; tambah teks "B" detik 1-3');
    expect(clash.json.unsupported.message).toMatch(/Bentrok/);
    expect((await readAudit(s.ws, (e) => e.op === 'copilot.plan' && e.outcome === 'blocked')).length).toBe(2);
  });

  it('double apply at the same time: applied exactly once', async () => {
    const s = await setup();
    const plan = (await s.plan('hook "A" 2 detik')).json.plan;
    const [a, b] = await Promise.all([s.apply(plan.plan_id, { expected_revision: 0 }), s.apply(plan.plan_id, { expected_revision: 0 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const p = await readProject(s.ws, 'p1');
    expect(p.revision).toBe(1);
    expect(p.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });

  it('AI planner hook (for W12): sees only prompt + timeline (no request/session); its ops are validated like any other', async () => {
    const seen: unknown[] = [];
    let ops: unknown = [{ op: 'add_clip', track_kind: 'text', text: 'Dari AI', start_ms: 0, duration_ms: 1500 }];
    const ai: AiPlanner = {
      unavailable: async () => null,
      plan: async (input) => {
        seen.push(input);
        return { ops, rationale: 'hook pendek', warnings: [], provider: { connection_id: 'conn_x', provider: 'fake', model: 'm1' }, cost_usd: 0.0012 };
      },
    };
    const s = await setup(ai, 'auto');
    // auto: local rules first — a known command never calls the AI.
    expect((await s.plan('hook "Lokal" 2 detik')).json.plan.source).toBe('local');
    expect(seen).toHaveLength(0);
    const r = await s.plan('bikin pembuka yang menarik');
    expect(r.json.plan).toMatchObject({ source: 'ai', provider: { provider: 'fake' }, cost_estimate: { usd: 0.0012 } });
    expect(Object.keys(seen[0] as object).sort()).toEqual(['playhead_ms', 'project_id', 'prompt', 'selected_clip_ids', 'timeline']);
    expect(JSON.stringify(seen)).not.toMatch(/Bearer|authorization|cookie|[0-9a-f]{64}/i);
    // Garbage from the model is refused as a whole.
    ops = [{ op: 'delete_clip', clip_id: 'c_ghost' }];
    expect((await s.plan('hapus yang jelek')).status).toBe(422);
    ops = [{ op: 'purge', version_id: 'v_1' }];
    expect((await s.plan('kosongkan trash')).status).toBe(422);
    expect((await readProject(s.ws, 'p1')).revision).toBe(0);
  });
});
