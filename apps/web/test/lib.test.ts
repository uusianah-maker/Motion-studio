import { describe, expect, it } from 'vitest';
import { blockerText, ellipsize, formatBytes, formatDuration, relativeDays, takeTokenFromHash } from '../src/lib';

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
