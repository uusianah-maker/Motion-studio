// Audit Jenius (14 Nov 2026): timeline visuals are rate-limited; AI connection data is the owner's.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiRoutes } from '../src/ai/routes.js';
import { openAiStore } from '../src/ai/store.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { initWorkspace } from '../src/core.js';
import { VISUALS_AT_ONCE, cutRoutes } from '../src/cuts.js';
import type { Role } from '../src/roles.js';

// Count the FFmpeg passes running at once (each fake pass takes 150 ms).
const live = vi.hoisted(() => ({ now: 0, max: 0 }));
vi.mock('../src/core.js', async (orig) => {
  const real = await orig<typeof import('../src/core.js')>();
  return {
    ...real,
    mediaVisuals: async (_ws: unknown, input: { version_id: string }) => {
      live.max = Math.max(live.max, ++live.now);
      await new Promise((r) => setTimeout(r, 150));
      live.now--;
      return { schema_version: 1, version_id: input.version_id, duration_ms: 1000, peaks: null, thumbs: null, made_at: 0, cached: false };
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(role: Role) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-aub-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const store = await openAiStore(path.join(dir, 'state'), undefined);
  const copilot = createCopilot(ws);
  const app = createApp({ ws, roleOf: () => role, routes: [...copilot.routes, ...cutRoutes(ws, { copilot }), ...aiRoutes(ws, store, undefined, fetch, { devEndpoints: true })] });
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
  return { call };
}

describe('audit Jenius: backend', () => {
  it('#3 visuals for many versions at once: at most VISUALS_AT_ONCE FFmpeg passes run together, all answered', async () => {
    const s = await setup('reviewer');
    live.max = 0;
    const ids = Array.from({ length: 8 }, (_, i) => `v_${String(i).padStart(16, '0')}`);
    const all = await Promise.all(ids.map((id) => s.call(`/api/media/${id}/visuals`)));
    expect(all.map((r) => r.status)).toEqual(ids.map(() => 200));
    expect(all.map((r) => r.json.visuals.version_id)).toEqual(ids);
    expect(VISUALS_AT_ONCE).toBe(2);
    expect(live.max).toBe(VISUALS_AT_ONCE);
  });

  it('#5 AI connections, prices, budget and errors: owner only; others get the Copilot mode', async () => {
    const owner = await setup('owner');
    const add = await owner.call('/api/ai/providers', { provider: 'openai', label: 'Kantor', model: 'gpt-x', api_key: 'sk-test-rahasia-1234567890', prices: { input_per_mtok: 1, output_per_mtok: 2 } });
    expect(add.status).toBe(200);
    const o = (await owner.call('/api/ai/providers')).json;
    expect(o.connections).toHaveLength(1);
    expect(o.settings.budget).toBeDefined();
    for (const role of ['editor', 'reviewer'] as const) {
      const r = await setup(role);
      const v = (await r.call('/api/ai/providers')).json;
      expect(v).toEqual({ connections: [], settings: { mode: expect.any(String) }, catalog: [] });
    }
  });
});
