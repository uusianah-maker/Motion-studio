import { describe, expect, it } from 'vitest';
import { pendingPlan } from '../src/storage/rencanaTertunda.js';

/** R25: a ready Generate plan that was never applied is flagged (editor banner + list label). */
const job = (over: Partial<{ job_id: string; mode: 'generate' | 'batch' | 'ulang' | 'pisah' | 'transfer' | 'beatspot'; state: 'menunggu' | 'berjalan' | 'siap' | 'ditolak' | 'gagal'; finished_at: number | null }> = {}) => ({ job_id: 'AYS-20261116-001', mode: 'generate' as const, state: 'siap' as const, finished_at: 1000, ...over });
const empty = { updated_at: 500, timeline: { tracks: [] } };
const filled = (updated_at: number) => ({ updated_at, timeline: { tracks: [{ clips: [{}] }] } });

describe('R25 rencana mesin belum diterapkan', () => {
  it('ready Generate plan + empty timeline → pending', () => {
    expect(pendingPlan(empty, [job()])).toEqual({ job_id: 'AYS-20261116-001', mode: 'generate', finished_at: 1000 });
    expect(pendingPlan({ ...empty, updated_at: 5000 }, [job()])?.job_id).toBe('AYS-20261116-001'); // empty wins
  });
  it('timeline not edited since the job finished → pending; edited (applied) after → not', () => {
    expect(pendingPlan(filled(900), [job()])).not.toBeNull();
    expect(pendingPlan(filled(1500), [job()])).toBeNull();
  });
  it('only the newest plan job counts; not ready / other modes / variants / archive → nothing', () => {
    expect(pendingPlan(empty, [job({ state: 'berjalan', finished_at: null })])).toBeNull();
    expect(pendingPlan(empty, [job({ state: 'gagal' })])).toBeNull();
    expect(pendingPlan(empty, [job({ job_id: 'B', state: 'gagal' }), job()])).toBeNull(); // newest failed
    expect(pendingPlan(empty, [job({ mode: 'batch' }), job({ mode: 'pisah' })])).toBeNull();
    expect(pendingPlan(empty, [job({ job_id: 'P', mode: 'pisah' }), job({ mode: 'ulang' })])?.mode).toBe('ulang'); // pisah skipped
    expect(pendingPlan({ ...empty, variant: { master_id: 'm' } }, [job()])).toBeNull();
    expect(pendingPlan({ ...empty, status: 'archived' }, [job()])).toBeNull();
    expect(pendingPlan(empty, [])).toBeNull();
  });
});
