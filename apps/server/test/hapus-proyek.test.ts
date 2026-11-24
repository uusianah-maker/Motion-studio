import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-hapus-'));
  cleanup.push(async () => {
    const walk = async (d: string): Promise<void> => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else await fsp.chmod(p, 0o666).catch(() => undefined);
      }
    };
    await walk(dir);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }) });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (method: string, p: string, body?: unknown, raw?: { bytes: Buffer; type: string }) =>
    new Promise<{ status: number; body: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const payload = raw ? raw.bytes : body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
      const headers: Record<string, string> = { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}` };
      if (payload) {
        headers['content-type'] = raw ? raw.type : 'application/json';
        headers['content-length'] = String(payload.length);
      }
      const r = http.request({ host: HOST, port, method, path: p, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  await call('POST', '/api/projects', { name: 'P', project_id: 'p' });
  const up = await call('POST', '/api/media/import?scope=shared', undefined, { bytes: Buffer.from(`clip-${Math.random()}`), type: 'application/octet-stream' });
  const media = { media_id: up.body.media_id as string, version_id: up.body.version.version_id as string };
  return { call, media };
}

describe('Hapus proyek (keluhan tim 24 Nov): proyek ke Trash, bisa dipulihkan', () => {
  it('hapus → hilang dari daftar, ada di Trash, hanya-baca, medianya tetap dilindungi; pulihkan → kembali utuh', async () => {
    const { call, media } = await setup();
    await call('POST', '/api/projects/p/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 3000 }] });
    await call('POST', '/api/projects', { name: 'Lain', project_id: 'q' });

    const stale = await call('POST', '/api/projects/p/hapus', { expected_revision: 0 });
    expect(stale.status).toBe(409);
    const del = await call('POST', '/api/projects/p/hapus', { expected_revision: 1 });
    expect(del.status).toBe(200);
    expect(del.body.project).toMatchObject({ status: 'archived', dihapus: { status_sebelum: 'active' } });

    const list = await call('GET', '/api/projects');
    expect(list.body.projects.map((p: { project_id: string }) => p.project_id)).toEqual(['q']);
    const trash = await call('GET', '/api/trash/projects');
    expect(trash.body.projects).toMatchObject([{ project_id: 'p', name: 'P' }]);

    // Still readable, but nothing may change it while it is in Trash.
    expect((await call('GET', '/api/projects/p')).status).toBe(200);
    const edit = await call('POST', '/api/projects/p/edit', { expected_revision: 2, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 3000, duration_ms: 1000 }] });
    expect(edit.status).not.toBe(200);
    const meta = await call('POST', '/api/projects/p/meta', { expected_revision: 2, status: 'active' });
    expect(meta.status).not.toBe(200);
    expect((await call('POST', '/api/projects/p/hapus', { expected_revision: 2 })).status).toBe(409);

    const back = await call('POST', '/api/trash/projects/p/restore', {});
    expect(back.status).toBe(200);
    expect(back.body.project).toMatchObject({ project_id: 'p', status: 'active' });
    expect((await call('GET', '/api/trash/projects')).body.projects).toEqual([]);
    const again = await call('GET', '/api/projects/p');
    expect(again.body.project.dihapus).toBeUndefined();
    expect(again.body.project.timeline.tracks.flatMap((t: { clips: unknown[] }) => t.clips)).toHaveLength(1);
    expect((await call('POST', '/api/trash/projects/p/restore', {})).status).toBe(409);
  });

  it('proyek arsip yang dihapus kembali sebagai arsip', async () => {
    const { call } = await setup();
    await call('POST', '/api/projects/p/meta', { expected_revision: 0, status: 'archived' });
    expect((await call('POST', '/api/projects/p/hapus', { expected_revision: 1 })).status).toBe(200);
    const back = await call('POST', '/api/trash/projects/p/restore', {});
    expect(back.body.project).toMatchObject({ status: 'archived' });
  });
});
