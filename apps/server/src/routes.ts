import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Route } from './app.js';
import {
  type Dashboard,
  type MediaScope,
  type ProjectManifest,
  type Registry,
  type VersionRecord,
  type Workspace,
  createProject,
  diskSpace,
  estimateSpace,
  BROWSER_VIDEO_CODECS,
  MEDIA_AREAS,
  checkTools,
  findFont,
  getDashboard,
  listOutputs,
  historyCounts,
  listProjectIds,
  loadRegistry,
  readProject,
  checkBrandGuard,
  localDate,
  variantState,
  appendLearning,
  correctionsFrom,
  engineOrigin,
  proxyPath,
  proxyReady,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { createImportQueue } from './importQueue.js';
import { type ProxyQueue, createProxyQueue } from './proxy.js';
import { type RenderJobView, type RenderJobs, createRenderJobs } from './render.js';
import { type StreamSigner, createStreamSigner, mimeFor, sendBytes } from './stream.js';

// ------------------------------------------------------------------ input helpers

export const bad = (message: string) => new ApiError(400, 'BAD_REQUEST', message);

export function str(body: Record<string, unknown>, key: string, opts: { optional?: boolean; max?: number } = {}): string | undefined {
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
export function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
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
    /** null = not playable media; undefined probe = not probed yet. */
    probe: v.probe === undefined ? undefined : v.probe,
    preview: !!v.probe && (v.probe.video_codec === null || BROWSER_VIDEO_CODECS.has(v.probe.video_codec)),
  };
}

/** A version that may be played right now: active, intact, inside a media area. */
async function playable(ws: Workspace, versionId: string): Promise<VersionRecord> {
  const v = (await loadRegistry(ws)).versions[versionId];
  if (!v) throw new ApiError(404, 'NOT_FOUND', 'Versi media tidak ditemukan');
  if (v.lifecycle !== 'active') throw new ApiError(409, 'CONFLICT', 'Media ada di Trash / sudah dihapus');
  if (v.integrity !== 'ok') throw new ApiError(409, 'INTEGRITY', 'Media berubah/hilang; perlu verifikasi');
  return v;
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

/** Project for the editor: timeline + undo/redo counts; stored history timelines stay on the server. */
export const projectView = (m: ProjectManifest) => {
  const { snapshots: _snapshots, ...rest } = m;
  void _snapshots;
  return { ...rest, history: historyCounts(m) };
};

export function revision(body: Record<string, unknown>): number {
  const r = body.expected_revision;
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0) throw bad('expected_revision wajib angka revisi');
  return r;
}

interface OutputItem {
  project_id: string;
  project_name: string;
  name: string;
  size: number;
  mtime_ms: number;
  variant?: { master_id: string; number: number; uji: boolean };
}

const projectSummary = (m: ProjectManifest) => ({
  project_id: m.project_id,
  name: m.name,
  status: m.status,
  revision: m.revision,
  created_at: m.created_at,
  updated_at: m.updated_at,
  ...(m.variant ? { variant: { master_id: m.variant.master_id, number: m.variant.number, state: variantState(m) } } : {}),
  ...(m.brand_id ? { brand_id: m.brand_id } : {}),
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
export async function receiveUpload(ws: Workspace, req: IncomingMessage, opts: UploadOptions): Promise<{ file: string; dir: string; name: string; size: number }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/octet-stream') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload harus application/octet-stream');
  const declared = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isSafeInteger(declared) || declared < 0) throw new ApiError(411, 'LENGTH_REQUIRED', 'Content-Length wajib');
  if (declared === 0) throw bad('File kosong');
  if (declared > opts.maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'File melebihi batas upload');
  // Same volume: the temp copy and the workspace staging copy exist at the same time (Checkpoint D F4).
  const sameVolume = await Promise.all([fsp.stat(opts.tmpDir), fsp.stat(ws.root)]).then(([a, b]) => a.dev === b.dev, () => true);
  const ws_space = await estimateSpace(ws, { bytes_needed: sameVolume ? declared * 2 : declared });
  if (!ws_space.ok) throw new ApiError(507, 'INSUFFICIENT_STORAGE', ws_space.reason ?? 'Ruang workspace tidak cukup');
  const tmpSpace = await diskSpace(opts.tmpDir);
  if (!tmpSpace || tmpSpace.free_bytes < declared) throw new ApiError(507, 'INSUFFICIENT_STORAGE', 'Ruang folder upload sementara tidak cukup');
  // Large videos may take long: no total time limit, but a stalled sender is dropped (Checkpoint D F3).
  req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(new Error('upload idle timeout')));

  const name = safeUploadName(req.headers['x-file-name'] as string | undefined);
  const dir = await fsp.mkdtemp(path.join(opts.tmpDir, UPLOAD_PREFIX));
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
    // Audit 14 Nov: the idle timeout is for a stalled SENDER. All bytes are here now; probing,
    // copying and hashing a multi-GB file may take minutes and must not cut the reply (the user
    // saw "Upload terputus" for media that was in fact imported).
    req.setTimeout(0);
    return { file, dir, name, size };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    if (e instanceof ApiError) throw e;
    throw bad('Upload gagal diterima');
  }
}

export const UPLOAD_PREFIX = 'motion-upload-';
export const UPLOAD_IDLE_MS = 2 * 60_000;

/**
 * Remove upload temp folders left by a crash (startup). Only our own prefix, and only when
 * nothing inside changed for `maxAgeMs` (another server instance may share the temp folder).
 */
export async function sweepUploadTemp(tmpDir: string, maxAgeMs = 6 * 3_600_000, now = Date.now(), prefix = UPLOAD_PREFIX): Promise<string[]> {
  const removed: string[] = [];
  for (const e of await fsp.readdir(tmpDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    const dir = path.join(tmpDir, e.name);
    try {
      let newest = (await fsp.lstat(dir)).mtimeMs;
      for (const f of await fsp.readdir(dir)) newest = Math.max(newest, (await fsp.lstat(path.join(dir, f))).mtimeMs);
      if (now - newest < maxAgeMs) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      /* in use or vanished: leave it */
    }
  }
  return removed;
}

// ------------------------------------------------------------------ render helpers

/** Output file name from the user/project name: safe single name, always `.mp4`. */
export function renderOutputName(raw: string): string {
  const safe = safeUploadName(encodeURIComponent(raw));
  const base = (safe === 'upload.bin' ? 'render' : safe.replace(/\.mp4$/i, '').slice(0, 120).replace(/[. ]+$/, '')) || 'render';
  return `${base}.mp4`;
}

/** A finished output of this project, by exact file name (never a path). */
async function findOutput(ws: Workspace, projectId: string, name: string | null) {
  if (!name || name.length > 200 || /[\\/]/.test(name) || name.startsWith('.')) throw bad('Nama output tidak valid');
  const hit = (await listOutputs(ws, projectId)).find((o) => o.name === name);
  if (!hit) throw new ApiError(404, 'NOT_FOUND', 'Output tidak ditemukan');
  return hit;
}

/** Renders queued + running at once (variants can queue several in one click). */
const MAX_ACTIVE_RENDERS = 12;
const activeRenders = (j: RenderJobs) => j.list().filter((x) => x.status === 'queued' || x.status === 'running').length;

/** X09: a variant row for the master's dialog (brief, approval state, latest render, outputs). */
function variantView(p: ProjectManifest, job: RenderJobView | null, outputs: number) {
  return {
    project_id: p.project_id,
    name: p.name,
    revision: p.revision,
    number: p.variant!.number,
    label: p.variant!.label,
    brief: p.variant!.brief,
    state: variantState(p),
    ratio: p.timeline.canvas?.ratio ?? '9:16',
    render: job ? { job_id: job.job_id, status: job.status, progress: job.progress, output_name: job.output?.name ?? job.output_name, problems: job.problems, error: job.error } : null,
    outputs,
  };
}

// ------------------------------------------------------------------ routes

export function apiRoutes(upload: Partial<UploadOptions> = {}, signer: StreamSigner = createStreamSigner(), render?: RenderJobs, proxies: ProxyQueue = createProxyQueue()): Route[] {
  const uploadOpts: UploadOptions = { tmpDir: upload.tmpDir ?? os.tmpdir(), maxBytes: upload.maxBytes ?? 50 * 1024 ** 3 };
  let jobs = render;
  const jobsFor = (ws: Workspace) => (jobs ??= createRenderJobs(ws, { tmpRoot: os.tmpdir() }));
  // One import at a time per server: parallel uploads would each pass the free-space check
  // (Checkpoint D F4). The others wait in a queue instead of being refused (owner request).
  const imports = createImportQueue();
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
    { method: 'GET', path: '/api/projects/:project_id', handle: async ({ ws, params }) => ({ project: projectView(await readProject(ws, params.project_id!)) }) },
    {
      method: 'POST',
      path: '/api/projects/:project_id/edit',
      handle: async ({ req, ws, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'ops', 'label']);
        const label = str(body, 'label', { optional: true, max: 80 });
        // R9: an editor's change to an engine draft (words, hook, cuts) is a lesson for the brand.
        const origin = actor === 'user' ? await engineOrigin(ws, params.project_id!) : null;
        const before = origin ? (await readProject(ws, params.project_id!)).timeline : null;
        const r = await svc.editTimeline({ project_id: params.project_id!, expected_revision: revision(body), ops: body.ops, actor, ...(label ? { label } : {}) });
        if (origin && before && Array.isArray(body.ops)) for (const n of correctionsFrom(before, body.ops, r.result.timeline, origin)) await appendLearning(ws, params.project_id!, n);
        return { project: projectView(r.result), clocks_ok: r.clocks.ok };
      },
    },
    ...(['undo', 'redo'] as const).map((dir) => ({
      method: 'POST' as const,
      path: `/api/projects/:project_id/${dir}`,
      handle: async ({ req, params, svc, actor }: Parameters<Route['handle']>[0]) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision']);
        const input = { project_id: params.project_id!, expected_revision: revision(body), actor };
        const r = dir === 'undo' ? await svc.undoTimeline(input) : await svc.redoTimeline(input);
        return { project: projectView(r.result), clocks_ok: r.clocks.ok };
      },
    })),

    // X09 variants: master → briefs → one project each → approve → render the approved ones.
    {
      method: 'GET',
      path: '/api/projects/:project_id/variants',
      handle: async ({ ws, params, svc }) => {
        const list = await svc.listVariants(params.project_id!);
        const j = jobsFor(ws);
        return { variants: await Promise.all(list.map(async (p) => variantView(p, j.list(p.project_id)[0] ?? null, (await listOutputs(ws, p.project_id)).length))) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/variants',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['briefs']);
        const r = await svc.createVariants({ master_id: params.project_id!, briefs: body.briefs, actor });
        return { variants: r.result.map((p) => variantView(p, null, 0)), clocks_ok: r.clocks.ok };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/variant-approval',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'approved']);
        const r = await svc.setVariantApproval({ project_id: params.project_id!, expected_revision: revision(body), approved: body.approved, actor });
        return { project: projectView(r.result) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/variants/render',
      handle: async ({ req, ws, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['short_side', 'accept_brand_warnings']);
        const short = body.short_side;
        if (short !== undefined && short !== 720 && short !== 1080) throw bad('short_side wajib 720 atau 1080');
        if (body.accept_brand_warnings !== undefined && typeof body.accept_brand_warnings !== 'boolean') throw bad('accept_brand_warnings harus true/false');
        const j = jobsFor(ws);
        const jobs: RenderJobView[] = [];
        const skipped: { project_id: string; reason: string }[] = [];
        for (const p of await svc.listVariants(params.project_id!)) {
          const state = variantState(p);
          if (state !== 'approved') {
            skipped.push({ project_id: p.project_id, reason: state === 'changed' ? 'diubah setelah disetujui' : 'belum disetujui' });
            continue;
          }
          if (j.list(p.project_id).some((x) => x.status === 'queued' || x.status === 'running')) {
            skipped.push({ project_id: p.project_id, reason: 'sedang dirender' });
            continue;
          }
          if (activeRenders(j) >= MAX_ACTIVE_RENDERS) {
            skipped.push({ project_id: p.project_id, reason: 'antrean penuh' });
            continue;
          }
          jobs.push(j.start({ project_id: p.project_id, output_name: renderOutputName(p.name), actor, ...(short ? { settings: { short_side: short } } : {}), ...(body.accept_brand_warnings ? { accept_brand_warnings: true } : {}) }));
        }
        return { jobs, skipped };
      },
    },

    // X08 Brand guard: what the render check would say right now (for the render dialog).
    {
      method: 'GET',
      path: '/api/projects/:project_id/brand-check',
      handle: async ({ ws, params, svc }) => {
        const project = await readProject(ws, params.project_id!);
        const kit = await svc.readBrandFor(project.brand_id);
        const today = localDate(ws.clock.now());
        return { today, brand_id: kit.brand_id || null, issues: checkBrandGuard(project.timeline, kit.guard, today) };
      },
    },

    // U1 Brand Kits per brand. The export for the browser never contains local paths.
    {
      method: 'GET',
      path: '/api/brands',
      handle: async ({ svc }) => ({ brands: await svc.listBrands(), default_id: await svc.defaultBrandId() }),
    },
    {
      method: 'POST',
      path: '/api/brands',
      handle: async ({ req, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['kit']);
        const r = await svc.createBrand({ kit: body.kit, actor });
        return { brand: r.result, clocks_ok: r.clocks.ok };
      },
    },
    { method: 'GET', path: '/api/brands/:brand_id', handle: async ({ svc, params }) => ({ brand: await svc.readBrand(params.brand_id!) }) },
    {
      method: 'POST',
      path: '/api/brands/:brand_id',
      handle: async ({ req, svc, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'kit']);
        const r = await svc.setBrandKit({ brand_id: params.brand_id!, expected_revision: revision(body), kit: body.kit, actor });
        return { brand: r.result, clocks_ok: r.clocks.ok };
      },
    },
    {
      // R13: a new brand from an existing Brand Kit (owner only — brands rule in roles.ts).
      method: 'POST',
      path: '/api/brands/:brand_id/duplicate',
      handle: async ({ req, svc, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['name', 'kode']);
        const r = await svc.duplicateBrand({ brand_id: params.brand_id!, name: body.name, ...(body.kode !== undefined ? { kode: body.kode } : {}), actor });
        return { brand: r.result };
      },
    },
    {
      method: 'POST',
      path: '/api/brands/:brand_id/default',
      handle: async ({ req, svc, params, actor }) => {
        onlyKeys(await readJsonBody(req), []);
        await svc.setDefaultBrand({ brand_id: params.brand_id!, actor });
        return { default_id: params.brand_id! };
      },
    },
    {
      method: 'POST',
      path: '/api/brands/:brand_id/delete',
      handle: async ({ req, svc, params, actor }) => {
        onlyKeys(await readJsonBody(req), []);
        const r = await svc.deleteBrand({ brand_id: params.brand_id!, actor });
        return { deleted: params.brand_id!, clocks_ok: r.clocks.ok };
      },
    },
    { method: 'GET', path: '/api/brands/:brand_id/export', handle: async ({ svc, params }) => ({ export: await svc.exportBrandKit(params.brand_id!, { paths: false }) }) },

    // X06 Brand Kit (workspace level).
    { method: 'GET', path: '/api/brand', handle: async ({ svc }) => ({ brand: await svc.readBrandKit() }) },
    {
      method: 'POST',
      path: '/api/brand',
      handle: async ({ req, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'kit']);
        const r = await svc.setBrandKit({ expected_revision: revision(body), kit: body.kit, actor });
        return { brand: r.result, clocks_ok: r.clocks.ok };
      },
    },

    // X05 project management. Export holds no files or paths (PC-13: files stay on the PC).
    {
      method: 'POST',
      path: '/api/projects/:project_id/meta',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'name', 'status', 'brand_id']);
        const r = await svc.updateProjectMeta({ project_id: params.project_id!, expected_revision: revision(body), name: body.name, status: body.status, brand_id: body.brand_id, actor });
        return { project: projectView(r.result), clocks_ok: r.clocks.ok };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/duplicate',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['name']);
        const r = await svc.duplicateProject({ project_id: params.project_id!, ...(body.name !== undefined ? { name: body.name } : {}), actor });
        return { project: projectSummary(r.result) };
      },
    },
    { method: 'GET', path: '/api/projects/:project_id/export', handle: async ({ params, svc }) => ({ export: await svc.exportProject(params.project_id!) }) },
    {
      method: 'POST',
      path: '/api/projects/import',
      handle: async ({ req, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['data', 'name']);
        const r = await svc.importProject({ data: body.data, ...(body.name !== undefined ? { name: body.name } : {}), actor });
        return { project: projectSummary(r.result.project), remapped: r.result.remapped };
      },
    },

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
        const list = mediaList(await loadRegistry(ws), filter);
        // R14: is the light preview copy of the current version ready (or being made)?
        const withProxy = await Promise.all(
          list.map(async (m) => ({ ...m, proxy: (await proxyReady(ws, m.current_version_id)) ? ('siap' as const) : proxies.busy(ws, m.current_version_id) ? ('proses' as const) : null })),
        );
        return { media: withProxy };
      },
    },
    {
      // R14: "Buat pratinjau ringan" for an older media (background; the answer does not wait).
      method: 'POST',
      path: '/api/media/:version_id/proxy',
      handle: async ({ req, ws, params }) => {
        onlyKeys(await readJsonBody(req), []);
        const v = await playable(ws, params.version_id!);
        if (await proxyReady(ws, v.version_id)) return { proxy: 'siap' };
        if (!v.probe?.video_codec) return { proxy: 'tidak_perlu' };
        void proxies.enqueue(ws, v.version_id);
        return { proxy: 'proses' };
      },
    },
    {
      method: 'POST',
      path: '/api/media/import',
      handle: async ({ req, res, url, ws, svc, actor }) => {
        const scope = scopeFrom(url);
        const display_name = url.searchParams.get('display_name') ?? undefined;
        if (display_name !== undefined && (!display_name.trim() || display_name.length > 200)) throw bad('display_name tidak valid');
        if (scope.kind === 'project') await readProject(ws, scope.project_id); // 404 before receiving any bytes
        const release = await imports.acquire(req, res);
        try {
          const up = await receiveUpload(ws, req, uploadOpts);
          try {
            const r = await svc.importMedia({ sourcePath: up.file, scope, actor, ...(display_name ? { display_name } : {}) });
            // R14: the light preview copy is made in the background (the import does not wait).
            void proxies.enqueue(ws, r.version.version_id);
            return { media_id: r.media.media_id, version: versionView(r.version), duplicate: r.duplicate };
          } finally {
            await fsp.rm(up.dir, { recursive: true, force: true });
          }
        } finally {
          release();
        }
      },
    },
    {
      // The upload queue for the Media page: one running, how many waiting (any page / team member).
      method: 'GET',
      path: '/api/media/import/antrean',
      handle: async () => imports.status(),
    },

    // Preview playback (W07): token-authenticated URL issue, then signed byte-range streaming.
    {
      method: 'GET',
      path: '/api/media/:version_id/stream-url',
      handle: async ({ ws, params, url }) => {
        const v = await playable(ws, params.version_id!);
        // R14: the editor plays the light copy when there is one (render always uses the original);
        // a media opened for the first time gets one made in the background. ?asli=1 = the original.
        if (url.searchParams.get('asli') !== '1') {
          if (await proxyReady(ws, v.version_id)) return { ...signer.signProxy(v.version_id), mime: 'video/mp4', probe: v.probe ?? null, proxy: true };
          if (v.probe?.video_codec) void proxies.enqueue(ws, v.version_id);
        }
        return { ...signer.sign(v.version_id), mime: mimeFor(v.rel_path), probe: v.probe ?? null, proxy: false };
      },
    },
    {
      method: 'GET',
      path: '/api/stream/:version_id',
      public: true, // <video> cannot send Authorization; the HMAC signature is the credential
      handle: async ({ req, res, url, ws, params }) => {
        if (url.searchParams.get('proxy') === '1') {
          signer.verifyProxy(params.version_id!, url.searchParams.get('exp'), url.searchParams.get('sig'));
          await playable(ws, params.version_id!);
          const file = proxyPath(ws, params.version_id!);
          const st = await fsp.stat(file).catch(() => null);
          if (!st?.isFile()) throw new ApiError(404, 'NOT_FOUND', 'Pratinjau ringan belum ada');
          await sendBytes(req, res, { size: st.size, mime: 'video/mp4', open: async (range) => createReadStream(file, range ? { start: range.start, end: range.end } : {}) });
          return undefined;
        }
        signer.verify(params.version_id!, url.searchParams.get('exp'), url.searchParams.get('sig'));
        const v = await playable(ws, params.version_id!);
        const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
        const st = await ws.blobs.stat(rel);
        if (!st?.isFile) throw new ApiError(404, 'NOT_FOUND', 'File media tidak ditemukan');
        await sendBytes(req, res, { size: st.size, mime: mimeFor(rel), open: (range) => ws.blobs.readStream(rel, range) });
        return undefined;
      },
    },

    // Render MP4 (W08): queued jobs, metadata-free outputs in 05_OUTPUT.
    {
      method: 'GET',
      path: '/api/render/tools',
      handle: async () => {
        const t = await checkTools();
        return { ok: t.ok, version: t.version, problems: t.problems, font: findFont() !== null };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/render',
      handle: async ({ req, ws, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['output_name', 'short_side', 'accept_brand_warnings']);
        if (body.accept_brand_warnings !== undefined && typeof body.accept_brand_warnings !== 'boolean') throw bad('accept_brand_warnings harus true/false');
        const project = await readProject(ws, params.project_id!);
        // A variant renders only as approved (same rule as "Render varian disetujui"), whoever asks.
        if (project.variant && variantState(project) !== 'approved')
          throw new ApiError(409, 'NOT_APPROVED', `Varian ini ${variantState(project) === 'changed' ? 'diubah setelah disetujui' : 'belum disetujui'}. Minta Owner / Reviewer menyetujuinya dulu, baru render.`);
        const raw = str(body, 'output_name', { optional: true, max: 120 });
        const short = body.short_side;
        if (short !== undefined && short !== 720 && short !== 1080) throw bad('short_side wajib 720 atau 1080');
        const j = jobsFor(ws);
        if (activeRenders(j) >= MAX_ACTIVE_RENDERS) throw new ApiError(409, 'BUSY', 'Antrean render penuh; tunggu yang berjalan selesai');
        const job = j.start({ project_id: project.project_id, output_name: renderOutputName(raw ?? project.name), actor, ...(short ? { settings: { short_side: short } } : {}), ...(body.accept_brand_warnings ? { accept_brand_warnings: true } : {}) });
        return { job };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/renders',
      handle: async ({ ws, params }) => {
        const outputs = (await listOutputs(ws, params.project_id!)).map(({ name, size, mtime_ms }) => ({ name, size, mtime_ms }));
        return { jobs: jobsFor(ws).list(params.project_id!), outputs };
      },
    },
    {
      // Halaman Hasil (owner 14 Nov): semua file render dari semua proyek, terbaru dulu. Tanpa path lokal.
      method: 'GET',
      path: '/api/outputs',
      handle: async ({ ws, url }) => {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
        const master = url.searchParams.get('master') ?? '';
        const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit'))) || 200, 1), 500);
        const offset = Math.max(Math.floor(Number(url.searchParams.get('offset'))) || 0, 0);
        const items: OutputItem[] = [];
        for (const id of await listProjectIds(ws)) {
          const m = await readProject(ws, id).catch(() => null);
          if (!m) continue;
          if (master && m.variant?.master_id !== master && m.project_id !== master) continue;
          for (const o of await listOutputs(ws, id).catch(() => [])) {
            items.push({
              project_id: id,
              project_name: m.name,
              name: o.name,
              size: o.size,
              mtime_ms: o.mtime_ms,
              ...(m.variant ? { variant: { master_id: m.variant.master_id, number: m.variant.number, uji: m.variant.bukan_iklan === true } } : {}),
            });
          }
        }
        const found = q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.project_name.toLowerCase().includes(q)) : items;
        found.sort((a, b) => b.mtime_ms - a.mtime_ms);
        return { outputs: found.slice(offset, offset + limit), total: found.length, offset, limit };
      },
    },
    {
      method: 'GET',
      path: '/api/render/jobs/:job_id',
      handle: async ({ ws, params }) => {
        const job = jobsFor(ws).get(params.job_id!);
        if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job render tidak ditemukan');
        return { job };
      },
    },
    {
      method: 'POST',
      path: '/api/render/jobs/:job_id/cancel',
      handle: async ({ ws, params }) => {
        const job = jobsFor(ws).cancel(params.job_id!);
        if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job render tidak ditemukan');
        return { job };
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/output-url',
      handle: async ({ ws, url, params }) => {
        const out = await findOutput(ws, params.project_id!, url.searchParams.get('name'));
        return signer.signOutput(params.project_id!, out.name, url.searchParams.get('download') === '1');
      },
    },
    {
      method: 'GET',
      path: '/api/output',
      public: true, // <video>/download links cannot send Authorization; the HMAC signature is the credential
      handle: async ({ req, res, url, ws }) => {
        const projectId = url.searchParams.get('project_id') ?? '';
        const name = url.searchParams.get('name') ?? '';
        const download = url.searchParams.get('download');
        signer.verifyOutput(projectId, name, download, url.searchParams.get('exp'), url.searchParams.get('sig'));
        const out = await findOutput(ws, projectId, name);
        const rel = await ws.blobs.resolve(out.rel, ['project_output']);
        const st = await ws.blobs.stat(rel);
        if (!st?.isFile) throw new ApiError(404, 'NOT_FOUND', 'Output tidak ditemukan');
        const ascii = out.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        await sendBytes(req, res, {
          size: st.size,
          mime: mimeFor(rel),
          open: (range) => ws.blobs.readStream(rel, range),
          ...(download === '1' ? { headers: { 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.name)}` } } : {}),
        });
        return undefined;
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
        // No free destination over HTTP: original path, or the server-suggested alternate (Checkpoint D F1).
        onlyKeys(body, ['on_conflict']);
        const on_conflict = body.on_conflict;
        if (on_conflict !== undefined && on_conflict !== 'ask' && on_conflict !== 'alternate') throw bad('on_conflict wajib "ask" atau "alternate"');
        const r = await svc.restore({ version_id: params.version_id!, actor, ...(on_conflict ? { onConflict: on_conflict } : {}) });
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
    {
      method: 'GET',
      path: '/api/dashboard',
      handle: async ({ ws }) => {
        // The audit trail stays on the server (it can hold absolute paths, Checkpoint D F5).
        const dashboard: Partial<Dashboard> = await getDashboard(ws, { audit_limit: 0 });
        delete dashboard.recent_audit;
        return { dashboard };
      },
    },
  ];
}
