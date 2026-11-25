// §29 Beat Spot Ganti Outfit over HTTP: Katalog Produk → siapkan (engine) → AI pictures (app, saved
// key, fake provider) → rakit (engine) → before/after view → plan → applied; make one again (limit),
// budget gate, the key never reaching the engine, roles.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { newestImageModel, openImageAiStore, providerFromKey } from '../src/ai/imageAi.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace, readBrandFor, readProject } from '../src/core.js';
import { createEngine } from '../src/engine.js';
import { createOutfit } from '../src/outfit.js';
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const KEY = 'sk-test-0123456789abcdef';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-outfit-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(root, { recursive: true });
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  const kit = await readBrandFor(ws, undefined);
  await createProject(ws, { project_id: 'b', name: 'Ganti Outfit' });
  const imp = async (name: string, args: string[] | Buffer, scope: 'project' | 'shared' = 'project') => {
    const f = path.join(dir, name);
    if (Buffer.isBuffer(args)) await fsp.writeFile(f, args);
    else execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: scope === 'shared' ? { kind: 'shared' } : { kind: 'project', project_id: 'b' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  const sources = [
    { kunci: '$sumber:jalan-1', ref: await imp('jalan-1.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) },
    { kunci: '$sumber:jalan-2', ref: await imp('jalan-2.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) },
    { kunci: '$sumber:snd', ref: await imp('snd.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=8']) },
  ];
  const foto = async (n: string, c: number) => imp(n, Buffer.concat([PNG, Buffer.from([c])]), 'shared');
  const katalog = [
    { nama: 'Kemeja', jenis: 'atasan', deskripsi: 'kemeja garis', warna: [{ nama: 'Biru', ref: await foto('k-biru.png', 1) }, { nama: 'Krem', ref: await foto('k-krem.png', 2) }] },
    { nama: 'Lucy Pants', jenis: 'bawahan', deskripsi: '', warna: [{ nama: 'Black', ref: await foto('l-black.png', 3) }, { nama: 'Ivory', ref: await foto('l-ivory.png', 4) }] },
  ];
  const config: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const stateDir = path.join(dir, 'state');
  const imageAi = await openImageAiStore(stateDir, '11'.repeat(32));
  // Fake picture provider: records what reached it.
  const seen: { url: string; auth: string | null; prompt: string; images: number; model: string }[] = [];
  let reply: () => Response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const form = init?.body as FormData;
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), prompt: String(form.get('prompt')), images: form.getAll('image[]').length, model: String(form.get('model')) });
    return reply();
  }) as typeof fetch;
  let role: Role = 'editor';
  const copilot = createCopilot(ws);
  let settled: (s: Parameters<NonNullable<Parameters<typeof createEngine>[1]['onSettled']>>[0]) => void = () => undefined;
  const engine = createEngine(ws, { copilot, config, onSettled: (s) => settled(s) });
  const outfit = createOutfit(ws, { engine, imageAi, stateDir, fetchImpl });
  settled = outfit.onSettled;
  const app = createApp({ ws, roleOf: () => role, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engine.routes, ...outfit.routes] });
  const port = await app.listen(0);
  cleanup.push(async () => {
    await outfit.stop();
    await engine.stopAll();
    await app.close();
  });
  const call = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const b = Buffer.concat(chunks);
            const json = (res.headers['content-type'] ?? '').includes('json') ? JSON.parse(b.toString('utf8') || 'null') : { bytes: b.length, type: res.headers['content-type'] };
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  /** Poll the run until it settles in one of `want`. */
  const until = async (jid: string, want: string[]) => {
    for (let i = 0; i < 300; i++) {
      const r = await call(`/api/projects/b/outfit/${jid}`);
      if (r.status === 200 && want.includes(r.json.outfit.tahap)) return r.json.outfit;
      if (r.status !== 200 && r.status !== 400) throw new Error(JSON.stringify(r.json));
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('timeout');
  };
  const jobDone = async (jid: string) => {
    for (let i = 0; i < 300; i++) {
      const j = (await call(`/api/projects/b/engine/jobs/${jid}`)).json.job;
      if (j.state !== 'menunggu' && j.state !== 'berjalan') return j;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('timeout');
  };
  return { ws, call, until, jobDone, sources, katalog, brandId: kit.brand_id, imageAi, seen, setReply: (f: () => Response) => (reply = f), asRole: (r: Role) => (role = r), outfit };
}

describe('§29 Ganti Outfit API', () => {
  it('recognises the provider from the key and picks the newest picture model', () => {
    expect(providerFromKey('sk-abc')).toBe('openai');
    expect(providerFromKey('AIzaXYZ')).toBe('gemini');
    expect(providerFromKey('xyz')).toBeNull();
    expect(newestImageModel(['gpt-4o', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'dall-e-3'])).toBe('gpt-image-1.5');
    expect(newestImageModel(['gpt-4o'])).toBeNull();
  });

  it.skipIf(!hasFfmpeg)('katalog → siapkan → pictures with the saved key → rakit → plan applied; make again is limited', async () => {
    const t = await setup();
    // Katalog Produk (editor may edit; optimistic revision).
    const k0 = (await t.call(`/api/katalog/${t.brandId}`)).json.katalog;
    expect(k0.produk).toEqual([]);
    const k1 = await t.call(`/api/katalog/${t.brandId}`, { produk: t.katalog, expected_revision: 0 });
    expect([k1.status, k1.json.error?.message]).toEqual([200, undefined]);
    expect(k1.json.katalog.produk.map((p: { id: string }) => p.id)).toEqual(['kemeja', 'lucy-pants']);
    expect((await t.call(`/api/katalog/${t.brandId}`, { produk: t.katalog, expected_revision: 0 })).status).toBe(409);

    // No key yet → refused before any job.
    const outfitBody = { sources: t.sources, outfit: { sound: '$sumber:snd', model_sendiri: true, teks_atas: 'uji teks' } };
    expect((await t.call('/api/projects/b/outfit', outfitBody)).status).toBe(409);
    await t.imageAi.setKey(KEY);
    expect(t.imageAi.raw().provider).toBe('openai'); // owner 25 Nov: just paste the key
    // "model sendiri" is mandatory; 6 footage is too many.
    expect((await t.call('/api/projects/b/outfit', { ...outfitBody, outfit: { sound: '$sumber:snd' } })).status).toBe(422);
    const enam = Array.from({ length: 6 }, (_, i) => ({ kunci: `$sumber:x${i}`, ref: t.sources[0]!.ref }));
    expect((await t.call('/api/projects/b/outfit', { ...outfitBody, sources: [...enam, t.sources[2]] })).status).toBe(422);

    const start = await t.call('/api/projects/b/outfit', outfitBody);
    expect([start.status, start.json.error?.message]).toEqual([200, undefined]);
    const jid = start.json.job.job_id as string;
    const job = JSON.parse(await fsp.readFile(path.join(t.ws.root, 'PROJECTS', 'b', '06_ENGINE', jid, 'job.json'), 'utf8'));
    expect(job.mode).toBe('outfit');
    expect(JSON.stringify(job)).not.toContain(KEY); // the key never reaches the engine
    const kat = JSON.parse(await fsp.readFile(path.join(t.ws.root, 'PROJECTS', 'b', '06_ENGINE', jid, 'katalog.json'), 'utf8'));
    expect(kat.produk[0].warna[0].path).toMatch(/\.png$/);

    const v = await t.until(jid, ['siap']);
    expect(v.items).toHaveLength(2);
    expect(v.items.every((i: { gambar: { status: string } }) => i.gambar.status === 'siap')).toBe(true);
    expect(v.items[0].qc.lulus).toBe(true);
    expect(t.seen).toHaveLength(2);
    expect(t.seen[0]).toMatchObject({ auth: `Bearer ${KEY}`, images: 3, model: 'gpt-image-1' });
    expect(t.seen[0]!.url).toBe('https://api.openai.com/v1/images/edits');
    expect(t.seen[0]!.prompt).toContain('Change ONLY the clothes');

    // Pictures for the page (frame, AI result, fitted result, end card).
    for (const j of ['frame', 'hasil', 'diam']) expect((await t.call(`/api/projects/b/outfit/${jid}/gambar/jalan-1/${j}`)).json.type).toBe('image/png');
    expect((await t.call(`/api/projects/b/outfit/${jid}/gambar/end/end`)).json.type).toBe('image/png');
    expect([404, 422]).toContain((await t.call(`/api/projects/b/outfit/${jid}/gambar/..%2F/frame`)).status);

    // The draft: plan of the rakit job, $outfit media imported, approved = on the timeline.
    const plan = await t.call(`/api/projects/b/engine/jobs/${v.rakit.job_id}/plan`, {});
    expect([plan.status, plan.json.error?.message]).toEqual([200, undefined]);
    expect(plan.json.plan.prompt).toContain('Ganti Outfit');
    const ap = await t.call(`/api/projects/b/copilot/plans/${plan.json.plan.plan_id}/apply`, { expected_revision: (await readProject(t.ws, 'b')).revision });
    expect([ap.status, ap.json.error?.message]).toEqual([200, undefined]);
    const p = await readProject(t.ws, 'b');
    expect(p.timeline.tracks.find((x) => x.kind === 'video')!.clips.length).toBe(5); // 2 × (jalan + diam) + end card
    expect(p.timeline.tracks.find((x) => x.kind === 'music')!.clips.length).toBe(1);

    // Make one picture again: counted, then a new rakit; limited to ULANG_MAKS (2).
    for (let n = 1; n <= 2; n++) {
      const u = await t.call(`/api/projects/b/outfit/${jid}/ulang`, { footage: 'jalan-1' });
      expect([u.status, u.json.error?.message]).toEqual([200, undefined]);
      const v2 = await t.until(jid, ['siap']);
      expect(v2.items[0].gambar.ulang).toBe(n);
      expect(v2.rakit.job_id).not.toBe(v.rakit.job_id);
    }
    expect((await t.call(`/api/projects/b/outfit/${jid}/ulang`, { footage: 'jalan-1' })).status).toBe(409);
    expect(t.seen).toHaveLength(4);

    // A look change: a new siapkan job; the untouched footage keeps its picture (no new call for it).
    const ubah = await t.call(`/api/projects/b/outfit/${jid}/ubah`, { look: { 'jalan-2': { atasan: 'kemeja/biru', bawahan: 'lucy-pants/ivory' } } });
    expect([ubah.status, ubah.json.error?.message]).toEqual([200, undefined]);
    const v3 = await t.until(ubah.json.job.job_id, ['siap']);
    expect(v3.items.find((i: { footage: string }) => i.footage === 'jalan-1').gambar.dipakai_ulang).toBe(true);
    expect(v3.items.find((i: { footage: string }) => i.footage === 'jalan-2').look.dipilih).toBe('tim');
    expect(t.seen).toHaveLength(5);

    // Reviewer: reads, cannot start or make again.
    t.asRole('reviewer');
    expect((await t.call(`/api/projects/b/outfit/${jid}`)).status).toBe(200);
    expect((await t.call(`/api/projects/b/outfit/${jid}/ulang`, { footage: 'jalan-2' })).status).toBe(403);
    expect((await t.call('/api/projects/b/outfit', outfitBody)).status).toBe(403);
  }, 120_000);

  it.skipIf(!hasFfmpeg)('budget: no estimated price → blocked; over the monthly limit → blocked; provider errors are shown', async () => {
    const t = await setup();
    await t.call(`/api/katalog/${t.brandId}`, { produk: t.katalog, expected_revision: 0 });
    await t.imageAi.setKey(KEY);
    await t.imageAi.setConfig({ provider: 'openai', endpoint: null, model: null, budget: { amount: 5000, currency: 'IDR' }, harga_per_gambar: null });
    const body = { sources: t.sources, outfit: { sound: '$sumber:snd', model_sendiri: true } };
    const j1 = (await t.call('/api/projects/b/outfit', body)).json.job.job_id;
    const v1 = await t.until(j1, ['gagal']);
    expect(v1.items[0].gambar.alasan).toMatch(/perkiraan harga per gambar/);
    expect(t.seen).toHaveLength(0);

    // 3000 per picture, limit 5000: the first is made, the second would pass the limit.
    await t.imageAi.setConfig({ provider: 'openai', endpoint: null, model: null, budget: { amount: 5000, currency: 'IDR' }, harga_per_gambar: 3000 });
    const j2 = (await t.call('/api/projects/b/outfit', body)).json.job.job_id;
    const v2 = await t.until(j2, ['gagal']);
    expect(v2.items.map((i: { gambar: { status: string } }) => i.gambar.status).sort()).toEqual(['gagal', 'siap']);
    expect(v2.items.find((i: { gambar: { status: string } }) => i.gambar.status === 'gagal').gambar.alasan).toMatch(/Batas biaya/);
    expect(t.seen).toHaveLength(1);
    t.asRole('owner'); // pemakaian AI gambar: menu AI, khusus owner (roles.ts)
    const pakai = (await t.call('/api/ai/gambar/pakai')).json.pakai;
    t.asRole('editor');
    expect(pakai).toMatchObject({ gambar: 1, biaya: 3000, batas: 5000 });

    // Provider refuses the key → shown as such; a failed picture may be retried (not counted).
    await t.imageAi.setConfig({ provider: 'openai', endpoint: null, model: null, budget: { amount: null, currency: 'IDR' }, harga_per_gambar: null });
    t.setReply(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const u = await t.call(`/api/projects/b/outfit/${j2}/ulang`, { footage: v2.items.find((i: { gambar: { status: string } }) => i.gambar.status === 'gagal').footage });
    expect(u.status).toBe(200);
    const v3 = await t.until(j2, ['gagal']);
    const g = v3.items.find((i: { gambar: { status: string } }) => i.gambar.status === 'gagal').gambar;
    expect(g.alasan).toMatch(/API key ditolak/);
    expect(g.ulang).toBe(0);
  }, 120_000);
});
