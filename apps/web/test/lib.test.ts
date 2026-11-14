import { describe, expect, it } from 'vitest';
import { TIMELINE_ZOOM, aspectCss, blockerText, clampScroll, clipAt, dragSpan, zoomAround, safeInsets, sourceSeconds, ellipsize, formatBytes, formatDuration, relativeDays, rulerTicks, snap, takeAuthError, takeTokenFromHash, visibleDuration } from '../src/lib';

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
    // Zoomed in to 6 s of a 60 s timeline: 1 s ticks across the whole minute.
    expect(rulerTicks(60_000, 6000)).toHaveLength(61);
  });
  it('zoom keeps the time under the cursor still and never scrolls past the ends (paket 1)', () => {
    // 1000 px view at 2×: the lane is 2000 px, at most 1000 px of scroll.
    expect(clampScroll(-5, 1000, 2)).toBe(0);
    expect(clampScroll(5000, 1000, 2)).toBe(1000);
    expect(clampScroll(300, 1000, 1)).toBe(0);
    // Cursor at 250 px with no scroll = 25% of the timeline; after 1→2× that same 25% is still under 250 px.
    const r = zoomAround(1, 2, 0, 250, 1000);
    expect(r).toEqual({ zoom: 2, scrollPx: 250 });
    expect((r.scrollPx + 250) / (1000 * r.zoom)).toBe(0.25);
    // Zooming out past 1× snaps back to fit; past the max is capped.
    expect(zoomAround(2, 0.3, 600, 100, 1000)).toEqual({ zoom: TIMELINE_ZOOM.min, scrollPx: 0 });
    expect(zoomAround(30, 999, 0, 0, 1000).zoom).toBe(TIMELINE_ZOOM.max);
  });
});

describe('preview helpers (W07)', () => {
  const clips = [{ start_ms: 0, end_ms: 2000, in_ms: 500 }, { start_ms: 2000, end_ms: 5000 }];
  it('picks the clip under the playhead (end exclusive) and maps to source time', () => {
    expect(clipAt(clips, 0)).toBe(clips[0]);
    expect(clipAt(clips, 1999)).toBe(clips[0]);
    expect(clipAt(clips, 2000)).toBe(clips[1]);
    expect(clipAt(clips, 5000)).toBeNull();
    expect(sourceSeconds(clips[0]!, 1000)).toBe(1.5);
    expect(sourceSeconds(clips[1]!, 2500)).toBe(0.5);
  });
  it('trim-end stops at the end of the source', () => {
    expect(dragSpan('trim-end', { start_ms: 1000, end_ms: 3000, in_ms: 2000, hasMedia: true, sourceMs: 8000 }, 99_000)).toEqual({ start_ms: 1000, end_ms: 7000 });
  });
  it('safe area and aspect', () => {
    expect(safeInsets('9:16')).toEqual([12, 14, 20, 6]);
    expect(safeInsets('16:9')).toEqual([5, 5, 5, 5]);
    expect(aspectCss('3:4')).toBe('3 / 4');
  });
});

describe('W09 auth error fragment', () => {
  it('reads a known-shaped code once and keeps the rest of the fragment', () => {
    expect(takeAuthError('#auth_error=EMAIL_NOT_ALLOWED')).toEqual({ code: 'EMAIL_NOT_ALLOWED', rest: '' });
    expect(takeAuthError('#view=trash&auth_error=ACCESS_DENIED')).toEqual({ code: 'ACCESS_DENIED', rest: '#view=trash' });
    expect(takeAuthError('#auth_error=<script>').code).toBeNull();
    expect(takeAuthError('')).toEqual({ code: null, rest: '' });
  });
});
