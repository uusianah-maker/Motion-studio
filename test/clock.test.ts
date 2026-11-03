import { describe, expect, it } from 'vitest';
import { DAY_MS, ManualClock, systemClock } from '../src/storage/clock.js';
import { StorageError, isStorageError } from '../src/storage/errors.js';

describe('clock', () => {
  it('manual clock advances deterministically', () => {
    const c = new ManualClock(1000);
    c.advance(30 * DAY_MS);
    expect(c.now()).toBe(1000 + 30 * DAY_MS);
  });
  it('rejects negative advance', () => {
    expect(() => new ManualClock(0).advance(-1)).toThrow(RangeError);
  });
  it('system clock is close to Date.now', () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});

describe('errors', () => {
  it('isStorageError narrows by code', () => {
    const e = new StorageError('FORBIDDEN', 'no');
    expect(isStorageError(e)).toBe(true);
    expect(isStorageError(e, 'FORBIDDEN')).toBe(true);
    expect(isStorageError(e, 'CONFLICT')).toBe(false);
    expect(isStorageError(new Error('x'))).toBe(false);
  });
});
