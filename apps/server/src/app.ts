import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Actor, StorageService, type Workspace } from './core.js';
import { ApiError, toApiError } from './errors.js';
import { sendError, sendJson } from './http.js';
import type { GoogleAuth, SessionUser } from './auth.js';
import { serveStatic } from './static.js';

/** The server only ever listens on loopback (plan v2.0 W03); on a VPS a reverse proxy (W15) fronts it. */
export const HOST = '127.0.0.1';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Decoded `:name` segments of the route path (each must be a safe ID-like segment). */
  params: Record<string, string>;
  /** Always 'user' for HTTP: AI and scheduler actions run inside the server with their own actor. */
  actor: Actor;
  /** Signed-in Google account (W09); null in local-token mode and on public routes. */
  user: SessionUser | null;
  ws: Workspace;
  svc: StorageService;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Exact path; `:name` segments become `ctx.params.name`. */
  path: string;
  /** Public routes skip the session token (health only). */
  public?: boolean;
  handle: (ctx: RequestContext) => Promise<unknown>;
}

export interface AppOptions {
  ws: Workspace;
  /** Session token; a fresh random one per start when omitted. Unused when `auth` is set. */
  token?: string;
  /** Google login (W09). When set, the URL token is off: every API call needs a login session. */
  auth?: GoogleAuth;
  /** Public origin when served behind a proxy/domain (e.g. https://motion.example.com). */
  publicOrigin?: string;
  /** Extra browser origins allowed to call the API (e.g. the web dev server in W05). */
  allowedOrigins?: string[];
  /** Additional routes (W04+). */
  routes?: Route[];
  /** Built web UI folder (apps/web/dist) served at `/` and `/assets/*` (W05). */
  staticDir?: string;
  onError?: (e: unknown) => void;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const PARAM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Match `/api/projects/:id` against a pathname; params must look like IDs (no dots/slashes). */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    let g: string;
    try {
      g = decodeURIComponent(got[i]!);
    } catch {
      return null;
    }
    if (w.startsWith(':')) {
      if (!PARAM_RE.test(g)) return null;
      params[w.slice(1)] = g;
    } else if (w !== g) return null;
  }
  return params;
}

export function createApp(opts: AppOptions) {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const tokenDigest = digest(token);
  const svc = new StorageService(opts.ws);
  let port = 0;

  const routes: Route[] = [
    { method: 'GET', path: '/api/health', public: true, handle: async () => ({ ok: true }) },
    { method: 'GET', path: '/api/auth/mode', public: true, handle: async () => ({ mode: opts.auth ? 'google' : 'local' }) },
    {
      method: 'GET',
      path: '/api/session',
      handle: async ({ actor, ws, user }) => ({
        actor,
        workspace_id: ws.meta.workspace_id,
        storage_backend: ws.blobs.kind,
        auth: opts.auth ? 'google' : 'local',
        user: user ? { email: user.email, name: user.name } : null,
      }),
    },
    ...(opts.auth?.routes ?? []),
    ...(opts.routes ?? []),
  ];

  const pub = opts.publicOrigin ? new URL(opts.publicOrigin) : null;
  if (pub && (pub.origin !== opts.publicOrigin!.replace(/\/$/, '') || !/^https?:$/.test(pub.protocol))) throw new Error(`publicOrigin harus origin saja (tanpa path): ${opts.publicOrigin}`);
  const allowedHosts = () => new Set([`${HOST}:${port}`, `localhost:${port}`, ...(pub ? [pub.host] : [])]);
  const allowedOrigins = () => new Set([`http://${HOST}:${port}`, `http://localhost:${port}`, ...(pub ? [pub.origin] : []), ...(opts.allowedOrigins ?? [])]);

  function bearerOk(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    if (!m) return false;
    return timingSafeEqual(digest(m[1]!), tokenDigest);
  }

  /** Who is calling: `undefined` = not allowed. Google mode: login cookie + our own request header. */
  function caller(req: IncomingMessage): SessionUser | null | undefined {
    if (!opts.auth) return bearerOk(req) ? null : undefined;
    // A custom header cannot be sent cross-site without a CORS preflight we never grant, so a
    // forged form/image/link from another site never reaches a handler even if a cookie leaks along.
    if (req.headers['x-motion-request'] !== '1') return undefined;
    return opts.auth.authenticate(req) ?? undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
    if (!allowedHosts().has((req.headers.host ?? '').toLowerCase())) throw new ApiError(403, 'HOST_REJECTED', 'Host tidak diizinkan');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) throw new ApiError(403, 'ORIGIN_REJECTED', 'Origin tidak diizinkan');
    // Online behind HTTPS (W15): browsers must keep using HTTPS for this host.
    if (pub?.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    if (opts.staticDir && !url.pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (await serveStatic(opts.staticDir, url.pathname, res, req.method === 'HEAD')) return;
      throw new ApiError(404, 'NOT_FOUND', 'Halaman tidak ada');
    }
    const matches = routes.map((r) => ({ r, params: matchPath(r.path, url.pathname) })).filter((m) => m.params !== null);
    if (!matches.length) throw new ApiError(404, 'NOT_FOUND', 'Endpoint tidak ada');
    const hit = matches.find((m) => m.r.method === req.method);
    if (!hit) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method tidak didukung');
    let user: SessionUser | null = null;
    if (!hit.r.public) {
      const who = caller(req);
      if (who === undefined) throw new ApiError(401, 'UNAUTHORIZED', opts.auth ? 'Belum login atau sesi sudah habis' : 'Sesi tidak valid');
      user = who;
    }
    const body = await hit.r.handle({ req, res, url, params: hit.params!, actor: 'user', user, ws: opts.ws, svc });
    if (!res.headersSent) sendJson(res, 200, body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = toApiError(e);
      if (err.code === 'INTERNAL') opts.onError?.(e);
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    });
  });

  // Node's default 5-minute total request limit cuts off large video uploads (Checkpoint D F3).
  // Instead: no total limit, but any socket idle for 2 minutes is closed (stalled/slow-loris senders).
  server.requestTimeout = 0;
  server.timeout = 2 * 60_000;

  return {
    server,
    /** Local-mode URL token. With Google login it is never accepted (and main never prints it). */
    token,
    svc,
    /** Listen on loopback only; resolves with the bound port. */
    listen(p = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, HOST, () => {
          server.off('error', reject);
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
