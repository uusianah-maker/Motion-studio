import { spawn } from 'node:child_process';
import path from 'node:path';
import { type EngineConfig, type Spawner, type Workspace, engineEnv, engineOrigin, isJobId, killTree, readBrandFor, readProject } from './core.js';

const VARIAN = /^varian-\d{3}$/;
const KODE = /^[A-Za-z0-9_.-]{1,60}$/;
const TIMEOUT_MS = 60_000;

/**
 * R6 (KONTRAK-ENGINE §13): tell the engine's per-brand usage history what the team decided, so a
 * new Batch Remix does not reuse what was rendered and may reuse what was struck:
 *   render of a Batch variant completed → `riwayat.py tandai <kode> <job> dirender <varian>`
 *   batch row struck → `lepas <kode> <job> <varian…>` · approved (again) → `tandai … disetujui`.
 * Best effort: one call at a time, never blocks or fails a render / decision (errors are logged).
 * Arguments are passed as an array (no shell) and checked first.
 */
export function createRiwayatSignal(ws: Workspace, cfg: EngineConfig | null, opts: { spawnImpl?: Spawner; onError?: (e: unknown) => void; timeoutMs?: number } = {}) {
  let chain: Promise<void> = Promise.resolve();
  const run = (args: string[]): Promise<void> => {
    if (!cfg) return Promise.resolve();
    const p = chain.then(
      () =>
        new Promise<void>((resolve) => {
          let child: ReturnType<Spawner>;
          try {
            child = (opts.spawnImpl ?? spawn)(cfg.command, [path.join(cfg.root, 'pipeline', 'batch', 'riwayat.py'), ...args], { cwd: cfg.root, windowsHide: true, env: engineEnv() });
          } catch (e) {
            opts.onError?.(e);
            resolve();
            return;
          }
          let err = '';
          child.stderr?.setEncoding('utf8');
          child.stderr?.on('data', (c: string) => (err = (err + c).slice(-2000)));
          child.stdout?.resume();
          const timer = setTimeout(() => killTree(child), opts.timeoutMs ?? TIMEOUT_MS);
          child.on('error', (e) => opts.onError?.(e));
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) opts.onError?.(new Error(`riwayat ${args[0]} gagal (kode ${String(code)}): ${err.trim().split('\n').pop() ?? ''}`));
            resolve();
          });
        }),
    );
    chain = p;
    return p;
  };
  const kodeOf = async (projectId: string): Promise<string | null> => {
    const p = await readProject(ws, projectId);
    const kode = (await readBrandFor(ws, p.brand_id)).kode;
    return kode && KODE.test(kode) ? kode : null;
  };
  return {
    /** A render of `projectId` completed: if it is a Batch Remix variant, mark it `dirender`. */
    async rendered(projectId: string): Promise<void> {
      try {
        const o = await engineOrigin(ws, projectId);
        if (o?.kind !== 'batch' || !isJobId(o.job_id) || !o.varian || !VARIAN.test(o.varian)) return;
        const kode = await kodeOf(projectId);
        if (kode) await run(['tandai', kode, o.job_id, 'dirender', o.varian]);
      } catch (e) {
        opts.onError?.(e);
      }
    },
    /** Batch rows decided on `projectId`'s job: struck → `lepas`, approved → `tandai disetujui`. */
    async decided(projectId: string, jobId: string, rows: { varian: string; status: string }[]): Promise<void> {
      try {
        if (!isJobId(jobId)) return;
        const kode = await kodeOf(projectId);
        if (!kode) return;
        const pick = (s: string) => rows.filter((r) => r.status === s && VARIAN.test(r.varian)).map((r) => r.varian);
        const struck = pick('dicoret');
        const approved = pick('disetujui');
        if (struck.length) await run(['lepas', kode, jobId, ...struck]);
        if (approved.length) await run(['tandai', kode, jobId, 'disetujui', ...approved]);
      } catch (e) {
        opts.onError?.(e);
      }
    },
    /** Everything sent so far is done (tests). */
    idle: () => chain,
  };
}
export type RiwayatSignal = ReturnType<typeof createRiwayatSignal>;
