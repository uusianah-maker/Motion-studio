import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp, matchPath } from '../src/app.js';
import { DAY_MS, ManualClock, PURGE_PHRASE, type ProjectManifest, type Workspace, initWorkspace, readAudit, readProject } from '../src/core.js';
import { apiRoutes, safeUploadName } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp(prefix: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(async () => {
    await makeWritable(dir);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}
async function makeWritable(dir: string): Promise<void> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await makeWritable(p);
    else await fsp.chmod(p, 0o666).catch(() => undefined);
  }
}

async function server(opts: { maxBytes?: number } = {}) {
  const clock = new ManualClock(Date.UTC(2026, 10, 1));
  const ws = await initWorkspace(path.join(await tmp('msc-api-'), 'ws'), { clock });
  const uploadTmp = await tmp('msc-up-');
  const app = createApp({ ws, routes: apiRoutes({ tmpDir: uploadTmp, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) }) });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const req = (method: string, p: string, o: { json?: unknown; raw?: Buffer; headers?: Record<string, string>; chunked?: boolean } = {}) =>
    new Promise<{ status: number; body: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const headers: Record<string, string> = { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...o.headers };
      let payload: Buffer | undefined;
      if (o.json !== undefined) {
        payload = Buffer.from(JSON.stringify(o.json));
        headers['content-type'] ??= 'application/json';
      } else if (o.raw) payload = o.raw;
      if (payload && !o.chunked) headers['content-length'] = String(payload.length);
      if (o.chunked) headers['transfer-encoding'] = 'chunked';
      const r = http.request({ host: HOST, port, method, path: p, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  const upload = (query: string, bytes: Buffer, name = 'clip.mp4', headers: Record<string, string> = {}) =>
    req('POST', `/api/media/import?${query}`, { raw: bytes, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...headers } });
  return { ws, clock, app, req, upload, uploadTmp };
}

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Make `oldId` an old, previously referenced, non-current version (eligible after 30 days). */
async function makeOld(s: Awaited<ReturnType<typeof server>>, ws: Workspace) {
  const a = await s.upload('scope=shared', Buffer.from(`old-${Math.random()}`), 'old.mp4');
  const media_id = a.body.media_id as string;
  const oldId = a.body.version.version_id as string;
  const src = path.join(await tmp('msc-src-'), 'new.mp4');
  await fsp.writeFile(src, `new-${Math.random()}`);
  await s.app.svc.addVersion({ media_id, sourcePath: src, actor: 'user' });
  await s.req('POST', '/api/projects', { json: { name: 'Proj', project_id: 'proj' } });
  const commit = async (refs: { media_id: string; version_id: string }[]) => {
    const base: ProjectManifest = await readProject(ws, 'proj');
    const manifest: ProjectManifest = {
      ...base,
      timeline: { tracks: [{ track_id: 'v', kind: 'video', clips: refs.map((m, i) => ({ clip_id: `c${i}`, start_ms: 0, end_ms: 1000, media: m })) }] },
    };
    await s.app.svc.commitProject({ manifest, expected_revision: base.revision, actor: 'user' });
  };
  await commit([{ media_id, version_id: oldId }]);
  await commit([]);
  return { media_id, oldId };
}

describe('W04 router', () => {
  it('path params must be ID-like; traversal never matches', () => {
    expect(matchPath('/api/projects/:id', '/api/projects/p-1')).toEqual({ id: 'p-1' });
    expect(matchPath('/api/projects/:id', '/api/projects/..')).toBeNull();
    expect(matchPath('/api/projects/:id', '/api/projects/%2e%2e%2fx')).toBeNull();
    expect(matchPath('/api/projects/:id', '/api/projects/a/b')).toBeNull();
    expect(matchPath('/api/projects/:id', '/api/projects/%E0%A4%A')).toBeNull();
  });
  it('upload names are reduced to one safe file name', () => {
    expect(safeUploadName(encodeURIComponent('../../evil.mp4'))).toBe('evil.mp4');
    expect(safeUploadName(encodeURIComponent('C:\\Windows\\x.mov'))).toBe('x.mov');
    expect(safeUploadName(encodeURIComponent('a:b*c?.mp4'))).toBe('abc.mp4');
    expect(safeUploadName(encodeURIComponent('CON.mp4'))).toBe('_CON.mp4');
    expect(safeUploadName(encodeURIComponent('video. . '))).toBe('video');
    expect(safeUploadName(undefined)).toBe('upload.bin');
    expect(safeUploadName('%E0%A4%A')).toBe('upload.bin');
  });
});

describe('W04 projects', () => {
  it('create, list, open; validation and conflicts are typed', async () => {
    const s = await server();
    const c = await s.req('POST', '/api/projects', { json: { name: 'Iklan Lebaran' } });
    expect(c.status).toBe(200);
    const id = c.body.project.project_id as string;
    expect(id).toMatch(/^p-[0-9a-f]{12}$/);
    expect((await s.req('GET', '/api/projects')).body.projects).toEqual([expect.objectContaining({ project_id: id, name: 'Iklan Lebaran', revision: 0 })]);
    expect((await s.req('GET', `/api/projects/${id}`)).body.project.timeline).toEqual({ tracks: [] });
    expect((await s.req('POST', '/api/projects', { json: { name: 'X', project_id: id } })).status).toBe(409);
    expect((await s.req('POST', '/api/projects', { json: { name: '' } })).body.error.code).toBe('BAD_REQUEST');
    expect((await s.req('POST', '/api/projects', { json: { name: 'X', extra: 1 } })).body.error.code).toBe('BAD_REQUEST');
    expect((await s.req('POST', '/api/projects', { json: { name: 'X', project_id: '../x' } })).body.error.code).toBe('PATH_INVALID');
    expect((await s.req('POST', '/api/projects', { json: { name: 'X', actor: 'ai' } })).body.error.code).toBe('ACTOR_NOT_ALLOWED');
    expect((await s.req('GET', '/api/projects/nope')).status).toBe(404);
  });
});

describe('W04 media import (upload from browser)', () => {
  it('imports exact bytes with the original name; duplicate returns the same version; temp cleaned', async () => {
    const s = await server();
    const bytes = Buffer.from(`video-bytes-${Math.random()}`.repeat(1000));
    const r = await s.upload('scope=shared', bytes, '../../Klip Saya.mp4');
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.version).toMatchObject({ original_name: 'Klip Saya.mp4', size: bytes.length, content_hash: sha(bytes), lifecycle: 'active', integrity: 'ok' });
    expect(JSON.stringify(r.body)).not.toContain('rel_path'); // no internal paths
    const again = await s.upload('scope=shared', bytes, 'copy.mp4');
    expect(again.body).toMatchObject({ duplicate: true, media_id: r.body.media_id });
    expect(await fsp.readdir(s.uploadTmp)).toEqual([]);
    const list = (await s.req('GET', '/api/media?scope=shared')).body.media;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ media_id: r.body.media_id, display_name: 'Klip Saya.mp4', versions: [expect.objectContaining({ content_hash: sha(bytes) })] });
  });

  it('project scope needs an existing project; list filters by project', async () => {
    const s = await server();
    expect((await s.upload('scope=project&project_id=nope', Buffer.from('x'))).status).toBe(404);
    await s.req('POST', '/api/projects', { json: { name: 'P', project_id: 'p1' } });
    const r = await s.upload('scope=project&project_id=p1', Buffer.from('project-bytes'), 'a.mov');
    expect(r.status).toBe(200);
    expect((await s.req('GET', '/api/media?scope=project&project_id=p1')).body.media).toHaveLength(1);
    expect((await s.req('GET', '/api/media?scope=shared')).body.media).toHaveLength(0);
    expect((await s.req('GET', '/api/media?scope=weird')).status).toBe(400);
    expect(await fsp.readdir(s.uploadTmp)).toEqual([]);
  });

  it('rejects bad uploads: type, length, size cap, scope, empty', async () => {
    const s = await server({ maxBytes: 100 });
    expect((await s.upload('scope=shared', Buffer.from('x'), 'a.mp4', { 'content-type': 'video/mp4' })).status).toBe(415);
    expect((await s.req('POST', '/api/media/import?scope=shared', { raw: Buffer.from('abc'), chunked: true, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(411);
    expect((await s.upload('scope=shared', Buffer.alloc(101, 1))).status).toBe(413);
    expect((await s.upload('scope=everything', Buffer.from('x'))).status).toBe(400);
    expect((await s.upload('', Buffer.from('x'))).status).toBe(400);
    expect((await s.req('POST', '/api/media/import?scope=shared', { raw: Buffer.alloc(0), headers: { 'content-type': 'application/octet-stream' } })).status).toBe(400);
    expect((await s.req('GET', '/api/media')).body.media).toEqual([]);
    expect(await fsp.readdir(s.uploadTmp)).toEqual([]);
  });

  it('upload needs the session token', async () => {
    const s = await server();
    expect((await s.upload('scope=shared', Buffer.from('x'), 'a.mp4', { authorization: '' })).status).toBe(401);
  });
});

describe('W04 Trash, restore, manual purge, dashboard', () => {
  it('full cycle over HTTP; purge needs the token AND the typed phrase; everything audited as user', async () => {
    const s = await server();
    const { oldId } = await makeOld(s, s.ws);
    s.clock.advance(30 * DAY_MS);
    const trash = await s.app.svc.autoTrash({ actor: 'scheduler' });
    expect(trash.moved.map((m) => m.version_id)).toEqual([oldId]);

    const listed = (await s.req('GET', '/api/trash')).body.items;
    expect(listed).toEqual([expect.objectContaining({ version_id: oldId, lifecycle: 'trashed', display_name: 'old.mp4' })]);

    const dash = (await s.req('GET', '/api/dashboard')).body.dashboard;
    expect(dash.trash.map((t: { version_id: string }) => t.version_id)).toEqual([oldId]);
    expect(dash.stats.usage.trash).toBeGreaterThan(0);

    const restored = await s.req('POST', `/api/trash/${oldId}/restore`, { json: {} });
    expect(restored.body.result).toMatchObject({ status: 'restored', version_id: oldId });
    expect((await s.req('GET', '/api/trash')).body.items).toEqual([]);
    expect((await s.req('POST', `/api/trash/${oldId}/restore`, { json: {} })).status).toBe(422); // not in Trash anymore
    expect((await s.req('POST', `/api/trash/${oldId}/restore`, { json: { on_conflict: 'overwrite' } })).status).toBe(400);

    // Back to Trash after a fresh 30-day period, then purge manually.
    s.clock.advance(30 * DAY_MS);
    expect((await s.app.svc.autoTrash({ actor: 'scheduler' })).moved).toHaveLength(1);
    const plan = (await s.req('POST', '/api/purge/prepare', { json: { version_ids: [oldId] } })).body.plan;
    expect(plan).toMatchObject({ required_phrase: PURGE_PHRASE, irreversible: true, items: [expect.objectContaining({ version_id: oldId, purgeable: true })] });
    const wrong = await s.req('POST', '/api/purge/execute', { json: { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: 'hapus' } });
    expect([wrong.status, wrong.body.error.code]).toEqual([403, 'FORBIDDEN']);
    // The request is burnt after any attempt: prepare again.
    const plan2 = (await s.req('POST', '/api/purge/prepare', { json: { version_ids: [oldId] } })).body.plan;
    const done = await s.req('POST', '/api/purge/execute', { json: { request_id: plan2.request_id, confirmation_token: plan2.confirmation_token, typed_phrase: PURGE_PHRASE } });
    expect(done.body.result).toMatchObject({ purged: [oldId] });
    expect((await s.req('GET', '/api/media')).body.media[0].versions.find((v: { version_id: string }) => v.version_id === oldId).lifecycle).toBe('purged');

    const actors = new Set((await readAudit(s.ws, (e) => ['trash.restore', 'purge.prepare', 'purge.item'].includes(String(e.op)))).map((e) => e.actor));
    expect([...actors]).toEqual(['user']);
  });

  it('purge input is validated; an active (not trashed) version is never purgeable', async () => {
    const s = await server();
    const r = await s.upload('scope=shared', Buffer.from('active-bytes'));
    const vid = r.body.version.version_id as string;
    expect((await s.req('POST', '/api/purge/prepare', { json: { version_ids: [] } })).status).toBe(400);
    expect((await s.req('POST', '/api/purge/prepare', { json: { version_ids: 'x' } })).status).toBe(400);
    const plan = (await s.req('POST', '/api/purge/prepare', { json: { version_ids: [vid] } })).body.plan;
    expect(plan.items[0]).toMatchObject({ purgeable: false });
    const res = await s.req('POST', '/api/purge/execute', { json: { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: PURGE_PHRASE } });
    expect(res.body.result).toMatchObject({ purged: [], blocked: [expect.objectContaining({ version_id: vid })] });
    expect((await s.req('POST', '/api/purge/execute', { json: { request_id: 'x', confirmation_token: 'y', typed_phrase: PURGE_PHRASE, extra: true } })).status).toBe(400);
  });
});
