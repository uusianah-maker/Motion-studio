import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageGenError, generateImageEdit, imageAiRoutes, openImageAiStore, ratioOf } from '../src/ai/imageAi.js';

/** 25 Nov: beliapi.com image provider (submit → poll → download), against a fake beliapi. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 7)]);
const KEY = 'kein_test_key_123456';

async function store() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-beliapi-'));
  const s = await openImageAiStore(dir, '22'.repeat(32));
  await s.setKey(KEY);
  await s.setConfig({ provider: 'beliapi', endpoint: null, model: null, budget: { amount: null, currency: 'IDR' } });
  return s;
}

function fakeBeliapi(opts: { statuses?: string[]; submitStatus?: number; fail?: string } = {}) {
  const calls: { method: string; url: string; auth: string | null; idem: string | null; body: Record<string, unknown> | null }[] = [];
  let polls = 0;
  const statuses = opts.statuses ?? ['queued', 'processing', 'completed'];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const h = new Headers(init.headers);
    calls.push({ method: init.method ?? 'GET', url: u, auth: h.get('authorization'), idem: h.get('idempotency-key'), body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (h.get('authorization') !== `Bearer ${KEY}`) return new Response(JSON.stringify({ detail: 'API key salah' }), { status: 401 });
    if (u === 'https://beliapi.com/v1/models') return Response.json({ data: [{ id: 'omni-1.2' }, { id: 'nano-banana-2.1' }] });
    if (u === 'https://beliapi.com/v1/generations') return opts.submitStatus ? new Response('{}', { status: opts.submitStatus }) : Response.json({ id: 'task_abc' }, { status: 202 });
    if (u === 'https://beliapi.com/v1/tasks/task_abc') {
      const st = statuses[Math.min(polls++, statuses.length - 1)]!;
      return Response.json({ id: 'task_abc', status: st, ...(st === 'completed' ? { output_url: '/v1/tasks/task_abc/output' } : {}), ...(st === 'failed' ? { error: opts.fail ?? 'gagal' } : {}) });
    }
    if (u === 'https://beliapi.com/v1/tasks/task_abc/output') return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const noSleep = async () => undefined;
const input = { images: [{ name: 'model.png', bytes: PNG, mime: 'image/png' }, { name: 'baju.jpg', bytes: PNG, mime: 'image/jpeg' }], prompt: 'Ganti baju model dengan baju dari gambar 2', size: '1024x1536' };

describe('beliapi.com AI gambar', () => {
  it('submits once with references, polls until completed, downloads the picture', async () => {
    const s = await store();
    const f = fakeBeliapi();
    const r = await generateImageEdit(s, input, f.fetchImpl, { sleep: noSleep });
    expect(r.model).toBe('nano-banana-2.1');
    expect(r.bytes.equals(PNG)).toBe(true);
    const sub = f.calls.filter((c) => c.url.endsWith('/v1/generations'));
    expect(sub).toHaveLength(1);
    expect(sub[0]!.idem).toMatch(/^[0-9a-f]{32}$/);
    expect(sub[0]!.body).toMatchObject({ model: 'nano-banana-2.1', ratio: '9:16' });
    expect((sub[0]!.body!.images as string[])[1]).toMatch(/^data:image\/jpeg;base64,/);
    expect(f.calls.filter((c) => c.url.endsWith('/tasks/task_abc'))).toHaveLength(3);
    expect(f.calls.every((c) => c.url.startsWith('https://beliapi.com/'))).toBe(true); // the key never goes elsewhere
  });
  it('clear Indonesian errors: wrong key, failed task, refused picture, queue full', async () => {
    const s = await store();
    const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof ImageGenError ? `${e.kind}:${e.message}` : String(e)));
    await s.setKey('kunci_lain_salah_123');
    expect(await code(generateImageEdit(s, input, fakeBeliapi().fetchImpl, { sleep: noSleep }))).toMatch(/^key:API key beliapi salah/);
    await s.setKey(KEY);
    expect(await code(generateImageEdit(s, input, fakeBeliapi({ statuses: ['failed'], fail: 'safety filter blocked' }).fetchImpl, { sleep: noSleep }))).toMatch(/^ditolak:/);
    expect(await code(generateImageEdit(s, input, fakeBeliapi({ statuses: ['failed'], fail: 'upstream timeout' }).fetchImpl, { sleep: noSleep }))).toMatch(/^lain:beliapi gagal membuat gambar/);
    expect(await code(generateImageEdit(s, input, fakeBeliapi({ submitStatus: 429 }).fetchImpl, { sleep: noSleep }))).toMatch(/^quota:Antrean beliapi penuh/);
    expect(await code(generateImageEdit(s, { ...input, images: [{ name: 'besar.png', bytes: Buffer.alloc(6 * 1024 * 1024), mime: 'image/png' }] }, fakeBeliapi().fetchImpl, { sleep: noSleep }))).toMatch(/^config:.*5 MB/);
  });
  it('"Tes koneksi" lists the account models (free) and finds the image model', async () => {
    const s = await store();
    const f = fakeBeliapi();
    const tes = imageAiRoutes(s, f.fetchImpl).find((r) => r.path === '/api/ai/gambar/tes')!;
    const req = Object.assign(new (await import('node:stream')).Readable({ read() {} }), { headers: { 'content-type': 'application/json' } });
    req.push('{}');
    req.push(null);
    const out = (await tes.handle({ req, params: {} } as never)) as { gambar: { last_test: { ok: boolean; message: string }; model_dipakai: string } };
    expect(out.gambar.last_test).toMatchObject({ ok: true, message: expect.stringContaining('nano-banana-2.1') });
    expect(f.calls[0]).toMatchObject({ url: 'https://beliapi.com/v1/models', auth: `Bearer ${KEY}` });
  });
  it('ratio from the wanted size', () => {
    expect([ratioOf('1024x1536'), ratioOf('1536x1024'), ratioOf('1024x1024'), ratioOf('x')]).toEqual(['9:16', '16:9', '1:1', '9:16']);
  });
});
