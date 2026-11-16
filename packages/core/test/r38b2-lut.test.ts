import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_BRAND, brandRenderRefs } from '../src/storage/brand.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R38b(2): colour LUTs rendered with FFmpeg lut3d — clip LUT, Brand default LUT, look "none" = off. */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cube = (size: number, f: (r: number, g: number, b: number) => [number, number, number]) => {
  const lines = ['TITLE "uji"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
};
const L = { media_id: 'ml', version_id: 'vl' };
const V = { media_id: 'm', version_id: 'v' };

describe('R38b(2) LUT render', () => {
  it('brandRenderRefs: the Brand LUT is needed only when a picture clip follows it', () => {
    const kit = { ...EMPTY_BRAND, lut_bawaan: L };
    const tl = (extra: object) => ({ tracks: [{ track_id: 't', kind: 'video' as const, clips: [{ clip_id: 'c', start_ms: 0, end_ms: 1000, media: V, in_ms: 0, ...extra }] }] });
    expect(brandRenderRefs(tl({}), kit).lut).toEqual(L);
    expect(brandRenderRefs(tl({ look: 'none' }), kit).lut).toBeNull();
    expect(brandRenderRefs(tl({ lut: { media_id: 'x', version_id: 'y' } }), kit).lut).toBeNull();
    expect(brandRenderRefs({ tracks: [] }, kit).lut).toBeNull();
  });
  it('plan: lut3d with the job-folder file after the look; clip LUT wins over the Brand one', () => {
    const inputs = new Map([['v', { path: 'a.mp4', probe: { duration_ms: 3000, width: 180, height: 320, video_codec: 'h264', audio_codec: null, fps: 30 } }]]);
    const t = { tracks: [{ track_id: 't', kind: 'video' as const, clips: [{ clip_id: 'c', start_ms: 0, end_ms: 1000, media: V, in_ms: 0, look: 'hangat' as const }, { clip_id: 'd', start_ms: 1000, end_ms: 2000, media: V, in_ms: 0, lut: { media_id: 'x', version_id: 'vx' } }] }] };
    const plan = buildRenderPlan(t as never, inputs as never, { ...DEFAULT_RENDER, short_side: 180 }, null, null, { font: null, logo: null, lut: L, luts: new Map([['vl', 'lut_vl.cube'], ['vx', 'lut_vx.cube']]) });
    expect(plan.graph).toMatch(/eq=[^[]*lut3d=file=lut_vl\.cube/);
    expect(plan.graph).toContain('lut3d=file=lut_vx.cube');
    expect(plan.graph.match(/lut3d/g)).toHaveLength(2);
  });

  it.skipIf(!hasFfmpeg)('real render: clip LUT inverts, Brand LUT applies to the rest, look "none" switches it off', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const imp = async (name: string, content: string | null, filter?: string) => {
      const f = path.join(fx.src, name);
      if (content !== null) await fsp.writeFile(f, content);
      else execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter!, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '8', f], { windowsHide: true });
      const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    const red = await imp('merah.mp4', null, 'color=c=0xc02020:s=180x320:r=30:d=3');
    const invert = await imp('invert.cube', cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    const toBlue = await imp('biru.cube', cube(2, (r, g, b) => [0, 0, Math.max(r, g, b)]));
    await svc.createBrand({ kit: { name: 'Lut', kode: 'LUT', lut_bawaan: toBlue }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'lt', name: 'lt' });
    await svc.editTimeline({ project_id: 'lt', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 1000, lut: invert },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 1000, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: red, start_ms: 2000, duration_ms: 1000, look: 'none' },
    ] as never });
    const res = await renderProject(fx.ws, { project_id: 'lt', output_name: 'lt.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'lt'))[0]!.rel);
    const at = (t: number) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      const i = (160 * 180 + 90) * 3;
      return [b[i]!, b[i + 1]!, b[i + 2]!];
    };
    const inv = at(0.5); // inverted red → cyan
    expect(inv[0]).toBeLessThan(90);
    expect(inv[1]).toBeGreaterThan(170);
    const brand = at(1.5); // Brand LUT → blue only
    expect(brand[0]).toBeLessThan(40);
    expect(brand[2]).toBeGreaterThan(150);
    const off = at(2.5); // look none → original red
    expect(off[0]).toBeGreaterThan(150);
    expect(off[2]).toBeLessThan(80);
  }, 120_000);
});
