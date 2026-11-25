import { describe, expect, it } from 'vitest';
import { RAMP_MS, validateEffect, zoomAt, zoomExpr } from '../src/storage/effects.js';
import { KF_EASES, easeExpr, easeOf, keyframeAt, kfExpr, validateKeyframes } from '../src/storage/keyframes.js';

/** Evaluate the small FFmpeg expression subset we emit (if/lt/clip/pow/cos/PI/min) in JS. */
function ff(expr: string, t: number): number {
  const js = expr
    .replace(/\bPI\b/g, 'Math.PI')
    .replace(/\bcos\(/g, 'Math.cos(')
    .replace(/\bsin\(/g, 'Math.sin(')
    .replace(/\bpow\(/g, 'Math.pow(')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bclip\(/g, '__clip(')
    .replace(/\bif\(/g, '__if(')
    .replace(/\blt\(/g, '__lt(');
  return new Function('t', '__clip', '__if', '__lt', `return ${js};`)(t, (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)), (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0)) as number;
}

describe('25 Nov: gerak keyframe & zoom lebih halus (keluhan owner)', () => {
  it('every easing: preview formula = render expression, 0→0 and 1→1', () => {
    for (const e of KF_EASES) {
      expect(easeOf(e, 0)).toBeCloseTo(0, 9);
      expect(easeOf(e, 1)).toBeCloseTo(1, 9);
      for (const p of [0.1, 0.25, 0.5, 0.8]) expect(ff(easeExpr(e, String(p)), 0)).toBeCloseTo(easeOf(e, p), 9);
    }
    expect(easeOf('in', 0.2)).toBeLessThan(0.2); // mulai pelan
    expect(easeOf('out', 0.2)).toBeGreaterThan(0.2); // berhenti pelan
    expect(easeOf('lembut', 0.8)).toBeGreaterThan(easeOf('out', 0.8)); // ekor lebih panjang
  });
  it('keyframes accept the new easings and render = preview at every frame', () => {
    const kfs = validateKeyframes([
      { at_ms: 0, scale: 1 },
      { at_ms: 700, scale: 1.3, x: 0.1, ease: 'in' },
      { at_ms: 1500, scale: 1, ease: 'lembut' },
      { at_ms: 2000, scale: 1.1, ease: 'out' },
    ]);
    for (const prop of ['scale', 'x'] as const) {
      const e = kfExpr(kfs, prop, 't');
      for (let ms = 0; ms <= 2200; ms += 1000 / 30) expect(ff(e, ms / 1000)).toBeCloseTo(keyframeAt(kfs, ms)[prop], 4);
    }
    expect(() => validateKeyframes([{ at_ms: 0, ease: 'bounce' }])).toThrow(/ease harus/);
  });
  it('smooth zoom ramps 600 ms by default, ramp_ms adjustable, zoom_through eased', () => {
    expect(RAMP_MS).toBe(600);
    const z = validateEffect({ type: 'zoom', scale: 1.2 });
    expect(zoomAt(z, 300, 3000)).toBeGreaterThan(1.05);
    expect(zoomAt(z, 300, 3000)).toBeLessThan(1.15); // still on its way in at 0.3 s
    expect(zoomAt(z, 600, 3000)).toBeCloseTo(1.2, 6);
    const slow = validateEffect({ type: 'zoom', scale: 1.2, ramp_ms: 1200 });
    expect(slow).toMatchObject({ ramp_ms: 1200 });
    expect(zoomAt(slow, 600, 4000)).toBeCloseTo(1.1, 6);
    expect(() => validateEffect({ type: 'zoom', ramp_ms: 50 })).toThrow(/ramp_ms/);
    for (const e of [z, slow, validateEffect({ type: 'zoom_through', scale: 1.4 })]) {
      const ex = zoomExpr(e, 2000, 5000);
      for (let ms = 2000; ms < 5000; ms += 100) expect(ff(ex, ms / 1000)).toBeCloseTo(zoomAt(e, ms - 2000, 3000), 3);
    }
    // zoom_through no longer a linear push: slow start
    const zt = validateEffect({ type: 'zoom_through', scale: 1.4 });
    expect(zoomAt(zt, 100, 1000) - 1).toBeLessThan(0.4 * 0.1);
  });
});

describe('25 Nov: keyframe rotasi (keyframe manual)', () => {
  it('rot is optional, interpolated, and the render rotates around the anchor like CSS', async () => {
    const { kfCorners, keyframeCss } = await import('../src/storage/keyframes.js');
    const kfs = validateKeyframes([{ at_ms: 0 }, { at_ms: 1000, rot: 90, ease: 'linear' }]);
    expect(kfs[0]).not.toHaveProperty('rot');
    expect(keyframeAt(kfs, 500).rot).toBeCloseTo(45);
    expect(keyframeCss(keyframeAt(kfs, 500)).transform).toContain('rotate(45.000deg)');
    // 90° at t = 1: a 100×50 picture anchored at its centre (60, 35) → top-left corner goes to (85, -15).
    const c = kfCorners(kfs, 't', '60', '35', [50, 50, 25, 25]);
    expect(ff(c.x0, 1)).toBeCloseTo(85, 6);
    expect(ff(c.y0, 1)).toBeCloseTo(-15, 6);
    // without rotation the corners are the old plain expressions (no sin/cos)
    expect(kfCorners(validateKeyframes([{ at_ms: 0 }, { at_ms: 900, scale: 2 }]), 't', '1', '1', [1, 1, 1, 1]).x0).not.toContain('cos');
    expect(() => validateKeyframes([{ at_ms: 0, rot: 400 }])).toThrow(/rot/);
  });
});
