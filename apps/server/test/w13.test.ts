import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeAi, startFakeAi } from '../../../scripts/fake-ai.mjs';
import { dayKey, openSpendGate } from '../src/ai/budget.js';
import { PLANNER_SYSTEM, estimateTokens } from '../src/ai/planner.js';
import { createAiPlanner } from '../src/ai/planner.js';
import { createRouter } from '../src/ai/router.js';
import { aiRoutes } from '../src/ai/routes.js';
import { openAiStore } from '../src/ai/store.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { createProject, initWorkspace, readAudit } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(clockStart = Date.now()) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w13-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const fake: FakeAi = await startFakeAi();
  cleanup.push(() => fake.close());
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'Promo' });
  const stateDir = path.join(dir, 'state');
  let clock = clockStart;
  const now = () => clock;
  const store = await openAiStore(stateDir, undefined);
  const ledger = await openSpendGate({ ws, store, stateDir, now });
  const router = createRouter({ ws, store, gate: ledger.gate, sleep: async () => undefined, now });
  const copilot = createCopilot(ws, { ai: createAiPlanner(store, router), mode: () => store.settings().mode });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...aiRoutes(ws, store, ledger)] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse>; raw: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || 'null'), raw });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  const add = async (extra: Record<string, unknown>) => (await call('/api/ai/providers', { provider: 'anthropic', model: 'claude-opus-5-5', api_key: 'sk-ant-budget-KEY1', capabilities: ['planner'], base_url: fake.url, ...extra })).json.connection.connection_id as string;
  await call('/api/ai/settings', { mode: 'ai', max_output_tokens: 500 });
  const plan = (p = 'buat pembuka') => call('/api/projects/p1/copilot/plan', { prompt: p });
  return { ws, fake, store, ledger, call, add, plan, stateDir, setClock: (t: number) => (clock = t), now };
}

const PRICES = { input_per_mtok: 4, output_per_mtok: 20, per_audio_minute: 0 };
const ACTUAL = (1200 * 4 + 300 * 20) / 1e6; // fake usage × prices = 0.0108

describe('W13 usage, cost and hard budget', () => {
  it('estimate over the per-request cap: blocked BEFORE any provider call, audited, clear message', async () => {
    const s = await setup();
    await s.add({ prices: PRICES });
    await s.call('/api/ai/settings', { budget: { per_request_usd: 0.005 } });
    const r = await s.plan();
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(r.json.error.message).toMatch(/melebihi batas per permintaan \$0\.0050/);
    expect(s.fake.count('anthropic.messages')).toBe(0);
    expect((await readAudit(s.ws, (e) => e.op === 'ai.budget_blocked')).length).toBe(1);
  });

  it('daily cap counts metered spend; the call that would cross it is refused; next day resets', async () => {
    const day1 = new Date(2026, 10, 9, 10, 0).getTime();
    const s = await setup(day1);
    await s.add({ prices: PRICES });
    await s.call('/api/ai/settings', { budget: { daily_usd: 0.032, monthly_usd: 10, per_request_usd: 1 } });
    // Estimate per call ≈ input (system + payload) × $4 + 500 out × $20 ≈ $0.013; actual $0.0108.
    const est = (estimateTokens(PLANNER_SYSTEM) + 200) * 4e-6 + 500 * 20e-6;
    expect(est).toBeGreaterThan(0.011);
    for (const p of ['satu', 'dua']) expect((await s.plan(p)).status).toBe(200);
    const third = await s.plan('tiga');
    expect(third.status).toBe(402);
    expect(third.json.error.message).toMatch(/Batas harian \$0\.0320 akan terlewati \(terpakai \$0\.0216/);
    expect(s.fake.count('anthropic.messages')).toBe(2);
    const u = (await s.call('/api/ai/usage')).json.usage;
    expect(u.today).toMatchObject({ calls: 2 });
    expect(u.today.usd).toBeCloseTo(2 * ACTUAL, 8);
    expect(u.by_model[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', calls: 2, input_tokens: 2400, output_tokens: 600 });
    s.setClock(day1 + 24 * 3_600_000);
    expect((await s.plan('besok')).status).toBe(200);
    expect(dayKey(s.now())).not.toBe(dayKey(day1));
  });

  it('monthly cap, and the ledger survives a restart (no prompts, no keys inside)', async () => {
    const s = await setup();
    await s.add({ prices: PRICES });
    await s.call('/api/ai/settings', { budget: { daily_usd: 5, monthly_usd: 0.02, per_request_usd: 1 } });
    expect((await s.plan('pembuka misterius')).status).toBe(200);
    expect((await s.plan('lagi')).json.error.message).toMatch(/Batas bulanan/);
    await s.ledger.flush();
    const raw = await fsp.readFile(s.ledger.file, 'utf8');
    expect(raw).not.toMatch(/pembuka misterius|sk-ant-budget|Hook dari AI/);
    const again = await openSpendGate({ ws: s.ws, store: s.store, stateDir: s.stateDir });
    expect(again.summary().month.usd).toBeCloseTo(ACTUAL, 8);
  });

  it('a paid provider without prices is blocked (cannot estimate); a local keyless server may be free', async () => {
    const s = await setup();
    const a = await s.add({});
    const r = await s.plan();
    expect(r.status).toBe(402);
    expect(r.json.error.message).toMatch(/Harga .* belum diisi/);
    expect(s.fake.count('anthropic.messages')).toBe(0);
    await s.call(`/api/ai/providers/${a}`, { enabled: false });
    await s.call('/api/ai/providers', { provider: 'openai_compatible', label: 'Ollama', model: 'llama', capabilities: ['planner'], base_url: s.fake.url });
    await s.call('/api/ai/settings', { budget: { daily_usd: 0, monthly_usd: 0 } });
    const free = await s.plan();
    expect(free.status).toBe(200);
    expect(free.json.plan.cost_estimate.usd).toBe(0);
  });

  it('calls in flight count against the cap: two at once, only one fits', async () => {
    const s = await setup();
    await s.add({ prices: PRICES });
    await s.call('/api/ai/settings', { budget: { daily_usd: 0.02, monthly_usd: 10, per_request_usd: 1 } });
    s.fake.queue('anthropic.messages', { status: 200, delayMs: 300, body: { content: [{ type: 'text', text: JSON.stringify(s.fake.state.planJson) }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 300 } } });
    const [a, b] = await Promise.all([s.plan('satu'), s.plan('dua')]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(s.fake.count('anthropic.messages')).toBe(1);
  });

  it('failed calls cost nothing and do not eat the budget; budget settings are validated', async () => {
    const s = await setup();
    await s.add({ prices: PRICES });
    await s.call('/api/ai/settings', { max_retries: 0, budget: { daily_usd: 0.02, per_request_usd: 1 } });
    s.fake.queue('anthropic.messages', { status: 500, body: {} });
    expect((await s.plan()).status).toBe(503);
    for (const c of s.store.connections()) c.cooldown_until = 0;
    expect((await s.plan()).status).toBe(200);
    const u = s.ledger.summary();
    expect(u.today.calls).toBe(1);
    expect(u.by_model[0]).toMatchObject({ calls: 2, failed: 1 });
    for (const bad of [{ budget: { daily_usd: -1 } }, { budget: { daily_usd: 'banyak' } }, { budget: { yearly_usd: 5 } }, { budget: [] }]) expect((await s.call('/api/ai/settings', bad)).status).toBe(400);
  });
});
