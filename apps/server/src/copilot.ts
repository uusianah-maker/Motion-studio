import type { Route } from './app.js';
import {
  type DiffItem,
  type EditOp,
  type EditPlan,
  LOCAL_EXAMPLES,
  MAX_PROMPT_LEN,
  PLAN_SCHEMA_VERSION,
  type PlanSource,
  type Workspace,
  audit,
  checkPlan,
  loadRegistry,
  pickOps,
  planLocal,
  readProject,
} from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { bad, onlyKeys, projectView, revision } from './routes.js';

/**
 * Copilot API (W11). Flow: prompt → planner → validated plan + diff (nothing changes) →
 * user approves all or some operations → applied through the normal edit path as ONE undo
 * step → the plan is marked applied, so a retry/double click never applies it twice.
 *
 * F7 (Checkpoint D): planners never see the request, its cookie or token. They get the prompt
 * and a timeline summary only, and they return JSON; only the user's own request applies it.
 */

export type CopilotMode = 'local' | 'auto' | 'ai';

/** Plugged in by the AI provider router (W12). */
export interface AiPlanner {
  /** Why AI cannot be used right now (no connection, budget, …) or null when it can. */
  unavailable(): Promise<string | null>;
  plan(input: { project_id: string; prompt: string; timeline: unknown; selected_clip_ids: string[]; playhead_ms: number }): Promise<{
    ops: unknown;
    rationale: string;
    warnings: string[];
    provider: { connection_id: string; provider: string; model: string };
    cost_usd: number;
  }>;
}

export interface CopilotOptions {
  ai?: AiPlanner;
  mode?: () => CopilotMode | Promise<CopilotMode>;
  now?: () => number;
  /** Plans made from transcripts (W14) are created by the server itself. */
}

type Status = 'proposed' | 'applying' | 'applied' | 'rejected';
export interface PlanRecord {
  plan: EditPlan;
  status: Status;
  applied_revision: number | null;
  accepted: number[] | null;
  decided_at: number | null;
}

const PLAN_TTL_MS = 6 * 3_600_000;
const MAX_PLANS = 300;
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Rencana tidak ada atau sudah kedaluwarsa; buat rencana baru');

export function createCopilot(ws: Workspace, opts: CopilotOptions = {}) {
  const now = opts.now ?? Date.now;
  const plans = new Map<string, PlanRecord>();
  let seq = 0;
  const newPlanId = () => `plan_${now().toString(36)}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  function prune(): void {
    const t = now();
    for (const [k, r] of plans) if (r.status === 'proposed' && t - r.plan.created_at > PLAN_TTL_MS) plans.delete(k);
    while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
  }

  async function sourceDuration() {
    const reg = await loadRegistry(ws);
    return (ref: { version_id: string }) => reg.versions[ref.version_id]?.probe?.duration_ms;
  }

  /** Validate untrusted ops and store a proposed plan (no change to the project). */
  async function propose(input: {
    project_id: string;
    source: PlanSource;
    prompt: string;
    ops: unknown;
    rationale: string;
    warnings: string[];
    provider?: EditPlan['provider'];
    cost_usd?: number;
  }): Promise<{ plan: EditPlan; diff: DiffItem[] }> {
    const project = await readProject(ws, input.project_id);
    const checked = checkPlan(project.timeline, input.ops, await sourceDuration());
    prune();
    const plan: EditPlan = {
      schema_version: PLAN_SCHEMA_VERSION,
      plan_id: newPlanId(),
      project_id: input.project_id,
      project_revision: project.revision,
      source: input.source,
      prompt: input.prompt,
      operations: checked.ops.map((op, i) => ({ op, label: checked.labels[i]! })),
      rationale: input.rationale.slice(0, 500),
      warnings: input.warnings.slice(0, 10).map((w) => String(w).slice(0, 200)),
      cost_estimate: { usd: input.cost_usd ?? 0, note: input.source === 'ai' ? 'biaya panggilan AI untuk menyusun rencana ini' : 'tanpa AI, tanpa biaya API' },
      requires_approval: true,
      provider: input.provider ?? null,
      created_at: now(),
    };
    plans.set(plan.plan_id, { plan, status: 'proposed', applied_revision: null, accepted: null, decided_at: null });
    await audit(ws, { op: 'copilot.plan', actor: 'ai', outcome: 'ok', project_id: plan.project_id, plan_id: plan.plan_id, source: plan.source, ops: plan.operations.length, provider: plan.provider?.provider ?? null });
    return { plan, diff: checked.diff };
  }

  function record(projectId: string, planId: string): PlanRecord {
    const r = plans.get(planId);
    if (!r || r.plan.project_id !== projectId) throw notFound();
    return r;
  }

  const view = (r: PlanRecord) => ({ plan: r.plan, status: r.status, applied_revision: r.applied_revision, accepted: r.accepted });

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/api/projects/:project_id/copilot/plan',
      handle: async ({ req, params }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['prompt', 'selected_clip_ids', 'playhead_ms', 'mode']);
        const prompt = body.prompt;
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LEN) throw bad(`Perintah wajib teks 1–${MAX_PROMPT_LEN} karakter`);
        const sel = body.selected_clip_ids ?? [];
        if (!Array.isArray(sel) || sel.length > 50 || !sel.every((x) => typeof x === 'string' && x.length <= 64)) throw bad('selected_clip_ids tidak valid');
        const playhead = body.playhead_ms ?? 0;
        if (typeof playhead !== 'number' || !Number.isFinite(playhead) || playhead < 0) throw bad('playhead_ms tidak valid');
        const reqMode = body.mode ?? null;
        if (reqMode !== null && reqMode !== 'local' && reqMode !== 'auto' && reqMode !== 'ai') throw bad('mode harus local | auto | ai');
        const mode: CopilotMode = (reqMode as CopilotMode | null) ?? (opts.mode ? await opts.mode() : 'local');
        const projectId = params.project_id!;
        const project = await readProject(ws, projectId);

        if (mode !== 'ai') {
          const local = planLocal(prompt, { timeline: project.timeline, selected_clip_ids: sel as string[], playhead_ms: playhead });
          if (local.ok) return propose({ project_id: projectId, source: 'local', prompt, ops: local.ops, rationale: local.rationale, warnings: local.warnings });
          if (mode === 'local' || !opts.ai) {
            await audit(ws, { op: 'copilot.plan', actor: 'ai', outcome: 'blocked', project_id: projectId, source: 'local', reason: 'UNSUPPORTED' });
            return { plan: null, unsupported: { message: local.message, examples: LOCAL_EXAMPLES, ai_available: false } };
          }
        }
        // AI path (W12): only via the router, never with the user's session.
        if (!opts.ai) return { plan: null, unsupported: { message: 'AI belum dipasang di server ini.', examples: LOCAL_EXAMPLES, ai_available: false } };
        const why = await opts.ai.unavailable();
        if (why) return { plan: null, unsupported: { message: why, examples: LOCAL_EXAMPLES, ai_available: false } };
        const out = await opts.ai.plan({ project_id: projectId, prompt, timeline: project.timeline, selected_clip_ids: sel as string[], playhead_ms: playhead });
        return propose({ project_id: projectId, source: 'ai', prompt, ops: out.ops, rationale: out.rationale, warnings: out.warnings, provider: out.provider, cost_usd: out.cost_usd });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:project_id/copilot/plans',
      handle: async ({ params }) => {
        prune();
        const list = [...plans.values()].filter((r) => r.plan.project_id === params.project_id).reverse().slice(0, 20);
        return { plans: list.map(view) };
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/copilot/plans/:plan_id/apply',
      handle: async ({ req, params, svc, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['expected_revision', 'accept']);
        const expected = revision(body);
        const r = record(params.project_id!, params.plan_id!);
        if (r.status === 'applied') {
          // Idempotent: a retry or double click returns the result, it never applies twice.
          return { project: projectView(await readProject(ws, r.plan.project_id)), ...view(r), already_applied: true };
        }
        if (r.status === 'rejected') throw new ApiError(409, 'CONFLICT', 'Rencana ini sudah ditolak');
        if (r.status === 'applying') throw new ApiError(409, 'BUSY', 'Rencana ini sedang diterapkan');
        if (expected !== r.plan.project_revision) throw new ApiError(409, 'CONFLICT', 'Proyek sudah berubah sejak rencana dibuat. Buat rencana baru supaya tidak menimpa perubahan lain.');
        const ops: EditOp[] = pickOps(
          r.plan.operations.map((o) => o.op),
          body.accept,
        );
        r.status = 'applying';
        try {
          const label = `Copilot: ${r.plan.prompt}`.slice(0, 80);
          const saved = await svc.editTimeline({ project_id: r.plan.project_id, expected_revision: expected, ops, label, actor });
          r.status = 'applied';
          r.applied_revision = saved.result.revision;
          r.accepted = Array.isArray(body.accept) ? (body.accept as number[]) : r.plan.operations.map((_, i) => i);
          r.decided_at = now();
          await audit(ws, { op: 'copilot.apply', actor, outcome: 'ok', project_id: r.plan.project_id, plan_id: r.plan.plan_id, source: r.plan.source, applied: ops.length, of: r.plan.operations.length, revision: saved.result.revision });
          return { project: projectView(saved.result), ...view(r), already_applied: false };
        } catch (e) {
          r.status = 'proposed';
          throw e;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:project_id/copilot/plans/:plan_id/reject',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, []);
        const r = record(params.project_id!, params.plan_id!);
        if (r.status === 'applied' || r.status === 'applying') throw new ApiError(409, 'CONFLICT', 'Rencana sudah diterapkan; pakai Undo untuk membatalkan');
        if (r.status !== 'rejected') {
          r.status = 'rejected';
          r.decided_at = now();
          await audit(ws, { op: 'copilot.reject', actor, outcome: 'ok', project_id: r.plan.project_id, plan_id: r.plan.plan_id });
        }
        return view(r);
      },
    },
  ];

  return { routes, propose, get: (id: string) => plans.get(id) ?? null };
}
export type Copilot = ReturnType<typeof createCopilot>;
