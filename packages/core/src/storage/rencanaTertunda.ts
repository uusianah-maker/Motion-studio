/**
 * R25 (kasus nyata tim 16 Nov): a Generate job is "siap" but its plan was never applied — the team
 * opens Edit and only sees an empty timeline. Pure rule shared by the server (project list label) and
 * the editor (banner): the newest plan job of a project is ready, and the timeline is still empty or
 * has not been edited since that job finished. Opening a plan does not touch the manifest, applying
 * it does (copilot apply = an edit), so an applied plan never shows here again.
 */
import type { EngineMode, EngineState } from './engine.js';

/** Engine modes whose result is an edit plan applied to this project's own timeline. */
export const PLAN_MODES: readonly EngineMode[] = ['generate', 'ulang'];

export interface PendingPlan {
  job_id: string;
  mode: EngineMode;
  finished_at: number;
}

type JobLike = { job_id: string; mode: EngineMode; state: EngineState; finished_at: number | null };
type ManifestLike = { updated_at: number; variant?: unknown; status?: string } & { timeline: { tracks: readonly { clips: readonly unknown[] }[] } };

/** `jobs` newest first (as `listEngineJobs` returns them). Null = nothing waiting. */
export function pendingPlan(m: ManifestLike, jobs: readonly JobLike[]): PendingPlan | null {
  if (m.variant || m.status === 'archived') return null;
  const j = jobs.find((x) => PLAN_MODES.includes(x.mode));
  if (!j || j.state !== 'siap' || !j.finished_at) return null;
  const empty = !m.timeline.tracks.some((t) => t.clips.length > 0);
  return empty || m.updated_at <= j.finished_at ? { job_id: j.job_id, mode: j.mode, finished_at: j.finished_at } : null;
}
