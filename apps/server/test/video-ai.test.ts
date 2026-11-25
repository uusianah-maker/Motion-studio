import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { openImageAiStore } from '../src/ai/imageAi.js';
import { createVideoAi } from '../src/ai/videoAi.js';
import { StorageService, createProject, initWorkspace, loadRegistry } from '../src/core.js';

/** 25 Nov: Video AI (beliapi OMNI FLASH 1.2) — queue, references, result into Media. */
const KEY = 'kein_video_key_123456';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(800, 3)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);

async function setup(provider: 'beliapi' | 'openai' = 'beliapi') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-videoai-t-'));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p1', name: 'Uji' });
  const f = path.join(dir, 'produk.png');
  await fsp.writeFile(f, PNG);
  const r = await new StorageService(ws).importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'p1' }, actor: 'user' });
  const img = { media_id: r.media.media_id, version_id: r.version.version_id };
  const store = await openImageAiStore(path.join(dir, 'state'), '33'.repeat(32));
  await store.setKey(KEY);
  await store.setConfig({ provider, endpoint: null, model: null, budget: { amount: null, currency: 'IDR' } });
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (new Headers(init.headers).get('authorization') !== `Bearer ${KEY}`) return new Response('{}', { status: 401 });
    if (u.endsWith('/v1/generations')) {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: 'task_v1' }, { status: 202 });
    }
    if (u.endsWith('/v1/tasks/task_v1')) return Response.json({ id: 'task_v1', status: 'completed', output_url: '/v1/tasks/task_v1/output' });
    if (u.endsWith('/v1/tasks/task_v1/output')) return new Response(new Uint8Array(MP4), { headers: { 'content-type': 'video/mp4' } });
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  const v = createVideoAi(ws, { imageAi: store, fetchImpl, sleep: async () => undefined, tmpRoot: dir });
  const call = async (method: string, body?: unknown) => {
    const route = v.routes.find((x) => x.method === method && x.path === '/api/projects/:project_id/video-ai')!;
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
    return route.handle({ req, params: { project_id: 'p1' }, actor: 'user' } as never) as Promise<Record<string, unknown>>;
  };
  const settle = async () => {
    for (let i = 0; i < 200 && !v.idle(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { ws, v, img, sent, call, settle };
}

describe('Video AI (OMNI FLASH 1.2 lewat beliapi)', () => {
  it('a picture becomes the first frame; the MP4 lands in the project Media; placement is left to the editor', async () => {
    const t = await setup();
    const { job } = (await t.call('POST', { prompt: 'Produk berputar pelan di meja kayu', mode: 'sfv', ratio: '9:16', media: [t.img], tempat: { start_ms: 2000, max_ms: 3000, asal: 'cetakan' } })) as { job: { job_id: string; state: string } };
    expect(job.state).toMatch(/antre|membuat/); // starts at once when the queue is empty
    await t.settle();
    const { jobs } = (await t.call('GET')) as { jobs: { state: string; hasil: { version_id: string } | null; tempat: unknown }[] };
    expect(jobs[0]).toMatchObject({ state: 'siap', tempat: { start_ms: 2000, max_ms: 3000, asal: 'cetakan' } });
    expect(t.sent[0]).toMatchObject({ model: 'omni-1.2', mode: 'sfv', ratio: '9:16' });
    expect((t.sent[0]!.media as string[])[0]).toMatch(/^data:image\/png;base64,/);
    const reg = await loadRegistry(t.ws);
    const v = reg.versions[jobs[0]!.hasil!.version_id]!;
    expect(v.original_name).toMatch(/^Video AI - Produk berputar/);
  });
  it('text only: no mode/media sent; bad input and a non-beliapi provider are refused clearly', async () => {
    const t = await setup();
    await t.call('POST', { prompt: 'Kain linen tertiup angin, cahaya pagi' });
    await t.settle();
    expect(t.sent[0]).toEqual({ model: 'omni-1.2', prompt: 'Kain linen tertiup angin, cahaya pagi', ratio: '9:16' });
    for (const bad of [{ prompt: 'ab' }, { prompt: 'halo dunia', mode: 'sfv' }, { prompt: 'halo dunia', mode: 'i2v', media: [t.img, t.img, t.img, t.img] }, { prompt: 'halo dunia', ratio: '1:1' }, { prompt: 'halo dunia', lain: 1 }]) await expect(t.call('POST', bad), JSON.stringify(bad)).rejects.toThrow();
    const o = await setup('openai');
    await o.call('POST', { prompt: 'Kain linen tertiup angin' });
    await o.settle();
    const { jobs } = (await o.call('GET')) as { jobs: { state: string; alasan: string }[] };
    expect(jobs[0]).toMatchObject({ state: 'gagal', alasan: expect.stringContaining('penyedia beliapi.com') });
  });
});
