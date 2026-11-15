// R12a: "AI gambar" settings (owner only). The key is sealed in the server state folder, never
// returned to the browser; "Tes koneksi" uses a mock here — no real paid API is ever called.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imageAiRoutes, openImageAiStore } from '../src/ai/imageAi.js';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';
import type { Role } from '../src/roles.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SECRET = 'sk-gambar-rahasia-1234ABCD';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(role: Role = 'owner', answer = 200) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r12a-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const stateDir = path.join(dir, 'state');
  const store = await openImageAiStore(stateDir, KEY_A);
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('{"data":[]}', { status: answer });
  }) as typeof fetch;
  let current: Role = role;
  const app = createApp({ ws, roleOf: () => current, routes: imageAiRoutes(store, fakeFetch) });
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
  return { call, store, stateDir, calls, setRole: (r: Role) => (current = r) };
}

describe('R12a AI gambar settings', () => {
  it('owner saves provider, model, budget and a key; the key is sealed on disk and never sent back', async () => {
    const s = await setup();
    expect((await s.call('/api/ai/gambar')).json.gambar).toMatchObject({ provider: null, key_saved: false });
    const cfg = await s.call('/api/ai/gambar', { provider: 'openai', model: 'gpt-image-1', budget: { amount: 500000, currency: 'IDR' } });
    expect(cfg.json.gambar).toMatchObject({ provider: 'openai', endpoint: null, model: 'gpt-image-1', budget: { amount: 500000, currency: 'IDR' } });
    const k = await s.call('/api/ai/gambar/key', { api_key: SECRET });
    expect(k.json.gambar).toMatchObject({ key_saved: true, key_hint: 'ABCD' });
    for (const r of [k, cfg, await s.call('/api/ai/gambar')]) expect(r.raw).not.toContain(SECRET.slice(0, 12));
    const disk = await fsp.readFile(s.store.file, 'utf8');
    expect(disk).not.toContain(SECRET);
    expect(disk).toContain('sealed_key');
    // The same server key opens it; another key fails closed (no silent loss).
    expect(await (await openImageAiStore(s.stateDir, KEY_A)).keyOf()).toBe(SECRET);
    await expect(openImageAiStore(s.stateDir, KEY_B)).rejects.toThrow(/kunci enkripsi berbeda/);
    // Remove the key.
    expect((await s.call('/api/ai/gambar/key', { api_key: null })).json.gambar).toMatchObject({ key_saved: false, key_hint: null });
  });

  it('"Tes koneksi" lists models with the key (mocked: no real API call); a refused key says so', async () => {
    const ok = await setup('owner', 200);
    await ok.call('/api/ai/gambar', { provider: 'gemini' });
    expect((await ok.call('/api/ai/gambar/tes', {})).status).toBe(422); // no key yet
    await ok.call('/api/ai/gambar/key', { api_key: SECRET });
    const t = await ok.call('/api/ai/gambar/tes', {});
    expect(t.json.gambar.last_test).toMatchObject({ ok: true, message: expect.stringContaining('berhasil') });
    expect(ok.calls).toEqual([{ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': SECRET } }]);
    const no = await setup('owner', 401);
    await no.call('/api/ai/gambar', { provider: 'lainnya', endpoint: 'https://ai.contoh.com' });
    await no.call('/api/ai/gambar/key', { api_key: SECRET });
    expect((await no.call('/api/ai/gambar/tes', {})).json.gambar.last_test).toMatchObject({ ok: false, message: 'API key ditolak (HTTP 401)' });
    expect(no.calls[0]!.url).toBe('https://ai.contoh.com/v1/models');
  });

  it('validation and owner-only access', async () => {
    const s = await setup();
    for (const bad of [
      { provider: 'midjourney' },
      { provider: 'lainnya' }, // needs an endpoint
      { provider: 'lainnya', endpoint: 'http://ai.contoh.com' }, // not https
      { provider: 'openai', endpoint: 'https://lain.com' }, // official provider: official host only
      { provider: 'openai', budget: { amount: -1 } },
      { provider: 'openai', budget: { amount: 5, currency: 'EUR' } },
    ])
      expect((await s.call('/api/ai/gambar', bad)).status, JSON.stringify(bad)).toBe(422);
    expect((await s.call('/api/ai/gambar/key', { api_key: 'pendek' })).status).toBe(422);
    for (const r of ['editor', 'reviewer'] as const) {
      s.setRole(r);
      expect((await s.call('/api/ai/gambar')).status).toBe(403);
      expect((await s.call('/api/ai/gambar/key', { api_key: SECRET })).status).toBe(403);
    }
  });
});
