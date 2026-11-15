import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { newId } from './ids.js';
import { writeJsonAtomic } from './jsonStore.js';
import { isInside } from './paths.js';
import type { Actor } from './permissions.js';
import { hashFile } from './hash.js';
import { loadRegistry } from './registry.js';
import { LAYOUT, type Workspace, withWorkspaceLock } from './workspace.js';

/**
 * Manual footage backup tracking (PRD v0.8 §G): the app never copies footage itself.
 * It records a user-chosen backup folder and verifies it READ-ONLY by content hash.
 * A version only counts as backed up after a successful hash match.
 */
export interface BackupLocation {
  location_id: string;
  path: string;
  registered_at: number;
}

export interface BackupProof {
  location_id: string;
  verified_at: number;
  /** Path inside the backup folder whose bytes matched the version hash. */
  backup_rel: string;
}

interface BackupFile {
  schema_version: 1;
  locations: BackupLocation[];
  verified: Record<string, BackupProof>;
}

export type BackupStatus = { status: 'verified'; location: string; verified_at: number; backup_rel: string } | { status: 'unverified' };

const backupsPath = (ws: Workspace) => path.join(ws.root, LAYOUT.meta, 'backups.json');

async function loadBackups(ws: Workspace): Promise<BackupFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(backupsPath(ws), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1, locations: [], verified: {} };
    throw e;
  }
  const o = JSON.parse(raw) as BackupFile;
  if (o?.schema_version !== 1 || !Array.isArray(o.locations) || typeof o.verified !== 'object') {
    throw new StorageError('INDEX_INVALID', 'backups.json tidak valid');
  }
  return o;
}

export async function registerBackupLocation(ws: Workspace, input: { path: string; actor: Actor }): Promise<BackupLocation> {
  await guard(ws, input.actor, 'set_protection', { backup_path: input.path });
  const abs = path.resolve(input.path);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new StorageError('NOT_FOUND', 'Folder backup tidak ditemukan', { path: abs });
  const real = await fsp.realpath(abs);
  if (isInside(ws.root, real) || isInside(real, ws.root)) {
    throw new StorageError('PRECONDITION', 'Folder backup harus di luar workspace (sebaiknya drive lain)', { path: abs });
  }
  return withWorkspaceLock(ws, 'registerBackup', async () => {
    const f = await loadBackups(ws);
    const existing = f.locations.find((l) => l.path.toLowerCase() === real.toLowerCase());
    if (existing) return existing;
    const loc: BackupLocation = { location_id: newId('op'), path: real, registered_at: ws.clock.now() };
    f.locations.push(loc);
    await writeJsonAtomic(backupsPath(ws), f);
    await audit(ws, { op: 'backup.register', actor: input.actor, outcome: 'ok', location_id: loc.location_id, path: real });
    return loc;
  });
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth > 12) return;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of the backup folder
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

/** Read-only verification: hash files whose size matches a known version and record matches. */
export async function verifyBackupLocation(ws: Workspace, input: { location_id: string; actor: Actor }): Promise<{ scanned: number; hashed: number; matched: string[] }> {
  await guard(ws, input.actor, 'set_protection', { location_id: input.location_id });
  const f0 = await loadBackups(ws);
  const loc = f0.locations.find((l) => l.location_id === input.location_id);
  if (!loc) throw new StorageError('NOT_FOUND', 'Lokasi backup tidak terdaftar', { location_id: input.location_id });
  const reg = await loadRegistry(ws);
  const bySize = new Map<number, { version_id: string; hash: string }[]>();
  for (const v of Object.values(reg.versions)) {
    if (v.lifecycle === 'purged') continue;
    (bySize.get(v.size) ?? bySize.set(v.size, []).get(v.size)!).push({ version_id: v.version_id, hash: v.content_hash });
  }
  const found: Record<string, string> = {};
  let scanned = 0;
  let hashed = 0;
  for await (const file of walk(loc.path, 0)) {
    scanned++;
    const st = await fsp.stat(file);
    const cands = bySize.get(st.size);
    if (!cands) continue;
    hashed++;
    const { hash } = await hashFile(file);
    for (const c of cands) if (c.hash === hash && !found[c.version_id]) found[c.version_id] = path.relative(loc.path, file);
  }
  await withWorkspaceLock(ws, 'verifyBackup', async () => {
    const f = await loadBackups(ws);
    const now = ws.clock.now();
    for (const [vid, rel] of Object.entries(found)) f.verified[vid] = { location_id: loc.location_id, verified_at: now, backup_rel: rel };
    await writeJsonAtomic(backupsPath(ws), f);
  });
  await audit(ws, { op: 'backup.verify', actor: input.actor, outcome: 'ok', location_id: loc.location_id, scanned, hashed, matched: Object.keys(found).length });
  return { scanned, hashed, matched: Object.keys(found).sort() };
}

/** Registered backup folders with how many versions each has proven (read-only). */
export async function listBackupLocations(ws: Workspace): Promise<(BackupLocation & { verified: number; last_verified_at: number | null })[]> {
  const f = await loadBackups(ws);
  return f.locations.map((l) => {
    const proofs = Object.values(f.verified).filter((p) => p.location_id === l.location_id);
    return { ...l, verified: proofs.length, last_verified_at: proofs.length ? Math.max(...proofs.map((p) => p.verified_at)) : null };
  });
}

export async function backupStatusOf(ws: Workspace, versionId: string): Promise<BackupStatus> {
  const f = await loadBackups(ws);
  const proof = f.verified[versionId];
  const loc = proof && f.locations.find((l) => l.location_id === proof.location_id);
  if (!proof || !loc) return { status: 'unverified' };
  return { status: 'verified', location: loc.path, verified_at: proof.verified_at, backup_rel: proof.backup_rel };
}
