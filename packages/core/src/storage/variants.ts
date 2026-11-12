import { commitProject } from './deps.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import type { Actor } from './permissions.js';
import { CANVAS_RATIOS, type CanvasRatio, MAX_TEXT_LEN, type ProjectManifest, type Timeline, type VariantBrief, type VariantInfo } from './project.js';
import { MAX_PROJECT_NAME, createWithTimeline } from './projectAdmin.js';
import { presetById } from './textPresets.js';
import { type EditOp, applyOps } from './timeline.js';
import { type Workspace, listProjectIds, readProject } from './workspace.js';

/**
 * Ad variants (X09, PRD workflow C "master → variant briefs → different hooks/CTAs → individual
 * approval → queue render"): each brief becomes its own project cloned from the master, so the
 * master is never touched and every variant has its own history, renders and approval.
 */

export const MAX_VARIANTS_PER_RUN = 8;
/** The hook is the first text that starts within this window. */
export const HOOK_WINDOW_MS = 3000;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const oneLine = (s: string) => [...s].map((c) => (c.charCodeAt(0) < 32 && c !== '\n' ? ' ' : c)).join('').trim();

export interface BriefInput {
  label?: string;
  ratio?: CanvasRatio;
  hook?: string;
  cta?: string;
}

export function validateBriefs(raw: unknown): (VariantBrief & { label: string })[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_VARIANTS_PER_RUN) return bad(`Isi 1–${MAX_VARIANTS_PER_RUN} varian`);
  return raw.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object' || Array.isArray(o)) bad(`Varian ${i + 1} tidak valid`);
    const extra = Object.keys(o).filter((k) => !['label', 'ratio', 'hook', 'cta'].includes(k));
    if (extra.length) bad(`Varian ${i + 1}: field tidak dikenal ${extra.join(', ')}`);
    const out: VariantBrief & { label: string } = { label: '' };
    if (o.ratio !== undefined && o.ratio !== null && o.ratio !== '') {
      if (!CANVAS_RATIOS.includes(o.ratio as CanvasRatio)) bad(`Varian ${i + 1}: rasio harus ${CANVAS_RATIOS.join(', ')}`);
      out.ratio = o.ratio as CanvasRatio;
    }
    for (const k of ['hook', 'cta'] as const) {
      const v = o[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string') bad(`Varian ${i + 1}: ${k} harus teks`);
      const t = oneLine(v as string);
      if (!t || t.length > MAX_TEXT_LEN) bad(`Varian ${i + 1}: ${k} 1–${MAX_TEXT_LEN} karakter`);
      out[k] = t;
    }
    if (!out.ratio && !out.hook && !out.cta) bad(`Varian ${i + 1}: isi minimal rasio, hook, atau CTA`);
    const label = typeof o.label === 'string' ? oneLine(o.label).slice(0, 60) : '';
    out.label = label || [out.ratio, out.hook && `Hook “${out.hook.slice(0, 18)}”`, out.cta && `CTA “${out.cta.slice(0, 18)}”`].filter(Boolean).join(' · ').slice(0, 60);
    return out;
  });
}

const end = (t: Timeline) => Math.max(0, ...t.tracks.flatMap((tr) => tr.clips.map((c) => c.end_ms)));

/** Ops that turn the master timeline into one variant (pure; checked by applying them). */
export function variantOps(t: Timeline, brief: VariantBrief): EditOp[] {
  const ops: EditOp[] = [];
  if (brief.ratio) ops.push({ op: 'set_canvas', ratio: brief.ratio });
  const texts = (t.tracks.find((x) => x.kind === 'text')?.clips ?? []).slice().sort((a, b) => a.start_ms - b.start_ms);
  const total = end(t);
  const hookClip = texts.find((c) => c.start_ms < HOOK_WINDOW_MS);
  const ctaClip = [...texts].reverse().find((c) => c.end_ms >= total - 500 && c !== hookClip);
  const addCta = !!brief.cta && !ctaClip;
  let hookEnd = 0;
  if (brief.hook) {
    if (hookClip) ops.push({ op: 'set_text', clip_id: hookClip.clip_id, text: brief.hook });
    else {
      const p = presetById('hook')!;
      // On a short master the new hook leaves room for a new CTA (first half at most).
      const len = Math.min(p.duration_ms, addCta ? Math.floor(total / 2) : total);
      if (len < 500) bad('Master terlalu pendek untuk hook (minimal 1 detik)');
      ops.push({ op: 'add_clip', track_kind: 'text', text: brief.hook, style: { ...p.style }, start_ms: 0, duration_ms: len });
      hookEnd = len;
    }
  }
  if (brief.cta) {
    if (ctaClip) ops.push({ op: 'set_text', clip_id: ctaClip.clip_id, text: brief.cta });
    else {
      const p = presetById('cta')!;
      const start = Math.max(total - p.duration_ms, hookEnd);
      if (total - start < 500) bad('Master terlalu pendek untuk CTA (minimal 1 detik)');
      ops.push({ op: 'add_clip', track_kind: 'text', text: brief.cta, style: { ...p.style }, start_ms: start, duration_ms: total - start });
    }
  }
  return ops;
}

/** Create one project per brief from the master. All briefs are checked before anything is created. */
export async function createVariants(ws: Workspace, input: { master_id: string; briefs: unknown; actor: Actor; newId: () => string }): Promise<ProjectManifest[]> {
  await guard(ws, input.actor, 'commit_project', { project_id: input.master_id, step: 'variants' });
  const master = await readProject(ws, input.master_id);
  if (master.variant) bad('Ini sudah varian. Buat varian dari proyek master-nya.');
  if (!master.timeline.tracks.some((t) => t.clips.length)) bad('Master masih kosong');
  const briefs = validateBriefs(input.briefs);
  // Dry run: every variant must be a valid timeline before any project is created.
  const planned = briefs.map((b, i) => {
    let timeline: Timeline;
    try {
      timeline = applyOps(master.timeline, variantOps(master.timeline, b), () => `c_v${i}_${Math.random().toString(36).slice(2, 10)}`);
    } catch (e) {
      throw new StorageError('EDIT_INVALID', `Varian ${i + 1} (${b.label}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return { b, timeline };
  });
  const out: ProjectManifest[] = [];
  let number = Math.max(0, ...(await listVariants(ws, master.project_id)).map((p) => p.variant!.number));
  for (const { b, timeline } of planned) {
    const { label, ...brief } = b;
    const variant: VariantInfo = { master_id: master.project_id, number: ++number, label, brief, approved_revision: null };
    out.push(await createWithTimeline(ws, { project_id: input.newId(), name: `${master.name} · ${label}`.slice(0, MAX_PROJECT_NAME), timeline, actor: input.actor, variant }));
  }
  return out;
}

/** Approve (or withdraw) a variant at its current content. Editing it later voids the approval. */
export async function setVariantApproval(ws: Workspace, input: { project_id: string; expected_revision: number; approved: unknown; actor: Actor }): Promise<ProjectManifest> {
  await guard(ws, input.actor, 'commit_project', { project_id: input.project_id, step: 'variant_approval' });
  if (typeof input.approved !== 'boolean') bad('approved harus true/false');
  const current = await readProject(ws, input.project_id);
  if (!current.variant) bad('Proyek ini bukan varian');
  if (current.revision !== input.expected_revision) throw new StorageError('CONFLICT', 'Revisi proyek sudah berubah; muat ulang dulu', { expected: input.expected_revision, actual: current.revision });
  // The commit bumps the revision by one: that new revision is the approved content.
  const next: ProjectManifest = { ...current, variant: { ...current.variant!, approved_revision: input.approved ? current.revision + 1 : null } };
  return commitProject(ws, { manifest: next, expected_revision: input.expected_revision, actor: input.actor });
}

export type VariantState = 'draft' | 'approved' | 'changed';
export const variantState = (p: ProjectManifest): VariantState =>
  !p.variant || p.variant.approved_revision === null ? 'draft' : p.variant.approved_revision === p.revision ? 'approved' : 'changed';

/** Variants of a master (unreadable manifests are skipped; the project list reports those). */
export async function listVariants(ws: Workspace, masterId: string): Promise<ProjectManifest[]> {
  await readProject(ws, masterId);
  const out: ProjectManifest[] = [];
  for (const id of await listProjectIds(ws)) {
    const p = await readProject(ws, id).catch(() => null);
    if (p?.variant?.master_id === masterId) out.push(p);
  }
  return out.sort((a, b) => a.variant!.number - b.variant!.number);
}
