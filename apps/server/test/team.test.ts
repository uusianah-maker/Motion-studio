import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGoogle, startFakeGoogle } from '../../../scripts/fake-google.mjs';
import { HOST } from '../src/app.js';
import { initWorkspace, openWorkspace, readAudit } from '../src/core.js';
import { start } from '../src/main.js';
import { allowedRoles } from '../src/roles.js';
import { TEAM_FILE, envMembers, openTeamStore } from '../src/team.js';

const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-team-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, HOST, () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: ReturnType<typeof JSON.parse>;
}
function call(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const r = http.request({ host: HOST, port, path: p, method: o.method ?? (data ? 'POST' : 'GET'), headers: { host: `${HOST}:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(t || 'null');
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}
const pair = (c: string | undefined) => (c ? c.split(';')[0]! : '');
const cookieNamed = (r: Reply, name: string) => ((r.headers['set-cookie'] ?? []) as string[]).find((c) => c.startsWith(`${name}=`));

/** A real start() in Google mode against a fake Google; `as(email)` signs in as that account. */
async function boot(o: { dir?: string; g?: FakeGoogle; env?: Record<string, string> } = {}) {
  const dir = o.dir ?? (await tmp());
  const g = o.g ?? (await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
  if (!o.g) cleanup.push(() => g.close());
  const ws = path.join(dir, 'ws');
  await initWorkspace(ws).catch(() => undefined);
  const port = await freePort();
  const stateDir = path.join(dir, 'state');
  const s = await start(
    { MOTION_WORKSPACE: ws, MOTION_GC: 'off', MOTION_UPLOAD_TMP: dir, MOTION_RENDER_TMP: dir, MOTION_STATE_DIR: stateDir, MOTION_PORT: String(port), MOTION_GOOGLE_CLIENT_ID: CLIENT_ID, MOTION_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, MOTION_ALLOWED_EMAILS: 'owner@example.com', MOTION_GOOGLE_AUTH_ENDPOINT: g.authUrl, MOTION_GOOGLE_TOKEN_ENDPOINT: g.tokenUrl, ...o.env },
    () => undefined,
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await s.stop();
  };
  cleanup.push(stop);
  async function as(email: string): Promise<{ sid: string; final: Reply }> {
    g.state.user = { sub: `sub-${email}`, email, email_verified: true, name: email.split('@')[0]! };
    const r = await call(port, '/api/auth/login');
    const state = pair(cookieNamed(r, 'motion_oauth'));
    const back = new URL((await fetch(r.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    const final = await call(port, `${back.pathname}${back.search}`, { headers: { cookie: state } });
    return { sid: pair(cookieNamed(final, 'motion_sid')), final };
  }
  const api = (sid: string, p: string, method = 'GET', body?: unknown) => call(port, p, { method, headers: { cookie: sid, 'x-motion-request': '1' }, ...(body !== undefined ? { body } : {}) });
  return { s, g, dir, ws, port, stateDir, as, api, stop };
}

describe('Halaman Tim: allowlist + peran dikelola owner dari web', () => {
  it('store: env locked, web members persist, last owner and self change refused, damaged file fails closed', async () => {
    const dir = await tmp();
    const env = envMembers(['Owner@x.com', 'ed@x.com'], { owner: ['owner@x.com'], editor: ['ed@x.com'], reviewer: [] });
    expect(env.map((m) => [m.email, m.role, m.source])).toEqual([
      ['owner@x.com', 'owner', 'env'],
      ['ed@x.com', 'editor', 'env'],
    ]);
    expect(envMembers(['a@x.com'], null)[0]!.role).toBe('owner'); // no role lists = owner (before U7)

    const t = await openTeamStore({ stateDir: dir, env, now: () => 1000 });
    const err = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code);
    expect(await err(t.add({ email: 'bukan email', role: 'editor' }, 'owner@x.com'))).toBe('BAD_REQUEST');
    expect(await err(t.add({ email: 'a@x.com', role: 'admin' }, 'owner@x.com'))).toBe('BAD_REQUEST');
    expect(await err(t.add({ email: 'ED@x.com', role: 'reviewer' }, 'owner@x.com'))).toBe('ALREADY_MEMBER');
    const added = await t.add({ email: '  New@X.com ', role: 'reviewer' }, 'owner@x.com');
    expect(added).toEqual({ email: 'new@x.com', role: 'reviewer', source: 'web', added_at: 1000, added_by: 'owner@x.com' });
    expect(t.isAllowed('NEW@x.com')).toBe(true);
    expect(t.roleOf('new@x.com')).toBe('reviewer');

    // Env accounts change only in .env.local.
    expect(await err(t.setRole({ email: 'ed@x.com', role: 'owner' }, 'owner@x.com'))).toBe('MANAGED_BY_ENV');
    expect(await err(t.remove({ email: 'owner@x.com' }, 'new@x.com'))).toBe('MANAGED_BY_ENV');
    expect(await err(t.remove({ email: 'nobody@x.com' }, 'owner@x.com'))).toBe('NOT_FOUND');

    await t.setRole({ email: 'new@x.com', role: 'owner' }, 'owner@x.com');
    expect(await err(t.setRole({ email: 'new@x.com', role: 'editor' }, 'new@x.com'))).toBe('SELF_CHANGE');
    expect(t.list().map((m) => `${m.email}:${m.role}:${m.source}`)).toEqual(['owner@x.com:owner:env', 'new@x.com:owner:web', 'ed@x.com:editor:env']);

    // Reopen: web members come back from team.json; the file holds emails and roles only.
    const t2 = await openTeamStore({ stateDir: dir, env });
    expect(t2.roleOf('new@x.com')).toBe('owner');
    const raw = JSON.parse(await fsp.readFile(path.join(dir, TEAM_FILE), 'utf8'));
    expect(raw).toEqual({ version: 1, members: [{ email: 'new@x.com', role: 'owner', added_at: 1000, added_by: 'owner@x.com' }] });

    // An email moved into the env is governed by the env from then on.
    const t3 = await openTeamStore({ stateDir: dir, env: envMembers(['owner@x.com', 'new@x.com'], { owner: ['owner@x.com'], editor: [], reviewer: ['new@x.com'] }) });
    expect(t3.list().find((m) => m.email === 'new@x.com')).toMatchObject({ role: 'reviewer', source: 'env' });

    // Last owner: with only web owners left (no env owner), the last one cannot go.
    const d2 = await tmp();
    const solo = await openTeamStore({ stateDir: d2, env: [] });
    await solo.add({ email: 'a@x.com', role: 'owner' }, null);
    await solo.add({ email: 'b@x.com', role: 'editor' }, null);
    expect(await err(solo.setRole({ email: 'a@x.com', role: 'editor' }, null))).toBe('LAST_OWNER');
    expect(await err(solo.remove({ email: 'a@x.com' }, null))).toBe('LAST_OWNER');
    await solo.setRole({ email: 'b@x.com', role: 'owner' }, null);
    await solo.remove({ email: 'a@x.com' }, null);
    expect(await err(solo.remove({ email: 'b@x.com' }, null))).toBe('LAST_OWNER');
    expect(solo.list().map((m) => m.email)).toEqual(['b@x.com']);

    await fsp.writeFile(path.join(d2, TEAM_FILE), '{rusak');
    await expect(openTeamStore({ stateDir: d2, env: [] })).rejects.toThrow(/file rusak/);
  });

  it('owner adds an editor from the web: login works at once, role changes at once, removal ends the session at once', async () => {
    const b = await boot();
    expect(allowedRoles('GET', '/api/team')).toEqual(['owner']);
    const owner = await b.as('owner@example.com');
    expect(owner.final.headers.location).toBe('/');

    // Not on the list yet: Google login is refused.
    const early = await b.as('editor@example.com');
    expect(early.final.headers.location).toBe('/#auth_error=EMAIL_NOT_ALLOWED');

    const list0 = await b.api(owner.sid, '/api/team');
    expect(list0.status).toBe(200);
    expect(list0.json.me).toBe('owner@example.com');
    expect(list0.json.members).toEqual([{ email: 'owner@example.com', role: 'owner', source: 'env', added_at: null, added_by: null }]);

    const add = await b.api(owner.sid, '/api/team', 'POST', { email: 'Editor@Example.com', role: 'editor' });
    expect(add.status).toBe(200);
    expect(add.json.member).toMatchObject({ email: 'editor@example.com', role: 'editor', source: 'web', added_by: 'owner@example.com' });
    expect((await b.api(owner.sid, '/api/team', 'POST', { email: 'editor@example.com', role: 'editor' })).status).toBe(409);
    expect((await b.api(owner.sid, '/api/team', 'POST', { email: 'x@example.com', role: 'editor', actor: 'ai' })).status).toBe(400);
    expect((await b.api(owner.sid, '/api/team', 'POST', { email: 'x@example.com', role: 'editor', extra: 1 })).status).toBe(400);

    // No restart: the new editor can sign in now, with the editor role.
    const ed = await b.as('editor@example.com');
    expect(ed.final.headers.location).toBe('/');
    expect((await b.api(ed.sid, '/api/session')).json).toMatchObject({ role: 'editor', user: { email: 'editor@example.com' } });
    // Only the owner sees or changes the team.
    expect((await b.api(ed.sid, '/api/team')).status).toBe(403);
    expect((await b.api(ed.sid, '/api/team', 'POST', { email: 'friend@example.com', role: 'owner' })).status).toBe(403);
    expect((await b.api(ed.sid, '/api/team', 'DELETE', { email: 'owner@example.com' })).status).toBe(403);

    // The env owner is locked, and cannot be demoted or removed from the web.
    expect((await b.api(owner.sid, '/api/team', 'PUT', { email: 'owner@example.com', role: 'editor' })).json.error.code).toBe('MANAGED_BY_ENV');
    expect((await b.api(owner.sid, '/api/team', 'DELETE', { email: 'owner@example.com' })).json.error.code).toBe('MANAGED_BY_ENV');

    // Role change applies to the running session.
    const put = await b.api(owner.sid, '/api/team', 'PUT', { email: 'editor@example.com', role: 'reviewer' });
    expect(put.status).toBe(200);
    expect((await b.api(ed.sid, '/api/session')).json.role).toBe('reviewer');

    // Removal: the session is dead on its very next request, and a new login is refused.
    const del = await b.api(owner.sid, '/api/team', 'DELETE', { email: 'editor@example.com' });
    expect(del.status).toBe(200);
    expect(del.json.members.map((m: { email: string }) => m.email)).toEqual(['owner@example.com']);
    expect((await b.api(ed.sid, '/api/session')).status).toBe(401);
    expect((await b.as('editor@example.com')).final.headers.location).toBe('/#auth_error=EMAIL_NOT_ALLOWED');
    expect((await b.api(owner.sid, '/api/session')).status).toBe(200);

    const ops = (await readAudit(await openWorkspace(b.ws), (e) => e.op.startsWith('team.'))).map((e) => e.op);
    expect(ops).toEqual(['team.add', 'team.role', 'team.remove']);
  });

  it('the list survives a restart; env role lists still apply; team.json holds no secret', async () => {
    const dir = await tmp();
    const g = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    cleanup.push(() => g.close());
    const env = { MOTION_ALLOWED_EMAILS: 'owner@example.com, rev@example.com', MOTION_OWNER_EMAILS: 'owner@example.com', MOTION_REVIEWER_EMAILS: 'rev@example.com' };
    const a = await boot({ dir, g, env });
    const owner = await a.as('owner@example.com');
    expect((await a.api(owner.sid, '/api/team', 'POST', { email: 'cut@example.com', role: 'editor' })).status).toBe(200);
    await a.stop();

    const b = await boot({ dir, g, env });
    const owner2 = await b.as('owner@example.com');
    const members = (await b.api(owner2.sid, '/api/team')).json.members as { email: string; role: string; source: string }[];
    expect(members.map((m) => `${m.email}:${m.role}:${m.source}`)).toEqual(['owner@example.com:owner:env', 'cut@example.com:editor:web', 'rev@example.com:reviewer:env']);
    const rev = await b.as('rev@example.com');
    expect((await b.api(rev.sid, '/api/session')).json.role).toBe('reviewer');
    const cut = await b.as('cut@example.com');
    expect((await b.api(cut.sid, '/api/session')).json.role).toBe('editor');

    const raw = await fsp.readFile(path.join(b.stateDir, TEAM_FILE), 'utf8');
    expect(raw).toContain('cut@example.com');
    expect(raw).not.toContain(CLIENT_SECRET);
    expect(raw).not.toContain('rev@example.com'); // env accounts are not copied into the file
  });
});
