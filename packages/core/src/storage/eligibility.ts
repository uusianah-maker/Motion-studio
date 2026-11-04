import { audit } from './audit.js';
import { DAY_MS } from './clock.js';
import { type DependencyIndex, type Holder, buildIndex, holdersOf } from './deps.js';
import { MEDIA_AREAS, areaOf } from './permissions.js';
import { type MediaRecord, type Registry, type VersionRecord, loadRegistry, saveRegistry } from './registry.js';
import { type Workspace, withWorkspaceLock } from './workspace.js';

/** Locked by PRD v0.8 §A: 30 continuous days of unreferenced eligibility. Not configurable. */
export const AUTO_TRASH_AFTER_MS = 30 * DAY_MS;

export type GcState =
  | 'AVAILABLE_NEW_PROTECTED'
  | 'REFERENCED'
  | 'PROTECTED'
  | 'UNREFERENCED_WAIT_30D'
  | 'GC_ELIGIBLE'
  | 'TRASHED'
  | 'PURGED_MANUALLY'
  | 'MISSING'
  | 'CHANGED'
  | 'FAILED_AUDIT';

/** Gate failures (PRD v0.8 §D). Every gate is evaluated so reports explain *all* reasons. */
export type Reason =
  | 'NEVER_USED' // gate 1 / 7
  | 'CURRENT' // gate 2
  | 'KEEP' // gate 2
  | 'PIN' // gate 2
  | 'LEGAL_HOLD' // gate 2
  | 'REFERENCED' // gate 3
  | 'NO_CLOCK' // gate 4
  | 'WAITING_30D' // gate 4
  | 'NOT_ACTIVE' // gate 5
  | 'MISSING' // gate 5
  | 'CHANGED' // gate 5
  | 'BUSY' // gate 5: import/relink/move/export in progress
  | 'INDEX_INVALID' // gate 6
  | 'PATH_NOT_MEDIA_AREA'; // gate 9

export interface Evaluation {
  version_id: string;
  media_id: string;
  state: GcState;
  eligible: boolean;
  reasons: Reason[];
  holders: Holder[];
  unreferenced_since: number | null;
  /** When the 30-day gate opens (null if the clock is not running). */
  eligible_at: number | null;
  restored: boolean;
}

export interface EvalContext {
  now: number;
  /** Null = dependency index invalid/unavailable → everything fails closed. */
  index: DependencyIndex | null;
  busy?: ReadonlySet<string>;
}

/** Pure evaluation of one version against all Smart GC gates. */
export function evaluateVersion(v: VersionRecord, media: MediaRecord, ctx: EvalContext): Evaluation {
  const holders = ctx.index ? holdersOf(ctx.index, v.version_id) : [];
  const reasons: Reason[] = [];
  if (!v.ever_referenced) reasons.push('NEVER_USED');
  if (media.current_version_id === v.version_id) reasons.push('CURRENT');
  if (v.keep) reasons.push('KEEP');
  if (v.pin) reasons.push('PIN');
  if (v.legal_hold) reasons.push('LEGAL_HOLD');
  if (!ctx.index) reasons.push('INDEX_INVALID');
  else if (holders.length > 0) reasons.push('REFERENCED');
  const since = v.unreferenced_since;
  const eligibleAt = since === null ? null : since + AUTO_TRASH_AFTER_MS;
  if (eligibleAt === null) reasons.push('NO_CLOCK');
  else if (ctx.now < eligibleAt) reasons.push('WAITING_30D');
  if (v.lifecycle !== 'active') reasons.push('NOT_ACTIVE');
  if (v.integrity === 'missing') reasons.push('MISSING');
  if (v.integrity === 'changed') reasons.push('CHANGED');
  if (ctx.busy?.has(v.version_id)) reasons.push('BUSY');
  let inMediaArea = false;
  try {
    inMediaArea = MEDIA_AREAS.includes(areaOf(v.rel_path));
  } catch {
    inMediaArea = false;
  }
  if (v.lifecycle === 'active' && !inMediaArea) reasons.push('PATH_NOT_MEDIA_AREA');

  let state: GcState;
  if (v.lifecycle === 'purged') state = 'PURGED_MANUALLY';
  else if (v.lifecycle === 'trashed') state = 'TRASHED';
  else if (v.integrity === 'missing') state = 'MISSING';
  else if (v.integrity === 'changed') state = 'CHANGED';
  else if (!ctx.index || reasons.includes('PATH_NOT_MEDIA_AREA')) state = 'FAILED_AUDIT';
  else if (holders.length > 0) state = 'REFERENCED';
  else if (!v.ever_referenced) state = 'AVAILABLE_NEW_PROTECTED';
  else if (reasons.some((r) => r === 'CURRENT' || r === 'KEEP' || r === 'PIN' || r === 'LEGAL_HOLD')) state = 'PROTECTED';
  else if (reasons.length > 0) state = 'UNREFERENCED_WAIT_30D';
  else state = 'GC_ELIGIBLE';

  return {
    version_id: v.version_id,
    media_id: v.media_id,
    state,
    eligible: reasons.length === 0 && state === 'GC_ELIGIBLE',
    reasons,
    holders,
    unreferenced_since: since,
    eligible_at: eligibleAt,
    restored: v.restored_at !== null,
  };
}

export function evaluateAll(reg: Registry, ctx: EvalContext): Evaluation[] {
  return Object.values(reg.versions)
    .map((v) => evaluateVersion(v, reg.media[v.media_id]!, ctx))
    .sort((a, b) => a.version_id.localeCompare(b.version_id));
}

export interface ClockChange {
  version_id: string;
  field: 'unreferenced_since' | 'ever_referenced';
  from: unknown;
  to: unknown;
}

/**
 * Maintain the 30-day clock (PRD v0.8 §B): any reference or protection resets it;
 * a previously referenced version starts it when it loses all of them.
 * Never-used versions never start a clock (GC-01). Mutates `reg`.
 */
export function reconcileClocks(reg: Registry, index: DependencyIndex, now: number): ClockChange[] {
  const changes: ClockChange[] = [];
  for (const v of Object.values(reg.versions)) {
    if (v.lifecycle !== 'active') continue;
    const holders = holdersOf(index, v.version_id);
    if (!v.ever_referenced && holders.some((h) => h.kind === 'project')) {
      changes.push({ version_id: v.version_id, field: 'ever_referenced', from: false, to: true });
      v.ever_referenced = true;
    }
    const media = reg.media[v.media_id]!;
    const held = holders.length > 0 || media.current_version_id === v.version_id || v.keep || v.pin || v.legal_hold;
    const next = held ? null : v.ever_referenced ? (v.unreferenced_since ?? now) : null;
    if (next !== v.unreferenced_since) {
      changes.push({ version_id: v.version_id, field: 'unreferenced_since', from: v.unreferenced_since, to: next });
      v.unreferenced_since = next;
    }
  }
  return changes;
}

export type SyncResult = { ok: true; changes: ClockChange[]; index: DependencyIndex } | { ok: false; errors: string[] };

/**
 * Rebuild the index and reconcile clocks under the workspace lock. If the index is invalid,
 * no clock is touched (fail closed) and the attempt is audited.
 */
export async function syncClocks(ws: Workspace, actor: 'user' | 'scheduler' | 'system' = 'system'): Promise<SyncResult> {
  return withWorkspaceLock(ws, 'syncClocks', async () => {
    const r = await buildIndex(ws);
    if (!r.ok) {
      await audit(ws, { op: 'gc.clock_sync', actor, outcome: 'blocked', reason: 'INDEX_INVALID', errors: r.errors });
      return { ok: false, errors: r.errors };
    }
    const reg = await loadRegistry(ws);
    const changes = reconcileClocks(reg, r.index, ws.clock.now());
    if (changes.length) {
      await saveRegistry(ws, reg);
      await audit(ws, { op: 'gc.clock_sync', actor, outcome: 'ok', changes });
    }
    return { ok: true, changes, index: r.index };
  });
}
