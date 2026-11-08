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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w06-'));
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

describe('W06 timeline edit API', () => {
  it('edit → undo → redo over HTTP, with revision checks; history timelines stay on the server', async () => {
    const { call, media } = await setup();
    const add = await call('POST', '/api/projects/p/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 5000 }] });
    expect(add.status).toBe(200);
    expect(add.body.project.revision).toBe(1);
    expect(add.body.project.history).toEqual({ undo: 1, redo: 0, undo_label: 'Tambah klip', redo_label: null });
    expect(add.body.project).not.toHaveProperty('snapshots');
    const clip = add.body.project.timeline.tracks[0].clips[0];
    expect(clip).toMatchObject({ start_ms: 0, end_ms: 5000, in_ms: 0, media });

    const split = await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'split_clip', clip_id: clip.clip_id, at_ms: 2000 }] });
    expect(split.body.project.timeline.tracks[0].clips.map((c: { in_ms: number }) => c.in_ms)).toEqual([0, 2000]);

    const stale = await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: clip.clip_id }] });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'CONFLICT']);

    const undo = await call('POST', '/api/projects/p/undo', { expected_revision: 2 });
    expect(undo.body.project.timeline.tracks[0].clips).toHaveLength(1);
    expect(undo.body.project.history).toMatchObject({ undo: 1, redo: 1, redo_label: 'Split klip' });
    const redo = await call('POST', '/api/projects/p/redo', { expected_revision: 3 });
    expect(redo.body.project.timeline.tracks[0].clips).toHaveLength(2);

    const get = await call('GET', '/api/projects/p');
    expect(get.body.project.revision).toBe(4);
    expect(get.body.project).not.toHaveProperty('snapshots');
  });

  it('invalid edits are typed 422/400 and change nothing', async () => {
    const { call, media } = await setup();
    await call('POST', '/api/projects/p/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 3000 }] });
    const overlap = await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 1000, duration_ms: 3000 }] });
    expect([overlap.status, overlap.body.error.code]).toEqual([422, 'EDIT_INVALID']);
    expect((await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'nuke' }] })).body.error.code).toBe('EDIT_INVALID');
    expect((await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [], extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/projects/p/edit', { expected_revision: 'x', ops: [] })).status).toBe(400);
    expect((await call('POST', '/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'delete_clip', clip_id: 'c_x' }], actor: 'ai' })).body.error.code).toBe('ACTOR_NOT_ALLOWED');
    expect((await call('POST', '/api/projects/p/redo', { expected_revision: 1 })).body.error.code).toBe('EDIT_INVALID');
    expect((await call('POST', '/api/projects/nope/undo', { expected_revision: 0 })).status).toBe(404);
    expect((await call('GET', '/api/projects/p')).body.project.revision).toBe(1);
  });
});
