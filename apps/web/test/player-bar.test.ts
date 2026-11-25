import { describe, expect, it } from 'vitest';
import { stepFrame, timecode } from '../src/views/PlayerBar';

describe('25 Nov player bar', () => {
  it('timecode HH:MM:SS:FF at 30 fps', () => {
    expect(timecode(0)).toBe('00:00:00:00');
    expect(timecode(1000)).toBe('00:00:01:00');
    expect(timecode(1500)).toBe('00:00:01:15');
    expect(timecode(3_311_000)).toBe('00:55:11:00');
    expect(timecode(3_600_000 + 33.4)).toBe('01:00:00:01');
    expect(timecode(33)).toBe('00:00:00:01'); // one frame step from 0
  });
  it('frame steps land on frame boundaries and never go below 0', () => {
    expect(stepFrame(0, 1)).toBe(33);
    expect(stepFrame(33, 1)).toBe(67);
    expect(stepFrame(1000, -1)).toBe(967);
    expect(stepFrame(0, -1)).toBe(0);
  });
});
