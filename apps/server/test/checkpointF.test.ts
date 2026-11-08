import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeAi, startFakeAi } from '../../../scripts/fake-ai.mjs';
import { AiCallError } from '../src/ai/adapters.js';
import { openSpendGate } from '../src/ai/budget.js';
import { createAiPlanner } from '../src/ai/planner.js';
import { type SpendGate, createRouter } from '../src/ai/router.js';
import { aiRoutes } from '../src/ai/routes.js';
import { openAiStore } from '../src/ai/store.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { buildCues, createProject, initWorkspace, validateCues } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const PRICES = { input_per_mtok: 4, output_per_mtok: 20, per_audio_minute: 0.006 };

async function setup(opts: { dev?: boolean } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-cpF-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const fake: FakeAi = await startFakeAi();
  cleanup.push(() => fake.close());
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'P' });
  const stateDir = path.join(dir, 'state');
  const store = await openAiStore(stateDir, undefined);
  const ledger = await openSpendGate({ ws, store, stateDir });
  const router = createRouter({ ws, store, gate: ledger.gate, sleep: async () => undefined });
  const copilot = createCopilot(ws, { ai: createAiPlanner(store, router), mode: () => store.settings().mode });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...aiRoutes(ws, store, ledger, fetch, { devEndpoints: opts.dev ?? true })] });
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
  return { ws, fake, store, ledger, router, call, stateDir };
}

describe('Checkpoint F regressions', () => {
  it('F-1/F-11: a stored key never follows a changed address; official providers are locked to their host; no IP literals', async () => {
    const s = await setup();
    const add = await s.call('/api/ai/providers', { provider: 'anthropic', model: 'claude-opus-5-5', api_key: 'sk-ant-OWNER-SECRET-1234', capabilities: ['planner'], base_url: s.fake.url, prices: PRICES });
    const id = add.json.connection.connection_id;
    const other = await startFakeAi();
    cleanup.push(() => other.close());
    const moved = await s.call(`/api/ai/providers/${id}`, { base_url: other.url });
    expect(moved.json.connection).toMatchObject({ has_key: false, key_hint: null, status: 'untested' });
    await s.call(`/api/ai/providers/${id}/test`, {});
    expect(other.state.requests.some((r) => JSON.stringify(r.headers).includes('OWNER-SECRET'))).toBe(false);

    const strict = await setup({ dev: false });
    const bad = async (b: Record<string, unknown>) => (await strict.call('/api/ai/providers', { model: 'm', api_key: 'sk-test-KEY-12345678', capabilities: ['planner'], prices: PRICES, ...b })).status;
    expect(await bad({ provider: 'anthropic', base_url: 'https://evil.example.com' })).toBe(400);
    expect(await bad({ provider: 'openai', base_url: strict.fake.url })).toBe(400); // loopback only in dev/test mode
    expect(await bad({ provider: 'anthropic', base_url: 'https://api.anthropic.com' })).toBe(200); // = the official host
    for (const u of ['https://169.254.169.254', 'https://10.0.0.5:8443', 'https://[::1]', 'https://user@evil.example.com', 'http://evil.example.com']) expect(await bad({ provider: 'openai_compatible', base_url: u }), u).toBe(400);
    expect(await bad({ provider: 'openai_compatible', base_url: 'https://llm.example.com/v1' })).toBe(200);

    // The sealed key is bound to its host: editing the address in the file makes it unreadable (fail closed).
    await s.store.flush();
    const keep = await s.call('/api/ai/providers', { provider: 'openai', model: 'gpt-test', api_key: 'sk-openai-BOUND-9999', capabilities: ['planner'], base_url: s.fake.url, prices: PRICES });
    await s.store.flush();
    const raw2 = JSON.parse(await fsp.readFile(s.store.file, 'utf8'));
    raw2.connections.find((c: { connection_id: string }) => c.connection_id === keep.json.connection.connection_id).base_url = other.url;
    await fsp.writeFile(s.store.file, JSON.stringify(raw2));
    await expect(openAiStore(s.stateDir, undefined)).rejects.toThrow(/kunci enkripsi berbeda|rusak/);
  });

  it('F-2: answers the provider metered (max_tokens / refusal) count toward the hard budget', async () => {
    const s = await setup();
    await s.call('/api/ai/providers', { provider: 'anthropic', model: 'claude-opus-5-5', api_key: 'sk-ant-KEY-00000000', capabilities: ['planner'], base_url: s.fake.url, prices: PRICES });
    await s.call('/api/ai/settings', { mode: 'ai', max_output_tokens: 8000, max_retries: 0, budget: { daily_usd: 0.5, monthly_usd: 10, per_request_usd: 1 } });
    const cut = { status: 200, body: { content: [{ type: 'text', text: '{"operations":[' }], stop_reason: 'max_tokens', usage: { input_tokens: 1200, output_tokens: 8000 } } };
    for (let i = 0; i < 6; i++) s.fake.queue('anthropic.messages', cut);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      for (const c of s.store.connections()) c.cooldown_until = 0;
      statuses.push((await s.call('/api/projects/p1/copilot/plan', { prompt: `pembuka ${i}` })).status);
    }
    expect(statuses).toEqual([503, 503, 503, 402, 402, 402]);
    expect(s.fake.count('anthropic.messages')).toBe(3);
    expect(s.ledger.summary().today.usd).toBeCloseTo(3 * (1200 * 4 + 8000 * 20) / 1e6, 8);
  });

  it('F-2: the per-request cap covers all retries of one request (an unclear 500 counts its estimate)', async () => {
    const s = await setup();
    await s.call('/api/ai/providers', { provider: 'anthropic', model: 'claude-opus-5-5', api_key: 'sk-ant-KEY-00000000', capabilities: ['planner'], base_url: s.fake.url, prices: PRICES });
    await s.call('/api/ai/settings', { mode: 'ai', max_output_tokens: 8000, max_retries: 3, budget: { daily_usd: 5, per_request_usd: 0.3 } });
    for (let i = 0; i < 4; i++) s.fake.queue('anthropic.messages', { status: 500, body: {} });
    const r = await s.call('/api/projects/p1/copilot/plan', { prompt: 'pembuka' });
    expect(r.json.error.code).toBe('BUDGET_EXCEEDED');
    expect(r.json.error.message).toMatch(/dari percobaan sebelumnya/);
    expect(s.fake.count('anthropic.messages')).toBe(1);
  });

  it('F-3/F-4/F-7/F-8: router — no paid upload twice, same-vendor hosts are one provider, bookkeeping never re-calls, skip ≠ failure', async () => {
    const s = await setup();
    const add = (extra: Record<string, unknown>) => s.store.add({ provider: 'openai', label: 'x', model: 'm', capabilities: ['transcription', 'planner'], base_url: s.fake.url, priority: 1, enabled: true, prices: PRICES, api_key: 'sk-test-KEY-12345678', ...extra } as Parameters<typeof s.store.add>[0]);
    const a = await add({ label: 'Utama', priority: 1 });
    const b = await add({ provider: 'openai_compatible', label: 'Lokal', priority: 2, base_url: 'http://127.0.0.1:9' });
    const tried: string[] = [];
    // F-3: an unclear failure on a paid transcription → never sent again anywhere.
    await expect(
      s.router.call('transcription', { project_id: null, estimate: () => 0.001 }, async (_t, _sig, c) => {
        tried.push(c.label);
        throw new AiCallError('transient', 'Waktu habis (timeout)', null, null, null, { maybeBilled: true });
      }),
    ).rejects.toThrow(/tidak dikirim ulang/);
    expect(tried).toEqual(['Utama']);
    // …but a clear refusal before processing (503) may go to the other provider.
    tried.length = 0;
    for (const c of s.store.connections()) Object.assign(c, { cooldown_until: 0, status: 'untested' });
    const r = await s.router.call('transcription', { project_id: null, estimate: () => 0.001 }, async (_t, _sig, c) => {
      tried.push(c.label);
      if (c.label === 'Utama') throw new AiCallError('transient', 'HTTP 503', 503);
      return { value: 'ok', usage: { input_tokens: 0, output_tokens: 0, audio_seconds: 6 }, request_id: null };
    });
    expect(r.connection.label).toBe('Lokal');
    expect(tried.filter((x) => x === 'Utama').length).toBe(3); // retried (max_retries 2), then moved on

    // F-4: a "compatible" connection on api.openai.com is OpenAI → not a second quota pool.
    await s.store.update(b.connection_id, { base_url: 'https://api.openai.com' });
    for (const c of s.store.connections()) Object.assign(c, { cooldown_until: 0, status: 'untested' });
    tried.length = 0;
    await expect(
      s.router.call('planner', { project_id: null, estimate: () => 0.001 }, async (_t, _sig, c) => {
        tried.push(c.label);
        throw new AiCallError('rate_limit', 'HTTP 429', 429, 0);
      }),
    ).rejects.toThrow();
    expect(new Set(tried)).toEqual(new Set(['Utama']));
    // …and it cannot be free: prices required (F-4).
    await s.store.update(b.connection_id, { prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 0 } });
    await expect(s.ledger.gate.reserve({ connection: s.store.find(b.connection_id)!, estimate_usd: 0, capability: 'planner', project_id: null })).rejects.toThrow(/belum diisi/);

    // F-8: skipping a connection does not mark it failing.
    await s.store.update(b.connection_id, { base_url: 'http://127.0.0.1:9', prices: PRICES });
    for (const c of s.store.connections()) Object.assign(c, { cooldown_until: 0, status: 'untested' });
    await s.router.call('planner', { project_id: null, estimate: () => 0, skip: (c) => (c.label === 'Utama' ? 'lebih mahal' : null) }, async () => ({ value: 1, usage: { input_tokens: 1, output_tokens: 1, audio_seconds: 0 }, request_id: null }));
    expect(s.store.find(a.connection_id)!.status).toBe('untested');

    // F-7: a bookkeeping failure after a successful paid call never triggers another call.
    let calls = 0;
    const flaky: SpendGate = { reserve: async () => 'r', settle: async () => Promise.reject(new Error('disk penuh')) };
    const r2 = createRouter({ ws: s.ws, store: s.store, gate: flaky, sleep: async () => undefined });
    const out = await r2.call('planner', { project_id: null, estimate: () => 0 }, async () => {
      calls++;
      return { value: 'ok', usage: { input_tokens: 1, output_tokens: 1, audio_seconds: 0 }, request_id: null };
    });
    expect(out.value).toBe('ok');
    expect(calls).toBe(1);
  });

  it('F-5: a request can narrow the Copilot mode, never widen it beyond the admin setting', async () => {
    const s = await setup();
    await s.call('/api/ai/providers', { provider: 'anthropic', model: 'claude-opus-5-5', api_key: 'sk-ant-KEY-00000000', capabilities: ['planner'], base_url: s.fake.url, prices: PRICES });
    await s.call('/api/ai/settings', { mode: 'local' });
    const r = await s.call('/api/projects/p1/copilot/plan', { prompt: 'bikin pembuka keren', mode: 'ai' });
    expect(r.json.plan).toBeNull();
    expect(s.fake.count('anthropic.messages')).toBe(0);
    await s.call('/api/ai/settings', { mode: 'ai' });
    expect((await s.call('/api/projects/p1/copilot/plan', { prompt: 'bikin pembuka keren', mode: 'local' })).json.plan).toBeNull();
    expect(s.fake.count('anthropic.messages')).toBe(0);
  });

  it('F-6: generated cues always pass the same validation as a human edit', () => {
    const w = (text: string, s: number, e: number) => ({ text, start_ms: s, end_ms: e });
    const cases = [
      [w('Ya.', 1000, 1100), w('Oke', 1100, 1500)], // first cue too short, next starts right after
      [w('Halo', 7600, 7900), w('semua.', 7900, 8000), w('Lagi', 8000, 8400)], // runs past an 8 s media
      [w('A.', 0, 50)], // a lone blip
      [w('Satu', 0, 400), w('dua.', 400, 450), w('Tiga', 450, 900)],
    ];
    for (const words of cases) {
      const cues = buildCues(words, { duration_ms: 8000 });
      expect(() => validateCues(cues, 8000)).not.toThrow();
    }
    // The too-short first cue joins the next one instead of failing validation.
    expect(buildCues([w('Ya.', 1000, 1100), w('Oke', 1100, 1500)], { duration_ms: 8000 }).map((c) => c.text)).toEqual(['Ya. Oke']);
  });
});
