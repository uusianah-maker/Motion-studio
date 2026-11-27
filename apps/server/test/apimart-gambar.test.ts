import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { apimartEdit, apimartImageModel, apimartSize } from '../src/ai/imageAi.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 7)]);

async function fakeApimart(opts: { status?: 'completed' | 'failed'; submit?: number } = {}) {
  const seen: { path: string; auth: string | undefined; body: unknown }[] = [];
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const send = (s: number, b: unknown, type = 'application/json') => {
      res.writeHead(s, { 'content-type': type });
      res.end(Buffer.isBuffer(b) ? b : JSON.stringify(b));
    };
    if (req.method === 'POST' && req.url === '/v1/images/generations') return opts.submit ? send(opts.submit, { error: { message: 'no access' } }) : send(200, { code: 200, data: [{ status: 'submitted', task_id: 'task_ABC123' }] });
    if (req.url === '/v1/tasks/task_ABC123') {
      polls++;
      if (polls < 2) return send(200, { code: 200, data: { id: 'task_ABC123', status: 'processing', progress: 40 } });
      if (opts.status === 'failed') return send(200, { code: 200, data: { id: 'task_ABC123', status: 'failed', error: { message: 'content policy' } } });
      return send(200, { code: 200, data: { id: 'task_ABC123', status: 'completed', progress: 100, result: { images: [{ url: [`${base}/f/image/hasil.png`], expires_at: 1 }] } } });
    }
    if (req.url === '/f/image/hasil.png') return send(200, PNG, 'image/png');
    send(404, {});
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(() => new Promise((ok) => server.close(() => ok())));
  return { base, seen };
}

describe('apimart AI gambar (27 Nov)', () => {
  it('pilih model gambar & ukuran', () => {
    expect(apimartImageModel(['claude-opus-4-8', 'gemini-3.1-flash-image-preview', 'gpt-image-2'])).toBe('gpt-image-2');
    expect(apimartImageModel(['nano-banana-2', 'claude-opus-4-8'])).toBe('nano-banana-2');
    expect(apimartImageModel(['claude-opus-4-8'])).toBeNull();
    expect(apimartSize('1024x1536')).toBe('2:3');
    expect(apimartSize('1080x1920')).toBe('9:16');
  });

  it('kirim tugas → tunggu → unduh; foto dikirim sebagai data URI; kunci tidak dikirim ke unduhan', async () => {
    const f = await fakeApimart();
    const r = await apimartEdit('sk-amTEST1234', f.base, 'gpt-image-2', { images: [{ name: 'frame.png', bytes: PNG, mime: 'image/png' }, { name: 'kemeja.jpg', bytes: PNG, mime: 'image/jpeg' }], prompt: 'ganti baju', size: '1024x1536' }, fetch, async () => undefined);
    expect(r.model).toBe('gpt-image-2');
    expect(r.bytes.equals(PNG)).toBe(true);
    const sub = f.seen[0]!;
    expect(sub.auth).toBe('Bearer sk-amTEST1234');
    expect(sub.body).toMatchObject({ model: 'gpt-image-2', size: '2:3', n: 1 });
    expect((sub.body as { image_urls: string[] }).image_urls).toHaveLength(2);
    expect((sub.body as { image_urls: string[] }).image_urls[1]).toMatch(/^data:image\/jpeg;base64,/);
    expect(f.seen.find((s) => s.path.startsWith('/f/'))!.auth).toBeUndefined();
  });

  it('gagal & tanpa akses model: pesan jelas', async () => {
    const f = await fakeApimart({ status: 'failed' });
    await expect(apimartEdit('sk-amTEST1234', f.base, 'gpt-image-2', { images: [], prompt: 'x', size: '1024x1536' }, fetch, async () => undefined)).rejects.toMatchObject({ kind: 'ditolak' });
    const g = await fakeApimart({ submit: 403 });
    await expect(apimartEdit('sk-amTEST1234', g.base, 'gpt-image-2', { images: [], prompt: 'x', size: '1024x1536' }, fetch, async () => undefined)).rejects.toMatchObject({ kind: 'key' });
  });
});
