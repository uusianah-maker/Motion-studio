import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { type JournalEntry, listJournal } from './journal.js';
import { writeJsonAtomic } from './jsonStore.js';
import { resolveCanonical } from './paths.js';
import { loadRegistry, saveRegistry } from './registry.js';
import { moveVerified } from './trash.js';
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

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);

async function abs(ws: Workspace, rel: string): Promise<string | null> {
  try {
    return (await resolveCanonical(ws.root, rel, { allowMissing: true })).abs;
  } catch {
    return null; // invalid path in a journal → treated as "not there"
  }
}

/**
 * Resolve one unfinished move. Policy: always return to the state *before* the operation
 * (roll back). The next scan re-decides from fresh data, so a stale decision is never
 * completed after a crash. If the registry already reflects completion, just clear.
 */
async function resolveEntry(ws: Workspace, e: JournalEntry): Promise<string> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[e.version_id];
  const fromAbs = await abs(ws, e.from_rel);
  const toAbs = await abs(ws, e.to_rel);
  const atFrom = fromAbs ? await exists(fromAbs) : false;
  const atTo = toAbs ? await exists(toAbs) : false;

  // Completed: registry already points at the destination.
  if (v && v.rel_path === e.to_rel && atTo && !atFrom) return 'completed-before-crash';

  if (atFrom && !atTo) return 'not-started';
  if (atFrom && atTo && toAbs) {
    // Interrupted copy/link: the source is authoritative; drop the partial destination.
    await fsp.chmod(toAbs, 0o666).catch(() => undefined);
    await fsp.rm(toAbs, { force: true });
    return 'partial-destination-removed';
  }
  if (!atFrom && atTo && fromAbs && toAbs && v) {
    await moveVerified(toAbs, fromAbs, e.content_hash);
    await fsp.chmod(fromAbs, 0o444).catch(() => undefined);
    if (e.kind === 'trash') {
      const m = await abs(ws, e.manifest_rel);
      if (m) await fsp.rm(m, { force: true });
    }
    // Registry was never updated (or is rolled back to match the bytes).
    v.rel_path = e.from_rel;
    if (e.kind === 'trash') {
      v.lifecycle = 'active';
      v.trash = null;
    }
    await saveRegistry(ws, reg);
    return 'rolled-back';
  }
  if (v) {
    v.integrity = 'missing';
    await saveRegistry(ws, reg);
  }
  return 'bytes-missing';
}

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
      if (!j.entry || typeof j.entry.version_id !== 'string' || (j.entry.kind !== 'trash' && j.entry.kind !== 'restore')) {
        report.corrupt_journal.push(path.basename(j.file));
        continue;
      }
      try {
        const action = await resolveEntry(ws, j.entry);
        await fsp.rm(j.file, { force: true });
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
      await sweep(path.join(ws.root, area), async (p, name) => {
        const rel = path.relative(ws.root, p).split(path.sep).join('/');
        if (name.startsWith('.importing-')) {
          await fsp.rm(p, { force: true });
          report.removed_temp_files.push(rel);
        } else if (/^v_[0-9a-f]{16}/.test(name) && !known.has(rel.toLowerCase())) {
          report.orphan_files.push(rel);
        }
      });
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
