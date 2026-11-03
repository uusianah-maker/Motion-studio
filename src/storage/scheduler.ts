import { audit } from './audit.js';
import { isStorageError } from './errors.js';
import { type RecoveryReport, recoverOnStartup } from './recovery.js';
import { type ScanReport, scanCandidates } from './scanner.js';
import { type AutoTrashResult, runAutoTrash } from './trash.js';
import { type Workspace, readPolicy } from './workspace.js';

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface CycleResult {
  at: number;
  status: 'ok' | 'skipped-overlap' | 'skipped-locked' | 'blocked' | 'error';
  scan?: ScanReport;
  trash?: AutoTrashResult;
  error?: string;
}

/**
 * Smart GC scheduler (PRD v0.8 §E): runs at app launch and on a background interval
 * *while the app is running* — no promise of work while closed. Never purges.
 * Cycles never overlap; a locked workspace just skips to the next tick.
 */
export class GcScheduler {
  private handle: unknown = null;
  private running = false;
  readonly history: CycleResult[] = [];
  lastRecovery: RecoveryReport | null = null;

  constructor(
    private readonly ws: Workspace,
    private readonly opts: { busy?: () => ReadonlySet<string>; timers?: Timers; autoTrash?: boolean } = {},
  ) {}

  /** App launch: crash recovery, then an immediate cycle, then the interval. */
  async start(): Promise<CycleResult> {
    if (this.handle !== null) throw new Error('scheduler sudah berjalan');
    this.lastRecovery = await recoverOnStartup(this.ws);
    const policy = await readPolicy(this.ws);
    const t = this.opts.timers ?? realTimers;
    this.handle = t.setInterval(() => void this.runCycle(), policy.gc.scan_interval_minutes * 60_000);
    return this.runCycle();
  }

  stop(): void {
    if (this.handle === null) return;
    (this.opts.timers ?? realTimers).clearInterval(this.handle);
    this.handle = null;
  }

  get active(): boolean {
    return this.handle !== null;
  }

  /** One scan + Auto Trash cycle. Never throws (a timer callback must not crash the app). */
  async runCycle(): Promise<CycleResult> {
    const at = this.ws.clock.now();
    if (this.running) return this.record({ at, status: 'skipped-overlap' });
    this.running = true;
    try {
      const busy = this.opts.busy?.() ?? new Set<string>();
      const scan = await scanCandidates(this.ws, { actor: 'scheduler', busy });
      if (!scan.ok) return this.record({ at, status: 'blocked', scan });
      if (this.opts.autoTrash === false || scan.candidates.length === 0) return this.record({ at, status: 'ok', scan });
      const trash = await runAutoTrash(this.ws, { actor: 'scheduler', busy });
      return this.record({ at, status: trash.ok ? 'ok' : 'error', scan, trash });
    } catch (e) {
      if (isStorageError(e, 'WORKSPACE_LOCKED')) return this.record({ at, status: 'skipped-locked' });
      const error = String(e);
      await audit(this.ws, { op: 'gc.scheduler', actor: 'scheduler', outcome: 'failed', error }).catch(() => undefined);
      return this.record({ at, status: 'error', error });
    } finally {
      this.running = false;
    }
  }

  private record(r: CycleResult): CycleResult {
    this.history.push(r);
    if (this.history.length > 100) this.history.shift();
    return r;
  }
}
