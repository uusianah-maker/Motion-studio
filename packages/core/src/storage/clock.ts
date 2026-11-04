/** Injectable time source so 30-day GC rules are deterministic in tests (ADR-001 D6). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Manually advanced clock for tests and simulations. */
export class ManualClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance() needs a finite, non-negative duration');
    this.current += ms;
  }
}
