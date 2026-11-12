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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u1-'));
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

describe('U1 brands API', () => {
  it('create / list / update / default / export (no paths) / project brand / delete only when unused', async () => {
    const { call } = await setup();
    const a = await call('POST', '/api/brands', { kit: { name: 'Aysilla Factory', kode: 'ays', colors: ['#ffffff'], guard: { banned: ['termurah'] } } });
    expect(a.status).toBe(200);
    expect(a.body.brand).toMatchObject({ kode: 'AYS', revision: 1, schema_version: 2 });
    const b = await call('POST', '/api/brands', { kit: { name: 'Lucy Pants', kode: 'LCY' } });
    expect((await call('POST', '/api/brands', { kit: { name: 'Dobel', kode: 'AYS' } })).status).toBe(422);
    expect((await call('POST', '/api/brands', { kit: { name: 'X', hacker: 1 } })).status).toBe(422);
    const list = await call('GET', '/api/brands');
    expect(list.body).toMatchObject({ default_id: a.body.brand.brand_id });
    expect(list.body.brands.map((x: { kode: string }) => x.kode)).toEqual(['AYS', 'LCY']);
    const upd = await call('POST', `/api/brands/${b.body.brand.brand_id}`, { expected_revision: 1, kit: { name: 'Lucy Pants', kode: 'LCY', target: 'Wanita 25+' } });
    expect(upd.body.brand).toMatchObject({ revision: 2, target: 'Wanita 25+' });
    expect((await call('POST', `/api/brands/${b.body.brand.brand_id}`, { expected_revision: 1, kit: { name: 'Lucy' } })).status).toBe(409);
    const ex = await call('GET', `/api/brands/${a.body.brand.brand_id}/export`);
    expect(ex.body.export).toMatchObject({ schema: 'brand-kit-export/1', brand: { kode: 'AYS' }, aturan: { terlarang: ['termurah'] } });
    expect(JSON.stringify(ex.body)).not.toMatch(/"path"|msc-u1-/);
    expect((await call('GET', '/api/brands/b-nope')).status).toBe(404);

    // Project brand: chosen in the meta route, shown in the project list, used by brand-check.
    await call('POST', '/api/projects/p/edit', { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'text', text: 'Paling termurah', start_ms: 0, duration_ms: 1000 }] });
    expect((await call('GET', '/api/projects/p/brand-check')).body.issues).toHaveLength(1); // default = AYS bans it
    await call('POST', '/api/projects/p/meta', { expected_revision: 1, brand_id: b.body.brand.brand_id });
    expect((await call('GET', '/api/projects')).body.projects[0].brand_id).toBe(b.body.brand.brand_id);
    expect((await call('GET', '/api/projects/p/brand-check')).body).toMatchObject({ brand_id: b.body.brand.brand_id, issues: [] });
    expect((await call('POST', '/api/projects/p/meta', { expected_revision: 2, brand_id: 'b-nope' })).status).toBe(404);

    expect((await call('POST', `/api/brands/${b.body.brand.brand_id}/delete`, {})).status).toBe(422); // in use
    expect((await call('POST', `/api/brands/${b.body.brand.brand_id}/default`, {})).body).toEqual({ default_id: b.body.brand.brand_id });
    await call('POST', '/api/projects/p/meta', { expected_revision: 2, brand_id: null });
    expect((await call('POST', `/api/brands/${b.body.brand.brand_id}/delete`, {})).status).toBe(200);
    expect((await call('GET', '/api/brands')).body).toMatchObject({ default_id: a.body.brand.brand_id });
  });
});
