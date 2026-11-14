import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Route } from './app.js';
import { createSecretBox } from './secrets.js';
import { type Workspace, audit } from './core.js';

/**
 * Google login (W09): OAuth 2.0 authorization code + PKCE, run entirely by the server
 * (confidential "Web application" client). Sign-in only (PC-13: files stay on the server's own
 * disk, no Drive): scopes `openid email profile`, no offline access, no Google token is kept.
 * The browser only ever holds an HttpOnly session cookie. Access is limited to an email
 * allowlist (fail closed: no list = server refuses to start).
 */

export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** A team laptop stays signed in for a week of not using the app, and at most 30 days in a row. */
export const SESSION_IDLE_MS = 7 * 24 * 3_600_000;
export const SESSION_MAX_MS = 30 * 24 * 3_600_000;
/** `last` changes on every request; it is written to disk at most this often. */
const SESSION_TOUCH_SAVE_MS = 5 * 60_000;
export const SESSIONS_FILE = 'sessions.json';
export const LOGIN_TTL_MS = 10 * 60_000;
const MAX_USED_STATES = 10_000;
const MAX_SESSIONS = 200;
const CLOCK_SKEW_MS = 5 * 60_000;

/** Codes the login page shows after a failed callback (`/#auth_error=CODE`). Never PII. */
export type AuthErrorCode = 'ACCESS_DENIED' | 'GOOGLE_ERROR' | 'STATE_INVALID' | 'TOKEN_EXCHANGE_FAILED' | 'ID_TOKEN_INVALID' | 'EMAIL_UNVERIFIED' | 'EMAIL_NOT_ALLOWED';

// ------------------------------------------------------------------ helpers

const b64u = (b: Buffer) => b.toString('base64url');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k && !Object.hasOwn(out, k)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function parseAllowlist(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const badOnes = list.filter((e) => !EMAIL_RE.test(e));
  if (badOnes.length) throw new Error(`MOTION_ALLOWED_EMAILS berisi alamat tidak valid: ${badOnes.join(', ')}`);
  return [...new Set(list)];
}

/** `uusi…@gmail.com` → `u***@gmail.com`: enough to recognise a denied attempt in the audit log. */
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

export function decodeIdToken(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('bentuk id_token salah');
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('klaim id_token bukan objek');
  return claims as Record<string, unknown>;
}

/**
 * The id_token comes straight from Google's token endpoint over TLS in exchange for our client
 * secret, so (per OpenID Connect §3.1.3.7) its signature needs no separate check; the claims do.
 */
export function checkIdToken(claims: Record<string, unknown>, want: { clientId: string; nonce: string; now: number }): { sub: string; email: string; email_verified: boolean; name: string } {
  const fail = (why: string): never => {
    throw new Error(why);
  };
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) fail('iss');
  const aud = claims.aud;
  if (!(aud === want.clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === want.clientId))) fail('aud');
  if (claims.azp !== undefined && claims.azp !== want.clientId) fail('azp');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < want.now - CLOCK_SKEW_MS) fail('exp');
  if (typeof claims.iat === 'number' && claims.iat * 1000 > want.now + CLOCK_SKEW_MS) fail('iat');
  if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, want.nonce)) fail('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) fail('sub');
  if (typeof claims.email !== 'string' || !EMAIL_RE.test(claims.email)) fail('email');
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  const name = typeof claims.name === 'string' ? claims.name.slice(0, 120) : '';
  return { sub: claims.sub as string, email: (claims.email as string).toLowerCase(), email_verified: verified, name };
}

// ------------------------------------------------------------------ provider

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
}

export interface GoogleAuthOptions {
  ws: Workspace;
  clientId: string;
  clientSecret: string;
  /** Fixed list (tests, older callers). Ignored when `isAllowed` is given. */
  allowedEmails?: string[];
  /** Halaman Tim: the CURRENT allowlist, asked at every login and on every request of a session. */
  isAllowed?: (email: string) => boolean;
  /** Public origin of the app, e.g. `http://127.0.0.1:4317` or `https://motion.example.com`. */
  publicUrl: () => string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  now?: () => number;
  fetch?: typeof fetch;
  /**
   * Folder that keeps sessions across server restarts (`<state dir>/sessions.json`). Only the
   * sha256 of each session id is stored, never the cookie itself nor any Google token.
   * Without it sessions live in memory only (tests, older callers).
   */
  stateDir?: string;
}

/** Login-in-progress data, sealed into the browser's own state cookie (no server map to flood). */
interface Pending {
  s: string;
  v: string;
  n: string;
  e: number;
}
interface Session extends SessionUser {
  created: number;
  last: number;
}

export function createGoogleAuth(opts: GoogleAuthOptions) {
  if (!opts.clientId || !opts.clientSecret) throw new Error('Client ID/secret Google wajib');
  if (!opts.isAllowed && !opts.allowedEmails?.length) throw new Error('Daftar email yang diizinkan kosong');
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const fixed = new Set((opts.allowedEmails ?? []).map((e) => e.toLowerCase()));
  const isAllowed = opts.isAllowed ?? ((email: string) => fixed.has(email));
  // Checkpoint E E3: no server-side map of pending logins that anonymous callers could fill to
  // evict real ones. PKCE verifier + nonce travel sealed (AES-GCM, key per server start) in the
  // state cookie; only *finished* states are remembered (to refuse replays), and only until expiry.
  const stateBox = createSecretBox(randomBytes(32));
  const used = new Map<string, number>(); // sha256(state) → expiry
  const sessions = new Map<string, Session>(); // key: hex sha256(session id)
  const sessionFile = opts.stateDir ? path.join(opts.stateDir, SESSIONS_FILE) : null;

  const secure = () => opts.publicUrl().startsWith('https://');
  const sidCookie = () => (secure() ? '__Host-motion_sid' : 'motion_sid');
  // Checkpoint E E12: `__Host-` (no Domain, Path=/) on https so a sibling subdomain cannot plant it.
  const stateCookie = () => (secure() ? '__Host-motion_oauth' : 'motion_oauth');
  const statePath = () => (secure() ? '/' : '/api/auth');
  const redirectUri = () => `${opts.publicUrl()}/api/auth/callback`;
  const cookie = (name: string, value: string, attrs: string) => `${name}=${value}; HttpOnly; ${attrs}${secure() ? '; Secure' : ''}`;

  function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
    res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  function prune(): void {
    const t = now();
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    while (used.size >= MAX_USED_STATES) used.delete(used.keys().next().value!);
    const before = sessions.size;
    for (const [k, s] of sessions) if (expired(s, t) || !isAllowed(s.email)) sessions.delete(k);
    if (sessions.size !== before) saveSessions();
  }
  const expired = (s: Session, t: number) => t - s.last > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS;

  // ---------------------------------------------------------------- sessions on disk
  // A restart of the PC server must not sign the whole team out. A damaged file only costs a
  // fresh login (fail closed: nothing in it is trusted unless every field checks out).
  function loadSessions(): void {
    if (!sessionFile) return;
    let raw: string;
    try {
      raw = readFileSync(sessionFile, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;
      const t = now();
      for (const r of parsed.sessions.slice(0, MAX_SESSIONS) as Record<string, unknown>[]) {
        if (!r || typeof r !== 'object') continue;
        const { k, sub, email, name, created, last } = r;
        if (typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) continue;
        if (typeof sub !== 'string' || typeof email !== 'string' || !EMAIL_RE.test(email) || typeof name !== 'string') continue;
        if (typeof created !== 'number' || typeof last !== 'number' || last < created || last > t + CLOCK_SKEW_MS) continue;
        const s: Session = { sub, email: email.toLowerCase(), name: name.slice(0, 120), created, last };
        if (!expired(s, t) && isAllowed(s.email)) sessions.set(k, s);
      }
    } catch {
      sessions.clear();
    }
  }

  let savedAt = 0;
  let saveTimer: NodeJS.Timeout | null = null;
  /** Write now (login, logout, revoke) — synchronous so a removed session cannot come back after a crash. */
  function saveSessions(): void {
    if (!sessionFile) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const body = JSON.stringify({ version: 1, sessions: [...sessions].map(([k, s]) => ({ k, ...s })) });
    try {
      mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
      const tmp = `${sessionFile}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, sessionFile);
      savedAt = now();
    } catch (e) {
      process.stderr.write(`[server] sesi login tidak bisa disimpan: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  /** Activity only moves `last`: batch those writes. */
  function touchSoon(): void {
    if (!sessionFile || saveTimer || now() - savedAt < SESSION_TOUCH_SAVE_MS) return;
    saveTimer = setTimeout(saveSessions, 1_000);
    saveTimer.unref();
  }
  loadSessions();

  function beginLogin(res: ServerResponse): void {
    prune();
    const state = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(48));
    const nonce = b64u(randomBytes(24));
    const sealed = stateBox.seal(JSON.stringify({ s: state, v: verifier, n: nonce, e: now() + LOGIN_TTL_MS } satisfies Pending), 'oauth-state');
    const q = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      state,
      nonce,
      code_challenge: b64u(sha(verifier)),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    redirect(res, `${opts.authEndpoint ?? GOOGLE_AUTH_ENDPOINT}?${q}`, [cookie(stateCookie(), sealed, `SameSite=Lax; Path=${statePath()}; Max-Age=${LOGIN_TTL_MS / 1000}`)]);
  }

  const clearState = () => cookie(stateCookie(), '', `SameSite=Lax; Path=${statePath()}; Max-Age=0`);

  function openState(raw: string): Pending | null {
    if (!raw || raw.length > 2000) return null;
    try {
      const p = JSON.parse(stateBox.open(raw, 'oauth-state')) as Pending;
      return typeof p.s === 'string' && typeof p.v === 'string' && typeof p.n === 'string' && typeof p.e === 'number' ? p : null;
    } catch {
      return null;
    }
  }

  async function deny(res: ServerResponse, code: AuthErrorCode, details: Record<string, unknown> = {}): Promise<void> {
    await audit(opts.ws, { op: 'auth.login', actor: 'user', outcome: 'blocked', reason: code, ...details }).catch(() => undefined);
    redirect(res, `/#auth_error=${code}`, [clearState()]);
  }

  /** Only the id_token is used; Google's access token is dropped right here (never stored). */
  async function exchange(code: string, verifier: string): Promise<{ id_token: string }> {
    const body = new URLSearchParams({ code, client_id: opts.clientId, client_secret: opts.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: verifier });
    const r = await doFetch(opts.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, unknown>;
    if (typeof data.id_token !== 'string') throw new Error('tidak ada id_token');
    return { id_token: data.id_token };
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    prune();
    const state = url.searchParams.get('state') ?? '';
    const p = openState(parseCookies(req.headers.cookie)[stateCookie()] ?? '');
    // Login CSRF: the callback must come back to the same browser that started the login,
    // within the time limit, and only once.
    if (!p || !state || !sameText(p.s, state) || p.e < now()) return deny(res, 'STATE_INVALID');
    const key = sha(state).toString('hex');
    if (used.has(key)) return deny(res, 'STATE_INVALID');
    used.set(key, p.e);
    const gErr = url.searchParams.get('error');
    if (gErr) return deny(res, gErr === 'access_denied' ? 'ACCESS_DENIED' : 'GOOGLE_ERROR');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) return deny(res, 'GOOGLE_ERROR');

    let tok: Awaited<ReturnType<typeof exchange>>;
    try {
      tok = await exchange(code, p.v);
    } catch (e) {
      return deny(res, 'TOKEN_EXCHANGE_FAILED', { detail: e instanceof Error ? e.message.slice(0, 120) : 'unknown' });
    }
    let user: ReturnType<typeof checkIdToken>;
    try {
      user = checkIdToken(decodeIdToken(tok.id_token), { clientId: opts.clientId, nonce: p.n, now: now() });
    } catch (e) {
      return deny(res, 'ID_TOKEN_INVALID', { claim: e instanceof Error ? e.message.slice(0, 40) : 'unknown' });
    }
    if (!user.email_verified) return deny(res, 'EMAIL_UNVERIFIED', { email: maskEmail(user.email) });
    if (!isAllowed(user.email)) return deny(res, 'EMAIL_NOT_ALLOWED', { email: maskEmail(user.email) });


    const sid = b64u(randomBytes(32));
    const t = now();
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    sessions.set(sha(sid).toString('hex'), { sub: user.sub, email: user.email, name: user.name, created: t, last: t });
    saveSessions();
    await audit(opts.ws, { op: 'auth.login', actor: 'user', outcome: 'ok', email: user.email });
    redirect(res, '/', [clearState(), cookie(sidCookie(), sid, `SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`)]);
  }

  function sessionKey(req: IncomingMessage): string | null {
    const sid = parseCookies(req.headers.cookie)[sidCookie()];
    if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    return sha(sid).toString('hex');
  }

  function authenticate(req: IncomingMessage): SessionUser | null {
    const k = sessionKey(req);
    if (!k) return null;
    const s = sessions.get(k);
    if (!s) return null;
    const t = now();
    // Halaman Tim: an email removed from the team loses its session at once, not at expiry.
    if (expired(s, t) || !isAllowed(s.email)) {
      sessions.delete(k);
      saveSessions();
      return null;
    }
    s.last = t;
    touchSoon();
    return { sub: s.sub, email: s.email, name: s.name };
  }

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/auth/login',
      public: true,
      handle: async ({ res }) => beginLogin(res),
    },
    {
      method: 'GET',
      path: '/api/auth/callback',
      public: true,
      handle: async ({ req, res, url }) => callback(req, res, url),
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      handle: async ({ req, res, user }) => {
        const k = sessionKey(req);
        if (k && sessions.delete(k)) saveSessions();
        await audit(opts.ws, { op: 'auth.logout', actor: 'user', outcome: 'ok', email: user?.email ?? null }).catch(() => undefined);
        res.setHeader('Set-Cookie', cookie(sidCookie(), '', 'SameSite=Strict; Path=/; Max-Age=0'));
        return { ok: true };
      },
    },
  ];

  return {
    mode: 'google' as const,
    routes,
    authenticate,
    /** Drop every session of this email now (Halaman Tim: removed from the team). */
    revokeEmail(email: string): number {
      const e = email.toLowerCase();
      let n = 0;
      for (const [k, s] of sessions) {
        if (s.email === e) {
          sessions.delete(k);
          n++;
        }
      }
      if (n) saveSessions();
      return n;
    },
    /** Test/ops view: active session count (no secrets). */
    sessionCount: () => {
      prune();
      return sessions.size;
    },
  };
}
export type GoogleAuth = ReturnType<typeof createGoogleAuth>;
