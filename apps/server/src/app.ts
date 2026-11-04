import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Actor, StorageService, type Workspace } from './core.js';
import { ApiError, toApiError } from './errors.js';
import { sendError, sendJson } from './http.js';

/** The server only ever listens on loopback (plan v2.0 W03); remote access comes with W09 + deploy. */
export const HOST = '127.0.0.1';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Always 'user' for HTTP: AI and scheduler actions run inside the server with their own actor. */
  actor: Actor;
  ws: Workspace;
  svc: StorageService;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Public routes skip the session token (health only). */
  public?: boolean;
  handle: (ctx: RequestContext) => Promise<unknown>;
}

export interface AppOptions {
  ws: Workspace;
  /** Session token; a fresh random one per start when omitted. */
  token?: string;
  /** Extra browser origins allowed to call the API (e.g. the web dev server in W05). */
  allowedOrigins?: string[];
  /** Additional routes (W04+). */
  routes?: Route[];
  onError?: (e: unknown) => void;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export function createApp(opts: AppOptions) {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const tokenDigest = digest(token);
  const svc = new StorageService(opts.ws);
  let port = 0;

  const routes: Route[] = [
    { method: 'GET', path: '/api/health', public: true, handle: async () => ({ ok: true }) },
    {
      method: 'GET',
      path: '/api/session',
      handle: async ({ actor, ws }) => ({ actor, workspace_id: ws.meta.workspace_id, storage_backend: ws.blobs.kind }),
    },
    ...(opts.routes ?? []),
  ];

  const allowedHosts = () => new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://${HOST}:${port}`, `http://localhost:${port}`, ...(opts.allowedOrigins ?? [])]);

  function authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    if (!m) return false;
    return timingSafeEqual(digest(m[1]!), tokenDigest);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
    if (!allowedHosts().has((req.headers.host ?? '').toLowerCase())) throw new ApiError(403, 'HOST_REJECTED', 'Host tidak diizinkan');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) throw new ApiError(403, 'ORIGIN_REJECTED', 'Origin tidak diizinkan');
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    const matches = routes.filter((r) => r.path === url.pathname);
    if (!matches.length) throw new ApiError(404, 'NOT_FOUND', 'Endpoint tidak ada');
    const route = matches.find((r) => r.method === req.method);
    if (!route) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method tidak didukung');
    if (!route.public && !authorized(req)) throw new ApiError(401, 'UNAUTHORIZED', 'Sesi tidak valid');
    const body = await route.handle({ req, res, url, actor: 'user', ws: opts.ws, svc });
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

  return {
    server,
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
