import { describe, expect, it } from 'vitest';
import { blockerText, dragSpan, ellipsize, formatBytes, formatDuration, relativeDays, rulerTicks, snap, takeTokenFromHash, visibleDuration } from '../src/lib';

const TOKEN = 'a'.repeat(64);

describe('web lib', () => {
  it('takes a valid token from the fragment and returns the rest without it', () => {
    expect(takeTokenFromHash(`#token=${TOKEN}`)).toEqual({ token: TOKEN, rest: '' });
    expect(takeTokenFromHash(`#token=${TOKEN}&view=trash`)).toEqual({ token: TOKEN, rest: '#view=trash' });
    expect(takeTokenFromHash('#token=short')).toEqual({ token: null, rest: '' });
    expect(takeTokenFromHash(`#token=${'G'.repeat(64)}`).token).toBeNull();
    expect(takeTokenFromHash('')).toEqual({ token: null, rest: '' });
  });
  it('formats sizes, durations and relative days', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(-1)).toBe('–');
    expect(formatDuration(65_400)).toBe('01:05');
    const now = Date.UTC(2026, 0, 1);
    expect(relativeDays(now + 3 * 86_400_000, now)).toBe('dalam 3 hari');
    expect(relativeDays(now + 1000, now)).toBe('besok');
    expect(relativeDays(now - 1, now)).toBe('sudah lewat');
  });
  it('explains purge blockers in plain words', () => {
    expect(blockerText('REFERENCED')).toBe('Masih dipakai proyek');
    expect(blockerText('NOT_IN_TRASH (active)')).toBe('Tidak ada di Trash');
    expect(blockerText('PROTECTED (CURRENT, KEEP)')).toBe('Dilindungi (CURRENT, KEEP)');
    expect(blockerText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
  it('ellipsizes long names', () => {
    expect(ellipsize('abcdef', 4)).toBe('abc…');
    expect(ellipsize('abc', 4)).toBe('abc');
  });
});


describe('timeline drag math (W06)', () => {
  const c = { start_ms: 2000, end_ms: 6000, in_ms: 1000, hasMedia: true };
  it('snaps to 100 ms and never goes below 0', () => {
    expect(snap(1249)).toBe(1200);
    expect(snap(1250)).toBe(1300);
    expect(snap(-40)).toBe(0);
  });
  it('move keeps length; trims respect minimum length and the source start', () => {
    expect(dragSpan('move', c, 1234)).toEqual({ start_ms: 3200, end_ms: 7200 });
    expect(dragSpan('move', c, -9999)).toEqual({ start_ms: 0, end_ms: 4000 });
    expect(dragSpan('trim-end', c, -9999)).toEqual({ start_ms: 2000, end_ms: 2100 });
    expect(dragSpan('trim-end', c, 1500)).toEqual({ start_ms: 2000, end_ms: 7500 });
    expect(dragSpan('trim-start', c, -9999)).toEqual({ start_ms: 1000, end_ms: 6000 }); // in_ms 1000 → source start at 1000
    expect(dragSpan('trim-start', c, 9999)).toEqual({ start_ms: 5900, end_ms: 6000 });
    expect(dragSpan('trim-start', { start_ms: 2000, end_ms: 6000 }, -9999)).toEqual({ start_ms: 0, end_ms: 6000 }); // no media: free
  });
  it('ruler and visible duration', () => {
    expect(rulerTicks(30_000)).toEqual([0, 5000, 10000, 15000, 20000, 25000, 30000]);
    expect(rulerTicks(8000)).toHaveLength(9);
    expect(visibleDuration(0)).toBe(30_000);
    expect(visibleDuration(41_200)).toBe(50_000);
  });
});
