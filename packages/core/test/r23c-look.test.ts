import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOKS, LOOK_IDS, effectiveLook, lookCss, lookFilters, sepiaMixer } from '../src/storage/clipLook.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

/** R23c (owner 16 Nov): looks Vintage, Clean Product, Natural Skin Tone, Cinematic (own numbers); Pastel/Adem stay. */
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('R23c preset look', () => {
  it('four new looks next to the old ones (Pastel, Adem stay)', () => {
    expect(LOOK_IDS).toEqual(expect.arrayContaining(['pastel', 'adem', 'vintage', 'produk', 'kulit', 'sinematik']));
    expect(['vintage', 'produk', 'kulit', 'sinematik'].map((id) => LOOKS[id as keyof typeof LOOKS].label)).toEqual(['Vintage', 'Clean Product', 'Natural Skin Tone', 'Cinematic']);
  });
  it('sepia = the CSS matrix; grain + sepia reach both the render filters and the preview', () => {
    expect(sepiaMixer(1)).toBe('colorchannelmixer=rr=0.3930:rg=0.7690:rb=0.1890:gr=0.3490:gg=0.6860:gb=0.1680:br=0.2720:bg=0.5340:bb=0.1310');
    expect(sepiaMixer(0)).toBe('colorchannelmixer=rr=1.0000:rg=0.0000:rb=0.0000:gr=0.0000:gg=1.0000:gb=0.0000:br=0.0000:bg=0.0000:bb=1.0000');
    const v = effectiveLook({ look: 'vintage' });
    expect(v.tone).toEqual({ sepia: 0.35, grain: 10 });
    expect(lookFilters(v.adjust, v.mono, v.tone)).toMatch(/eq=.*colorchannelmixer=rr=0\.78\d\d.*vignette=.*noise=alls=10:allf=t$/);
    expect(lookCss(v.adjust, v.mono, v.tone)).toMatchObject({ grain: 10 });
    expect(lookCss(v.adjust, v.mono, v.tone).filter).toContain('sepia(0.350)');
    const p = effectiveLook({ look: 'produk' });
    expect(lookFilters(p.adjust, p.mono, p.tone)).toContain('unsharp=');
    // Own adjust still adds on top of a look (hybrid).
    expect(effectiveLook({ look: 'kulit', adjust: { terang: 10, kontras: 0, saturasi: 0, suhu: 0, tajam: 0, vignette: 0 } }).adjust.terang).toBe(14);
    expect(effectiveLook({ look: 'hangat' }).tone).toEqual({ sepia: 0, grain: 0 });
  });

  it.skipIf(!hasFfmpeg)('real render: Vintage warms + grains a gray picture; Cinematic darkens the corners', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const f = path.join(fx.src, 'abu.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8a8a8a:s=180x320:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    const m = { media_id: r.media.media_id, version_id: r.version.version_id };
    await createProject(fx.ws, { project_id: 'lk', name: 'lk' });
    await svc.editTimeline({ project_id: 'lk', expected_revision: 0, actor: 'user', ops: [
      { op: 'add_clip', track_kind: 'video', media: m, start_ms: 0, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: m, start_ms: 1000, duration_ms: 1000, look: 'vintage' },
      { op: 'add_clip', track_kind: 'video', media: m, start_ms: 2000, duration_ms: 1000, look: 'sinematik' },
    ] as never });
    const res = await renderProject(fx.ws, { project_id: 'lk', output_name: 'lk.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
    expect(res.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'lk'))[0]!.rel);
    const frame = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    const px = (b: Buffer, x: number, y: number): [number, number, number] => [b[(y * 180 + x) * 3]!, b[(y * 180 + x) * 3 + 1]!, b[(y * 180 + x) * 3 + 2]!];
    const plain = frame(0.5);
    const vint = frame(1.5);
    const [pr, , pb] = px(plain, 90, 160);
    const [vr, , vb] = px(vint, 90, 160);
    expect(Math.abs(pr - pb)).toBeLessThan(6); // gray stays gray without a look
    expect(vr - vb).toBeGreaterThan(20); // Vintage: sepia + warm
    // Grain: neighbouring pixels of a flat picture differ.
    const spread = (b: Buffer) => {
      const vals = Array.from({ length: 40 }, (_, i) => px(b, 70 + i, 160)[1]);
      return Math.max(...vals) - Math.min(...vals);
    };
    expect(spread(vint)).toBeGreaterThan(spread(plain) + 4);
    const cine = frame(2.5);
    expect(px(cine, 3, 3)[1]).toBeLessThan(px(cine, 90, 160)[1] - 15); // vignette
  }, 120_000);
});
