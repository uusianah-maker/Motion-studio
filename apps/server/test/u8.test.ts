// Batch Remix library API (audit yuki 14 Nov 2026): Pisah Audio job, batch dropdown, Shot Library,
// exclusions sent to the engine, per-sentence breakdown. Engine = fake-engine.mjs (contract stand-in).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { type EngineConfig, StorageService, createProject, initWorkspace } from '../src/core.js';
import { engineRoutes } from '../src/engine.js';
import { allowedRoles } from '../src/roles.js';
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

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(opts: { daftar?: boolean } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u8-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  const root = path.join(dir, 'engine');
  await fsp.mkdir(path.join(root, 'konten'), { recursive: true });
  const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
  ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'konten', 'f1.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3', path.join(root, 'konten', 'f1-vokal.wav')]);
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(ws, { project_id: 'f', name: 'Footage' });
  await createProject(ws, { project_id: 'b', name: 'Batch' });
  const refs = [];
  for (const [n, c] of [['IN1', 'gray'], ['IN2', 'navy']] as const) {
    const src = path.join(dir, `${n}.mp4`);
    ff(['-f', 'lavfi', '-i', `color=c=${c}:s=360x640:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const v = await svc.importMedia({ sourcePath: src, scope: { kind: 'project', project_id: 'f' }, actor: 'user' });
    refs.push({ media_id: v.media.media_id, version_id: v.version.version_id });
  }
  // An engine without `daftar_batch` (older engine.py): a script that exits 2 for it.
  let script = FAKE;
  if (opts.daftar === false) {
    script = path.join(dir, 'old-engine.mjs');
    await fsp.writeFile(script, "process.stderr.write('usage: engine generate|batch|ulang|cek <job_dir>\\n'); process.exit(2);\n");
  }
  const config: EngineConfig = { root, command: process.execPath, script, timeout_ms: 60_000 };
  const copilot = createCopilot(ws);
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...engineRoutes(ws, { copilot, config })] });
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
  const until = async (p: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await call(p);
      if (r.json.job.state !== 'menunggu' && r.json.job.state !== 'berjalan') return r.json;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`timeout ${p}`);
  };
  return { ws, call, until, refs };
}

const brief = { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' };

describe('U8 Batch Remix library API', () => {
  it.skipIf(!hasFfmpeg)('Pisah Audio → batch list → Shot Library + thumbnails → exclusions reach job.json → per-sentence table', async () => {
    const s = await setup();
    const start = await s.call('/api/projects/f/engine/jobs', { mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: s.refs[0] }, { kunci: '$sumber:IN2', ref: s.refs[1] }], pisah: { batch: '2026-11-14_baru' } });
    expect(start.status).toBe(200);
    const id = start.json.job.job_id as string;
    expect((await s.until(`/api/projects/f/engine/jobs/${id}`)).job).toMatchObject({ mode: 'pisah', state: 'siap' });
    const pisah = await s.call(`/api/projects/f/engine/jobs/${id}/pisah`);
    expect(pisah.json.pisah).toMatchObject({ batch: '2026-11-14_baru', files: [{ file: 'IN1.mp4', vokal: true }, { file: 'IN2.mp4', musik: true }] });
    expect((await s.call(`/api/projects/f/engine/jobs/${id}/plan`, {})).status).toBe(400); // no edit plan

    const list = await s.call('/api/engine/batches');
    expect(list.json).toMatchObject({ tersedia: true, batches: [{ batch: '2026-11-14_baru', footage: 2, vo: 2, siap_batch: true }] });

    const lib = await s.call('/api/engine/batches/2026-11-14_baru/shots');
    expect(lib.json.library.shots.map((x: { id: string }) => x.id)).toEqual(['IN1#00', 'IN1#01', 'IN2#00', 'IN2#01', 'X#99']);
    expect(lib.json.kecualikan).toEqual([]);
    expect(JSON.stringify(lib.json)).not.toMatch(/[A-Za-z]:[\\/]/);
    const th = await s.call(`/api/engine/batches/2026-11-14_baru/thumbs?ids=${encodeURIComponent('IN1#00,X#99')}`);
    expect(Object.keys(th.json.thumbs)).toEqual(['IN1#00']);
    expect((await s.call('/api/engine/batches/2026-11-14_baru/thumbs')).status).toBe(400);
    expect((await s.call('/api/engine/batches/..%2Fx/shots')).status).toBe(404);

    const ex = await s.call('/api/engine/batches/2026-11-14_baru/kecualikan', { shots: ['IN2#01', 'IN1#00'] });
    expect(ex.json.kecualikan).toEqual(['IN1#00', 'IN2#01']);
    expect((await s.call('/api/engine/batches/2026-11-14_baru/kecualikan', { shots: ['IN1#00'], extra: 1 })).status).toBe(400);
    expect((await s.call('/api/engine/batches/2026-11-14_baru/shots')).json.kecualikan).toEqual(['IN1#00', 'IN2#01']);

    // The browser cannot inject exclusions itself; the server adds the stored ones.
    const sneaky = await s.call('/api/projects/b/engine/jobs', { mode: 'batch', sources: [], preset: 'p', brief, ai: false, mode_ops: 'u3', batch: { batch: '2026-11-14_baru', jumlah: 2, kecualikan_shot: [] } });
    expect(sneaky.status).toBe(422); // EDIT_INVALID: field tidak dikenal
    const b = await s.call('/api/projects/b/engine/jobs', { mode: 'batch', sources: [], preset: 'p', brief, ai: false, mode_ops: 'u3', batch: { batch: '2026-11-14_baru', jumlah: 2, vo_batch: 'vo-lain', izinkan_musik_tanpa_lisensi: true, buang_otomatis: ['urgensi'] } });
    expect(b.status).toBe(200);
    const bid = b.json.job.job_id as string;
    const job = JSON.parse(await fsp.readFile(path.join(s.ws.root, 'PROJECTS', 'b', '06_ENGINE', bid, 'job.json'), 'utf8'));
    expect(job).toMatchObject({ batch: '2026-11-14_baru', vo_batch: 'vo-lain', izinkan_musik_tanpa_lisensi: true, buang_otomatis: ['urgensi'], kecualikan_shot: ['IN1#00', 'IN2#01'] });
    expect((await s.until(`/api/projects/b/engine/jobs/${bid}`)).job.state).toBe('siap');
    const table = await s.call(`/api/projects/b/engine/jobs/${bid}/batch`);
    expect(table.json.batch.media).toBeUndefined();
    expect(table.json.batch.varian[0]).toMatchObject({ kalimat_sumber: 'mesin', kalimat: [{ teks: 'Hook 1', shot: ['F1#00'] }, { teks: 'Cek keranjang', shot: ['F1#01', 'F1#00', 'F1＠1.5'] }] });
    expect(table.json.batch.varian[1]).toMatchObject({ kalimat_sumber: 'ops', kalimat: [{ teks: 'Hook 2', shot: [] }] });
  }, 90_000);

  it.skipIf(!hasFfmpeg)('an engine without daftar_batch: the dropdown says so, nothing breaks', async () => {
    const s = await setup({ daftar: false });
    const r = await s.call('/api/engine/batches');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tersedia: false, batches: [] });
    expect(r.json.alasan).toMatch(/belum mendukung daftar_batch/);
    expect(r.json.alasan).not.toMatch(/[A-Za-z]:[\\/]/);
  }, 60_000);

  it('roles: everyone reads the library; only owner / editor change exclusions or run Pisah Audio', () => {
    expect(allowedRoles('GET', '/api/engine/batches').join(',')).toBe('owner,editor,reviewer');
    expect(allowedRoles('GET', '/api/engine/batches/:batch/shots').join(',')).toBe('owner,editor,reviewer');
    expect(allowedRoles('GET', '/api/engine/batches/:batch/thumbs').join(',')).toBe('owner,editor,reviewer');
    expect(allowedRoles('POST', '/api/engine/batches/:batch/kecualikan').join(',')).toBe('owner,editor');
    expect(allowedRoles('POST', '/api/projects/:project_id/engine/jobs').join(',')).toBe('owner,editor');
  });
});
