import { StorageError } from './errors.js';
import { type ResolveOptions, type Resolved, relativeSegments, resolveCanonical } from './paths.js';

/** Who is asking. Enforced in the storage service, never only in UI (PRD v0.8 §F, §H). */
export type Actor = 'user' | 'scheduler' | 'ai';

export type Operation =
  | 'read_status'
  | 'scan_dry_run'
  | 'import'
  | 'commit_project'
  | 'set_protection'
  | 'auto_trash'
  | 'restore'
  | 'purge'
  | 'cache_cleanup'
  | 'manage_lease'
  | 'render_preflight';

const MATRIX: Record<Operation, readonly Actor[]> = {
  read_status: ['user', 'scheduler', 'ai'],
  scan_dry_run: ['user', 'scheduler', 'ai'],
  import: ['user'],
  commit_project: ['user'],
  set_protection: ['user'],
  auto_trash: ['user', 'scheduler'],
  restore: ['user'],
  // Permanent delete is manual only: never AI, never scheduler (Option A).
  purge: ['user'],
  cache_cleanup: ['user', 'scheduler'],
  manage_lease: ['user', 'scheduler'],
  render_preflight: ['user', 'scheduler'],
};

export function isAllowed(actor: Actor, op: Operation): boolean {
  return Object.hasOwn(MATRIX, op) && MATRIX[op].includes(actor);
}

export function assertAllowed(actor: Actor, op: Operation): void {
  if (!isAllowed(actor, op)) {
    throw new StorageError('FORBIDDEN', `Aktor "${actor}" tidak boleh menjalankan "${op}"`, { actor, op });
  }
}

export type Area =
  | 'shared_media'
  | 'shared_assets'
  | 'project_input'
  | 'project_assets'
  | 'project_manifest'
  | 'project_cache'
  | 'project_output'
  | 'backup'
  | 'meta'
  | 'trash'
  | 'other';

const PROJECT_AREAS: Record<string, Area> = {
  '01_INPUT': 'project_input',
  '02_ASSETS': 'project_assets',
  '03_PROJECT': 'project_manifest',
  '04_CACHE': 'project_cache',
  '05_OUTPUT': 'project_output',
};

/** Classify a workspace-relative path into a storage area. */
export function areaOf(rel: string): Area {
  const [a, , c] = relativeSegments(rel);
  switch (a) {
    case 'SHARED_MEDIA':
      return 'shared_media';
    case 'SHARED_ASSETS':
      return 'shared_assets';
    case 'BACKUP_PROJECTS':
      return 'backup';
    case '.motionstudio':
      return 'meta';
    case '.trash':
      return 'trash';
    case 'PROJECTS':
      return (c !== undefined && PROJECT_AREAS[c]) || 'other';
    default:
      return 'other';
  }
}

/** Areas that hold original media (never treated as cache, GC-only via Trash). */
export const MEDIA_AREAS: readonly Area[] = ['shared_media', 'project_input', 'project_assets', 'shared_assets'];

export function assertArea(rel: string, allowed: readonly Area[]): Area {
  const area = areaOf(rel);
  if (!allowed.includes(area)) {
    throw new StorageError('FORBIDDEN', `Operasi tidak diizinkan di area "${area}"`, { rel, area, allowed });
  }
  return area;
}

/**
 * Resolve a path AND check its area on the canonical form (case variants / short names
 * cannot alias another area). This is the only area check callers should use for I/O.
 */
export async function resolveInArea(rootReal: string, rel: string, allowed: readonly Area[], opts: ResolveOptions = {}): Promise<Resolved & { area: Area }> {
  const r = await resolveCanonical(rootReal, rel, opts);
  return { ...r, area: assertArea(r.rel, allowed) };
}
