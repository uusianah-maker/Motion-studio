import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGoogle, startFakeGoogle } from '../../../scripts/fake-google.mjs';
import { HOST, createApp } from '../src/app.js';
import { SESSION_IDLE_MS, SESSION_MAX_MS, checkIdToken, createGoogleAuth, createSecretBox, loadSecretKey, maskEmail, openTokenStore, parseAllowlist, parseCookies } from '../src/auth.js';
import { initWorkspace, readAudit } from '../src/core.js';
import { start } from '../src/main.js';
import { apiRoutes } from '../src/routes.js';
import { createStreamSigner } from '../src/stream.js';

const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w09-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function google(): Promise<FakeGoogle> {
  const g = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  cleanup.push(() => g.close());
  return g;
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
  text: string;
  json: ReturnType<typeof JSON.parse>;
}
function call(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: HOST, port, method: o.method ?? 'GET', path: p, headers: { host: o.host ?? `${HOST}:${port}`, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text || 'null');
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

const setCookies = (r: Reply) => (r.headers['set-cookie'] ?? []) as string[];
const cookieNamed = (r: Reply, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`));
const pair = (c: string | undefined) => (c ? c.split(';')[0]! : '');

async function setup(o: { allowed?: string[]; now?: () => number; dir?: string; g?: FakeGoogle } = {}) {
  const dir = o.dir ?? (await tmp());
  const g = o.g ?? (await google());
  const ws = await initWorkspace(path.join(dir, `ws-${randomBytes(3).toString('hex')}`));
  const stateDir = path.join(dir, 'state');
  const { key } = await loadSecretKey(undefined, stateDir);
  const tokens = await openTokenStore(stateDir, createSecretBox(key));
  let port = 0;
  const auth = createGoogleAuth({
    ws,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedEmails: o.allowed ?? ['owner@example.com'],
    publicUrl: () => `http://${HOST}:${port}`,
    tokens,
    authEndpoint: g.authUrl,
    tokenEndpoint: g.tokenUrl,
    ...(o.now ? { now: o.now } : {}),
  });
  const app = createApp({ ws, auth, routes: apiRoutes({ tmpDir: dir }, createStreamSigner()) });
  port = await app.listen(0);
  cleanup.push(() => app.close());

  /** Drive the browser part: our /login → Google → our /callback (following our redirects to Google). */
  async function login(extraCookie = ''): Promise<{ final: Reply; sid: string; rounds: number }> {
    let r = await call(port, '/api/auth/login');
    let rounds = 0;
    for (;;) {
      rounds++;
      expect(r.status).toBe(302);
      const state = pair(cookieNamed(r, 'motion_oauth'));
      const atGoogle = await fetch(r.headers.location!, { redirect: 'manual' });
      const back = new URL(atGoogle.headers.get('location')!);
      r = await call(port, `${back.pathname}${back.search}`, { headers: { cookie: [state, extraCookie].filter(Boolean).join('; ') } });
      if (r.headers.location?.startsWith(g.authUrl)) continue; // server asked Google again (consent)
      return { final: r, sid: pair(cookieNamed(r, 'motion_sid')), rounds };
    }
  }
  const api = (p: string, sid: string, o2: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    call(port, p, { ...o2, headers: { cookie: sid, 'x-motion-request': '1', ...(o2.body ? { 'content-type': 'application/json' } : {}), ...o2.headers } });
  return { app, port, ws, g, auth, tokens, stateDir, login, api };
}

describe('W09 login Google', () => {
  it('login: PKCE + state cookie, session cookie only, refresh token sealed on the server', async () => {
    const s = await setup();
    const r = await call(s.port, '/api/auth/login');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location!);
    expect(`${loc.origin}${loc.pathname}`).toBe(s.g.authUrl);
    const q = Object.fromEntries(loc.searchParams);
    expect(q).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `http://${HOST}:${s.port}/api/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'select_account',
    });
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.nonce).toBeTruthy();
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sc = cookieNamed(r, 'motion_oauth')!;
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Path=/api/auth');
    expect(sc).not.toContain('Secure'); // http://127.0.0.1: a Secure cookie would be dropped

    const { final, sid } = await s.login();
    expect(final.status).toBe(302);
    expect(final.headers.location).toBe('/');
    const sess = cookieNamed(final, 'motion_sid')!;
    expect(sess).toMatch(/HttpOnly/);
    expect(sess).toMatch(/SameSite=Strict/);
    expect(sess).toMatch(/Path=\//);
    expect(cookieNamed(final, 'motion_oauth')).toContain('Max-Age=0');
    const tr = s.g.state.tokenRequests.at(-1)!;
    expect(tr.client_secret).toBe(CLIENT_SECRET);
    expect(tr.code_verifier?.length).toBeGreaterThanOrEqual(43);

    const me = await s.api('/api/session', sid);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ auth: 'google', actor: 'user', user: { email: 'owner@example.com', name: 'Owner', drive_granted: true } });
    expect((await s.api('/api/projects', sid)).status).toBe(200);
    expect((await s.api('/api/projects', sid, { method: 'POST', body: JSON.stringify({ name: 'Promo' }) })).status).toBe(200);

    // Cookie alone (a forged cross-site request) is not enough; neither is the local URL token.
    expect((await call(s.port, '/api/session', { headers: { cookie: sid } })).status).toBe(401);
    expect((await call(s.port, '/api/session', { headers: { authorization: `Bearer ${s.app.token}`, 'x-motion-request': '1' } })).status).toBe(401);
    expect((await call(s.port, '/api/session', { headers: { cookie: 'motion_sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'x-motion-request': '1' } })).status).toBe(401);

    // Refresh token: on disk only sealed, never in any reply, decrypts on the server.
    const raw = await fsp.readFile(s.tokens.file, 'utf8');
    expect(raw).not.toContain('fake-refresh');
    expect(raw).toContain('"refresh": "v1.');
    const stored = s.tokens.get('1001')!;
    expect(stored.refresh_token).toMatch(/^1\/\/fake-refresh-/);
    expect(stored.scope).toContain('drive.file');
    for (const reply of [final, me]) expect(JSON.stringify(reply.headers) + reply.text).not.toContain('fake-refresh');
    const log = await readAudit(s.ws, (e) => e.op === 'auth.login');
    expect(log.at(-1)).toMatchObject({ outcome: 'ok', email: 'owner@example.com', drive_granted: true, offline_access: true });
    expect(JSON.stringify(log)).not.toContain('fake-refresh');
  });

  it('later logins reuse the stored refresh token; a server without one asks Google for consent once', async () => {
    const dir = await tmp();
    const g = await google();
    const s = await setup({ dir, g });
    expect((await s.login()).rounds).toBe(1);
    const first = s.tokens.get('1001')!.refresh_token;
    const again = await s.login();
    expect(again.rounds).toBe(1); // Google sent no refresh token this time; the stored one stays
    expect(again.sid).toMatch(/^motion_sid=/);
    expect(s.tokens.get('1001')!.refresh_token).toBe(first);

    // A fresh server (empty token store) for an account that already consented before.
    const s2 = await setup({ g });
    const r = await s2.login();
    expect(r.rounds).toBe(2);
    const retry = g.state.authRequests.at(-1)!;
    expect(retry.prompt).toBe('consent');
    expect(retry.login_hint).toBe('owner@example.com');
    expect(r.sid).toMatch(/^motion_sid=/);
    expect(s2.tokens.get('1001')!.refresh_token).toMatch(/^1\/\/fake-refresh-/);
  });

  it('refuses: login CSRF/replay, cancel, unlisted or unverified email, bad id_token, Google errors', async () => {
    const s = await setup({ allowed: ['Owner@Example.com'] });
    const denied = async (code: string, r: Reply) => {
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe(`/#auth_error=${code}`);
      expect(cookieNamed(r, 'motion_sid')).toBeUndefined();
    };
    // Callback without the state cookie of the browser that started the login.
    const start1 = await call(s.port, '/api/auth/login');
    const back1 = new URL((await fetch(start1.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    await denied('STATE_INVALID', await call(s.port, `${back1.pathname}${back1.search}`));
    // …or with another login's cookie.
    const start2 = await call(s.port, '/api/auth/login');
    const start3 = await call(s.port, '/api/auth/login');
    const back2 = new URL((await fetch(start2.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    await denied('STATE_INVALID', await call(s.port, `${back2.pathname}${back2.search}`, { headers: { cookie: pair(cookieNamed(start3, 'motion_oauth')) } }));
    // Replay of a finished callback.
    const start4 = await call(s.port, '/api/auth/login');
    const c4 = pair(cookieNamed(start4, 'motion_oauth'));
    const back4 = new URL((await fetch(start4.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    expect(cookieNamed(await call(s.port, `${back4.pathname}${back4.search}`, { headers: { cookie: c4 } }), 'motion_sid')).toBeTruthy();
    await denied('STATE_INVALID', await call(s.port, `${back4.pathname}${back4.search}`, { headers: { cookie: c4 } }));

    s.g.state.deny = true;
    await denied('ACCESS_DENIED', (await s.login()).final);
    s.g.state.deny = false;

    s.g.state.user = { sub: '2002', email: 'stranger@example.com', email_verified: true, name: 'Stranger' };
    await denied('EMAIL_NOT_ALLOWED', (await s.login()).final);
    expect(s.tokens.has('2002')).toBe(false);
    const audits = JSON.stringify(await readAudit(s.ws, (e) => e.op === 'auth.login' && e.outcome === 'blocked'));
    expect(audits).toContain('s***@example.com');
    expect(audits).not.toContain('stranger@');

    s.g.state.user = { sub: '1001', email: 'owner@example.com', email_verified: false, name: 'Owner' };
    await denied('EMAIL_UNVERIFIED', (await s.login()).final);
    s.g.state.user = { sub: '1001', email: 'OWNER@example.com', email_verified: true, name: 'Owner' };
    const bads: [string, (c: Record<string, unknown>) => Record<string, unknown>][] = [
      ['aud', (c) => ({ ...c, aud: 'other-client.apps.googleusercontent.com' })],
      ['iss', (c) => ({ ...c, iss: 'https://evil.example' })],
      ['nonce', (c) => ({ ...c, nonce: 'replayed-nonce' })],
      ['exp', (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 })],
      ['azp', (c) => ({ ...c, azp: 'other' })],
    ];
    for (const [, mutate] of bads) {
      s.g.state.mutateClaims = mutate;
      await denied('ID_TOKEN_INVALID', (await s.login()).final);
    }
    s.g.state.mutateClaims = null;
    s.g.state.tokenStatus = 500;
    await denied('TOKEN_EXCHANGE_FAILED', (await s.login()).final);
    s.g.state.tokenStatus = 200;
    // Allowlist is case-insensitive (Google may return any casing).
    expect((await s.login()).sid).toMatch(/^motion_sid=/);
    expect(s.auth.sessionCount()).toBe(2);
  });

  it('logout ends the session; sessions expire when idle or too old', async () => {
    let clock = Date.now();
    const s = await setup({ now: () => clock });
    const { sid } = await s.login();
    expect((await s.api('/api/session', sid)).status).toBe(200);
    expect((await call(s.port, '/api/auth/logout', { method: 'POST', headers: { cookie: sid } })).status).toBe(401); // needs our header
    const out = await s.api('/api/auth/logout', sid, { method: 'POST', body: '{}' });
    expect(out.status).toBe(200);
    expect(cookieNamed(out, 'motion_sid')).toContain('Max-Age=0');
    expect((await s.api('/api/session', sid)).status).toBe(401);
    expect((await readAudit(s.ws, (e) => e.op === 'auth.logout')).length).toBe(1);

    const idle = (await s.login()).sid;
    clock += SESSION_IDLE_MS - 60_000;
    expect((await s.api('/api/session', idle)).status).toBe(200);
    clock += SESSION_IDLE_MS + 1;
    expect((await s.api('/api/session', idle)).status).toBe(401);

    clock = Date.now(); // the fake id_token is dated by the real clock
    const old = (await s.login()).sid;
    expect(old).toMatch(/^motion_sid=/);
    const born = clock;
    while (clock - born < SESSION_MAX_MS - SESSION_IDLE_MS) {
      clock += SESSION_IDLE_MS - 60_000;
      expect((await s.api('/api/session', old)).status).toBe(200);
    }
    clock = born + SESSION_MAX_MS + 1;
    expect((await s.api('/api/session', old)).status).toBe(401);
  });

  it('Drive permission unticked: signed in, but drive_granted is false', async () => {
    const s = await setup();
    s.g.state.grantDrive = false;
    const { sid } = await s.login();
    expect((await s.api('/api/session', sid)).json.user).toMatchObject({ email: 'owner@example.com', drive_granted: false });
    expect(s.tokens.get('1001')!.scope).not.toContain('drive.file');
  });

  it('secrets at rest: AES-GCM bound to the account, key file created once, bad keys fail closed', async () => {
    const dir = await tmp();
    const box = createSecretBox(randomBytes(32));
    const sealed = box.seal('1//refresh-abc', 'sub-1');
    expect(sealed).not.toContain('refresh-abc');
    expect(box.open(sealed, 'sub-1')).toBe('1//refresh-abc');
    expect(() => box.open(sealed, 'sub-2')).toThrow(); // copied to another account
    expect(() => createSecretBox(randomBytes(32)).open(sealed, 'sub-1')).toThrow(); // other key
    const flipped = Buffer.from(sealed.slice(3), 'base64url');
    flipped[flipped.length - 1]! ^= 1;
    expect(() => box.open(`v1.${flipped.toString('base64url')}`, 'sub-1')).toThrow();
    expect(box.seal('x', 'a')).not.toBe(box.seal('x', 'a')); // fresh IV

    const stateDir = path.join(dir, 'state');
    const k1 = await loadSecretKey(undefined, stateDir);
    const k2 = await loadSecretKey('', stateDir);
    expect(k1.source).toBe('created');
    expect(k2.source).toBe('file');
    expect(k2.key.equals(k1.key)).toBe(true);
    await expect(loadSecretKey('abc', stateDir)).rejects.toThrow(/64 karakter hex/);
    expect((await loadSecretKey('a'.repeat(64), stateDir)).source).toBe('env');

    const store = await openTokenStore(stateDir, createSecretBox(k1.key));
    await store.put('sub-1', { email: 'owner@example.com', scope: 'openid', refresh_token: '1//r' });
    await expect(openTokenStore(stateDir, createSecretBox(randomBytes(32)))).rejects.toThrow(/kunci enkripsi berbeda/);
    expect((await openTokenStore(stateDir, createSecretBox(k1.key))).get('sub-1')!.refresh_token).toBe('1//r');
  });

  it('pure helpers: allowlist, cookies, id_token claims, masking', () => {
    expect(parseAllowlist(' A@x.com, b@y.co ;a@x.com ')).toEqual(['a@x.com', 'b@y.co']);
    expect(() => parseAllowlist('owner@example.com, nope')).toThrow(/tidak valid/);
    expect(parseCookies('a=1; b=2; a=3; bad; =x')).toEqual({ a: '1', b: '2' });
    expect(maskEmail('owner@example.com')).toBe('o***@example.com');
    const now = Date.now();
    const base = { iss: 'accounts.google.com', aud: 'c', sub: 's', email: 'X@Y.com', email_verified: 'true', nonce: 'n', exp: now / 1000 + 60, iat: now / 1000 };
    expect(checkIdToken(base, { clientId: 'c', nonce: 'n', now })).toMatchObject({ sub: 's', email: 'x@y.com', email_verified: true });
    expect(() => checkIdToken({ ...base, iat: now / 1000 + 3600 }, { clientId: 'c', nonce: 'n', now })).toThrow('iat');
    expect(() => checkIdToken({ ...base, sub: '' }, { clientId: 'c', nonce: 'n', now })).toThrow('sub');
    expect(() => checkIdToken({ ...base, aud: ['c', 'd'] }, { clientId: 'c', nonce: 'n', now })).toThrow('aud');
  });

  it('start(): Google mode fails closed on partial config, never prints a token, https cookies behind a domain', async () => {
    const dir = await tmp();
    const g = await google();
    const ws = path.join(dir, 'ws');
    await initWorkspace(ws);
    const base = { MOTION_WORKSPACE: ws, MOTION_GC: 'off', MOTION_UPLOAD_TMP: dir, MOTION_RENDER_TMP: dir, MOTION_STATE_DIR: path.join(dir, 'state') };
    const full = { ...base, MOTION_GOOGLE_CLIENT_ID: CLIENT_ID, MOTION_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, MOTION_ALLOWED_EMAILS: 'owner@example.com', MOTION_GOOGLE_AUTH_ENDPOINT: g.authUrl, MOTION_GOOGLE_TOKEN_ENDPOINT: g.tokenUrl };
    const quiet = () => undefined;
    await expect(start({ ...base, MOTION_GOOGLE_CLIENT_ID: CLIENT_ID }, quiet)).rejects.toThrow(/belum lengkap.*MOTION_GOOGLE_CLIENT_SECRET.*MOTION_ALLOWED_EMAILS/);
    await expect(start({ ...full, MOTION_ALLOWED_EMAILS: 'owner@example.com, bukan-email' }, quiet)).rejects.toThrow(/tidak valid/);
    await expect(start({ ...full, MOTION_PORT: '0' }, quiet)).rejects.toThrow(/port tetap/);
    await expect(start({ ...full, MOTION_PORT: '1', MOTION_PUBLIC_URL: 'https://motion.example.com/app' }, quiet)).rejects.toThrow(/tanpa path/);
    await expect(start({ ...full, MOTION_PORT: '1', MOTION_GOOGLE_TOKEN_ENDPOINT: 'http://evil.example/token' }, quiet)).rejects.toThrow(/https/);
    await expect(start({ ...full, MOTION_PORT: '1', MOTION_SECRET_KEY: 'short' }, quiet)).rejects.toThrow(/64 karakter hex/);

    const port = await freePort();
    const lines: string[] = [];
    const s = await start({ ...full, MOTION_PORT: String(port) }, (l) => lines.push(l));
    cleanup.push(() => s.stop());
    expect(lines.join('\n')).toContain(`Login Google aktif (1 email diizinkan). Buka: http://127.0.0.1:${port}/`);
    expect(lines.join('\n')).not.toContain('#token=');
    expect((await call(port, '/api/auth/mode')).json).toEqual({ mode: 'google' });
    expect((await call(port, '/api/session', { headers: { authorization: `Bearer ${s.app.token}` } })).status).toBe(401);
    await s.stop();
    cleanup.pop();

    // Behind a domain (VPS + reverse proxy, W15): https cookie names + Secure, Host allowed.
    const port2 = await freePort();
    const s2 = await start({ ...full, MOTION_PORT: String(port2), MOTION_PUBLIC_URL: 'https://motion.example.com' }, quiet);
    cleanup.push(() => s2.stop());
    const r = await call(port2, '/api/auth/login', { host: 'motion.example.com' });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location!).searchParams.get('redirect_uri')).toBe('https://motion.example.com/api/auth/callback');
    const sc = cookieNamed(r, '__Secure-motion_oauth')!;
    expect(sc).toContain('; Secure');
    expect((await call(port2, '/api/health', { host: 'evil.example' })).status).toBe(403);
    const back = new URL((await fetch(r.headers.location!, { redirect: 'manual' })).headers.get('location')!);
    const done = await call(port2, `${back.pathname}${back.search}`, { host: 'motion.example.com', headers: { cookie: pair(sc) } });
    const sid = cookieNamed(done, '__Host-motion_sid')!;
    expect(sid).toContain('; Secure');
    expect(sid).toContain('Path=/');
    await s2.stop();
    cleanup.pop();

    // Tokens sealed with one key cannot be opened with another: refuse to start.
    await expect(start({ ...full, MOTION_PORT: String(port2), MOTION_SECRET_KEY: 'b'.repeat(64) }, quiet)).rejects.toThrow(/kunci enkripsi berbeda/);
  });

  it('local mode is unchanged: URL token works, no Google routes', async () => {
    const dir = await tmp();
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const app = createApp({ ws });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    expect((await call(port, '/api/auth/mode')).json).toEqual({ mode: 'local' });
    expect((await call(port, '/api/auth/login')).status).toBe(404);
    const me = await call(port, '/api/session', { headers: { authorization: `Bearer ${app.token}` } });
    expect(me.json).toMatchObject({ auth: 'local', user: null });
  });
});
