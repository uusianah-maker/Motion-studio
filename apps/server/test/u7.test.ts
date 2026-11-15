import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { StorageService, createProject, initWorkspace } from '../src/core.js';
import { reviewRoutes } from '../src/review.js';
import { type Role, allowedRoles, parseRoleLists, roleResolver } from '../src/roles.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(role: Role) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u7-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await createProject(ws, { project_id: 'p', name: 'Promo' });
  await new StorageService(ws).editTimeline({ project_id: 'p', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Halo', start_ms: 0, duration_ms: 1000 }] });
  const app = createApp({ ws, roleOf: () => role, routes: [...apiRoutes({ tmpDir: dir }), ...reviewRoutes(ws)] });
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
  return { call };
}

describe('U7 roles enforced on the server', () => {
  it('rule table: owner admin, editors edit, approvers approve, everyone reads and comments', () => {
    const can = (m: string, p: string) => allowedRoles(m, p).join(',');
    expect(can('GET', '/api/projects/:project_id')).toBe('owner,editor,reviewer');
    expect(can('POST', '/api/projects/:project_id/edit')).toBe('owner,editor');
    expect(can('POST', '/api/projects/:project_id/render')).toBe('owner,editor');
    expect(can('POST', '/api/brands/:brand_id')).toBe('owner');
    expect(can('POST', '/api/brand')).toBe('owner');
    expect(can('DELETE', '/api/ai/providers/:connection_id')).toBe('owner');
    expect(can('POST', '/api/purge/execute')).toBe('owner');
    expect(can('GET', '/api/ai/usage')).toBe('owner'); // AI spending + prompt log: owner only
    expect(can('GET', '/api/ai/log')).toBe('owner');
    expect(can('GET', '/api/ai/providers')).toBe('owner,editor,reviewer'); // Copilot reads the mode
    expect(can('GET', '/api/ai/gambar')).toBe('owner'); // R12a: AI gambar settings, reading too
    expect(can('POST', '/api/ai/gambar/key')).toBe('owner');
    expect(can('POST', '/api/projects/:project_id/comments')).toBe('owner,editor,reviewer');
    expect(can('POST', '/api/projects/:project_id/review')).toBe('owner,reviewer');
    expect(can('POST', '/api/projects/:project_id/variant-approval')).toBe('owner,reviewer');
    expect(can('POST', '/api/projects/:project_id/engine/jobs/:job_id/batch/decide')).toBe('owner,reviewer');
    // Audit 14 Nov: opening an engine plan imports the engine's media (a write) — not for reviewers.
    expect(can('POST', '/api/projects/:project_id/engine/jobs/:job_id/plan')).toBe('owner,editor');
    expect(can('POST', '/api/projects/:project_id/engine/jobs')).toBe('owner,editor');
  });

  it('role lists from env: must be allowed emails, one role each, at least one owner; unlisted = reviewer', () => {
    const allowed = ['o@x.com', 'e@x.com', 'r@x.com', 'n@x.com'];
    expect(parseRoleLists({}, allowed)).toBeNull();
    const lists = parseRoleLists({ MOTION_OWNER_EMAILS: 'O@x.com', MOTION_EDITOR_EMAILS: 'e@x.com', MOTION_REVIEWER_EMAILS: 'r@x.com' }, allowed);
    const of = roleResolver(lists);
    const u = (email: string) => ({ sub: '1', email, name: email });
    expect([of(u('o@x.com')), of(u('E@x.com')), of(u('r@x.com')), of(u('n@x.com')), of(null)]).toEqual(['owner', 'editor', 'reviewer', 'reviewer', 'owner']);
    expect(roleResolver(null)(u('n@x.com'))).toBe('owner'); // no lists = everyone owner (before U7)
    expect(() => parseRoleLists({ MOTION_OWNER_EMAILS: 'x@y.com' }, allowed)).toThrow(/ALLOWED/);
    expect(() => parseRoleLists({ MOTION_OWNER_EMAILS: 'o@x.com', MOTION_EDITOR_EMAILS: 'o@x.com' }, allowed)).toThrow(/satu peran/);
    expect(() => parseRoleLists({ MOTION_EDITOR_EMAILS: 'e@x.com' }, allowed)).toThrow(/owner/);
  });

  it('reviewer: reads + comments + Lulus, cannot edit; editor: edits + comments, cannot approve or change the Brand Kit', async () => {
    const rev = await setup('reviewer');
    expect((await rev.call('/api/session')).json.role).toBe('reviewer');
    expect((await rev.call('/api/projects/p')).status).toBe(200);
    const edit = await rev.call('/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'set_canvas', ratio: '1:1' }] });
    expect(edit.status).toBe(403);
    expect(edit.json.error.message).toContain('Reviewer');
    expect((await rev.call('/api/brands', { kit: { name: 'X' } })).status).toBe(403);
    const c = await rev.call('/api/projects/p/comments', { at_ms: 500, text: 'Bagus' });
    expect(c.status).toBe(200);
    expect(c.json.comment.author).toEqual({ email: null, name: 'Pemilik (PC ini)' });
    expect((await rev.call(`/api/projects/p/comments/${c.json.comment.comment_id}/resolve`, { resolved: true })).status).toBe(200);
    const pass = await rev.call('/api/projects/p/review', { expected_revision: 1, status: 'lulus' });
    expect(pass.status).toBe(200);
    expect(pass.json.state).toBe('lulus');
    expect((await rev.call('/api/projects/p/review')).json.review.state).toBe('lulus');

    const ed = await setup('editor');
    expect((await ed.call('/api/projects/p/edit', { expected_revision: 1, ops: [{ op: 'set_canvas', ratio: '1:1' }] })).status).toBe(200);
    expect((await ed.call('/api/projects/p/comments', { at_ms: 0, text: 'sudah' })).status).toBe(200);
    expect((await ed.call('/api/projects/p/review', { expected_revision: 2, status: 'lulus' })).status).toBe(403);
    expect((await ed.call('/api/brands', { kit: { name: 'X' } })).status).toBe(403);
    expect((await ed.call('/api/purge/prepare', { version_ids: [] })).status).toBe(403);
    expect((await ed.call('/api/projects/p/comments/cm_zz/resolve', { resolved: true })).status).toBe(404);
  });
});
