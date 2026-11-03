import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { buildIndex } from './deps.js';
import { evaluateVersion, reconcileClocks } from './eligibility.js';
import { StorageError } from './errors.js';
import { newId } from './ids.js';
import { readJson, withFsRetry, writeJsonAtomic } from './jsonStore.js';
import { resolveCanonical } from './paths.js';
import { type Actor, MEDIA_AREAS, assertAllowed, isAllowed, resolveInArea } from './permissions.js';
import { type Registry, type VersionRecord, hashFile, loadRegistry, saveRegistry } from './registry.js';
import { LAYOUT, META_FILES, type Workspace, withWorkspaceLock } from './workspace.js';

// ------------------------------------------------------------------ journal (crash safety, ST-09)

export interface JournalEntry {
  schema_version: 1;
  op_id: string;
  kind: 'trash' | 'restore';
  version_id: string;
  from_rel: string;
  to_rel: string;
  manifest_rel: string;
  content_hash: string;
  started_at: number;
}

const journalRel = (op_id: string, version_id: string) => `${LAYOUT.meta}/${META_FILES.journal}/${op_id}--${version_id}.json`;

export async function writeJournal(ws: Workspace, e: JournalEntry): Promise<void> {
  await writeJsonAtomic((await resolveCanonical(ws.root, journalRel(e.op_id, e.version_id), { allowMissing: true })).abs, e);
}
export async function clearJournal(ws: Workspace, e: Pick<JournalEntry, 'op_id' | 'version_id'>): Promise<void> {
  await fsp.rm(path.join(ws.root, LAYOUT.meta, META_FILES.journal, `${e.op_id}--${e.version_id}.json`), { force: true });
}
export async function listJournal(ws: Workspace): Promise<{ file: string; entry: JournalEntry | null }[]> {
  const dir = path.join(ws.root, LAYOUT.meta, META_FILES.journal);
  const out: { file: string; entry: JournalEntry | null }[] = [];
  for (const name of (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    const entry = await readJson(file, (x) => x as JournalEntry).catch(() => null);
    out.push({ file, entry });
  }
  return out;
}
/** Versions with an unfinished move are busy for every other operation. */
export async function journalBusy(ws: Workspace): Promise<Set<string>> {
  return new Set((await listJournal(ws)).map((j) => j.entry?.version_id).filter((x): x is string => !!x));
}

// ------------------------------------------------------------------ manifest

export interface TrashManifest {
  schema_version: 1;
  op_id: string;
  media_id: string;
  version_id: string;
  content_hash: string;
  size: number;
  original_rel_path: string;
  trash_rel_path: string;
  trashed_at: number;
  trashed_by: Actor;
  unreferenced_since: number | null;
  eligible_since: number | null;
  dependencies_checked: { index_fingerprint: string; holders: number; checked_at: number };
}

export function validateTrashManifest(x: unknown): TrashManifest {
  const m = x as Partial<TrashManifest> | null;
  if (!m || m.schema_version !== 1 || typeof m.version_id !== 'string' || typeof m.content_hash !== 'string' || typeof m.original_rel_path !== 'string' || typeof m.trash_rel_path !== 'string') {
    throw new StorageError('INTEGRITY', 'Manifest Trash tidak valid');
  }
  return m as TrashManifest;
}

// ------------------------------------------------------------------ move helpers

/** Rename; on cross-device fall back to copy → verify hash → remove original. Returns true if renamed. */
export async function moveVerified(fromAbs: string, toAbs: string, expectedHash: string): Promise<boolean> {
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await withFsRetry(() => fsp.rename(fromAbs, toAbs));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  await fsp.copyFile(fromAbs, toAbs, fsc.COPYFILE_EXCL);
  if ((await hashFile(toAbs)).hash !== expectedHash) {
    await fsp.chmod(toAbs, 0o666).catch(() => undefined);
    await fsp.rm(toAbs, { force: true });
    throw new StorageError('INTEGRITY', 'Salinan lintas-drive tidak cocok hash; original dibiarkan');
  }
  await fsp.chmod(fromAbs, 0o666);
  await fsp.rm(fromAbs);
  return false;
}

/** Fresh on-disk checks right before a destructive step (TOCTOU guard, Checkpoint A M5). */
export async function revalidateFile(ws: Workspace, v: VersionRecord, allowed = MEDIA_AREAS): Promise<{ abs: string; rel: string }> {
  const { abs, rel } = await resolveInArea(ws.root, v.rel_path, allowed);
  const st = await fsp.lstat(abs);
  if (!st.isFile()) throw new StorageError('INTEGRITY', 'Bukan file biasa', { rel });
  if (st.nlink > 1) throw new StorageError('PRECONDITION', 'File punya hard link lain; tidak dioperasikan', { rel, nlink: st.nlink });
  const { hash } = await hashFile(abs);
  if (hash !== v.content_hash) throw new StorageError('INTEGRITY', 'Hash file berubah', { rel });
  return { abs, rel };
}

// ------------------------------------------------------------------ Auto Trash

export interface AutoTrashResult {
  op_id: string;
  ok: boolean;
  errors: string[];
  moved: { version_id: string; from: string; to: string; manifest: string; renamed: boolean }[];
  skipped: { version_id: string; reason: string }[];
  /** Space reported as reclaimed: always 0 — a Trash move is never claimed to free disk (GC-10, PRD §E). */
  freed_bytes: number;
  moved_bytes: number;
}

/**
 * Move every GC-eligible version to the reversible Trash (PRD v0.8 §D gate 8, §E).
 * Runs entirely under the workspace lock with a fresh index; every candidate is
 * re-evaluated and re-hashed right before its move. Never deletes anything.
 */
export async function runAutoTrash(ws: Workspace, opts: { actor: Actor; busy?: ReadonlySet<string> }): Promise<AutoTrashResult> {
  const op_id = newId('op');
  if (!isAllowed(opts.actor, 'auto_trash')) {
    await audit(ws, { op_id, op: 'gc.auto_trash', actor: opts.actor, outcome: 'blocked', reason: 'FORBIDDEN' });
  }
  assertAllowed(opts.actor, 'auto_trash');
  return withWorkspaceLock(ws, 'autoTrash', async () => {
    const res: AutoTrashResult = { op_id, ok: true, errors: [], moved: [], skipped: [], freed_bytes: 0, moved_bytes: 0 };
    const idx = await buildIndex(ws);
    if (!idx.ok) {
      await audit(ws, { op_id, op: 'gc.auto_trash', actor: opts.actor, outcome: 'blocked', reason: 'INDEX_INVALID', errors: idx.errors });
      return { ...res, ok: false, errors: idx.errors };
    }
    let reg: Registry;
    try {
      reg = await loadRegistry(ws);
    } catch (e) {
      await audit(ws, { op_id, op: 'gc.auto_trash', actor: opts.actor, outcome: 'blocked', reason: 'REGISTRY_INVALID' });
      return { ...res, ok: false, errors: [String(e)] };
    }
    const now = ws.clock.now();
    if (reconcileClocks(reg, idx.index, now).length) await saveRegistry(ws, reg);
    const busy = new Set([...(opts.busy ?? []), ...(await journalBusy(ws))]);

    for (const v of Object.values(reg.versions).sort((a, b) => a.version_id.localeCompare(b.version_id))) {
      const e = evaluateVersion(v, reg.media[v.media_id]!, { now, index: idx.index, busy });
      if (!e.eligible) continue;
      let src: { abs: string; rel: string };
      try {
        src = await revalidateFile(ws, v);
      } catch (err) {
        const reason = err instanceof StorageError ? `${err.code}: ${err.message}` : String(err);
        res.skipped.push({ version_id: v.version_id, reason });
        await audit(ws, { op_id, op: 'gc.auto_trash.item', actor: opts.actor, outcome: 'blocked', version_id: v.version_id, reason });
        continue;
      }
      const base = `${LAYOUT.trash}/${op_id}/${v.version_id}`;
      const to = await resolveCanonical(ws.root, `${base}/${path.basename(src.rel)}`, { allowMissing: true });
      const manifestRel = `${base}/manifest.json`;
      const journal: JournalEntry = { schema_version: 1, op_id, kind: 'trash', version_id: v.version_id, from_rel: src.rel, to_rel: to.rel, manifest_rel: manifestRel, content_hash: v.content_hash, started_at: now };
      try {
        await writeJournal(ws, journal);
        const renamed = await moveVerified(src.abs, to.abs, v.content_hash);
        const manifest: TrashManifest = {
          schema_version: 1,
          op_id,
          media_id: v.media_id,
          version_id: v.version_id,
          content_hash: v.content_hash,
          size: v.size,
          original_rel_path: src.rel,
          trash_rel_path: to.rel,
          trashed_at: now,
          trashed_by: opts.actor,
          unreferenced_since: v.unreferenced_since,
          eligible_since: e.eligible_at,
          dependencies_checked: { index_fingerprint: idx.index.fingerprint, holders: e.holders.length, checked_at: now },
        };
        await writeJsonAtomic((await resolveCanonical(ws.root, manifestRel, { allowMissing: true })).abs, manifest);
        v.lifecycle = 'trashed';
        v.rel_path = to.rel;
        v.trash = { op_id, trashed_at: now, original_rel_path: src.rel, manifest_rel_path: manifestRel };
        v.unreferenced_since = null;
        await saveRegistry(ws, reg);
        await clearJournal(ws, journal);
        res.moved.push({ version_id: v.version_id, from: src.rel, to: to.rel, manifest: manifestRel, renamed });
        res.moved_bytes += v.size;
        await audit(ws, {
          op_id,
          op: 'gc.auto_trash.item',
          actor: opts.actor,
          outcome: 'ok',
          media_id: v.media_id,
          version_id: v.version_id,
          old_path: src.rel,
          new_path: to.rel,
          checksum: v.content_hash,
          unreferenced_since: manifest.unreferenced_since,
          eligible_since: manifest.eligible_since,
          dependencies_checked: manifest.dependencies_checked,
        });
      } catch (err) {
        // Journal stays in place when the move may be half-done; recovery (ST-09) resolves it.
        res.ok = false;
        res.errors.push(`${v.version_id}: ${String(err)}`);
        await audit(ws, { op_id, op: 'gc.auto_trash.item', actor: opts.actor, outcome: 'failed', version_id: v.version_id, error: String(err) });
      }
    }
    await audit(ws, {
      op_id,
      op: 'gc.auto_trash',
      actor: opts.actor,
      outcome: res.ok ? 'ok' : 'failed',
      moved: res.moved.length,
      skipped: res.skipped.length,
      moved_bytes: res.moved_bytes,
      freed_bytes: res.freed_bytes,
      note: 'Trash di volume yang sama tidak membebaskan ruang disk',
    });
    return res;
  });
}

export async function readTrashManifest(ws: Workspace, manifestRel: string): Promise<TrashManifest> {
  const { abs } = await resolveInArea(ws.root, manifestRel, ['trash']);
  return readJson(abs, validateTrashManifest, 'INDEX_INVALID');
}
