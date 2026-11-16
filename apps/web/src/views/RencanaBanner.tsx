import { useEffect, useState } from 'react';
import { pendingPlan } from '../../../../packages/core/dist/storage/rencanaTertunda.js';
import type { Api, EngineJob, Project, Role } from '../api';

/**
 * R25 (kasus nyata tim 16 Nov): job Generate sudah "siap" tapi rencananya belum diterapkan, jadi
 * Editor hanya menampilkan linimasa kosong. Banner ini menerapkan rencana yang sama dengan halaman
 * Video iklan (satu edit = satu undo) atau membuka rencananya di sana. Reviewer hanya diberi tahu.
 */
export function RencanaBanner({
  api,
  project,
  role,
  busy,
  run,
  onLihat,
}: {
  api: Api;
  project: Project;
  role: Role;
  busy: boolean;
  run: (fn: (p: Project) => Promise<Project>) => Promise<void>;
  onLihat?: (projectId: string, jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<EngineJob[] | null>(null);
  useEffect(() => {
    let stale = false;
    setJobs(null);
    void api.engineJobs(project.project_id).then(
      (j) => !stale && setJobs(j),
      () => !stale && setJobs([]),
    );
    return () => {
      stale = true;
    };
  }, [api, project.project_id]);
  const pending = jobs ? pendingPlan(project, jobs) : null;
  if (!pending) return null;
  const apply = () =>
    run(async (p) => {
      const plan = await api.enginePlan(p.project_id, pending.job_id);
      if (!plan.plan) throw new Error('Rencana mesin kosong; buka "Lihat rencana" untuk detailnya.');
      const r = await api.copilotApply(p.project_id, plan.plan.plan_id, p.revision);
      return r.project;
    });
  return (
    <div style={{ padding: '12px 16px 0' }}>
      <div className="notice info" role="status" aria-label="Rencana mesin siap">
        <b>Rencana mesin siap (job {pending.job_id})</b> — belum diterapkan ke timeline.{' '}
        {role === 'reviewer' ? (
          <span>Minta Editor/Owner menerapkan rencana ini.</span>
        ) : (
          <button className="btn small primary" disabled={busy || project.status === 'archived'} onClick={() => void apply()}>
            Terapkan ke timeline
          </button>
        )}{' '}
        {onLihat && (
          <button className="btn small" onClick={() => onLihat(project.project_id, pending.job_id)}>
            Lihat rencana
          </button>
        )}
      </div>
    </div>
  );
}
