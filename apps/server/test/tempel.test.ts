import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeAi, startFakeAi } from '../../../scripts/fake-ai.mjs';
import { aiRoutes } from '../src/ai/routes.js';
import { openImageAiStore } from '../src/ai/imageAi.js';
import { openAiStore } from '../src/ai/store.js';
import { urutanCoba, urutanModel } from '../src/ai/tempel.js';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace, readAudit } from '../src/core.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-tempel-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const openai: FakeAi = await startFakeAi();
  const apimart: FakeAi = await startFakeAi();
  cleanup.push(() => openai.close(), () => apimart.close());
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const store = await openAiStore(path.join(dir, 'state'), undefined);
  const imageAi = await openImageAiStore(path.join(dir, 'state'), undefined);
  const app = createApp({ ws, routes: aiRoutes(ws, store, undefined, fetch, { devEndpoints: true, imageAi, tempelBases: { openai: openai.url, apimart: apimart.url, anthropic: openai.url } }) });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const tempel = (api_key: string) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse>; raw: string }>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ api_key }));
      const r = http.request(
        { host: HOST, port, path: '/api/ai/tempel', method: 'POST', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, 'content-type': 'application/json', 'content-length': String(data.length) } },
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
  return { ws, store, imageAi, openai, apimart, tempel };
}

describe('Tempel API key (27 Nov)', () => {
  it('urutan: kunci berawalan resmi hanya ke penyedianya; sk- generik ke OpenAI dulu, baru reseller', () => {
    expect(urutanCoba('sk-ant-abc12345')).toEqual(['anthropic']);
    expect(urutanCoba('AIzaSyXXXXXXXX')).toEqual(['gemini']);
    expect(urutanCoba('sk-proj-abcdefgh')).toEqual(['openai']);
    expect(urutanCoba('sk-abcdefgh1234')).toEqual(['openai', 'apimart']);
    expect(urutanCoba('am-abcdefgh1234')).toEqual(['apimart']);
  });

  it('pilih model teks terbaik, buang model gambar/suara/mini', () => {
    const ids = ['gpt-image-1.5-official', 'gpt-4o', 'gpt-5.5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.6-flash', 'whisper-1', 'gpt-5.4-mini', 'nano-banana-2'];
    expect(urutanModel(ids)).toEqual(['claude-sonnet-5-5', 'gpt-5.5', 'claude-opus-5-5']);
    expect(urutanModel(['gpt-5.9', 'gpt-5.10-mini', 'gpt-4.1', 'dall-e-3'])).toEqual(['gpt-5.9', 'gpt-4.1']);
    expect(urutanModel(['whisper-1', 'tts-1'])).toEqual([]);
  });

  it('kunci apimart: ditolak OpenAI → dikenali apimart, model dipilih & dites, Copilot otomatis aktif, kunci tidak bocor', async () => {
    const s = await setup();
    const KEY = 'sk-apimartTEST9876';
    s.openai.queue('models', { status: 401, body: { error: { code: 'invalid_api_key' } } });
    const r = await s.tempel(KEY);
    expect(r.status, r.raw).toBe(200);
    expect(r.json).toMatchObject({ ok: true, penyedia: 'apimart.ai', model: 'claude-opus-5-5', mode: 'auto' });
    expect(r.raw).not.toContain('TEST9876');
    expect(s.openai.count('models')).toBe(1);
    expect(s.apimart.count('models')).toBe(1);
    expect(s.apimart.count('openai.chat')).toBe(1);
    expect(s.apimart.state.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const [c] = s.store.connections();
    expect(c).toMatchObject({ provider: 'openai_compatible', label: 'apimart.ai', model: 'claude-opus-5-5', status: 'ok', capabilities: ['planner'], enabled: true });
    expect(await s.store.keyOf(c!)).toBe(KEY);
    expect(s.store.settings().mode).toBe('auto');
    expect(s.store.settings().budget).toEqual({ daily_usd: 20, monthly_usd: 300, per_request_usd: 3 });
    expect(JSON.stringify(await readAudit(s.ws))).not.toContain('TEST9876');

    // Tempel lagi (kunci baru) = ganti kunci koneksi yang sama, bukan menambah koneksi.
    s.openai.queue('models', { status: 401, body: {} });
    const r2 = await s.tempel('sk-apimartBARU5555');
    expect(r2.json.ok).toBe(true);
    expect(s.store.connections()).toHaveLength(1);
    expect(await s.store.keyOf(s.store.connections()[0]!)).toBe('sk-apimartBARU5555');
  });

  it('apimart yang menjawab sepotong-sepotong (stream) tetap terbaca; stream:false dikirim', async () => {
    const s = await setup();
    s.openai.queue('models', { status: 401, body: {} });
    s.apimart.queue('models', { status: 200, body: { data: [{ id: 'claude-opus-4-8' }], object: 'list', success: true } });
    const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { content }, finish_reason: finish, index: 0 }] })}\n\n`;
    s.apimart.queue('openai.chat', { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `: PING\n\n${chunk('')}${chunk('{"ok"')}${chunk(':true}', 'stop')}data: [DONE]\n\n` });
    const r = await s.tempel('sk-streamTEST1234');
    expect(r.json, r.raw).toMatchObject({ ok: true, penyedia: 'apimart.ai', model: 'claude-opus-4-8' });
    const chat = s.apimart.state.requests.find((q) => q.key === 'openai.chat')!;
    expect(chat.body).toMatchObject({ model: 'claude-opus-4-8', stream: false });
  });

  it('satu kunci untuk semua: kunci apimart yang boleh gambar ikut dipakai AI gambar; kunci gambar lama tidak ditimpa', async () => {
    const s = await setup();
    s.openai.queue('models', { status: 401, body: {} });
    s.apimart.queue('models', { status: 200, body: { data: [{ id: 'claude-opus-4-8' }, { id: 'gpt-image-2' }] } });
    const r = await s.tempel('sk-semuaTEST1234');
    expect(r.json).toMatchObject({ ok: true, gambar: { status: 'dipakai', model: 'gpt-image-2' } });
    expect(s.imageAi.raw()).toMatchObject({ provider: 'apimart', model_terdeteksi: 'gpt-image-2' });
    expect(await s.imageAi.keyOf()).toBe('sk-semuaTEST1234');

    const t = await setup();
    await t.imageAi.setKey('kunci-beliapi-lama');
    t.openai.queue('models', { status: 401, body: {} });
    t.apimart.queue('models', { status: 200, body: { data: [{ id: 'claude-opus-4-8' }, { id: 'gpt-image-2' }] } });
    const r2 = await t.tempel('sk-semuaTEST1234');
    expect(r2.json.gambar.status).toBe('sudah_ada');
    expect(await t.imageAi.keyOf()).toBe('kunci-beliapi-lama');
  });

  it('kunci Claude resmi tidak pernah dikirim ke reseller', async () => {
    const s = await setup();
    s.openai.queue('models', { status: 401, body: {} });
    const r = await s.tempel('sk-ant-RAHASIA1234');
    expect(r.json.ok).toBe(false);
    expect(s.apimart.state.requests).toHaveLength(0);
    expect(s.store.connections()).toHaveLength(0);
  });

  it('kunci salah: pesan jelas, tidak ada koneksi; saldo habis dikenali', async () => {
    const s = await setup();
    s.openai.queue('models', { status: 401, body: {} });
    s.apimart.queue('models', { status: 401, body: {} });
    const r = await s.tempel('sk-salahsemua000');
    expect(r.json).toMatchObject({ ok: false });
    expect(r.json.pesan).toContain('ditolak');
    expect(s.store.connections()).toHaveLength(0);
    expect(s.store.settings().mode).toBe('local');

    s.openai.queue('models', { status: 401, body: {} });
    s.apimart.queue('openai.chat', { status: 402, body: { error: { code: 'insufficient_quota' } } });
    const r2 = await s.tempel('sk-saldohabis000');
    expect(r2.json.ok).toBe(false);
    expect(r2.json.pesan).toContain('saldo');
  });
});
