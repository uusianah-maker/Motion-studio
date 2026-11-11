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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x05-'));
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

describe('X05 project management API', () => {
  it('rename, archive (read-only), duplicate, export → import over HTTP', async () => {
    const { call, media } = await setup();
    await call('POST', '/api/projects/p/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 3000 }] });
    const ren = await call('POST', '/api/projects/p/meta', { expected_revision: 1, name: 'Promo Baru' });
    expect(ren.status).toBe(200);
    expect(ren.body.project).toMatchObject({ name: 'Promo Baru', revision: 2, history: { undo: 1 } });
    expect((await call('POST', '/api/projects/p/meta', { expected_revision: 2, status: 'archived' })).body.project.status).toBe('archived');
    const blocked = await call('POST', '/api/projects/p/edit', { expected_revision: 3, ops: [{ op: 'set_canvas', ratio: '1:1' }] });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/diarsipkan/);
    const list = (await call('GET', '/api/projects')).body.projects;
    expect(list.find((p: { project_id: string }) => p.project_id === 'p').status).toBe('archived');

    const dup = await call('POST', '/api/projects/p/duplicate', {});
    expect(dup.status).toBe(200);
    expect(dup.body.project).toMatchObject({ name: 'Promo Baru (salinan)', status: 'active', revision: 1 });

    const exp = await call('GET', '/api/projects/p/export');
    expect(exp.body.export.format).toBe('motion-studio-project');
    expect(JSON.stringify(exp.body)).not.toMatch(/snapshots|rel_path|msc-x05-/);
    const imp = await call('POST', '/api/projects/import', { data: exp.body.export, name: 'Impor' });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ project: { name: 'Impor', status: 'active' }, remapped: 0 });

    // Refusals: unknown keys, stale revision, junk import, unknown media.
    expect((await call('POST', '/api/projects/p/meta', { expected_revision: 4, name: 'x', owner: 'z' })).status).toBe(400);
    expect((await call('POST', '/api/projects/p/meta', { expected_revision: 1, name: 'x' })).status).toBe(409);
    expect((await call('POST', '/api/projects/import', { data: { format: 'capcut' } })).status).toBe(422);
    const ghost = structuredClone(exp.body.export);
    ghost.project.timeline.tracks[0].clips[0].media = { media_id: 'm_ghost', version_id: 'v_ghost' };
    ghost.media = [{ media_id: 'm_ghost', version_id: 'v_ghost', content_hash: 'sha256:00', display_name: 'hilang.mp4', duration_ms: null }];
    const miss = await call('POST', '/api/projects/import', { data: ghost });
    expect(miss.status).toBe(422);
    expect(miss.body.error.message).toMatch(/hilang\.mp4/);
    expect((await call('GET', '/api/projects')).body.projects).toHaveLength(3);
  });
});
