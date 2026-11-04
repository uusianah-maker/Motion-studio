import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Route } from './app.js';
import {
  type MediaScope,
  type ProjectManifest,
  type Registry,
  type VersionRecord,
  type Workspace,
  createProject,
  diskSpace,
  estimateSpace,
  getDashboard,
  listProjectIds,
  loadRegistry,
  readProject,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';

// ------------------------------------------------------------------ input helpers

const bad = (message: string) => new ApiError(400, 'BAD_REQUEST', message);

function str(body: Record<string, unknown>, key: string, opts: { optional?: boolean; max?: number } = {}): string | undefined {
  const v = body[key];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > (opts.max ?? 200)) throw bad(`Field "${key}" wajib teks 1–${opts.max ?? 200} karakter`);
  return v;
}

function strList(body: Record<string, unknown>, key: string, max = 200): string[] {
  const v = body[key];
  if (!Array.isArray(v) || !v.length || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)) {
    throw bad(`Field "${key}" wajib daftar ID (1–${max})`);
  }
  return v as string[];
}

/** Only fields the route knows are accepted (typos and smuggled fields are rejected, not ignored). */
function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`Field tidak dikenal: ${extra.join(', ')}`);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Original file name from the browser → a safe single file name (never a path). */
export function safeUploadName(raw: string | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = '';
  }
  name = name.split(/[\\/]/).pop() ?? '';
  name = [...name].filter((c) => c.charCodeAt(0) >= 0x20 && !'<>:"|?*'.includes(c)).join('');
  name = name.replace(/[. ]+$/, '').replace(/^[. ]+/, '').slice(0, 180);
  if (!name) return 'upload.bin';
  return WIN_RESERVED.test(name) ? `_${name}` : name;
}

function scopeFrom(url: URL): MediaScope {
  const scope = url.searchParams.get('scope');
  if (scope === 'shared') return { kind: 'shared' };
  if (scope === 'project') {
    const project_id = url.searchParams.get('project_id');
    if (!project_id) throw bad('project_id wajib untuk scope=project');
    return { kind: 'project', project_id };
  }
  throw bad('scope wajib "shared" atau "project"');
}

// ------------------------------------------------------------------ views (no internal paths)

function versionView(v: VersionRecord) {
  return {
    version_id: v.version_id,
    original_name: v.original_name,
    size: v.size,
    content_hash: v.content_hash,
    imported_at: v.imported_at,
    lifecycle: v.lifecycle,
    integrity: v.integrity,
    ever_referenced: v.ever_referenced,
    keep: v.keep,
    pin: v.pin,
    legal_hold: v.legal_hold,
    trashed_at: v.trash?.trashed_at ?? null,
  };
}

function mediaList(reg: Registry, filter: (scope: MediaScope) => boolean) {
  const versions = Object.values(reg.versions);
  return Object.values(reg.media)
    .filter((m) => filter(m.scope))
    .sort((a, b) => b.created_at - a.created_at)
    .map((m) => ({
      media_id: m.media_id,
      display_name: m.display_name,
      scope: m.scope,
      created_at: m.created_at,
      current_version_id: m.current_version_id,
      versions: versions.filter((v) => v.media_id === m.media_id).sort((a, b) => a.imported_at - b.imported_at).map(versionView),
    }));
}

const projectSummary = (m: ProjectManifest) => ({
  project_id: m.project_id,
  name: m.name,
  status: m.status,
  revision: m.revision,
  created_at: m.created_at,
  updated_at: m.updated_at,
});

// ------------------------------------------------------------------ upload

export interface UploadOptions {
  /** Where uploads are staged before import; must be outside the workspace. */
  tmpDir: string;
  /** Hard cap per upload (bytes). */
  maxBytes: number;
}

/**
 * Stream the request body to a temp file (outside the workspace), enforcing the declared
 * Content-Length exactly. The storage core then copies + hashes it into the workspace.
 */
async function receiveUpload(ws: Workspace, req: IncomingMessage, opts: UploadOptions): Promise<{ file: string; dir: string; name: string; size: number }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/octet-stream') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload harus application/octet-stream');
  const declared = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isSafeInteger(declared) || declared < 0) throw new ApiError(411, 'LENGTH_REQUIRED', 'Content-Length wajib');
  if (declared === 0) throw bad('File kosong');
  if (declared > opts.maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'File melebihi batas upload');
  const ws_space = await estimateSpace(ws, { bytes_needed: declared });
  if (!ws_space.ok) throw new ApiError(507, 'INSUFFICIENT_STORAGE', ws_space.reason ?? 'Ruang workspace tidak cukup');
  const tmpSpace = await diskSpace(opts.tmpDir);
  if (!tmpSpace || tmpSpace.free_bytes < declared) throw new ApiError(507, 'INSUFFICIENT_STORAGE', 'Ruang folder upload sementara tidak cukup');

  const name = safeUploadName(req.headers['x-file-name'] as string | undefined);
  const dir = await fsp.mkdtemp(path.join(opts.tmpDir, 'motion-upload-'));
  const file = path.join(dir, name);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > declared) cb(new ApiError(400, 'BAD_REQUEST', 'Body lebih besar dari Content-Length'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(file, { flags: 'wx' }));
    if (size !== declared) throw bad('Upload terputus (ukuran tidak cocok)');
    return { file, dir, name, size };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    if (e instanceof ApiError) throw e;
    throw bad('Upload gagal diterima');
  }
}

// ------------------------------------------------------------------ routes

export function apiRoutes(upload: Partial<UploadOptions> = {}): Route[] {
  const uploadOpts: UploadOptions = { tmpDir: upload.tmpDir ?? os.tmpdir(), maxBytes: upload.maxBytes ?? 50 * 1024 ** 3 };
  return [
    // Projects
    {
      method: 'GET',
      path: '/api/projects',
      handle: async ({ ws }) => {
        const out = [];
        for (const id of await listProjectIds(ws)) {
          out.push(await readProject(ws, id).then(projectSummary, () => ({ project_id: id, error: 'PROJECT_INVALID' })));
        }
        return { projects: out };
      },
    },
    {
      method: 'POST',
      path: '/api/projects',
      handle: async ({ req, ws }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['name', 'project_id']);
        const name = str(body, 'name', { max: 120 })!.trim();
        const project_id = str(body, 'project_id', { optional: true, max: 64 }) ?? `p-${randomBytes(6).toString('hex')}`;
        return { project: projectSummary(await createProject(ws, { project_id, name })) };
      },
    },
    { method: 'GET', path: '/api/projects/:project_id', handle: async ({ ws, params }) => ({ project: await readProject(ws, params.project_id!) }) },

    // Media
    {
      method: 'GET',
      path: '/api/media',
      handle: async ({ ws, url }) => {
        const scope = url.searchParams.get('scope');
        const pid = url.searchParams.get('project_id');
        const filter = (s: MediaScope) =>
          !scope || scope === 'all' ? true : scope === 'shared' ? s.kind === 'shared' : s.kind === 'project' && (!pid || s.project_id === pid);
        if (scope && !['all', 'shared', 'project'].includes(scope)) throw bad('scope tidak dikenal');
        return { media: mediaList(await loadRegistry(ws), filter) };
      },
    },
    {
      method: 'POST',
      path: '/api/media/import',
      handle: async ({ req, url, ws, svc, actor }) => {
        const scope = scopeFrom(url);
        const display_name = url.searchParams.get('display_name') ?? undefined;
        if (display_name !== undefined && (!display_name.trim() || display_name.length > 200)) throw bad('display_name tidak valid');
        const up = await receiveUpload(ws, req, uploadOpts);
        try {
          const r = await svc.importMedia({ sourcePath: up.file, scope, actor, ...(display_name ? { display_name } : {}) });
          return { media_id: r.media.media_id, version: versionView(r.version), duplicate: r.duplicate };
        } finally {
          await fsp.rm(up.dir, { recursive: true, force: true });
        }
      },
    },

    // Trash / restore / manual purge
    {
      method: 'GET',
      path: '/api/trash',
      handle: async ({ ws }) => {
        const reg = await loadRegistry(ws);
        const items = Object.values(reg.versions)
          .filter((v) => v.lifecycle === 'trashed' && v.trash)
          .sort((a, b) => b.trash!.trashed_at - a.trash!.trashed_at)
          .map((v) => ({ ...versionView(v), media_id: v.media_id, display_name: reg.media[v.media_id]?.display_name ?? v.original_name, original_rel_path: v.trash!.original_rel_path }));
        return { items };
      },
    },
    {
      method: 'POST',
      path: '/api/trash/:version_id/restore',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['destination', 'on_conflict']);
        const destination = str(body, 'destination', { optional: true, max: 1024 });
        const on_conflict = body.on_conflict;
        if (on_conflict !== undefined && on_conflict !== 'ask' && on_conflict !== 'alternate') throw bad('on_conflict wajib "ask" atau "alternate"');
        const r = await svc.restore({ version_id: params.version_id!, actor, ...(destination ? { destination } : {}), ...(on_conflict ? { onConflict: on_conflict } : {}) });
        return { result: r.result, clocks_ok: r.clocks.ok };
      },
    },
    {
      method: 'POST',
      path: '/api/purge/prepare',
      handle: async ({ req, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['version_ids']);
        return { plan: await svc.preparePurge({ version_ids: strList(body, 'version_ids'), actor }) };
      },
    },
    {
      method: 'POST',
      path: '/api/purge/execute',
      handle: async ({ req, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['request_id', 'confirmation_token', 'typed_phrase']);
        return {
          result: await svc.executePurge({
            request_id: str(body, 'request_id', { max: 64 })!,
            confirmation_token: str(body, 'confirmation_token', { max: 128 })!,
            typed_phrase: str(body, 'typed_phrase', { max: 64 })!,
            actor,
          }),
        };
      },
    },

    // Storage dashboard (read-only)
    { method: 'GET', path: '/api/dashboard', handle: async ({ ws }) => ({ dashboard: await getDashboard(ws) }) },
  ];
}
