import { describe, expect, it } from 'vitest';
import { fitMove, fitTrim, gapAt } from '../src/dragFit';

const s = (start_ms: number, end_ms: number) => ({ start_ms, end_ms });

describe('fitMove (drag klip di timeline)', () => {
  const others = [s(0, 1000), s(3000, 4000)];
  it('free space: lands where dropped', () => expect(fitMove(s(1500, 2000), others, [], 50, s(1200, 1700))).toEqual(s(1500, 2000)));
  it('sticks to a nearby neighbour edge (start or end)', () => {
    expect(fitMove(s(1040, 1540), others, [], 100, s(1500, 2000))).toEqual(s(1000, 1500));
    expect(fitMove(s(2460, 2960), others, [], 100, s(1500, 2000))).toEqual(s(2500, 3000));
  });
  it('sticks to the playhead', () => expect(fitMove(s(1960, 2460), others, [2000], 100, s(1500, 2000))).toEqual(s(2000, 2500)));
  it('dropped onto a neighbour: stops against it instead of bouncing back', () => {
    expect(fitMove(s(2800, 3300), others, [], 10, s(1500, 2000))).toEqual(s(2500, 3000));
    expect(fitMove(s(800, 1300), others, [], 10, s(1500, 2000))).toEqual(s(1000, 1500));
    expect(fitMove(s(3800, 4300), others, [], 10, s(1500, 2000))).toEqual(s(4000, 4500)); // past it: after it
  });
  it('never before 0', () => expect(fitMove(s(-500, 0), [], [], 10, s(100, 600)).start_ms).toBe(0));
  it('no free spot that fits: stays where it was', () => expect(fitMove(s(1200, 3200), [s(0, 1000), s(2500, 4000), s(4000, 9000)], [], 10, s(1000, 2500))).toEqual(s(1000, 2500)));
});

describe('fitTrim', () => {
  const others = [s(0, 1000), s(3000, 4000)];
  it('end stops at the next clip', () => expect(fitTrim(s(1500, 3600), 'end', others, s(1500, 2000))).toEqual(s(1500, 3000)));
  it('start stops at the previous clip', () => expect(fitTrim(s(400, 2000), 'start', others, s(1500, 2000))).toEqual(s(1000, 2000)));
  it('shortening is untouched', () => expect(fitTrim(s(1500, 1800), 'end', others, s(1500, 2000))).toEqual(s(1500, 1800)));
});

describe('gapAt (Hapus jarak)', () => {
  const c = (clip_id: string, a: number, b: number) => ({ clip_id, start_ms: a, end_ms: b });
  const clips = [c('a', 0, 16000), c('b', 16100, 17000), c('d', 18000, 19000)];
  it('pulls every clip after the gap left by its width', () => expect(gapAt(clips, 16050)).toEqual({ clip_ids: ['b', 'd'], delta_ms: -100 }));
  it('a gap at the very start closes to 0', () => expect(gapAt([c('x', 500, 900)], 200)).toEqual({ clip_ids: ['x'], delta_ms: -500 }));
  it('inside a clip or after the last one: no gap', () => {
    expect(gapAt(clips, 500)).toBeNull();
    expect(gapAt(clips, 20000)).toBeNull();
  });
});
