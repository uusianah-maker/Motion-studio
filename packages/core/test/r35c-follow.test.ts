import { describe, expect, it } from 'vitest';
import { validateBlur, placeOnCanvas } from '../src/storage/framing.js';
import { canvasBoxToSource, followBlurRegions, followTextKeyframes, longestPath, sourcePointToCanvas } from '../src/storage/follow.js';
import { validateKeyframes } from '../src/storage/keyframes.js';

/** R35c Lacak objek: preview box ↔ source box, tracked path → text keyframes / blur areas. */
const geo = { src: { w: 1920, h: 1080 }, canvas: { w: 1080, h: 1920 }, cover: false };

describe('R35c lacak objek', () => {
  it('canvas box → source box is the inverse of the preview/render placement', () => {
    // 16:9 source fitted (contain) in 9:16: picture band in the middle of the canvas.
    const area = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const r = placeOnCanvas(geo.src, undefined, geo.canvas, area);
    const back = canvasBoxToSource({ x: r.left / 1080, y: r.top / 1920, w: r.width / 1080, h: r.height / 1920 }, geo);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(area[k], 3);
    const c = sourcePointToCanvas({ x: 0.5, y: 0.5 }, geo);
    expect([c.x, c.y]).toEqual([0.5, 0.5]);
    // Cover (fit 'isi') + crop work the same way.
    const g2 = { ...geo, cover: true, crop: { x: 0.1, y: 0, w: 0.8, h: 1 } };
    const r2 = placeOnCanvas(g2.src, g2.crop, g2.canvas, area, true);
    const b2 = canvasBoxToSource({ x: r2.left / 1080, y: r2.top / 1920, w: r2.width / 1080, h: r2.height / 1920 }, g2);
    expect(b2.x).toBeCloseTo(0.25, 2);
  });
  it('longest path; text keyframes follow the centre, inside the text clip, ≤ 20, valid', () => {
    const data = { jalur: [{ titik: [{ t: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] }, { titik: [0, 1, 2, 3].map((t) => ({ t, x: 0.2 + t * 0.1, y: 0.4, w: 0.2, h: 0.2 })) }] };
    const pts = longestPath(data);
    expect(pts).toHaveLength(4);
    const kfs = followTextKeyframes(pts, { video: { start_ms: 1000, in_ms: 0 }, text: { start_ms: 1000, end_ms: 3500 }, base: { x: 0.5, y: 0.5 }, geo });
    expect(kfs.map((k) => k.at_ms)).toEqual([0, 1000, 2000]); // t=3 s → 3000 ms, after the text's 2,5 s
    expect(kfs[0]!.x).toBeCloseTo(sourcePointToCanvas({ x: 0.3, y: 0.5 }, geo).x - 0.5, 3);
    expect(validateKeyframes(kfs)).toHaveLength(3);
  });
  it('blur areas follow the path (time windows, source ms, valid)', () => {
    const pts = [0, 0.5, 1, 1.5, 2].map((t) => ({ t, x: 0.1 + t * 0.2, y: 0.3, w: 0.1, h: 0.1 }));
    const b = followBlurRegions(pts, 4);
    expect(b).toHaveLength(4);
    expect(b[0]!.dari_ms).toBe(0);
    expect(b[3]!.sampai_ms).toBe(2050);
    expect(b[0]!.x).toBeLessThan(b[3]!.x);
    expect(validateBlur(b)).toHaveLength(4);
    expect(followBlurRegions([], 3)).toEqual([]);
  });
});
