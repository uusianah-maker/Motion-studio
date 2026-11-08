import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type AuditEntry, audit, readAudit } from './audit.js';
import { backupStatusOf } from './backup.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { isSafeId } from './ids.js';
import { listJournal } from './journal.js';
import { type Actor, resolveInArea } from './permissions.js';
import { loadRegistry } from './registry.js';
import { type ScanReport, gcStatusView } from './scanner.js';
import { LAYOUT, type Policy, type Workspace, listProjectIds, readPolicy, withWorkspaceLock } from './workspace.js';

export interface AreaUsage {
  shared_media: number;
  shared_assets: number;
  project_input: number;
  project_assets: number;
  project_cache: number;
  project_output: number;
  trash: number;
  backup_projects: number;
}

export type StorageWarning =
  | { code: 'LOW_FREE_SPACE'; free_bytes: number; reserve_bytes: number; advice: string }
  | { code: 'MEDIA_SOFT_QUOTA'; media_bytes: number; soft_bytes: number; advice: string }
  | { code: 'CACHE_OVER_LIMIT'; cache_bytes: number; max_bytes: number; advice: string }
  | { code: 'TRASH_REVIEW_SUGGESTED'; trash_bytes: number; advice: string }
  | { code: 'AREA_UNREADABLE'; path: string; reason: string; advice: string };

export interface StorageStats {
  at: number;
  usage: AreaUsage;
  media_bytes: number;
  disk: { free_bytes: number; total_bytes: number } | null;
  policy: Policy['quota'];
  warnings: StorageWarning[];
}

async function dirSize(dir: string, depth = 0): Promise<number> {
  if (depth > 16) return 0;
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += await dirSize(p, depth + 1);
    else if (e.isFile()) total += (await fsp.stat(p)).size;
  }
  return total;
}

export async function diskSpace(dir: string): Promise<{ free_bytes: number; total_bytes: number } | null> {
  try {
    const s = await fsp.statfs(dir);
    return { free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/**
 * Usage per area + warnings (PRD v0.8 §G). Warnings only *recommend a manual review*;
 * nothing here ever trashes or purges (design check: disk full never triggers purge).
 */
export async function getStorageStats(ws: Workspace, opts: { disk?: { free_bytes: number; total_bytes: number } | null } = {}): Promise<StorageStats> {
  const policy = (await readPolicy(ws)).quota;
  const warnings: StorageWarning[] = [];
  // One odd folder or a linked area must not break the whole dashboard (Checkpoint D F2): count it
  // as 0 and say so, instead of throwing.
  const blobUsage = async (rel: string): Promise<number> => {
    try {
      return await ws.blobs.usage(rel);
    } catch (e) {
      warnings.push({ code: 'AREA_UNREADABLE', path: rel, reason: String((e as { code?: string }).code ?? e), advice: 'Folder ini tidak bisa diperiksa dengan aman (link/nama tidak valid). Periksa manual.' });
      return 0;
    }
  };
  const usage: AreaUsage = {
    // Blob areas (media, Trash, output) through the backend; backups + cache are local metadata.
    shared_media: await blobUsage(LAYOUT.sharedMedia),
    shared_assets: await blobUsage(LAYOUT.sharedAssets),
    project_input: 0,
    project_assets: 0,
    project_cache: 0,
    project_output: 0,
    trash: await blobUsage(LAYOUT.trash),
    backup_projects: await dirSize(path.join(ws.root, LAYOUT.backups)),
  };
  for (const p of await listProjectIds(ws)) {
    const base = `${LAYOUT.projects}/${p}`;
    if (!isSafeId(p)) {
      warnings.push({ code: 'AREA_UNREADABLE', path: base, reason: 'PATH_INVALID', advice: 'Nama folder proyek tidak valid; tidak dihitung. Periksa manual.' });
      continue;
    }
    usage.project_input += await blobUsage(`${base}/01_INPUT`);
    usage.project_assets += await blobUsage(`${base}/02_ASSETS`);
    usage.project_cache += await dirSize(path.join(ws.root, LAYOUT.projects, p, '04_CACHE'));
    usage.project_output += await blobUsage(`${base}/05_OUTPUT`);
  }
  const media_bytes = usage.shared_media + usage.shared_assets + usage.project_input + usage.project_assets;
  const disk = opts.disk !== undefined ? opts.disk : await diskSpace(ws.root);
  if (disk && disk.free_bytes < policy.free_space_reserve_bytes) {
    warnings.push({ code: 'LOW_FREE_SPACE', free_bytes: disk.free_bytes, reserve_bytes: policy.free_space_reserve_bytes, advice: 'Ruang disk menipis. Tinjau cache, output lama, atau Trash secara manual.' });
    if (usage.trash > 0) {
      warnings.push({ code: 'TRASH_REVIEW_SUGGESTED', trash_bytes: usage.trash, advice: 'Trash berisi file. Hapus permanen hanya lewat dialog manual dengan konfirmasi.' });
    }
  }
  if (policy.media_soft_bytes !== null && media_bytes > policy.media_soft_bytes) {
    warnings.push({ code: 'MEDIA_SOFT_QUOTA', media_bytes, soft_bytes: policy.media_soft_bytes, advice: 'Media melewati soft quota. Pertimbangkan arsip/backup manual.' });
  }
  if (usage.project_cache > policy.cache_max_bytes) {
    warnings.push({ code: 'CACHE_OVER_LIMIT', cache_bytes: usage.project_cache, max_bytes: policy.cache_max_bytes, advice: 'Cache melewati batas; bisa dibersihkan otomatis (file regenerable saja).' });
  }
  return { at: ws.clock.now(), usage, media_bytes, disk, policy, warnings };
}

/** Preflight space estimate for an import/render temp requirement. */
export async function estimateSpace(ws: Workspace, input: { bytes_needed: number; disk?: { free_bytes: number; total_bytes: number } | null }): Promise<{ ok: boolean; free_bytes: number | null; reserve_bytes: number; free_after: number | null; reason?: string }> {
  const policy = (await readPolicy(ws)).quota;
  const disk = input.disk !== undefined ? input.disk : await diskSpace(ws.root);
  if (!disk) return { ok: false, free_bytes: null, reserve_bytes: policy.free_space_reserve_bytes, free_after: null, reason: 'Ruang kosong tidak bisa dibaca (fail closed)' };
  const free_after = disk.free_bytes - input.bytes_needed;
  const ok = free_after >= policy.free_space_reserve_bytes;
  return { ok, free_bytes: disk.free_bytes, reserve_bytes: policy.free_space_reserve_bytes, free_after, ...(ok ? {} : { reason: 'Ruang tidak cukup setelah menyisakan cadangan' }) };
}

/**
 * Automated cache cleanup (PRD v0.8 §G): only regenerable files in `PROJECTS/<id>/04_CACHE`,
 * oldest first, skipping anything an active job uses. Original media are never cache.
 */
export async function cleanupCache(ws: Workspace, input: { actor: Actor; target_bytes?: number; in_use?: ReadonlySet<string> }): Promise<{ removed: string[]; freed_bytes: number; cache_bytes_after: number }> {
  await guard(ws, input.actor, 'cache_cleanup');
  return withWorkspaceLock(ws, 'cleanupCache', async () => {
    const limit = input.target_bytes ?? (await readPolicy(ws)).quota.cache_max_bytes;
    const files: { rel: string; abs: string; size: number; mtime: number }[] = [];
    for (const p of (await listProjectIds(ws)).filter(isSafeId)) {
      const walk = async (dirRel: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        const dir = path.join(ws.root, dirRel);
        for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const rel = `${dirRel}/${e.name}`;
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) await walk(rel, depth + 1);
          else if (e.isFile()) {
            const { abs } = await resolveInArea(ws.root, rel, ['project_cache']);
            const st = await fsp.stat(abs);
            files.push({ rel, abs, size: st.size, mtime: st.mtimeMs });
          }
        }
      };
      await walk(`${LAYOUT.projects}/${p}/04_CACHE`, 0);
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    const removed: string[] = [];
    let freed = 0;
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limit) break;
      if (input.in_use?.has(f.rel)) continue;
      await fsp.rm(f.abs, { force: true });
      total -= f.size;
      freed += f.size;
      removed.push(f.rel);
    }
    await audit(ws, { op: 'cache.cleanup', actor: input.actor, outcome: 'ok', removed: removed.length, freed_bytes: freed, limit });
    return { removed, freed_bytes: freed, cache_bytes_after: total };
  });
}

export interface Dashboard {
  stats: StorageStats;
  gc: Pick<ScanReport, 'ok' | 'errors' | 'summary'> & { candidates: number; next_eligible: { version_id: string; eligible_at: number }[] };
  trash: { version_id: string; media_id: string; filename: string; size: number; trashed_at: number; original_rel_path: string; backup: string }[];
  pending_operations: number;
  corrupt_journal: number;
  backup: { verified: number; active_versions: number };
  recent_audit: AuditEntry[];
}

/** Read-only storage dashboard data: writes nothing, hashes nothing (Checkpoint D F6). */
export async function getDashboard(ws: Workspace, opts: { disk?: { free_bytes: number; total_bytes: number } | null; audit_limit?: number } = {}): Promise<Dashboard> {
  const stats = await getStorageStats(ws, opts.disk !== undefined ? { disk: opts.disk } : {});
  const scan = await gcStatusView(ws);
  const reg = await loadRegistry(ws).catch(() => null);
  if (!reg) throw new StorageError('INDEX_INVALID', 'Registry tidak bisa dibaca');
  const trash = [];
  let verified = 0;
  let active = 0;
  for (const v of Object.values(reg.versions)) {
    const b = await backupStatusOf(ws, v.version_id).catch(() => ({ status: 'unverified' as const }));
    if (v.lifecycle === 'active') {
      active++;
      if (b.status === 'verified') verified++;
    }
    if (v.lifecycle === 'trashed' && v.trash) {
      trash.push({ version_id: v.version_id, media_id: v.media_id, filename: v.original_name, size: v.size, trashed_at: v.trash.trashed_at, original_rel_path: v.trash.original_rel_path, backup: b.status });
    }
  }
  const journal = await listJournal(ws);
  const next_eligible = scan.evaluations
    .filter((e) => e.state === 'UNREFERENCED_WAIT_30D' && e.eligible_at !== null)
    .map((e) => ({ version_id: e.version_id, eligible_at: e.eligible_at! }))
    .sort((a, b) => a.eligible_at - b.eligible_at)
    .slice(0, 10);
  const all = await readAudit(ws);
  return {
    stats,
    gc: { ok: scan.ok, errors: scan.errors, summary: scan.summary, candidates: scan.candidates, next_eligible },
    trash: trash.sort((a, b) => b.trashed_at - a.trashed_at),
    pending_operations: journal.filter((j) => j.entry).length,
    corrupt_journal: journal.filter((j) => !j.entry).length,
    backup: { verified, active_versions: active },
    recent_audit: all.slice(-(opts.audit_limit ?? 20)),
  };
}
