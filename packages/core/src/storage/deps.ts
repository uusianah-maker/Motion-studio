import { createHash } from 'node:crypto';
import { brandFiles, brandReferences, listBrands } from './brand.js';
import { katalogFiles, katalogReferences } from './katalog.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { StorageError, isStorageError } from './errors.js';
import { isSafeId, newId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { type MediaRef, type ProjectManifest, manifestReferences, validateProjectManifest } from './project.js';
import { resolveInside } from './paths.js';
import { guard } from './guard.js';
import { journalBusy } from './journal.js';
import type { Actor } from './permissions.js';
import { type Registry, loadRegistry, saveRegistry } from './registry.js';
import { META_FILES, type Workspace, listProjectIds, manifestRel, metaPath, readProject, withWorkspaceLock } from './workspace.js';

// ------------------------------------------------------------------ leases

/** U6: `engine` = the engine CLI reading the sources while it plans. */
export type JobKind = 'render' | 'ai' | 'engine';
export type LeaseStatus = 'queued' | 'running';

export interface LeasedMedia extends MediaRef {
  content_hash: string;
}

/** A queued/running job pins exact media versions (PRD v0.8 §H). */
export interface Lease {
  lease_id: string;
  job: JobKind;
  status: LeaseStatus;
  label: string;
  created_at: number;
  media: LeasedMedia[];
  /** Render output path reserved by this job (no two queued renders share a final name). */
  output_rel?: string;
  /** Process running the job (W08). A lease whose worker died is released at server start. */
  worker_pid?: number;
}

interface LeaseFile {
  schema_version: 1;
  leases: Lease[];
}

function validateLeases(x: unknown): LeaseFile {
  const bad = (m: string): never => {
    throw new StorageError('INDEX_INVALID', `leases.json tidak valid: ${m}`);
  };
  const o = x as Partial<LeaseFile> | null;
  if (!o || o.schema_version !== 1 || !Array.isArray(o.leases)) bad('struktur');
  for (const l of o!.leases!) {
    if (!isSafeId(l.lease_id) || (l.job !== 'render' && l.job !== 'ai' && l.job !== 'engine') || (l.status !== 'queued' && l.status !== 'running') || !Array.isArray(l.media)) bad(`lease ${String(l?.lease_id)}`);
    if (l.output_rel !== undefined && typeof l.output_rel !== 'string') bad(`lease ${l.lease_id} output`);
    if (l.worker_pid !== undefined && (!Number.isSafeInteger(l.worker_pid) || l.worker_pid <= 0)) bad(`lease ${l.lease_id} worker`);
    for (const m of l.media) if (!isSafeId(m.media_id) || !isSafeId(m.version_id) || typeof m.content_hash !== 'string') bad(`lease ${l.lease_id} media`);
  }
  return o as LeaseFile;
}

export const loadLeases = (ws: Workspace): Promise<LeaseFile> => readJson(metaPath(ws, META_FILES.leases), validateLeases, 'INDEX_INVALID');
const saveLeases = (ws: Workspace, f: LeaseFile) => writeJsonAtomic(metaPath(ws, META_FILES.leases), validateLeases(f));

function assertUsable(reg: Registry, ref: MediaRef, busy: ReadonlySet<string>): void {
  if (busy.has(ref.version_id)) throw new StorageError('PRECONDITION', 'Versi media sedang dipindah (operasi belum selesai)', { ...ref });
  const v = reg.versions[ref.version_id];
  if (!v || v.media_id !== ref.media_id) throw new StorageError('PRECONDITION', 'Referensi media tidak dikenal', { ...ref });
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', `Versi media sedang ${v.lifecycle}; pulihkan dulu`, { ...ref });
  if (v.integrity !== 'ok') throw new StorageError('INTEGRITY', `Versi media ${v.integrity}: perlu relink/verifikasi, tidak diganti diam-diam`, { ...ref });
}

function assertKnown(reg: Registry, ref: MediaRef): void {
  const v = reg.versions[ref.version_id];
  if (!v || v.media_id !== ref.media_id) throw new StorageError('PRECONDITION', 'Referensi media di riwayat tidak dikenal', { ...ref });
}

/** Create a job lease pinning exact versions + hashes (immutable dependency snapshot). */
export async function createLease(ws: Workspace, input: { job: JobKind; label: string; media: MediaRef[]; actor: Actor; output_rel?: string; worker_pid?: number }): Promise<Lease> {
  await guard(ws, input.actor, 'manage_lease', { job: input.job });
  return withWorkspaceLock(ws, 'createLease', async () => {
    const reg = await loadRegistry(ws);
    const busy = await journalBusy(ws);
    for (const r of input.media) assertUsable(reg, r, busy);
    const file = await loadLeases(ws);
    const lease: Lease = {
      lease_id: newId('lease'),
      job: input.job,
      status: 'queued',
      label: input.label,
      created_at: ws.clock.now(),
      media: input.media.map((r) => ({ ...r, content_hash: reg.versions[r.version_id]!.content_hash })),
      ...(input.output_rel ? { output_rel: input.output_rel } : {}),
      ...(input.worker_pid !== undefined ? { worker_pid: input.worker_pid } : {}),
    };
    if (lease.output_rel && file.leases.some((l) => l.output_rel?.toLowerCase() === lease.output_rel!.toLowerCase())) {
      throw new StorageError('CONFLICT', 'Nama output sedang dipakai render lain', { output_rel: lease.output_rel });
    }
    file.leases.push(lease);
    await saveLeases(ws, file);
    // A lease holds its versions: reset their clocks right here (review H1/M1), not only on reconcile.
    let touched = false;
    for (const r of input.media) {
      const v = reg.versions[r.version_id]!;
      if (v.unreferenced_since !== null) {
        v.unreferenced_since = null;
        touched = true;
      }
    }
    if (touched) await saveRegistry(ws, reg);
    await audit(ws, { op: 'lease.create', actor: input.actor, outcome: 'ok', lease_id: lease.lease_id, job: lease.job, media: lease.media });
    return lease;
  });
}

export async function setLeaseStatus(ws: Workspace, input: { lease_id: string; status: LeaseStatus; actor: Actor }): Promise<Lease> {
  await guard(ws, input.actor, 'manage_lease', { lease_id: input.lease_id });
  return withWorkspaceLock(ws, 'setLeaseStatus', async () => {
    const file = await loadLeases(ws);
    const lease = file.leases.find((l) => l.lease_id === input.lease_id);
    if (!lease) throw new StorageError('NOT_FOUND', 'Lease tidak ditemukan', { lease_id: input.lease_id });
    lease.status = input.status;
    await saveLeases(ws, file);
    return lease;
  });
}

/** Job finished/failed/cancelled: the lease stops holding its media. */
export async function releaseLease(ws: Workspace, input: { lease_id: string; outcome: 'completed' | 'failed' | 'cancelled'; actor: Actor }): Promise<void> {
  await guard(ws, input.actor, 'manage_lease', { lease_id: input.lease_id });
  await withWorkspaceLock(ws, 'releaseLease', async () => {
    const file = await loadLeases(ws);
    const i = file.leases.findIndex((l) => l.lease_id === input.lease_id);
    if (i < 0) throw new StorageError('NOT_FOUND', 'Lease tidak ditemukan', { lease_id: input.lease_id });
    file.leases.splice(i, 1);
    await saveLeases(ws, file);
    await audit(ws, { op: 'lease.release', actor: input.actor, outcome: 'ok', lease_id: input.lease_id, result: input.outcome });
  });
}

/** True when a process with this pid exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Server start (W08): release job leases whose worker process is gone (crash / killed while
 * rendering), so their media can age normally again. Leases without a worker pid (CLI, tests,
 * older files) and leases of another live process are never touched. A lease carrying this
 * process's own pid is orphaned too: a freshly started server has no jobs yet.
 */
export async function releaseOrphanLeases(ws: Workspace, opts: { selfPid?: number; alive?: (pid: number) => boolean } = {}): Promise<string[]> {
  const self = opts.selfPid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  const orphans = (await loadLeases(ws)).leases.filter((l) => l.worker_pid !== undefined && (l.worker_pid === self || !alive(l.worker_pid)));
  for (const l of orphans) {
    await releaseLease(ws, { lease_id: l.lease_id, outcome: 'failed', actor: 'scheduler' }).catch((e: unknown) => {
      if (!isStorageError(e, 'NOT_FOUND')) throw e;
    });
  }
  if (orphans.length) await audit(ws, { op: 'lease.orphans_released', actor: 'system', outcome: 'info', leases: orphans.map((l) => ({ lease_id: l.lease_id, job: l.job, label: l.label })) });
  return orphans.map((l) => l.lease_id);
}

// ------------------------------------------------------------------ index

export type Holder =
  | { kind: 'project'; project_id: string; status: 'active' | 'archived'; source: 'timeline' | 'snapshot' | 'undo'; detail: string }
  | { kind: 'lease'; lease_id: string; job: JobKind; status: LeaseStatus }
  | { kind: 'brand'; brand_id: string; slot: 'font' | 'font_caption' | 'logo' | 'logo_light' | 'outro' | 'aset' | 'katalog' };

export interface DependencyIndex {
  schema_version: 1;
  built_at: number;
  /** Hash over every input (manifests, leases, registry) the index was derived from. */
  fingerprint: string;
  projects: Record<string, { status: 'active' | 'archived'; revision: number }>;
  by_version: Record<string, Holder[]>;
}

export type IndexResult = { ok: true; index: DependencyIndex } | { ok: false; errors: string[] };

async function inputsFingerprint(ws: Workspace, projectIds: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const id of projectIds) {
    h.update(`p:${id}\n`);
    h.update(await fsp.readFile(await resolveInside(ws.root, manifestRel(id))));
  }
  h.update('leases\n');
  h.update(await fsp.readFile(metaPath(ws, META_FILES.leases)));
  h.update('registry\n');
  h.update(await fsp.readFile(metaPath(ws, META_FILES.registry)));
  h.update('brand\n');
  h.update(await fsp.readFile(metaPath(ws, META_FILES.brand)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? Buffer.from('none') : Promise.reject(e))));
  for (const f of await brandFiles(ws)) {
    h.update(`brand:${path.basename(f)}\n`);
    h.update(await fsp.readFile(f));
  }
  // §29: foto Katalog Produk dirujuk seperti aset Brand Kit.
  for (const f of await katalogFiles(ws)) {
    h.update(`katalog:${path.basename(f)}\n`);
    h.update(await fsp.readFile(f));
  }
  return h.digest('hex');
}

/**
 * Rebuild the reverse index from source of truth (project manifests + leases + registry).
 * Any missing/corrupt/dangling input makes the whole result invalid (fail closed, GC-07).
 */
export async function buildIndex(ws: Workspace): Promise<IndexResult> {
  const errors: string[] = [];
  let reg: Registry;
  let leases: LeaseFile;
  let projectIds: string[];
  try {
    reg = await loadRegistry(ws);
    leases = await loadLeases(ws);
    projectIds = await listProjectIds(ws);
  } catch (e) {
    return { ok: false, errors: [isStorageError(e) ? `${e.code}: ${e.message}` : String(e)] };
  }

  const by_version: Record<string, Holder[]> = {};
  const add = (vid: string, h: Holder) => (by_version[vid] ??= []).push(h);
  const projects: DependencyIndex['projects'] = {};
  const checkRef = (ref: MediaRef, where: string) => {
    const v = reg.versions[ref.version_id];
    if (!v) errors.push(`${where}: versi ${ref.version_id} tidak ada di registry`);
    else if (v.media_id !== ref.media_id) errors.push(`${where}: versi ${ref.version_id} bukan milik media ${ref.media_id}`);
    else if (v.lifecycle !== 'active') errors.push(`${where}: versi ${ref.version_id} berstatus ${v.lifecycle} padahal masih direferensikan`);
  };

  for (const id of projectIds) {
    let m: ProjectManifest;
    try {
      m = await readJson(await resolveInside(ws.root, manifestRel(id)), validateProjectManifest, 'PROJECT_INVALID');
      if (m.project_id !== id) throw new StorageError('PROJECT_INVALID', 'project_id tidak cocok dengan folder');
    } catch (e) {
      errors.push(`proyek ${id}: ${isStorageError(e) ? e.message : String(e)}`);
      continue;
    }
    projects[id] = { status: m.status, revision: m.revision };
    for (const r of manifestReferences(m)) {
      checkRef(r.ref, `proyek ${id} (${r.source} ${r.detail})`);
      add(r.ref.version_id, { kind: 'project', project_id: id, status: m.status, source: r.source, detail: r.detail });
    }
  }
  // X06/U1: each Brand Kit holds its fonts, logos and outro like a project holds its clips.
  try {
    for (const kit of await listBrands(ws)) {
      for (const b of brandReferences(kit)) {
        checkRef(b.ref, `Brand Kit ${kit.kode} (${b.slot})`);
        add(b.ref.version_id, { kind: 'brand', brand_id: kit.brand_id, slot: b.slot });
      }
    }
  } catch (e) {
    errors.push(`Brand Kit: ${isStorageError(e) ? e.message : String(e)}`);
  }
  try {
    for (const k of await katalogReferences(ws)) {
      checkRef(k.ref, `Katalog Produk (${k.detail})`);
      add(k.ref.version_id, { kind: 'brand', brand_id: k.brand_id, slot: 'katalog' });
    }
  } catch (e) {
    errors.push(`Katalog Produk: ${isStorageError(e) ? e.message : String(e)}`);
  }
  for (const l of leases.leases) {
    for (const r of l.media) {
      checkRef(r, `lease ${l.lease_id}`);
      add(r.version_id, { kind: 'lease', lease_id: l.lease_id, job: l.job, status: l.status });
    }
  }
  if (errors.length) return { ok: false, errors };
  let fingerprint: string;
  try {
    fingerprint = await inputsFingerprint(ws, projectIds);
  } catch (e) {
    return { ok: false, errors: [`fingerprint: ${String(e)}`] };
  }
  return { ok: true, index: { schema_version: 1, built_at: ws.clock.now(), fingerprint, projects, by_version } };
}

/** Rebuild and persist `deps.json` (for dashboards). GC never trusts the persisted copy. */
export async function rebuildAndSaveIndex(ws: Workspace): Promise<IndexResult> {
  return withWorkspaceLock(ws, 'rebuildIndex', async () => {
    const r = await buildIndex(ws);
    await writeJsonAtomic(metaPath(ws, META_FILES.deps), r.ok ? { status: 'ok', ...r.index } : { status: 'invalid', built_at: ws.clock.now(), errors: r.errors });
    return r;
  });
}

/** True when nothing the index was derived from has changed since it was built. */
export async function isIndexFresh(ws: Workspace, index: DependencyIndex): Promise<boolean> {
  try {
    return (await inputsFingerprint(ws, await listProjectIds(ws))) === index.fingerprint;
  } catch {
    return false;
  }
}

export const holdersOf = (index: DependencyIndex, versionId: string): Holder[] => index.by_version[versionId] ?? [];

// ------------------------------------------------------------------ project commits

/**
 * Commit a project manifest through the storage service (optimistic concurrency on revision).
 * Referenced versions must be active + intact and are marked `ever_referenced`.
 * `afterCommit` lets the eligibility layer reconcile clocks inside the same lock.
 */
export async function commitProject(
  ws: Workspace,
  input: { manifest: ProjectManifest; expected_revision: number; actor: Actor },
  afterCommit?: (reg: Registry) => Promise<void>,
): Promise<ProjectManifest> {
  await guard(ws, input.actor, 'commit_project');
  const next = validateProjectManifest(input.manifest);
  return withWorkspaceLock(ws, 'commitProject', async () => {
    const current = await readProject(ws, next.project_id);
    if (current.revision !== input.expected_revision) {
      throw new StorageError('CONFLICT', 'Revisi proyek sudah berubah; muat ulang dulu', { expected: input.expected_revision, actual: current.revision });
    }
    const reg = await loadRegistry(ws);
    const refs = manifestReferences(next);
    const busy = await journalBusy(ws);
    // PC-10 (owner: A): only the live timeline must be usable. Undo/redo/snapshot history still
    // holds its media (never trashed) but may point at a version that later changed/missing; that
    // must not lock the whole project. Undoing *to* such a step is refused by this same check.
    // Checkpoint G G-1: a commit that leaves the live timeline untouched (rename, archive) adds no
    // new use of any media, so a damaged file must not block it — it only has to be known.
    const sameTimeline = JSON.stringify(current.timeline) === JSON.stringify(next.timeline);
    for (const r of refs) {
      if (r.source === 'timeline' && !sameTimeline) assertUsable(reg, r.ref, busy);
      else assertKnown(reg, r.ref);
    }
    const saved: ProjectManifest = { ...next, revision: current.revision + 1, created_at: current.created_at, updated_at: ws.clock.now() };
    await writeJsonAtomic(await resolveInside(ws.root, manifestRel(next.project_id)), saved);
    for (const r of refs) {
      const v = reg.versions[r.ref.version_id]!;
      v.ever_referenced = true;
      v.unreferenced_since = null; // reference resets the clock at commit time (review H1), index-independent
    }
    await saveRegistry(ws, reg);
    if (afterCommit) await afterCommit(reg);
    await audit(ws, { op: 'project.commit', actor: input.actor, outcome: 'ok', project_id: saved.project_id, revision: saved.revision, status: saved.status, refs: refs.length });
    return saved;
  });
}
