import { audit } from './audit.js';
import { buildIndex } from './deps.js';
import { type Evaluation, type GcState, evaluateAll, reconcileClocks, syncClocks } from './eligibility.js';
import { newId } from './ids.js';
import { guard } from './guard.js';
import { type Actor, MEDIA_AREAS } from './permissions.js';
import { type Registry, loadRegistry, verifyVersion } from './registry.js';
import { journalBusy } from './trash.js';
import type { Workspace } from './workspace.js';

export interface ScanReport {
  op_id: string;
  at: number;
  dry_run: true;
  ok: boolean;
  /** Why the scan stopped (GC-07). Empty when ok. */
  errors: string[];
  /** Versions passing every gate *and* a fresh on-disk hash check. */
  candidates: Evaluation[];
  /** Versions that passed the gates but failed the on-disk check (excluded, with reason). */
  rejected: { version_id: string; reason: string }[];
  summary: Partial<Record<GcState, number>>;
  evaluations: Evaluation[];
}

/**
 * Conservative candidate scan — **dry run only**: never moves or deletes anything.
 * - Rebuilds the dependency index; invalid/incomplete → stop safely and log (GC-07).
 * - Reconciles 30-day clocks (persisted for user/scheduler; in-memory only for AI).
 * - Re-hashes every gate-passing version so a stale integrity flag never yields a candidate.
 */
export async function scanCandidates(ws: Workspace, opts: { actor: Actor; busy?: ReadonlySet<string> }): Promise<ScanReport> {
  await guard(ws, opts.actor, 'scan_dry_run');
  const op_id = newId('op');
  const at = ws.clock.now();
  const fail = async (errors: string[]): Promise<ScanReport> => {
    await audit(ws, { op_id, op: 'gc.scan', actor: opts.actor, outcome: 'blocked', dry_run: true, reason: 'INDEX_INVALID', errors });
    return { op_id, at, dry_run: true, ok: false, errors, candidates: [], rejected: [], summary: {}, evaluations: [] };
  };

  let reg: Registry;
  let index;
  if (opts.actor === 'ai') {
    // AI may only read status: compute clocks on a private copy, write nothing but the audit entry.
    const r = await buildIndex(ws);
    if (!r.ok) return fail(r.errors);
    index = r.index;
    try {
      reg = await loadRegistry(ws);
    } catch (e) {
      return fail([String(e)]);
    }
    reconcileClocks(reg, index, at);
  } else {
    const s = await syncClocks(ws, opts.actor);
    if (!s.ok) return fail(s.errors);
    index = s.index;
    reg = await loadRegistry(ws);
  }

  const busy = new Set([...(opts.busy ?? []), ...(await journalBusy(ws))]);
  const evaluations = evaluateAll(reg, { now: at, index, busy });
  const candidates: Evaluation[] = [];
  const rejected: ScanReport['rejected'] = [];
  for (const e of evaluations.filter((x) => x.eligible)) {
    const v = reg.versions[e.version_id]!;
    try {
      const { hash } = await ws.blobs.hash(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS));
      if (hash !== v.content_hash) {
        rejected.push({ version_id: v.version_id, reason: 'CHANGED' });
        if (opts.actor !== 'ai') await verifyVersion(ws, v.version_id);
        continue;
      }
      candidates.push(e);
    } catch (err) {
      rejected.push({ version_id: v.version_id, reason: `UNVERIFIABLE: ${String(err)}` });
      if (opts.actor !== 'ai') await verifyVersion(ws, v.version_id).catch(() => undefined);
    }
  }
  const summary: ScanReport['summary'] = {};
  for (const e of evaluations) summary[e.state] = (summary[e.state] ?? 0) + 1;
  await audit(ws, {
    op_id,
    op: 'gc.scan',
    actor: opts.actor,
    outcome: 'ok',
    dry_run: true,
    summary,
    candidates: candidates.map((c) => ({ version_id: c.version_id, media_id: c.media_id, unreferenced_since: c.unreferenced_since })),
    rejected,
    index_fingerprint: index.fingerprint,
  });
  return { op_id, at, dry_run: true, ok: true, errors: [], candidates, rejected, summary, evaluations };
}

export interface GcStatusView {
  ok: boolean;
  errors: string[];
  summary: Partial<Record<GcState, number>>;
  /** Pass every rule now; bytes are re-hashed only when Auto Trash actually runs. */
  candidates: number;
  evaluations: Evaluation[];
}

/**
 * Read-only GC status for dashboards (Checkpoint D F6): no audit entry, no hashing, no writes.
 * Clocks are reconciled on an in-memory copy, exactly like the AI-safe scan, so a page view
 * never shows up as an actor in the audit log and never re-reads gigabytes of video.
 */
export async function gcStatusView(ws: Workspace): Promise<GcStatusView> {
  const at = ws.clock.now();
  const r = await buildIndex(ws);
  if (!r.ok) return { ok: false, errors: r.errors, summary: {}, candidates: 0, evaluations: [] };
  let reg: Registry;
  try {
    reg = await loadRegistry(ws);
  } catch (e) {
    return { ok: false, errors: [String(e)], summary: {}, candidates: 0, evaluations: [] };
  }
  reconcileClocks(reg, r.index, at);
  const evaluations = evaluateAll(reg, { now: at, index: r.index, busy: await journalBusy(ws) });
  const summary: GcStatusView['summary'] = {};
  for (const e of evaluations) summary[e.state] = (summary[e.state] ?? 0) + 1;
  return { ok: true, errors: [], summary, candidates: evaluations.filter((e) => e.eligible).length, evaluations };
}
