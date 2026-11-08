import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import type { StagedBlob } from './backend.js';
import { StorageError } from './errors.js';
import { assertSafeId, isSafeId, newId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { isInside } from './paths.js';
import { guard } from './guard.js';
import type { Actor } from './permissions.js';
import { LAYOUT, META_FILES, type Workspace, metaPath, projectRel, readProject, withWorkspaceLock } from './workspace.js';

import { type MediaProbe, probeFile, validateProbe } from './probe.js';

export { hashFile } from './hash.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type MediaScope = { kind: 'shared' } | { kind: 'project'; project_id: string };

export interface MediaRecord {
  media_id: string;
  scope: MediaScope;
  display_name: string;
  current_version_id: string;
  created_at: number;
}

/** Physical/lifecycle status of the bytes. GC display states are derived in eligibility.ts. */
export type Lifecycle = 'active' | 'trashed' | 'purged';
export type Integrity = 'ok' | 'missing' | 'changed';

export interface VersionRecord {
  version_id: string;
  media_id: string;
  /** Immutable after import: `sha256:<hex>`. */
  content_hash: string;
  size: number;
  /** Canonical workspace-relative path of the bytes (changes only on trash/restore). */
  rel_path: string;
  original_name: string;
  imported_at: number;
  lifecycle: Lifecycle;
  integrity: Integrity;
  last_verified_at: number;
  /** Bound to a committed timeline/retained snapshot at least once (PRD v0.8 §B). */
  ever_referenced: boolean;
  /** Start of the current continuous unreferenced+unprotected period, or null. */
  unreferenced_since: number | null;
  keep: boolean;
  pin: boolean;
  legal_hold: boolean;
  restored_at: number | null;
  trash: TrashInfo | null;
  /** ffprobe result (W07): undefined = not probed yet, null = probed but not playable media. */
  probe?: MediaProbe | null;
}

export interface TrashInfo {
  op_id: string;
  trashed_at: number;
  original_rel_path: string;
  manifest_rel_path: string;
}

export interface Registry {
  schema_version: typeof REGISTRY_SCHEMA_VERSION;
  media: Record<string, MediaRecord>;
  versions: Record<string, VersionRecord>;
}

// ------------------------------------------------------------------ load/save

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function validateRegistry(x: unknown): Registry {
  const bad = (msg: string): never => {
    throw new StorageError('INDEX_INVALID', `registry.json tidak valid: ${msg}`);
  };
  const o = x as Partial<Registry> | null;
  if (!o || o.schema_version !== REGISTRY_SCHEMA_VERSION || typeof o.media !== 'object' || typeof o.versions !== 'object' || !o.media || !o.versions) {
    bad('struktur');
  }
  const reg = o as Registry;
  for (const [id, m] of Object.entries(reg.media)) {
    if (!isSafeId(id) || m.media_id !== id || !isSafeId(m.current_version_id)) bad(`media ${id}`);
    if (m.scope?.kind !== 'shared' && !(m.scope?.kind === 'project' && isSafeId(m.scope.project_id))) bad(`scope ${id}`);
  }
  for (const [id, v] of Object.entries(reg.versions)) {
    if (!isSafeId(id) || v.version_id !== id || !reg.media[v.media_id]) bad(`version ${id}`);
    if (!HASH_RE.test(v.content_hash) || typeof v.size !== 'number' || typeof v.rel_path !== 'string') bad(`version ${id} hash/size/path`);
    if (!['active', 'trashed', 'purged'].includes(v.lifecycle) || !['ok', 'missing', 'changed'].includes(v.integrity)) bad(`version ${id} status`);
    if (typeof v.ever_referenced !== 'boolean' || !(v.unreferenced_since === null || typeof v.unreferenced_since === 'number')) bad(`version ${id} clock`);
    if (v.probe !== undefined) {
      try {
        validateProbe(v.probe);
      } catch {
        bad(`version ${id} probe`);
      }
    }
  }
  for (const m of Object.values(reg.media)) {
    if (reg.versions[m.current_version_id]?.media_id !== m.media_id) bad(`current version ${m.media_id}`);
  }
  return reg;
}

export const loadRegistry = (ws: Workspace): Promise<Registry> =>
  readJson(metaPath(ws, META_FILES.registry), validateRegistry, 'INDEX_INVALID');

export const saveRegistry = (ws: Workspace, reg: Registry): Promise<void> =>
  writeJsonAtomic(metaPath(ws, META_FILES.registry), validateRegistry(reg));

const safeExt = (name: string): string => {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
};

// ------------------------------------------------------------------ import

export interface ImportResult {
  media: MediaRecord;
  version: VersionRecord;
  /** True when identical bytes already existed; nothing was copied. */
  duplicate: boolean;
}

async function validateSource(ws: Workspace, sourcePath: string): Promise<string> {
  const abs = path.resolve(sourcePath);
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    throw new StorageError('NOT_FOUND', 'File sumber tidak ditemukan', { sourcePath });
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new StorageError('PRECONDITION', 'Sumber harus file biasa (bukan folder/symlink)', { sourcePath });
  if (st.size === 0) throw new StorageError('PRECONDITION', 'File sumber kosong', { sourcePath });
  const real = await fsp.realpath(abs);
  if (isInside(ws.root, real)) throw new StorageError('PRECONDITION', 'Sumber import harus dari luar workspace', { sourcePath });
  return real;
}

function scopeDir(scope: MediaScope): string {
  return scope.kind === 'shared' ? LAYOUT.sharedMedia : projectRel(scope.project_id, '01_INPUT');
}

const sameScope = (a: MediaScope, b: MediaScope) =>
  a.kind === b.kind && (a.kind === 'shared' || (b.kind === 'project' && a.project_id === b.project_id));

/**
 * Duplicate detection (review M5): only *active* versions count, and only when the existing
 * media is shared or in the same scope (projects never silently depend on another project's input).
 * Identical bytes sitting in Trash are reported instead of returning an unusable version.
 */
function findDuplicate(reg: Registry, hash: string, accept: (v: VersionRecord) => boolean): VersionRecord | undefined {
  const matches = Object.values(reg.versions).filter((v) => v.content_hash === hash && accept(v));
  const active = matches.find((v) => v.lifecycle === 'active');
  if (active) return active;
  const trashed = matches.find((v) => v.lifecycle === 'trashed');
  if (trashed) {
    throw new StorageError('CONFLICT', 'Byte yang sama ada di Trash: pulihkan versi itu, jangan import ulang', { version_id: trashed.version_id });
  }
  return undefined;
}

function newVersion(ws: Workspace, mediaId: string, versionId: string, staged: StagedBlob, rel: string, originalName: string, probe: MediaProbe | null | undefined): VersionRecord {
  const now = ws.clock.now();
  return {
    version_id: versionId,
    media_id: mediaId,
    content_hash: staged.hash,
    size: staged.size,
    rel_path: rel,
    original_name: originalName,
    imported_at: now,
    lifecycle: 'active',
    integrity: 'ok',
    last_verified_at: now,
    ever_referenced: false,
    unreferenced_since: null,
    keep: false,
    pin: false,
    legal_hold: false,
    restored_at: null,
    ...(probe !== undefined ? { probe } : {}),
    trash: null,
  };
}

/** Import a new media item (new media_id + first version). Duplicate bytes return the existing version. */
export async function importMedia(
  ws: Workspace,
  input: { sourcePath: string; scope: MediaScope; display_name?: string; actor: Actor },
): Promise<ImportResult> {
  await guard(ws, input.actor, 'import');
  if (input.scope.kind === 'project') {
    assertSafeId(input.scope.project_id, 'Project ID');
    await readProject(ws, input.scope.project_id); // must exist and be valid
  }
  const source = await validateSource(ws, input.sourcePath);
  const dirRel = scopeDir(input.scope);
  // Metadata only (duration/size/codec); the stored bytes are still identified by the staged hash.
  const probe = await probeFile(source);
  const staged = await ws.blobs.stage(dirRel, source);
  try {
    return await withWorkspaceLock(ws, 'importMedia', async () => {
      const reg = await loadRegistry(ws);
      const dup = findDuplicate(reg, staged.hash, (v) => {
        const sc = reg.media[v.media_id]!.scope;
        return sc.kind === 'shared' || sameScope(sc, input.scope);
      });
      if (dup) {
        await ws.blobs.discard(staged);
        await audit(ws, { op: 'media.import', actor: input.actor, outcome: 'info', duplicate: true, version_id: dup.version_id, content_hash: dup.content_hash });
        return { media: reg.media[dup.media_id]!, version: dup, duplicate: true };
      }
      const mediaId = newId('m');
      const versionId = newId('v');
      const rel = await ws.blobs.commit(staged, `${dirRel}/${mediaId}/${versionId}${safeExt(source)}`);
      const originalName = path.basename(source);
      const version = newVersion(ws, mediaId, versionId, staged, rel, originalName, probe);
      const media: MediaRecord = {
        media_id: mediaId,
        scope: input.scope,
        display_name: input.display_name ?? originalName,
        current_version_id: versionId,
        created_at: version.imported_at,
      };
      reg.media[mediaId] = media;
      reg.versions[versionId] = version;
      await saveRegistry(ws, reg);
      await audit(ws, { op: 'media.import', actor: input.actor, outcome: 'ok', media_id: mediaId, version_id: versionId, rel_path: rel, content_hash: staged.hash, size: staged.size });
      return { media, version, duplicate: false };
    });
  } finally {
    await ws.blobs.discard(staged);
  }
}

/** Add a new immutable version to existing media; old versions are never overwritten. */
export async function addVersion(
  ws: Workspace,
  input: { media_id: string; sourcePath: string; makeCurrent?: boolean; actor: Actor },
): Promise<ImportResult> {
  await guard(ws, input.actor, 'import');
  const mediaId = assertSafeId(input.media_id, 'Media ID');
  const source = await validateSource(ws, input.sourcePath);
  const before = await loadRegistry(ws);
  const m0 = before.media[mediaId];
  if (!m0) throw new StorageError('NOT_FOUND', 'Media tidak ditemukan', { media_id: mediaId });
  const dirRel = scopeDir(m0.scope);
  const probe = await probeFile(source);
  const staged = await ws.blobs.stage(dirRel, source);
  try {
    return await withWorkspaceLock(ws, 'addVersion', async () => {
      const reg = await loadRegistry(ws);
      const media = reg.media[mediaId];
      if (!media) throw new StorageError('NOT_FOUND', 'Media tidak ditemukan', { media_id: mediaId });
      const dup = findDuplicate(reg, staged.hash, (v) => v.media_id === mediaId);
      if (dup) {
        await audit(ws, { op: 'media.add_version', actor: input.actor, outcome: 'info', duplicate: true, version_id: dup.version_id });
        return { media, version: dup, duplicate: true };
      }
      const versionId = newId('v');
      const rel = await ws.blobs.commit(staged, `${dirRel}/${mediaId}/${versionId}${safeExt(source)}`);
      const version = newVersion(ws, mediaId, versionId, staged, rel, path.basename(source), probe);
      reg.versions[versionId] = version;
      const previous = media.current_version_id;
      if (input.makeCurrent ?? true) media.current_version_id = versionId;
      await saveRegistry(ws, reg);
      await audit(ws, { op: 'media.add_version', actor: input.actor, outcome: 'ok', media_id: mediaId, version_id: versionId, previous_current: previous, now_current: media.current_version_id, content_hash: staged.hash });
      return { media, version, duplicate: false };
    });
  } finally {
    await ws.blobs.discard(staged);
  }
}

export async function setCurrentVersion(ws: Workspace, input: { media_id: string; version_id: string; actor: Actor }): Promise<MediaRecord> {
  await guard(ws, input.actor, 'set_protection', { version_id: input.version_id });
  return withWorkspaceLock(ws, 'setCurrentVersion', async () => {
    const reg = await loadRegistry(ws);
    const media = reg.media[input.media_id];
    const v = reg.versions[input.version_id];
    if (!media || !v || v.media_id !== media.media_id) throw new StorageError('NOT_FOUND', 'Media/versi tidak cocok', { ...input });
    if (v.lifecycle !== 'active' || v.integrity !== 'ok') throw new StorageError('PRECONDITION', 'Versi current harus aktif dan utuh', { version_id: v.version_id });
    const previous = media.current_version_id;
    media.current_version_id = v.version_id;
    v.unreferenced_since = null; // protection resets the clock immediately, even if the index is invalid
    await saveRegistry(ws, reg);
    await audit(ws, { op: 'media.set_current', actor: input.actor, outcome: 'ok', media_id: media.media_id, previous, now: v.version_id });
    return media;
  });
}

export async function setProtection(
  ws: Workspace,
  input: { version_id: string; keep?: boolean; pin?: boolean; legal_hold?: boolean; actor: Actor },
): Promise<VersionRecord> {
  await guard(ws, input.actor, 'set_protection', { version_id: input.version_id });
  return withWorkspaceLock(ws, 'setProtection', async () => {
    const reg = await loadRegistry(ws);
    const v = reg.versions[input.version_id];
    if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: input.version_id });
    for (const k of ['keep', 'pin', 'legal_hold'] as const) if (input[k] !== undefined) v[k] = input[k];
    if (v.keep || v.pin || v.legal_hold) v.unreferenced_since = null; // reset at the mutation (review H1)
    await saveRegistry(ws, reg);
    await audit(ws, { op: 'media.set_protection', actor: input.actor, outcome: 'ok', version_id: v.version_id, keep: v.keep, pin: v.pin, legal_hold: v.legal_hold });
    return v;
  });
}

export interface VerifyResult {
  version_id: string;
  integrity: Integrity;
  expected_hash: string;
  actual_hash?: string;
  /** Set when the file could not be read (locked/busy/denied): nothing was recorded. */
  unverifiable?: string;
  /** True when the result was persisted to the registry. */
  recorded: boolean;
}

/**
 * Re-hash a version's bytes. A mismatch marks it CHANGED (alert, GC-11); the recorded
 * hash is never updated, so timelines are never silently upgraded to new bytes.
 * Hashing happens outside the lock; the result is only recorded if the version did not
 * move meanwhile (review L1). Read errors other than "not found" record nothing.
 * The AI actor may verify but never writes.
 */
export async function verifyVersion(ws: Workspace, versionId: string, actor: Actor | 'system' = 'system'): Promise<VerifyResult> {
  const reg0 = await loadRegistry(ws);
  const v0 = reg0.versions[versionId];
  if (!v0) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: versionId });
  const base = { version_id: versionId, expected_hash: v0.content_hash };
  if (v0.lifecycle === 'purged') return { ...base, integrity: v0.integrity, recorded: false };
  let integrity: Integrity;
  let actual: string | undefined;
  try {
    actual = (await ws.blobs.hash(v0.rel_path)).hash;
    integrity = actual === v0.content_hash ? 'ok' : 'changed';
  } catch (e) {
    const notFound = (e instanceof StorageError && e.code === 'NOT_FOUND') || (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (!notFound) return { ...base, integrity: v0.integrity, unverifiable: String(e), recorded: false };
    integrity = 'missing';
  }
  const result = { ...base, integrity, ...(actual ? { actual_hash: actual } : {}) };
  if (actor === 'ai') return { ...result, recorded: false };
  return withWorkspaceLock(ws, 'verifyVersion', async () => {
    const reg = await loadRegistry(ws);
    const v = reg.versions[versionId];
    if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: versionId });
    if (v.rel_path !== v0.rel_path || v.lifecycle !== v0.lifecycle) return { ...result, recorded: false }; // stale: moved meanwhile
    const prev = v.integrity;
    v.integrity = integrity;
    v.last_verified_at = ws.clock.now();
    await saveRegistry(ws, reg);
    if (integrity !== 'ok' || prev !== 'ok') {
      await audit(ws, {
        op: 'media.verify',
        actor,
        outcome: integrity === 'ok' ? 'info' : 'alert',
        version_id: versionId,
        integrity,
        previous: prev,
        expected_hash: v.content_hash,
        actual_hash: actual,
      });
    }
    return { ...result, recorded: true };
  });
}

/**
 * Fill in the probe of versions imported before W07 (or when ffprobe was missing). Runs the
 * probe outside the lock on a local copy from the backend, then records it only if the version
 * still has no probe. Never touches the media bytes.
 */
export async function backfillProbes(ws: Workspace, opts: { limit?: number } = {}): Promise<{ probed: string[]; failed: string[] }> {
  const reg0 = await loadRegistry(ws);
  const todo = Object.values(reg0.versions).filter((v) => v.lifecycle === 'active' && v.integrity === 'ok' && v.probe === undefined).slice(0, opts.limit ?? 50);
  const probed: string[] = [];
  const failed: string[] = [];
  for (const v of todo) {
    let probe: MediaProbe | null | undefined;
    try {
      probe = await ws.blobs.withLocalFile(v.rel_path, (file) => probeFile(file));
    } catch {
      failed.push(v.version_id);
      continue;
    }
    await withWorkspaceLock(ws, 'backfillProbe', async () => {
      const reg = await loadRegistry(ws);
      const cur = reg.versions[v.version_id];
      if (probe === undefined || !cur || cur.probe !== undefined || cur.rel_path !== v.rel_path) return;
      cur.probe = probe;
      await saveRegistry(ws, reg);
      probed.push(v.version_id);
    });
  }
  return { probed, failed };
}
