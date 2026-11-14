import { randomBytes } from 'node:crypto';
import {
  type Actor,
  type PreflightProblem,
  type RenderOutput,
  type RenderPhase,
  type RenderSettings,
  type Workspace,
  isStorageError,
  renderProject,
  salinKeHasil,
} from './core.js';

/**
 * Render jobs (W08). Jobs run one at a time in this server process (FFmpeg already uses every
 * core); the rest wait in order. State is in memory: after a restart the job list is empty,
 * finished outputs are still in 05_OUTPUT, and a lease of a killed render is released at start.
 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export interface RenderJobView {
  job_id: string;
  project_id: string;
  output_name: string;
  status: JobStatus;
  phase: RenderPhase | null;
  /** 0..1 (encoding progress; 1 when completed). */
  progress: number;
  created_at: number;
  finished_at: number | null;
  output: Omit<RenderOutput, 'rel'> | null;
  /** Preflight problems (codes + media refs only: never local paths). */
  problems: { code: string; media_id?: string; version_id?: string }[];
  error: { code: string; message: string } | null;
}

interface Job extends RenderJobView {
  controller: AbortController;
  settings: Partial<RenderSettings>;
  actor: Actor;
  /** X08: the user accepted warn-level Brand guard issues for this render. */
  accept_brand_warnings: boolean;
}

export interface RenderJobsOptions {
  /** Job temp folder parent (outside the workspace). */
  tmpRoot: string;
  /** Fixed settings (tests use a tiny size); request settings are merged on top. */
  settings?: Partial<RenderSettings>;
  keep?: number;
}

const ACTIVE: readonly JobStatus[] = ['queued', 'running'];

/** Problem codes only: `OUTPUT_NOT_WRITABLE.detail` etc. can contain absolute paths (Checkpoint D F5). */
const problemView = (p: PreflightProblem) => ({ code: p.code, ...('ref' in p ? { media_id: p.ref.media_id, version_id: p.ref.version_id } : {}), ...('issues' in p ? { issues: p.issues } : {}) });

/** Messages of our own typed errors are user-facing Indonesian text without paths; anything else is generic. */
function errorView(e: unknown): { code: string; message: string } {
  if (isStorageError(e)) return { code: e.code, message: e.message };
  return { code: 'INTERNAL', message: 'Render gagal karena kesalahan internal (lihat log server)' };
}

export function createRenderJobs(ws: Workspace, opts: RenderJobsOptions, onError?: (e: unknown) => void) {
  const jobs: Job[] = [];
  const keep = opts.keep ?? 50;
  let running = false;

  const view = (j: Job): RenderJobView => {
    const { controller: _c, settings: _s, actor: _a, accept_brand_warnings: _b, ...v } = j;
    void _c;
    void _s;
    void _a;
    void _b;
    return { ...v, problems: [...v.problems], output: v.output ? { ...v.output } : null };
  };

  async function pump(): Promise<void> {
    if (running) return;
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    running = true;
    next.status = 'running';
    try {
      const r = await renderProject(
        ws,
        { project_id: next.project_id, output_name: next.output_name, actor: next.actor, ...(next.accept_brand_warnings ? { accept_brand_warnings: true } : {}) },
        {
          tmpRoot: opts.tmpRoot,
          settings: { ...opts.settings, ...next.settings },
          signal: next.controller.signal,
          worker_pid: process.pid,
          onPhase: (p) => (next.phase = p),
          onProgress: (f) => (next.progress = f),
        },
      );
      if (r.status === 'blocked') {
        next.status = 'blocked';
        next.problems = r.preflight.problems.map(problemView);
      } else {
        next.status = 'completed';
        next.progress = 1;
        const { rel: _rel, ...out } = r.output;
        void _rel;
        next.output = out;
        next.output_name = out.name;
        // Folder "HASIL RENDER/<tanggal>" yang mudah dibaca di Explorer (owner 14 Nov). Salinan; gagal = tidak apa-apa.
        void salinKeHasil(ws, { project_id: next.project_id, rel: r.output.rel, name: out.name }).catch((e: unknown) => onError?.(e));
      }
    } catch (e) {
      next.status = isStorageError(e, 'CANCELLED') ? 'cancelled' : 'failed';
      next.error = errorView(e);
      if (!isStorageError(e)) onError?.(e);
    } finally {
      next.finished_at = Date.now();
      running = false;
      // Forget old finished jobs (outputs stay in 05_OUTPUT).
      while (jobs.length > keep) {
        const i = jobs.findIndex((j) => !ACTIVE.includes(j.status));
        if (i < 0) break;
        jobs.splice(i, 1);
      }
      void pump();
    }
  }

  return {
    /** `actor` comes from the caller (Checkpoint E E9); the core refuses render for AI. */
    start(input: { project_id: string; output_name: string; actor: Actor; settings?: Partial<RenderSettings>; accept_brand_warnings?: boolean }): RenderJobView {
      const job: Job = {
        job_id: `job_${randomBytes(8).toString('hex')}`,
        project_id: input.project_id,
        output_name: input.output_name,
        status: 'queued',
        phase: null,
        progress: 0,
        created_at: Date.now(),
        finished_at: null,
        output: null,
        problems: [],
        error: null,
        controller: new AbortController(),
        settings: input.settings ?? {},
        actor: input.actor,
        accept_brand_warnings: !!input.accept_brand_warnings,
      };
      jobs.push(job);
      void pump();
      return view(job);
    },
    get(jobId: string): RenderJobView | null {
      const j = jobs.find((x) => x.job_id === jobId);
      return j ? view(j) : null;
    },
    list(projectId?: string): RenderJobView[] {
      return jobs.filter((j) => !projectId || j.project_id === projectId).map(view).reverse();
    },
    /** Queued: removed from the queue. Running: FFmpeg is killed, nothing is saved. */
    cancel(jobId: string): RenderJobView | null {
      const j = jobs.find((x) => x.job_id === jobId);
      if (!j) return null;
      if (j.status === 'queued') {
        j.status = 'cancelled';
        j.finished_at = Date.now();
        j.error = { code: 'CANCELLED', message: 'Render dibatalkan' };
      } else if (j.status === 'running') j.controller.abort();
      return view(j);
    },
    hasActive: (projectId?: string) => jobs.some((j) => ACTIVE.includes(j.status) && (!projectId || j.project_id === projectId)),
    /** Server stop: cancel everything and wait until the running FFmpeg is gone. */
    async stopAll(): Promise<void> {
      for (const j of jobs) if (ACTIVE.includes(j.status)) this.cancel(j.job_id);
      for (let i = 0; running && i < 200; i++) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
export type RenderJobs = ReturnType<typeof createRenderJobs>;
