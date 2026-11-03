import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { audit } from './audit.js';
import { StorageError } from './errors.js';
import { assertSafeId, isSafeId, newId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { isInside, resolveCanonical, resolveInside } from './paths.js';
import { type Actor, assertAllowed } from './permissions.js';
import { LAYOUT, META_FILES, type Workspace, metaPath, projectRel, readProject, withWorkspaceLock } from './workspace.js';

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

// ------------------------------------------------------------------ hashing

export async function hashFile(file: string): Promise<{ hash: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: `sha256:${h.digest('hex')}`, size };
}

/** Copy while hashing the exact bytes written, then fsync. */
async function copyHashing(src: string, dest: string): Promise<{ hash: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createWriteStream(dest, { flags: 'wx' }));
  const fh = await fsp.open(dest, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { hash: `sha256:${h.digest('hex')}`, size };
}

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

function findByHash(reg: Registry, hash: string, mediaId?: string): VersionRecord | undefined {
  return Object.values(reg.versions).find(
    (v) => v.content_hash === hash && v.lifecycle !== 'purged' && (mediaId === undefined || v.media_id === mediaId),
  );
}

interface StagedCopy {
  tmpAbs: string;
  hash: string;
  size: number;
}

/** Copy the source into the destination area under a temp name (outside the lock: may be slow). */
async function stage(ws: Workspace, dirRel: string, source: string): Promise<StagedCopy> {
  const dir = await resolveInside(ws.root, dirRel);
  const tmpAbs = path.join(dir, `.importing-${newId('op')}`);
  try {
    const { hash, size } = await copyHashing(source, tmpAbs);
    return { tmpAbs, hash, size };
  } catch (e) {
    await fsp.rm(tmpAbs, { force: true });
    throw e;
  }
}

async function commitStaged(ws: Workspace, staged: StagedCopy, mediaId: string, versionId: string, ext: string, dirRel: string): Promise<string> {
  const rel = `${dirRel}/${mediaId}/${versionId}${ext}`;
  const target = await resolveCanonical(ws.root, rel, { allowMissing: true });
  await fsp.mkdir(path.dirname(target.abs), { recursive: true });
  await fsp.rename(staged.tmpAbs, target.abs);
  await fsp.chmod(target.abs, 0o444); // media are read-only for the app (PRD v0.8 §C)
  return target.rel;
}

function newVersion(ws: Workspace, mediaId: string, versionId: string, staged: StagedCopy, rel: string, originalName: string): VersionRecord {
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
    trash: null,
  };
}

/** Import a new media item (new media_id + first version). Duplicate bytes return the existing version. */
export async function importMedia(
  ws: Workspace,
  input: { sourcePath: string; scope: MediaScope; display_name?: string; actor: Actor },
): Promise<ImportResult> {
  assertAllowed(input.actor, 'import');
  if (input.scope.kind === 'project') {
    assertSafeId(input.scope.project_id, 'Project ID');
    await readProject(ws, input.scope.project_id); // must exist and be valid
  }
  const source = await validateSource(ws, input.sourcePath);
  const dirRel = scopeDir(input.scope);
  const staged = await stage(ws, dirRel, source);
  try {
    return await withWorkspaceLock(ws, 'importMedia', async () => {
      const reg = await loadRegistry(ws);
      const dup = findByHash(reg, staged.hash);
      if (dup) {
        await fsp.rm(staged.tmpAbs, { force: true });
        await audit(ws, { op: 'media.import', actor: input.actor, outcome: 'info', duplicate: true, version_id: dup.version_id, content_hash: dup.content_hash });
        return { media: reg.media[dup.media_id]!, version: dup, duplicate: true };
      }
      const mediaId = newId('m');
      const versionId = newId('v');
      const rel = await commitStaged(ws, staged, mediaId, versionId, safeExt(source), dirRel);
      const originalName = path.basename(source);
      const version = newVersion(ws, mediaId, versionId, staged, rel, originalName);
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
    await fsp.rm(staged.tmpAbs, { force: true });
  }
}

/** Add a new immutable version to existing media; old versions are never overwritten. */
export async function addVersion(
  ws: Workspace,
  input: { media_id: string; sourcePath: string; makeCurrent?: boolean; actor: Actor },
): Promise<ImportResult> {
  assertAllowed(input.actor, 'import');
  const mediaId = assertSafeId(input.media_id, 'Media ID');
  const source = await validateSource(ws, input.sourcePath);
  const before = await loadRegistry(ws);
  const m0 = before.media[mediaId];
  if (!m0) throw new StorageError('NOT_FOUND', 'Media tidak ditemukan', { media_id: mediaId });
  const dirRel = scopeDir(m0.scope);
  const staged = await stage(ws, dirRel, source);
  try {
    return await withWorkspaceLock(ws, 'addVersion', async () => {
      const reg = await loadRegistry(ws);
      const media = reg.media[mediaId];
      if (!media) throw new StorageError('NOT_FOUND', 'Media tidak ditemukan', { media_id: mediaId });
      const dup = findByHash(reg, staged.hash, mediaId);
      if (dup) {
        await audit(ws, { op: 'media.add_version', actor: input.actor, outcome: 'info', duplicate: true, version_id: dup.version_id });
        return { media, version: dup, duplicate: true };
      }
      const versionId = newId('v');
      const rel = await commitStaged(ws, staged, mediaId, versionId, safeExt(source), dirRel);
      const version = newVersion(ws, mediaId, versionId, staged, rel, path.basename(source));
      reg.versions[versionId] = version;
      const previous = media.current_version_id;
      if (input.makeCurrent ?? true) media.current_version_id = versionId;
      await saveRegistry(ws, reg);
      await audit(ws, { op: 'media.add_version', actor: input.actor, outcome: 'ok', media_id: mediaId, version_id: versionId, previous_current: previous, now_current: media.current_version_id, content_hash: staged.hash });
      return { media, version, duplicate: false };
    });
  } finally {
    await fsp.rm(staged.tmpAbs, { force: true });
  }
}

export async function setCurrentVersion(ws: Workspace, input: { media_id: string; version_id: string; actor: Actor }): Promise<MediaRecord> {
  assertAllowed(input.actor, 'set_protection');
  return withWorkspaceLock(ws, 'setCurrentVersion', async () => {
    const reg = await loadRegistry(ws);
    const media = reg.media[input.media_id];
    const v = reg.versions[input.version_id];
    if (!media || !v || v.media_id !== media.media_id) throw new StorageError('NOT_FOUND', 'Media/versi tidak cocok', { ...input });
    if (v.lifecycle !== 'active' || v.integrity !== 'ok') throw new StorageError('PRECONDITION', 'Versi current harus aktif dan utuh', { version_id: v.version_id });
    const previous = media.current_version_id;
    media.current_version_id = v.version_id;
    await saveRegistry(ws, reg);
    await audit(ws, { op: 'media.set_current', actor: input.actor, outcome: 'ok', media_id: media.media_id, previous, now: v.version_id });
    return media;
  });
}

export async function setProtection(
  ws: Workspace,
  input: { version_id: string; keep?: boolean; pin?: boolean; legal_hold?: boolean; actor: Actor },
): Promise<VersionRecord> {
  assertAllowed(input.actor, 'set_protection');
  return withWorkspaceLock(ws, 'setProtection', async () => {
    const reg = await loadRegistry(ws);
    const v = reg.versions[input.version_id];
    if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: input.version_id });
    for (const k of ['keep', 'pin', 'legal_hold'] as const) if (input[k] !== undefined) v[k] = input[k];
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
}

/**
 * Re-hash a version's bytes. A mismatch marks it CHANGED (alert, GC-11); the recorded
 * hash is never updated, so timelines are never silently upgraded to new bytes.
 */
export async function verifyVersion(ws: Workspace, versionId: string): Promise<VerifyResult> {
  const reg0 = await loadRegistry(ws);
  const v0 = reg0.versions[versionId];
  if (!v0) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: versionId });
  if (v0.lifecycle === 'purged') return { version_id: versionId, integrity: v0.integrity, expected_hash: v0.content_hash };
  let integrity: Integrity;
  let actual: string | undefined;
  try {
    const abs = await resolveInside(ws.root, v0.rel_path);
    actual = (await hashFile(abs)).hash;
    integrity = actual === v0.content_hash ? 'ok' : 'changed';
  } catch (e) {
    if (e instanceof StorageError && e.code !== 'NOT_FOUND') throw e;
    integrity = 'missing';
  }
  return withWorkspaceLock(ws, 'verifyVersion', async () => {
    const reg = await loadRegistry(ws);
    const v = reg.versions[versionId];
    if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: versionId });
    const prev = v.integrity;
    v.integrity = integrity;
    v.last_verified_at = ws.clock.now();
    await saveRegistry(ws, reg);
    if (integrity !== 'ok' || prev !== 'ok') {
      await audit(ws, {
        op: 'media.verify',
        actor: 'system',
        outcome: integrity === 'ok' ? 'info' : 'alert',
        version_id: versionId,
        integrity,
        previous: prev,
        expected_hash: v.content_hash,
        actual_hash: actual,
      });
    }
    return { version_id: versionId, integrity, expected_hash: v.content_hash, ...(actual ? { actual_hash: actual } : {}) };
  });
}
