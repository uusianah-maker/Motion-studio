import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Route } from './app.js';
import { type Workspace, audit } from './core.js';

/**
 * Google login (W09, ADR-002): OAuth 2.0 authorization code + PKCE, run entirely by the server
 * (confidential "Web application" client). The browser only ever holds an HttpOnly session
 * cookie; Google tokens stay on the server, the refresh token encrypted at rest (AES-256-GCM).
 * Access is limited to an email allowlist (fail closed: no list = server refuses to start).
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_SCOPES = ['openid', 'email', 'profile', DRIVE_FILE_SCOPE] as const;
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export const SESSION_IDLE_MS = 12 * 3_600_000;
export const SESSION_MAX_MS = 7 * 24 * 3_600_000;
export const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_SESSIONS = 200;
const CLOCK_SKEW_MS = 5 * 60_000;

/** Codes the login page shows after a failed callback (`/#auth_error=CODE`). Never PII. */
export type AuthErrorCode = 'ACCESS_DENIED' | 'GOOGLE_ERROR' | 'STATE_INVALID' | 'TOKEN_EXCHANGE_FAILED' | 'ID_TOKEN_INVALID' | 'EMAIL_UNVERIFIED' | 'EMAIL_NOT_ALLOWED';

// ------------------------------------------------------------------ secrets at rest

const b64u = (b: Buffer) => b.toString('base64url');

/** AES-256-GCM box. `aad` binds a ciphertext to its owner (a token copied to another user fails). */
export function createSecretBox(key: Buffer) {
  if (key.length !== 32) throw new Error('Kunci enkripsi harus 32 byte');
  return {
    seal(plain: string, aad: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`;
    },
    open(sealed: string, aad: string): string {
      if (!sealed.startsWith('v1.')) throw new Error('Format rahasia tidak dikenal');
      const raw = Buffer.from(sealed.slice(3), 'base64url');
      if (raw.length < 29) throw new Error('Rahasia rusak');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;

/**
 * The encryption key: `MOTION_SECRET_KEY` (64 hex chars; preferred on a VPS), else a random key
 * file created once in the server state folder (outside the workspace, never synced to Drive).
 */
export async function loadSecretKey(envValue: string | undefined, stateDir: string): Promise<{ key: Buffer; source: 'env' | 'file' | 'created' }> {
  if (envValue !== undefined && envValue !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(envValue.trim())) throw new Error('MOTION_SECRET_KEY harus 64 karakter hex (32 byte)');
    return { key: Buffer.from(envValue.trim(), 'hex'), source: 'env' };
  }
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'secret.key');
  try {
    await fsp.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const key = await readKeyFile(file);
    return { key, source: 'created' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return { key: await readKeyFile(file), source: 'file' };
}

async function readKeyFile(file: string): Promise<Buffer> {
  const raw = (await fsp.readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`File kunci rusak: ${file}`);
  return Buffer.from(raw, 'hex');
}

interface StoredUser {
  email: string;
  scope: string;
  refresh: string;
  updated_at: number;
}

/** Google refresh tokens per account (`sub`), sealed with the secret box. Used by the Drive backend (W10). */
export async function openTokenStore(stateDir: string, box: SecretBox, now: () => number = Date.now) {
  const file = path.join(stateDir, 'google-tokens.json');
  let users: Record<string, StoredUser> = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { version?: number; users?: Record<string, StoredUser> };
    if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== 'object') throw new Error('bad');
    users = parsed.users;
    // Fail closed at start, not at first use: a key mismatch means the tokens are unusable.
    for (const [sub, u] of Object.entries(users)) box.open(u.refresh, sub);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Simpanan token Google tidak bisa dibuka (${file}): file rusak atau kunci enkripsi berbeda`);
  }
  let writing: Promise<void> = Promise.resolve();
  const save = () => {
    writing = writing.then(async () => {
      await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, users }, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    return writing;
  };
  return {
    file,
    has: (sub: string) => Object.hasOwn(users, sub),
    get(sub: string): { email: string; scope: string; refresh_token: string; updated_at: number } | null {
      const u = users[sub];
      return u ? { email: u.email, scope: u.scope, refresh_token: box.open(u.refresh, sub), updated_at: u.updated_at } : null;
    },
    async put(sub: string, v: { email: string; scope: string; refresh_token: string }): Promise<void> {
      users[sub] = { email: v.email, scope: v.scope, refresh: box.seal(v.refresh_token, sub), updated_at: now() };
      await save();
    },
    /** Scope changes without a new refresh token (Google returns one only on first consent). */
    async touch(sub: string, scope: string): Promise<void> {
      const u = users[sub];
      if (!u) return;
      u.scope = scope;
      u.updated_at = now();
      await save();
    },
  };
}
export type TokenStore = Awaited<ReturnType<typeof openTokenStore>>;

// ------------------------------------------------------------------ helpers

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
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

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
  /** Whether the account granted `drive.file` (Google lets users untick it on the consent page). */
  drive_granted: boolean;
}

export interface GoogleAuthOptions {
  ws: Workspace;
  clientId: string;
  clientSecret: string;
  allowedEmails: string[];
  /** Public origin of the app, e.g. `http://127.0.0.1:4317` or `https://motion.example.com`. */
  publicUrl: () => string;
  tokens: TokenStore;
  authEndpoint?: string;
  tokenEndpoint?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

interface Pending {
  verifier: string;
  nonce: string;
  created: number;
  consent: boolean;
}
interface Session extends SessionUser {
  created: number;
  last: number;
}

export function createGoogleAuth(opts: GoogleAuthOptions) {
  if (!opts.clientId || !opts.clientSecret) throw new Error('Client ID/secret Google wajib');
  if (!opts.allowedEmails.length) throw new Error('Daftar email yang diizinkan kosong');
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const allowed = new Set(opts.allowedEmails.map((e) => e.toLowerCase()));
  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Session>(); // key: hex sha256(session id)

  const secure = () => opts.publicUrl().startsWith('https://');
  const sidCookie = () => (secure() ? '__Host-motion_sid' : 'motion_sid');
  const stateCookie = () => (secure() ? '__Secure-motion_oauth' : 'motion_oauth');
  const redirectUri = () => `${opts.publicUrl()}/api/auth/callback`;
  const cookie = (name: string, value: string, attrs: string) => `${name}=${value}; HttpOnly; ${attrs}${secure() ? '; Secure' : ''}`;

  function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
    res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  function prune(): void {
    const t = now();
    for (const [k, p] of pending) if (t - p.created > LOGIN_TTL_MS) pending.delete(k);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    for (const [k, s] of sessions) if (expired(s, t)) sessions.delete(k);
  }
  const expired = (s: Session, t: number) => t - s.last > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS;

  function beginLogin(res: ServerResponse, extra: { consent?: boolean; login_hint?: string } = {}): void {
    prune();
    const state = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(48));
    const nonce = b64u(randomBytes(24));
    pending.set(state, { verifier, nonce, created: now(), consent: !!extra.consent });
    const q = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      state,
      nonce,
      code_challenge: b64u(sha(verifier)),
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: extra.consent ? 'consent' : 'select_account',
      ...(extra.login_hint ? { login_hint: extra.login_hint } : {}),
    });
    redirect(res, `${opts.authEndpoint ?? GOOGLE_AUTH_ENDPOINT}?${q}`, [cookie(stateCookie(), state, `SameSite=Lax; Path=/api/auth; Max-Age=${LOGIN_TTL_MS / 1000}`)]);
  }

  const clearState = () => cookie(stateCookie(), '', 'SameSite=Lax; Path=/api/auth; Max-Age=0');

  async function deny(res: ServerResponse, code: AuthErrorCode, details: Record<string, unknown> = {}): Promise<void> {
    await audit(opts.ws, { op: 'auth.login', actor: 'user', outcome: 'blocked', reason: code, ...details }).catch(() => undefined);
    redirect(res, `/#auth_error=${code}`, [clearState()]);
  }

  async function exchange(code: string, verifier: string): Promise<{ id_token: string; refresh_token?: string; scope: string }> {
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
    return {
      id_token: data.id_token,
      ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      scope: typeof data.scope === 'string' ? data.scope : '',
    };
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    prune();
    const state = url.searchParams.get('state') ?? '';
    const bound = parseCookies(req.headers.cookie)[stateCookie()] ?? '';
    const p = state ? pending.get(state) : undefined;
    if (p) pending.delete(state); // single use, whatever happens next
    // Login CSRF: the callback must come back to the same browser that started the login.
    if (!p || !bound || !sameText(bound, state)) return deny(res, 'STATE_INVALID');
    const gErr = url.searchParams.get('error');
    if (gErr) return deny(res, gErr === 'access_denied' ? 'ACCESS_DENIED' : 'GOOGLE_ERROR');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) return deny(res, 'GOOGLE_ERROR');

    let tok: Awaited<ReturnType<typeof exchange>>;
    try {
      tok = await exchange(code, p.verifier);
    } catch (e) {
      return deny(res, 'TOKEN_EXCHANGE_FAILED', { detail: e instanceof Error ? e.message.slice(0, 120) : 'unknown' });
    }
    let user: ReturnType<typeof checkIdToken>;
    try {
      user = checkIdToken(decodeIdToken(tok.id_token), { clientId: opts.clientId, nonce: p.nonce, now: now() });
    } catch (e) {
      return deny(res, 'ID_TOKEN_INVALID', { claim: e instanceof Error ? e.message.slice(0, 40) : 'unknown' });
    }
    if (!user.email_verified) return deny(res, 'EMAIL_UNVERIFIED', { email: maskEmail(user.email) });
    if (!allowed.has(user.email)) return deny(res, 'EMAIL_NOT_ALLOWED', { email: maskEmail(user.email) });

    if (tok.refresh_token) await opts.tokens.put(user.sub, { email: user.email, scope: tok.scope, refresh_token: tok.refresh_token });
    else if (opts.tokens.has(user.sub)) await opts.tokens.touch(user.sub, tok.scope);
    else if (!p.consent) {
      // Google only sends a refresh token on a consent screen; ask once, for this account.
      return beginLogin(res, { consent: true, login_hint: user.email });
    }

    const sid = b64u(randomBytes(32));
    const t = now();
    const drive_granted = tok.scope.split(' ').includes(DRIVE_FILE_SCOPE);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    sessions.set(sha(sid).toString('hex'), { sub: user.sub, email: user.email, name: user.name, drive_granted, created: t, last: t });
    await audit(opts.ws, { op: 'auth.login', actor: 'user', outcome: 'ok', email: user.email, drive_granted, offline_access: opts.tokens.has(user.sub) });
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
    if (expired(s, t)) {
      sessions.delete(k);
      return null;
    }
    s.last = t;
    return { sub: s.sub, email: s.email, name: s.name, drive_granted: s.drive_granted };
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
        if (k) sessions.delete(k);
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
    allowedCount: allowed.size,
    /** Test/ops view: active session count (no secrets). */
    sessionCount: () => {
      prune();
      return sessions.size;
    },
  };
}
export type GoogleAuth = ReturnType<typeof createGoogleAuth>;
