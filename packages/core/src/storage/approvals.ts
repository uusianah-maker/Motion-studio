/**
 * R10: the PIC's approval queue. Every project (all brands, or one) whose latest rendered video
 * waits for a decision: never reviewed, or changed since the last decision. The decision itself
 * is the existing U7 review (Lulus / Revisi + note) — no new status.
 */
import { readBrandFor } from './brand.js';
import { listOutputs } from './render.js';
import { type ReviewState, type ReviewStatus, readReview } from './review.js';
import { type Workspace, listProjectIds, readProject } from './workspace.js';

export interface ApprovalItem {
  project_id: string;
  name: string;
  /** Effective brand (a project without one follows the workspace default). */
  brand_id: string | null;
  brand_name: string | null;
  revision: number;
  state: ReviewState;
  /** The newest rendered file: what the PIC watches. */
  output: { name: string; size: number; mtime_ms: number };
  outputs: number;
  variant?: { master_id: string; number: number; uji: boolean };
  open_comments: number;
  /** The previous decision on an earlier revision (e.g. what was asked last time). */
  last: { status: ReviewStatus; note: string; by: string | null } | null;
}

/** Waiting = has a render, not archived, and not "Lulus" for its current revision. Oldest render first. */
export async function approvalQueue(ws: Workspace, opts: { brand_id?: string | null } = {}): Promise<ApprovalItem[]> {
  const brands = new Map<string, { id: string | null; name: string | null }>();
  const brandOf = async (id: string | null | undefined) => {
    const k = id ?? '';
    if (!brands.has(k)) {
      const kit = await readBrandFor(ws, id ?? null).catch(() => null);
      brands.set(k, { id: kit?.brand_id || null, name: kit?.name ?? null });
    }
    return brands.get(k)!;
  };
  const out: ApprovalItem[] = [];
  for (const id of await listProjectIds(ws)) {
    const p = await readProject(ws, id).catch(() => null);
    if (!p || p.status === 'archived') continue;
    const files = await listOutputs(ws, id).catch(() => []);
    if (!files.length) continue;
    const r = await readReview(ws, id).catch(() => null);
    if (!r || r.state === 'lulus') continue;
    // "Revisi" for THIS revision is with the editor, not waiting for the PIC; once the editor
    // changed the project after it, it waits again (shown as "berubah").
    if (r.state === 'revisi' && r.decision?.revision === p.revision) continue;
    const state: ReviewState = r.state === 'revisi' ? 'berubah' : r.state;
    const b = await brandOf(p.brand_id);
    if (opts.brand_id !== undefined && opts.brand_id !== null && b.id !== opts.brand_id) continue;
    const newest = files[0]!;
    out.push({
      project_id: id,
      name: p.name,
      brand_id: b.id,
      brand_name: b.name,
      revision: p.revision,
      state,
      output: { name: newest.name, size: newest.size, mtime_ms: newest.mtime_ms },
      outputs: files.length,
      ...(p.variant ? { variant: { master_id: p.variant.master_id, number: p.variant.number, uji: p.variant.bukan_iklan === true } } : {}),
      open_comments: r.comments.filter((c) => c.resolved_at === null).length,
      last: r.decision ? { status: r.decision.status, note: r.decision.note, by: r.decision.by?.name ?? null } : null,
    });
  }
  return out.sort((a, b) => a.output.mtime_ms - b.output.mtime_ms);
}
