import { describe, expect, it } from 'vitest';
import { validateKeyframes } from '../src/storage/keyframes.js';
import { reframeCanvas, reframeKeyframes } from '../src/storage/visualCalc.js';

/** R23g / R35b: the engine's keyframe_app (§18.2) → valid keyframes on the clip. */
const kf = (at_ms: number, x = 0, scale = 3.16) => ({ at_ms, x, y: 0, scale, opacity: 1, ease: 'linear' });

describe('R23g auto reframe', () => {
  it('canvas size per ratio (1080 short side)', () => {
    expect(reframeCanvas('9:16')).toEqual([1080, 1920]);
    expect(reframeCanvas('16:9')).toEqual([1920, 1080]);
    expect(reframeCanvas('1:1')).toEqual([1080, 1080]);
    expect(reframeCanvas('3:4')).toEqual([1080, 1440]);
  });
  it('clamps to the clip: before 0 → value at 0, after the end dropped, rising, ≤ 20, valid for the editor', () => {
    const out = reframeKeyframes([kf(-500, 0.4), kf(-100, 0.5), kf(1000, -0.2), kf(1000, 0.9), kf(5000, 0)], 3000);
    expect(out.map((k) => [k.at_ms, k.x])).toEqual([[0, 0.5], [1000, -0.2]]);
    expect(validateKeyframes(out)).toHaveLength(2);
    const many = reframeKeyframes(Array.from({ length: 60 }, (_, i) => kf(i * 100, (i % 10) / 10 - 0.5)), 10_000);
    expect(many).toHaveLength(20);
    expect(many[0]!.at_ms).toBe(0);
    expect(many[19]!.at_ms).toBe(5900);
    expect(validateKeyframes(many)).toHaveLength(20);
    expect(reframeKeyframes([kf(0, 5, 9)], 1000)[0]).toMatchObject({ x: 1, scale: 4 }); // clamped to the editor's ranges
    expect(reframeKeyframes(null, 1000)).toEqual([]);
  });
});
