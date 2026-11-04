import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { type JournalEntry, listJournal } from './journal.js';
import { writeJsonAtomic } from './jsonStore.js';
import type { Area } from './permissions.js';
import { loadRegistry, saveRegistry } from './registry.js';
import { LAYOUT, META_FILES, type Workspace, listProjectIds, metaPath, withWorkspaceLock } from './workspace.js';

export interface RecoveryReport {
  journal: { file: string; version_id?: string; kind?: string; action: string }[];
  /** Journal files that could not be parsed: GC stays blocked until a human resolves them. */
  corrupt_journal: string[];
  removed_temp_files: string[];
  /** Media-looking files with no registry record. Reported only — never deleted (could be data). */
  orphan_files: string[];
  expired_purge_requests: number;
}

export const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/** Area each journal path must be in; a tampered journal can never point recovery elsewhere (review C-H2). */
const MEDIA = ['shared_media', 'shared_assets', 'project_input', 'project_assets'] as const;
const AREAS: Record<JournalEntry['kind'], { from: readonly Area[]; to: readonly Area[] }> = {
  trash: { from: MEDIA, to: ['trash'] },
  restore: { from: ['trash'], to: MEDIA },
  purge: { from: ['trash'], to: ['trash'] },
};

async function inArea(ws: Workspace, rel: string, allowed: readonly Area[]): Promise<string | null> {
  try {
    return await ws.blobs.resolve(rel, allowed, { allowMissing: true });
  } catch {
    return null;
  }
}

const hashIs = async (ws: Workspace, rel: string, h: string) => (await ws.blobs.hash(rel).catch(() => null))?.hash === h;

/** Remove our own Trash manifest and its now-empty folders. */
async function dropManifest(ws: Workspace, manifestRel: string): Promise<void> {
  const m = await inArea(ws, manifestRel, ['trash']);
  if (!m) return;
  await ws.blobs.remove(m, { missingOk: true });
  await ws.blobs.pruneEmptyParents(m, 2);
}

/**
 * Resolve one unfinished operation. Rules (Checkpoint C):
 * - Never delete or move a file unless it is *proven* to be this operation's bytes
 *   (same inode as the source, or identical hash while the source is intact).
 * - Registry already at the destination = completed: only tidy our own leftovers.
 * - Otherwise roll back to the pre-operation state; anything unprovable is left untouched
 *   and reported for a human (journal is kept when paths are invalid).
 */
async function resolveEntry(ws: Workspace, e: JournalEntry): Promise<{ action: string; keepJournal?: boolean }> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[e.version_id];
  const areas = AREAS[e.kind];
  const from = await inArea(ws, e.from_rel, areas.from);
  const to = e.kind === 'purge' ? from : await inArea(ws, e.to_rel, areas.to);
  if (!from || !to || !v) return { action: 'invalid-journal-left-for-review', keepJournal: true };
  const atFrom = await ws.blobs.exists(from);
  const atTo = await ws.blobs.exists(to);

  if (e.kind === 'purge') {
    if (atFrom) return { action: 'purge-not-started' };
    // File is gone: the user-approved purge happened but the registry was not saved.
    const m = await inArea(ws, e.manifest_rel, ['trash']);
    if (m) await ws.blobs.remove(m, { missingOk: true });
    reg.versions[v.version_id] = { ...v, lifecycle: 'purged', trash: null, unreferenced_since: null };
    await saveRegistry(ws, reg);
    await audit(ws, { op: 'purge.item', actor: 'system', outcome: 'ok', phase: 'recovered', version_id: v.version_id, deleted_path: e.from_rel });
    return { action: 'purge-completed-recorded' };
  }

  // Completed before the crash: registry already points at the destination.
  if (v.rel_path === e.to_rel) {
    if (e.kind === 'restore') await dropManifest(ws, e.manifest_rel);
    if (atFrom && atTo && (await ws.blobs.sameObject(from, to))) {
      await ws.blobs.remove(from); // leftover hard link of the same bytes
      await ws.blobs.setReadOnly(to).catch(() => undefined);
    }
    return { action: 'completed-before-crash' };
  }

  if (atFrom && !atTo) return { action: 'not-started' };

  if (atFrom && atTo) {
    if (await ws.blobs.sameObject(from, to)) {
      await ws.blobs.remove(to); // same bytes via hard link: removing the extra name loses nothing
      await ws.blobs.setReadOnly(from).catch(() => undefined); // shared inode: restore read-only
      return { action: 'extra-link-removed' };
    }
    if (e.kind === 'trash' && (await hashIs(ws, from, e.content_hash)) && (await hashIs(ws, to, e.content_hash))) {
      await ws.blobs.remove(to); // complete duplicate inside our own Trash folder; source intact
      return { action: 'duplicate-copy-removed' };
    }
    // Could be a partial copy or a user's file: never guess, never delete.
    await audit(ws, { op: 'recovery.item', actor: 'system', outcome: 'alert', version_id: v.version_id, reason: 'DESTINATION_UNPROVEN', left_untouched: e.to_rel });
    return { action: 'destination-left-untouched' };
  }

  if (!atFrom && atTo) {
    if (!(await hashIs(ws, to, e.content_hash))) {
      v.integrity = 'missing';
      await saveRegistry(ws, reg);
      await audit(ws, { op: 'recovery.item', actor: 'system', outcome: 'alert', version_id: v.version_id, reason: 'BYTES_UNPROVEN', left_untouched: e.to_rel });
      return { action: 'bytes-unproven-left-untouched' };
    }
    await ws.blobs.move(to, from, e.content_hash);
    await ws.blobs.setReadOnly(from).catch(() => undefined);
    if (e.kind === 'trash') {
      const m = await inArea(ws, e.manifest_rel, ['trash']);
      if (m) await ws.blobs.remove(m, { missingOk: true });
      v.lifecycle = 'active';
      v.trash = null;
    }
    v.rel_path = e.from_rel;
    await saveRegistry(ws, reg);
    return { action: 'rolled-back' };
  }

  v.integrity = 'missing';
  await saveRegistry(ws, reg);
  return { action: 'bytes-missing' };
}

/** Local metadata sweep (temp files of atomic JSON writes). */
async function sweep(dir: string, onFile: (p: string, name: string) => Promise<void>, depth = 0): Promise<void> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await sweep(p, onFile, depth + 1);
    else if (e.isFile()) await onFile(p, e.name);
  }
}

/** Startup recovery (ST-09). Safe to run repeatedly (idempotent). */
export async function recoverOnStartup(ws: Workspace): Promise<RecoveryReport> {
  return withWorkspaceLock(ws, 'recovery', async () => {
    const report: RecoveryReport = { journal: [], corrupt_journal: [], removed_temp_files: [], orphan_files: [], expired_purge_requests: 0 };

    for (const j of await listJournal(ws)) {
      if (!j.entry || typeof j.entry.version_id !== 'string' || !['trash', 'restore', 'purge'].includes(j.entry.kind)) {
        report.corrupt_journal.push(path.basename(j.file));
        continue;
      }
      try {
        const { action, keepJournal } = await resolveEntry(ws, j.entry);
        if (keepJournal) report.corrupt_journal.push(path.basename(j.file));
        else await fsp.rm(j.file, { force: true });
        report.journal.push({ file: path.basename(j.file), version_id: j.entry.version_id, kind: j.entry.kind, action });
      } catch (err) {
        report.journal.push({ file: path.basename(j.file), version_id: j.entry.version_id, kind: j.entry.kind, action: `failed: ${String(err)}` });
      }
    }

    // Temp files from interrupted imports/atomic writes, plus orphan media files.
    const reg = await loadRegistry(ws);
    const known = new Set(Object.values(reg.versions).map((v) => v.rel_path.toLowerCase()));
    const areas = [LAYOUT.sharedMedia, ...(await listProjectIds(ws)).map((p) => `${LAYOUT.projects}/${p}/01_INPUT`)];
    for (const area of areas) {
      for (const f of await ws.blobs.listFiles(area, 4)) {
        if (f.name.startsWith('.importing-')) {
          // Imports stage outside the lock: only sweep temps untouched for a day (review C-L2).
          if (Date.now() - f.mtimeMs < STALE_TEMP_MS) continue;
          await ws.blobs.remove(f.rel, { missingOk: true });
          report.removed_temp_files.push(f.rel);
        } else if (/^v_[0-9a-f]{16}/.test(f.name) && !known.has(f.rel.toLowerCase())) {
          report.orphan_files.push(f.rel);
        }
      }
    }
    await sweep(path.join(ws.root, LAYOUT.meta), async (p, name) => {
      if (/\.tmp$/.test(name)) {
        await fsp.rm(p, { force: true });
        report.removed_temp_files.push(path.relative(ws.root, p).split(path.sep).join('/'));
      }
    });

    // Expired purge requests can never be executed; drop them.
    try {
      const file = metaPath(ws, META_FILES.purgeRequests);
      const f = JSON.parse(await fsp.readFile(file, 'utf8')) as { schema_version: 1; requests: { expires_at: number; used: boolean }[] };
      const keep = f.requests.filter((r) => !r.used && r.expires_at > ws.clock.now());
      report.expired_purge_requests = f.requests.length - keep.length;
      if (report.expired_purge_requests) await writeJsonAtomic(file, { ...f, requests: keep });
    } catch {
      // Invalid purge file is reported by preparePurge itself (fail closed there).
    }

    const notable = report.journal.length + report.corrupt_journal.length + report.removed_temp_files.length + report.orphan_files.length;
    await audit(ws, { op: 'recovery.startup', actor: 'system', outcome: report.corrupt_journal.length || report.orphan_files.length ? 'alert' : 'info', ...report, notable });
    return report;
  });
}
