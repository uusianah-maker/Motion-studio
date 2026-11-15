// Storage "Verifikasi backup": the owner registers a backup folder and verifies it read-only in the
// background; the result shows per folder. Others only see folder names and cannot start anything.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { backupRoutes } from '../src/backup.js';
import { StorageService, initWorkspace } from '../src/core.js';
import type { Role } from '../src/roles.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('backup verify from Storage', () => {
  it('owner registers + verifies (background, read-only); reviewer sees names only', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-backup-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const svc = new StorageService(ws);
    const src = path.join(dir, 'asli.mp4');
    await fsp.writeFile(src, Buffer.alloc(5000, 7));
    await svc.importMedia({ sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    const backupDir = path.join(dir, 'drive-backup');
    await fsp.mkdir(path.join(backupDir, 'sub'), { recursive: true });
    await fsp.copyFile(src, path.join(backupDir, 'sub', 'salinan.mp4'));
    await fsp.writeFile(path.join(backupDir, 'lain.txt'), 'x');
    const before = await fsp.readFile(path.join(backupDir, 'sub', 'salinan.mp4'));

    let role: Role = 'owner';
    const app = createApp({ ws, roleOf: () => role, routes: backupRoutes(ws) });
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

    expect((await call('/api/backup')).json).toMatchObject({ lokasi: [], verifikasi: { state: 'idle' } });
    // Inside the workspace is refused; a missing folder too.
    expect((await call('/api/backup/lokasi', { path: path.join(dir, 'ws') })).status).toBe(422);
    expect((await call('/api/backup/lokasi', { path: path.join(dir, 'tidak-ada') })).status).toBe(404);
    const reg = await call('/api/backup/lokasi', { path: backupDir });
    expect(reg.status).toBe(200);
    const loc = reg.json.lokasi[0];
    expect(loc).toMatchObject({ nama: 'drive-backup', terverifikasi: 0, terakhir: null });
    expect(path.resolve(loc.path)).toBe(await fsp.realpath(backupDir));

    const start = await call(`/api/backup/lokasi/${loc.location_id}/verifikasi`, {});
    expect([start.status, start.json.verifikasi.state]).toEqual([200, 'berjalan']);
    let st = start.json.verifikasi;
    for (let i = 0; i < 100 && st.state === 'berjalan'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      st = (await call('/api/backup')).json.verifikasi;
    }
    expect(st).toMatchObject({ state: 'selesai', location_id: loc.location_id, hasil: { scanned: 2, hashed: 1, matched: 1 } });
    expect((await call('/api/backup')).json.lokasi[0]).toMatchObject({ terverifikasi: 1, terakhir: expect.any(Number) });
    // Read-only: the backup copy is untouched.
    expect(await fsp.readFile(path.join(backupDir, 'sub', 'salinan.mp4'))).toEqual(before);
    expect((await call('/api/backup/lokasi/op_tidakada/verifikasi', {})).status).toBe(404);

    // A folder that went away: the verify fails with a plain reason, no local path.
    await fsp.rm(backupDir, { recursive: true, force: true });
    await call(`/api/backup/lokasi/${loc.location_id}/verifikasi`, {});
    for (let i = 0; i < 100 && st.state !== 'gagal'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      st = (await call('/api/backup')).json.verifikasi;
    }
    expect(st.state).toBe('gagal');
    expect(st.alasan).not.toContain(dir);

    role = 'reviewer';
    const seen = (await call('/api/backup')).json.lokasi[0];
    expect(seen.nama).toBe('drive-backup');
    expect(seen).not.toHaveProperty('path');
    expect((await call(`/api/backup/lokasi/${loc.location_id}/verifikasi`, {})).status).toBe(403);
    role = 'editor';
    expect((await call('/api/backup/lokasi', { path: dir })).status).toBe(403);
  });
});
