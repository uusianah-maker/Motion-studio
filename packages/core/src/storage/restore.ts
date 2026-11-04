import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { StorageError } from './errors.js';
import { newId } from './ids.js';
import { resolveCanonical, resolveInside } from './paths.js';
import { type Actor, MEDIA_AREAS, areaOf, assertAllowed, isAllowed, resolveInArea } from './permissions.js';
import { hashFile, loadRegistry, saveRegistry } from './registry.js';
import { type JournalEntry, clearJournal, readTrashManifest, writeJournal } from './trash.js';
import { type Workspace, withWorkspaceLock } from './workspace.js';

/**
 * Move bytes without ever overwriting: hard-link to the destination (fails atomically with
 * EEXIST if something is there), then unlink the source. Cross-device: exclusive copy + hash check.
 */
export async function moveNoOverwrite(fromAbs: string, toAbs: string, expectedHash: string): Promise<void> {
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fsp.link(fromAbs, toAbs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new StorageError('CONFLICT', 'Tujuan sudah ada; tidak ditimpa', { toAbs });
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw e;
    await fsp.copyFile(fromAbs, toAbs, fsc.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new StorageError('CONFLICT', 'Tujuan sudah ada; tidak ditimpa', { toAbs });
      throw err;
    });
    if ((await hashFile(toAbs)).hash !== expectedHash) {
      await fsp.chmod(toAbs, 0o666).catch(() => undefined);
      await fsp.rm(toAbs, { force: true });
      throw new StorageError('INTEGRITY', 'Salinan restore tidak cocok hash');
    }
  }
  await fsp.chmod(fromAbs, 0o666).catch(() => undefined);
  await fsp.rm(fromAbs);
  await fsp.chmod(toAbs, 0o444);
}

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);

/** First free sibling name: `<base>.restored-1<ext>`, `-2`, … */
async function alternatePath(ws: Workspace, rel: string): Promise<string> {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  for (let i = 1; i < 1000; i++) {
    const cand = `${dir}/${base}.restored-${i}${ext}`;
    const r = await resolveCanonical(ws.root, cand, { allowMissing: true });
    if (!(await exists(r.abs))) return r.rel;
  }
  throw new StorageError('CONFLICT', 'Tidak menemukan nama alternatif yang bebas');
}

export type RestoreResult =
  | { status: 'restored'; op_id: string; version_id: string; rel_path: string; alternate: boolean }
  | { status: 'conflict'; op_id: string; version_id: string; wanted: string; suggested: string }
  | { status: 'failed'; op_id: string; version_id: string; reason: string };

/**
 * Restore a trashed version (PRD v0.8 §F). Validates manifest + hash, keeps the destination
 * inside a media area, never overwrites (conflict → user chooses), updates registry so all
 * existing media/version references work again, and restarts eligibility from zero.
 */
export async function restoreVersion(
  ws: Workspace,
  input: { version_id: string; actor: Actor; destination?: string; onConflict?: 'ask' | 'alternate' },
): Promise<RestoreResult> {
  const op_id = newId('op');
  if (!isAllowed(input.actor, 'restore')) {
    await audit(ws, { op_id, op: 'trash.restore', actor: input.actor, outcome: 'blocked', reason: 'FORBIDDEN', version_id: input.version_id });
  }
  assertAllowed(input.actor, 'restore');
  return withWorkspaceLock(ws, 'restore', async () => {
    const reg = await loadRegistry(ws);
    const v = reg.versions[input.version_id];
    if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: input.version_id });
    if (v.lifecycle !== 'trashed' || !v.trash) throw new StorageError('PRECONDITION', `Versi tidak ada di Trash (status ${v.lifecycle})`);

    const failed = async (reason: string): Promise<RestoreResult> => {
      await audit(ws, { op_id, op: 'trash.restore', actor: input.actor, outcome: 'failed', version_id: v.version_id, reason });
      return { status: 'failed', op_id, version_id: v.version_id, reason };
    };

    let manifest;
    let srcAbs: string;
    try {
      manifest = await readTrashManifest(ws, v.trash.manifest_rel_path);
      if (manifest.version_id !== v.version_id || manifest.content_hash !== v.content_hash || manifest.trash_rel_path !== v.rel_path) {
        return failed('Manifest Trash tidak cocok dengan registry');
      }
      srcAbs = (await resolveInArea(ws.root, v.rel_path, ['trash'])).abs;
      if ((await hashFile(srcAbs)).hash !== v.content_hash) return failed('File di Trash rusak (hash tidak cocok)');
    } catch (e) {
      return failed(e instanceof StorageError ? `${e.code}: ${e.message}` : `File Trash hilang/tidak terbaca: ${String(e)}`);
    }

    // Destination: default original path; must be a media area; project folder must still exist.
    const wanted = await resolveInArea(ws.root, input.destination ?? manifest.original_rel_path, MEDIA_AREAS, { allowMissing: true });
    if (areaOf(wanted.rel) !== 'shared_media' && areaOf(wanted.rel) !== 'shared_assets') {
      const projDir = wanted.rel.split('/').slice(0, 2).join('/');
      try {
        await resolveInside(ws.root, projDir);
      } catch {
        return failed(`Proyek tujuan tidak ada lagi: ${projDir}`);
      }
    }
    let dest = wanted.rel;
    let alternate = false;
    if (await exists(wanted.abs)) {
      const suggested = await alternatePath(ws, wanted.rel);
      if (input.onConflict !== 'alternate') {
        await audit(ws, { op_id, op: 'trash.restore', actor: input.actor, outcome: 'blocked', reason: 'CONFLICT', version_id: v.version_id, wanted: wanted.rel, suggested });
        return { status: 'conflict', op_id, version_id: v.version_id, wanted: wanted.rel, suggested };
      }
      dest = suggested;
      alternate = true;
    }
    const destAbs = (await resolveCanonical(ws.root, dest, { allowMissing: true })).abs;
    const journal: JournalEntry = { schema_version: 1, op_id, kind: 'restore', version_id: v.version_id, from_rel: v.rel_path, to_rel: dest, manifest_rel: v.trash.manifest_rel_path, content_hash: v.content_hash, started_at: ws.clock.now() };
    await writeJournal(ws, journal);
    try {
      await moveNoOverwrite(srcAbs, destAbs, v.content_hash);
    } catch (e) {
      await clearJournal(ws, journal);
      if (e instanceof StorageError && e.code === 'CONFLICT') {
        const suggested = await alternatePath(ws, dest);
        return { status: 'conflict', op_id, version_id: v.version_id, wanted: dest, suggested };
      }
      return failed(String(e));
    }
    const manifestAbs = (await resolveInArea(ws.root, v.trash.manifest_rel_path, ['trash'])).abs;
    const now = ws.clock.now();
    const fromRel = v.rel_path;
    v.lifecycle = 'active';
    v.integrity = 'ok';
    v.rel_path = dest;
    v.trash = null;
    v.restored_at = now;
    v.last_verified_at = now;
    v.unreferenced_since = null; // eligibility cleared; re-evaluated only after a new full period
    await saveRegistry(ws, reg);
    await clearJournal(ws, journal);
    await fsp.rm(manifestAbs, { force: true });
    await fsp.rmdir(path.dirname(manifestAbs)).catch(() => undefined); // only if empty
    await fsp.rmdir(path.dirname(path.dirname(manifestAbs))).catch(() => undefined); // op folder, only if empty
    await audit(ws, { op_id, op: 'trash.restore', actor: input.actor, outcome: 'ok', media_id: v.media_id, version_id: v.version_id, from: fromRel, to: dest, alternate, checksum: v.content_hash });
    return { status: 'restored', op_id, version_id: v.version_id, rel_path: dest, alternate };
  });
}

