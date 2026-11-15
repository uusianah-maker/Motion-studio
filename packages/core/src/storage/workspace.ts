import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { StorageBackend } from './backend.js';
import { type Clock, systemClock } from './clock.js';
import { StorageError } from './errors.js';
import { assertSafeId, newId } from './ids.js';
import { readJson, withLock, writeJsonAtomic } from './jsonStore.js';
import { LocalFsBackend } from './localfs.js';
import { PROJECT_SCHEMA_VERSION, type ProjectFitur, type ProjectManifest, isProjectFitur, validateProjectManifest } from './project.js';
import { canonicalRoot, resolveInside } from './paths.js';

export const WORKSPACE_SCHEMA_VERSION = 1;

/** Workspace layout from PRD v0.8 §C. */
export const LAYOUT = {
  sharedMedia: 'SHARED_MEDIA',
  sharedAssets: 'SHARED_ASSETS',
  projects: 'PROJECTS',
  backups: 'BACKUP_PROJECTS',
  meta: '.motionstudio',
  trash: '.trash',
} as const;

export const PROJECT_DIRS = ['01_INPUT', '02_ASSETS', '03_PROJECT', '04_CACHE', '05_OUTPUT'] as const;

export const META_FILES = {
  workspace: 'workspace.json',
  policy: 'policy.json',
  registry: 'registry.json',
  leases: 'leases.json',
  deps: 'deps.json',
  brand: 'brand_kit.json',
  purgeRequests: 'purge_requests.json',
  audit: 'audit.log.jsonl',
  lock: 'workspace.lock',
  journal: 'journal',
} as const;

export interface WorkspaceMeta {
  schema_version: typeof WORKSPACE_SCHEMA_VERSION;
  workspace_id: string;
  created_at: number;
}

/**
 * Tunables. Values marked PC-2 are defaults pending owner decision (PRD v0.8 §L).
 * The 30-day Auto Trash rule is locked by PRD and deliberately NOT configurable here.
 */
export interface Policy {
  schema_version: 1;
  gc: { scan_interval_minutes: number };
  quota: { media_soft_bytes: number | null; cache_max_bytes: number; free_space_reserve_bytes: number };
}

export const DEFAULT_POLICY: Policy = {
  schema_version: 1,
  gc: { scan_interval_minutes: 360 },
  quota: { media_soft_bytes: null, cache_max_bytes: 20 * 1024 ** 3, free_space_reserve_bytes: 5 * 1024 ** 3 },
};

export interface Workspace {
  /** Canonical (realpath) root. */
  readonly root: string;
  readonly meta: WorkspaceMeta;
  readonly clock: Clock;
  /** Where media bytes live (W02). Metadata always stays under `root`. */
  readonly blobs: StorageBackend;
}

export interface WorkspaceOptions {
  clock?: Clock;
  /** Blob backend for this workspace; default = local filesystem under the root. */
  backend?: (root: string) => StorageBackend;
}

const makeBackend = (root: string, opts: WorkspaceOptions): StorageBackend => (opts.backend ?? ((r) => new LocalFsBackend(r)))(root);

export const metaPath = (ws: Pick<Workspace, 'root'>, file: string): string => path.join(ws.root, LAYOUT.meta, file);

function validateMeta(x: unknown): WorkspaceMeta {
  const o = x as Partial<WorkspaceMeta> | null;
  if (!o || o.schema_version !== WORKSPACE_SCHEMA_VERSION || typeof o.workspace_id !== 'string' || typeof o.created_at !== 'number') {
    throw new StorageError('WORKSPACE_INVALID', 'workspace.json tidak valid');
  }
  return { schema_version: WORKSPACE_SCHEMA_VERSION, workspace_id: o.workspace_id, created_at: o.created_at };
}

export function validatePolicy(x: unknown): Policy {
  const o = x as Partial<Policy> | null;
  const okNum = (n: unknown, min: number) => typeof n === 'number' && Number.isFinite(n) && n >= min;
  if (
    !o ||
    o.schema_version !== 1 ||
    !o.gc ||
    !okNum(o.gc.scan_interval_minutes, 1) ||
    !o.quota ||
    !(o.quota.media_soft_bytes === null || okNum(o.quota.media_soft_bytes, 0)) ||
    !okNum(o.quota.cache_max_bytes, 0) ||
    !okNum(o.quota.free_space_reserve_bytes, 0)
  ) {
    throw new StorageError('WORKSPACE_INVALID', 'policy.json tidak valid');
  }
  return o as Policy;
}

/** Create a brand-new workspace. Refuses non-empty folders so we never adopt random user data. */
export async function initWorkspace(rootInput: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
  const clock = opts.clock ?? systemClock;
  const abs = path.resolve(rootInput);
  await fsp.mkdir(abs, { recursive: true });
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new StorageError('WORKSPACE_INVALID', 'Root workspace harus folder biasa (bukan symlink/junction)', { root: abs });
  }
  const entries = await fsp.readdir(abs);
  if (entries.length > 0) {
    throw new StorageError('CONFLICT', 'Folder root harus kosong untuk workspace baru', { root: abs, entries: entries.slice(0, 5) });
  }
  const root = await canonicalRoot(abs);
  try {
    for (const dir of Object.values(LAYOUT)) await fsp.mkdir(path.join(root, dir));
    await fsp.mkdir(path.join(root, LAYOUT.meta, META_FILES.journal));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StorageError('CONFLICT', 'Workspace sedang/sudah dibuat oleh proses lain', { root });
    }
    throw e;
  }
  const meta: WorkspaceMeta = { schema_version: WORKSPACE_SCHEMA_VERSION, workspace_id: newId('ws'), created_at: clock.now() };
  const ws: Workspace = { root, meta, clock, blobs: makeBackend(root, opts) };
  await writeJsonAtomic(metaPath(ws, META_FILES.policy), DEFAULT_POLICY);
  await writeJsonAtomic(metaPath(ws, META_FILES.registry), { schema_version: 1, media: {}, versions: {} });
  await writeJsonAtomic(metaPath(ws, META_FILES.leases), { schema_version: 1, leases: [] });
  await writeJsonAtomic(metaPath(ws, META_FILES.purgeRequests), { schema_version: 1, requests: [] });
  // workspace.json last: its presence marks a complete init.
  await writeJsonAtomic(metaPath(ws, META_FILES.workspace), meta);
  return ws;
}

/** Open and validate an existing workspace (all layout folders present, none are links). */
export async function openWorkspace(rootInput: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
  try {
    if ((await fsp.lstat(path.resolve(rootInput))).isSymbolicLink()) {
      throw new StorageError('WORKSPACE_INVALID', 'Root workspace tidak boleh symlink/junction', { root: rootInput });
    }
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw new StorageError('WORKSPACE_INVALID', 'Root workspace tidak bisa diakses', { root: rootInput, cause: String(e) });
  }
  const root = await canonicalRoot(rootInput);
  // Metadata files must be regular files inside the workspace (no links pointing elsewhere).
  for (const f of [META_FILES.workspace, META_FILES.policy, META_FILES.registry, META_FILES.leases, META_FILES.purgeRequests]) {
    try {
      const p = await resolveInside(root, `${LAYOUT.meta}/${f}`);
      if (!(await fsp.lstat(p)).isFile()) throw new StorageError('WORKSPACE_INVALID', `Bukan file biasa: ${f}`);
    } catch (e) {
      throw new StorageError('WORKSPACE_INVALID', `File metadata bermasalah: ${f}`, { cause: String(e) });
    }
  }
  const meta = await readJson(path.join(root, LAYOUT.meta, META_FILES.workspace), validateMeta);
  for (const dir of [...Object.values(LAYOUT), `${LAYOUT.meta}/${META_FILES.journal}`]) {
    let p: string;
    try {
      p = await resolveInside(root, dir);
    } catch (e) {
      throw new StorageError('WORKSPACE_INVALID', `Folder workspace bermasalah: ${dir}`, { cause: String(e) });
    }
    if (!(await fsp.stat(p)).isDirectory()) throw new StorageError('WORKSPACE_INVALID', `Bukan folder: ${dir}`);
  }
  return { root, meta, clock: opts.clock ?? systemClock, blobs: makeBackend(root, opts) };
}

export const withWorkspaceLock = <T>(ws: Workspace, owner: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> =>
  withLock(metaPath(ws, META_FILES.lock), owner, fn, timeoutMs);

export async function readPolicy(ws: Workspace): Promise<Policy> {
  return readJson(metaPath(ws, META_FILES.policy), validatePolicy);
}

// ---------------------------------------------------------------- projects

export const projectRel = (projectId: string, sub?: (typeof PROJECT_DIRS)[number]): string =>
  [LAYOUT.projects, assertSafeId(projectId, 'Project ID'), ...(sub ? [sub] : [])].join('/');

export const manifestRel = (projectId: string): string => `${projectRel(projectId, '03_PROJECT')}/project.json`;

export async function createProject(ws: Workspace, input: { project_id: string; name: string; fitur?: ProjectFitur }): Promise<ProjectManifest> {
  const id = assertSafeId(input.project_id, 'Project ID');
  if (input.fitur !== undefined && !isProjectFitur(input.fitur)) throw new StorageError('EDIT_INVALID', 'Fitur proyek tidak dikenal', { fitur: String(input.fitur) });
  return withWorkspaceLock(ws, 'createProject', async () => {
    const dir = await resolveInside(ws.root, projectRel(id), { allowMissing: true });
    try {
      await fsp.mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('CONFLICT', 'Proyek sudah ada', { project_id: id });
      throw e;
    }
    for (const sub of PROJECT_DIRS) await fsp.mkdir(path.join(dir, sub));
    const now = ws.clock.now();
    const manifest: ProjectManifest = {
      schema_version: PROJECT_SCHEMA_VERSION,
      project_id: id,
      name: input.name,
      status: 'active',
      revision: 0,
      created_at: now,
      updated_at: now,
      timeline: { tracks: [] },
      snapshots: [],
      ...(input.fitur ? { fitur: input.fitur } : {}),
    };
    await writeJsonAtomic(await resolveInside(ws.root, manifestRel(id), { allowMissing: true }), manifest);
    return manifest;
  });
}

export async function listProjectIds(ws: Workspace): Promise<string[]> {
  const dir = await resolveInside(ws.root, LAYOUT.projects);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const link = entries.find((e) => e.isSymbolicLink());
  if (link) throw new StorageError('PATH_LINK_REJECTED', 'Symlink/junction di folder PROJECTS tidak diizinkan', { name: link.name });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function readProject(ws: Workspace, projectId: string): Promise<ProjectManifest> {
  const file = await resolveInside(ws.root, manifestRel(projectId));
  const m = await readJson(file, validateProjectManifest, 'PROJECT_INVALID');
  if (m.project_id !== projectId) throw new StorageError('PROJECT_INVALID', 'project_id di manifest tidak cocok dengan folder', { projectId });
  return m;
}
