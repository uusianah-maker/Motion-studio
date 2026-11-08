import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeAi, startFakeAi } from '../../../scripts/fake-ai.mjs';
import { classify, parseJsonObject } from '../src/ai/adapters.js';
import { createAiPlanner } from '../src/ai/planner.js';
import { createRouter } from '../src/ai/router.js';
import { aiRoutes } from '../src/ai/routes.js';
import { openAiStore } from '../src/ai/store.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { createProject, initWorkspace, readAudit, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const KEY_A = 'sk-ant-test-AAAA1111';
const KEY_O = 'sk-openai-test-OOOO2222';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w12-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const fake: FakeAi = await startFakeAi();
  cleanup.push(() => fake.close());
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'Promo' });
  const stateDir = path.join(dir, 'state');
  const store = await openAiStore(stateDir, undefined);
  const waits: number[] = [];
  const router = createRouter({ ws, store, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
  const copilot = createCopilot(ws, { ai: createAiPlanner(store, router), mode: () => store.settings().mode });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...aiRoutes(ws, store, undefined, fetch, { devEndpoints: true })] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown, method?: string) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse>; raw: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: method ?? (data ? 'POST' : 'GET'), headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
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
  const prices = { input_per_mtok: 4, output_per_mtok: 20, per_audio_minute: 0.006 };
  const add = async (extra: Record<string, unknown>) => {
    const r = await call('/api/ai/providers', { model: 'claude-opus-5-5', base_url: fake.url, prices, ...extra });
    expect(r.status, r.raw).toBe(200);
    return r.json.connection.connection_id as string;
  };
  const settings = (s: Record<string, unknown>) => call('/api/ai/settings', s);
  const plan = (prompt: string) => call('/api/projects/p1/copilot/plan', { prompt });
  return { ws, fake, store, router, waits, call, add, settings, plan, stateDir, app };
}

describe('W12 AI Provider Manager', () => {
  it('manual enrollment: key goes in once, is sealed on disk, never comes back (reply, list, audit, log)', async () => {
    const s = await setup();
    const id = await s.add({ provider: 'anthropic', label: 'Claude utama', api_key: KEY_A, capabilities: ['planner'] });
    const list = await s.call('/api/ai/providers');
    expect(list.json.connections[0]).toMatchObject({ connection_id: id, provider: 'anthropic', key_hint: '…1111', has_key: true, status: 'untested' });
    expect(list.json.connections[0].sealed_key).toBeUndefined();
    const disk = await fsp.readFile(s.store.file, 'utf8');
    const auditRaw = JSON.stringify(await readAudit(s.ws));
    for (const blob of [list.raw, disk, auditRaw, (await s.call('/api/ai/log')).raw]) expect(blob).not.toContain('AAAA1111' + '');
    expect(disk).not.toContain(KEY_A);
    expect(disk).toContain('"sealed_key": "v1.');

    // Bad input is refused, nothing saved.
    const bads: Record<string, unknown>[] = [
      { provider: 'anthropic', capabilities: ['planner'] }, // no key
      { provider: 'anthropic', api_key: KEY_A, capabilities: ['transcription'] }, // capability not offered
      { provider: 'anthropic', api_key: KEY_A, base_url: 'http://evil.example' }, // plain http off-box
      { provider: 'openai_compatible' }, // needs its server URL
      { provider: 'openai', api_key: 'has space here' },
      { provider: 'nope', api_key: KEY_A },
      { provider: 'anthropic', api_key: KEY_A, model: 'x; rm -rf /' },
      { provider: 'anthropic', api_key: KEY_A, actor: 'user' },
    ];
    for (const b of bads) expect((await s.call('/api/ai/providers', { model: 'm', ...b, ...(b.base_url === undefined && b.provider !== 'openai_compatible' ? { base_url: s.fake.url } : {}) })).status, JSON.stringify(b)).toBe(400);
    expect(s.store.connections()).toHaveLength(1);

    // Rotate + remove.
    const rot = await s.call(`/api/ai/providers/${id}/key`, { api_key: 'sk-ant-new-ZZZZ9999' });
    expect(rot.json.connection.key_hint).toBe('…9999');
    expect((await s.call(`/api/ai/providers/${id}`, undefined, 'DELETE')).status).toBe(200);
    expect(s.store.connections()).toHaveLength(0);
    expect((await readAudit(s.ws, (e) => e.op.startsWith('ai.provider.'))).map((e) => e.op)).toEqual(['ai.provider.add', 'ai.provider.rotate', 'ai.provider.remove']);
  });

  it('connection test: official headers, model listed; a rejected key needs the admin', async () => {
    const s = await setup();
    const id = await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'] });
    const ok = await s.call(`/api/ai/providers/${id}/test`, {});
    expect(ok.json.result).toMatchObject({ ok: true, model_listed: true });
    const req = s.fake.state.requests.at(-1)!;
    expect(req.headers['x-api-key']).toBe(KEY_A);
    expect(req.headers['anthropic-version']).toBe('2026-10-21');
    expect(req.headers.cookie).toBeUndefined();
    s.fake.queue('models', { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const bad = await s.call(`/api/ai/providers/${id}/test`, {});
    expect(bad.json.result).toMatchObject({ ok: false, error: { class: 'auth', status: 401 } });
    expect(bad.json.connection.status).toBe('needs_admin');
  });

  it('Copilot mode ai: one planner call, path-free payload, validated ops, real cost; auto = rules first; local = never calls', async () => {
    const s = await setup();
    await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'] });
    await s.settings({ mode: 'ai', max_output_tokens: 4000 });
    const r = await s.plan('bikin hook yang menarik');
    expect(r.status, r.raw).toBe(200);
    expect(r.json.plan).toMatchObject({ source: 'ai', provider: { provider: 'anthropic', model: 'claude-opus-5-5' }, operations: [{ label: 'Tambah teks “Hook dari AI” di 0:00–0:02' }] });
    expect(r.json.plan.cost_estimate.usd).toBeCloseTo((1200 * 4 + 300 * 20) / 1e6, 8);
    const sent = s.fake.state.requests.find((q) => q.key === 'anthropic.messages')!;
    const body = sent.body as { model: string; max_tokens: number; system: string; messages: { content: string }[] };
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4000 });
    expect(body.system).toMatch(/ONE JSON object/);
    expect(JSON.parse(body.messages[0]!.content)).toMatchObject({ instruction: 'bikin hook yang menarik', timeline: { canvas: '9:16', tracks: [] } });
    expect(JSON.stringify(sent)).not.toMatch(/Bearer [0-9a-f]{64}|PROJECTS|\.motionstudio|[A-Z]:\\\\/);
    expect((await readProject(s.ws, 'p1')).revision).toBe(0); // still needs approval

    await s.settings({ mode: 'auto' });
    const before = s.fake.count('anthropic.messages');
    expect((await s.plan('hook "Lokal" 2 detik')).json.plan.source).toBe('local');
    expect(s.fake.count('anthropic.messages')).toBe(before);
    expect((await s.plan('buat pembuka dramatis')).json.plan.source).toBe('ai');

    await s.settings({ mode: 'local' });
    const n = s.fake.count('anthropic.messages');
    expect((await s.plan('buat pembuka dramatis')).json.plan).toBeNull();
    expect(s.fake.count('anthropic.messages')).toBe(n);
  });

  it('failover: timeouts/5xx retried with backoff then cooldown → another provider; 429 honours Retry-After', async () => {
    const s = await setup();
    const a = await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'], priority: 1 });
    await s.add({ provider: 'openai', api_key: KEY_O, model: 'gpt-test', capabilities: ['planner'], priority: 2 });
    await s.settings({ mode: 'ai', max_retries: 2, cooldown_ms: 60_000 });
    const down = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
    s.fake.queue('anthropic.messages', down, down, down);
    const r = await s.plan('pembuka');
    expect(r.json.plan.provider.provider).toBe('openai');
    expect(s.fake.count('anthropic.messages')).toBe(3);
    expect(s.waits).toEqual([500, 1000]); // exponential backoff (jitter fixed at ×1 in the test)
    expect(s.store.find(a)!.cooldown_until).toBeGreaterThan(Date.now());
    const oreq = s.fake.state.requests.find((q) => q.key === 'openai.chat')!;
    expect(oreq.headers.authorization).toBe(`Bearer ${KEY_O}`);
    expect((oreq.body as { response_format: unknown }).response_format).toEqual({ type: 'json_object' });
    // While cooling down, the primary is skipped.
    const n = s.fake.count('anthropic.messages');
    expect((await s.plan('pembuka lagi')).json.plan.provider.provider).toBe('openai');
    expect(s.fake.count('anthropic.messages')).toBe(n);
    const log = await readAudit(s.ws, (e) => e.op === 'ai.call');
    expect(log.map((e) => `${e.provider}:${e.outcome}:${e.error_class ?? ''}`)).toEqual(['anthropic:failed:transient', 'anthropic:failed:transient', 'anthropic:failed:transient', 'openai:ok:', 'openai:ok:']);

    // 429 with Retry-After on a fresh setup: waits exactly as told, same provider succeeds.
    const t = await setup();
    await t.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'] });
    await t.settings({ mode: 'ai' });
    t.fake.queue('anthropic.messages', { status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error' } } });
    expect((await t.plan('pembuka')).json.plan.provider.provider).toBe('anthropic');
    expect(t.waits).toEqual([3000]);
  });

  it('401 and billing errors: no retry, connection held for the admin, failover only to ANOTHER provider', async () => {
    const s = await setup();
    const a = await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'], priority: 1 });
    const a2 = await s.add({ provider: 'anthropic', label: 'Claude kedua', api_key: 'sk-ant-second-BBBB', capabilities: ['planner'], priority: 2 });
    const o = await s.add({ provider: 'openai', api_key: KEY_O, model: 'gpt-test', capabilities: ['planner'], priority: 3 });
    await s.settings({ mode: 'ai' });
    s.fake.queue('anthropic.messages', { status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
    const r = await s.plan('pembuka');
    expect(r.json.plan.provider.connection_id).toBe(o); // skipped the second Anthropic key
    expect(s.fake.count('anthropic.messages')).toBe(1);
    expect(s.waits).toEqual([]);
    expect(s.store.find(a)!.status).toBe('needs_admin');
    expect(s.store.find(a2)!.status).toBe('untested');

    // Billing on OpenAI (insufficient_quota arrives as 429): not retried, held.
    s.fake.queue('openai.chat', { status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } });
    await s.store.update(a, { enabled: false });
    await s.store.update(a2, { enabled: false });
    const r2 = await s.plan('pembuka');
    expect(r2.status).toBe(503);
    expect(r2.json.error.code).toBe('AI_UNAVAILABLE');
    expect(r2.json.error.message).toMatch(/kredit\/tagihan habis/);
    expect(s.store.find(o)!.status).toBe('needs_admin');
    expect((await readProject(s.ws, 'p1')).revision).toBe(0);
    // Admin rotates the key → eligible again.
    await s.store.update(a, { enabled: true });
    expect((await s.plan('pembuka')).json.unsupported.message).toMatch(/perlu tindakan admin/); // explained before any call
    await s.call(`/api/ai/providers/${a}/key`, { api_key: 'sk-ant-fixed-CCCC' });
    expect((await s.plan('pembuka')).json.plan.provider.connection_id).toBe(a);
  });

  it('failover off, all down, hung provider, bad model output: clear errors, nothing applied', async () => {
    const s = await setup();
    await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'], priority: 1 });
    await s.add({ provider: 'openai', api_key: KEY_O, model: 'gpt-test', capabilities: ['planner'], priority: 2 });
    await s.settings({ mode: 'ai', failover: false, max_retries: 0 });
    s.fake.queue('anthropic.messages', { status: 500, body: {} });
    expect((await s.plan('pembuka')).json.error.code).toBe('AI_UNAVAILABLE');
    expect(s.fake.count('openai.chat')).toBe(0);

    await s.store.setSettings({ ...s.store.settings(), failover: true, timeout_ms: 300, cooldown_ms: 0 });
    for (const c of s.store.connections()) c.cooldown_until = 0; // the 500 above put the primary on cooldown
    s.fake.queue('anthropic.messages', { status: 200, hang: true, body: {} });
    s.fake.queue('openai.chat', { status: 503, body: {} });
    const down = await s.plan('pembuka');
    expect(down.status).toBe(503);
    expect(down.json.error.message).toMatch(/Semua koneksi AI gagal.*timeout.*HTTP 503/s);

    s.fake.state.planJson = 'ini bukan json';
    s.fake.queue('anthropic.messages', { status: 200, body: { content: [{ type: 'text', text: 'Maaf, saya tidak bisa.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } });
    const junk = await s.plan('pembuka');
    expect(junk.json.error.code).toBe('AI_OUTPUT_INVALID');
    s.fake.state.planJson = { operations: [{ op: 'delete_clip', clip_id: 'c_ghost' }], rationale: 'x' };
    expect((await s.plan('pembuka')).json.error.code).toBe('EDIT_INVALID');
    s.fake.state.planJson = { operations: [], rationale: 'Tidak ada media untuk dipotong' };
    expect((await s.plan('pembuka')).json.error.message).toMatch(/Tidak ada media/);
    expect((await readProject(s.ws, 'p1')).revision).toBe(0);
  });

  it('Gemini and a keyless local OpenAI-compatible server use their own official shapes', async () => {
    const s = await setup();
    const g = await s.add({ provider: 'gemini', api_key: 'gm-key-GGGG', model: 'gemini-test', capabilities: ['planner'], priority: 1 });
    await s.settings({ mode: 'ai' });
    expect((await s.plan('pembuka')).json.plan.provider.provider).toBe('gemini');
    const gq = s.fake.state.requests.find((q) => q.key === 'gemini.generate')!;
    expect(gq.path).toBe('/v1beta/models/gemini-test:generateContent');
    expect(gq.headers['x-goog-api-key']).toBe('gm-key-GGGG');
    expect((gq.body as { generationConfig: unknown }).generationConfig).toMatchObject({ responseMimeType: 'application/json' });
    await s.call(`/api/ai/providers/${g}`, undefined, 'DELETE');
    await s.add({ provider: 'openai_compatible', label: 'Ollama', model: 'llama-local', capabilities: ['planner'] });
    expect((await s.plan('pembuka')).json.plan.provider.provider).toBe('openai_compatible');
    expect(s.fake.state.requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('secrets: another server key cannot open the stored keys (fail closed at start); helpers', async () => {
    const s = await setup();
    await s.add({ provider: 'anthropic', api_key: KEY_A, capabilities: ['planner'] });
    await s.store.flush();
    await expect(openAiStore(s.stateDir, 'c'.repeat(64))).rejects.toThrow(/kunci enkripsi berbeda/);
    expect((await openAiStore(s.stateDir, undefined)).connections()).toHaveLength(1);
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonObject('[1,2]')).toThrow();
    const cls = async (status: number, body: unknown, headers: Record<string, string> = {}) => (await classify(new Response(JSON.stringify(body), { status, headers }))).cls;
    expect(await cls(403, {})).toBe('auth');
    expect(await cls(402, {})).toBe('billing');
    expect(await cls(400, { error: { type: 'invalid_request_error', message: 'credit balance is too low' } })).toBe('bad_request');
    expect(await cls(400, { error: { type: 'billing_error' } })).toBe('billing');
    expect(await cls(429, { error: { code: 'insufficient_quota' } })).toBe('billing');
    expect(await cls(429, {})).toBe('rate_limit');
    expect(await cls(529, {})).toBe('transient');
    expect(await cls(404, {})).toBe('bad_request');
  });
});
