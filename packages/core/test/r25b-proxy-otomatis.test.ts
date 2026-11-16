// R25b (kasus nyata 16 Nov: footage DJI HEVC Main 10, 59,94 fps → pratinjau hitam): the proxy rule
// also catches 10-bit / 4:2:2 video, > 30 fps and a long side over 1920 px; the probe records pix_fmt
// and fps; the proxy is 8-bit H.264 ≤ 30 fps; the RENDER still reads the original file.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHeavyPixFmt, makeProxy, needsProxy, proxyPath } from '../src/storage/proxy.js';
import { validateProbe } from '../src/storage/probe.js';
import { loadRegistry } from '../src/storage/registry.js';
import { listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const has = (enc: string) => {
  try {
    return execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { windowsHide: true }).toString().includes(enc);
  } catch {
    return false;
  }
};
const hasX265 = has('libx265');

describe('R25b aturan proxy otomatis', () => {
  const light = { video_codec: 'h264', width: 540, height: 960, duration_ms: 10_000 };
  it('10-bit / 4:2:2, > 30 fps and a long side > 1920 need a proxy even when small and light', () => {
    expect(needsProxy({ ...light, pix_fmt: 'yuv420p', fps: 30 }, 1_200_000)).toBe(false);
    expect(needsProxy({ ...light, pix_fmt: 'yuv420p10le', fps: 30 }, 1_200_000)).toBe(true);
    expect(needsProxy({ ...light, pix_fmt: 'yuv422p', fps: 30 }, 1_200_000)).toBe(true);
    expect(needsProxy({ ...light, pix_fmt: 'yuv420p', fps: 59.94 }, 1_200_000)).toBe(true);
    expect(needsProxy({ ...light, width: 500, height: 2400 }, 1_200_000)).toBe(true);
    expect(needsProxy({ ...light, video_codec: 'hevc' }, 1_200_000)).toBe(true);
    expect(needsProxy({ ...light, video_codec: null, pix_fmt: null, fps: null }, 1_200_000)).toBe(false); // audio only
    expect([isHeavyPixFmt('yuv420p'), isHeavyPixFmt('nv12'), isHeavyPixFmt('yuv420p10le'), isHeavyPixFmt('p010le'), isHeavyPixFmt('yuv444p')]).toEqual([false, false, true, true, true]);
  });
  it('probe: pix_fmt + fps are optional (old registries stay valid), bad values dropped', () => {
    const base = { duration_ms: 1000, width: 10, height: 10, video_codec: 'h264', audio_codec: null };
    expect(validateProbe(base)).toEqual(base);
    expect(validateProbe({ ...base, pix_fmt: 'yuv420p10le', fps: 59.94 })).toEqual({ ...base, pix_fmt: 'yuv420p10le', fps: 59.94 });
    expect(validateProbe({ ...base, pix_fmt: 5, fps: -1 })).toEqual(base);
  });

  it.skipIf(!hasX265)('HEVC 10-bit 60 fps: import records pix_fmt/fps → 8-bit H.264 30 fps proxy; render reads the ORIGINAL', async () => {
    const { ws, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const f = path.join(src, 'dji-kecil.mp4');
    // Small like the team's DJI clip but tiny: HEVC Main 10, 59,94 fps, red top / blue bottom.
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=360x640:r=60000/1001:d=2,geq=r='if(lt(Y\\,320)\\,220\\,30)':g='30':b='if(lt(Y\\,320)\\,30\\,220)'", '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', f], { windowsHide: true });
    const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    const vid = imp.version.version_id;
    expect((await loadRegistry(ws)).versions[vid]!.probe).toMatchObject({ video_codec: 'hevc', pix_fmt: 'yuv420p10le', fps: 59.94 });
    expect(await makeProxy(ws, vid)).toBe('dibuat');
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,avg_frame_rate', '-of', 'json', proxyPath(ws, vid)], { windowsHide: true }).toString());
    expect(info.streams[0]).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', avg_frame_rate: '30/1' });

    // Render: the proxy is replaced by garbage — the render still works, so it reads the original.
    await fsp.writeFile(proxyPath(ws, vid), 'bukan video');
    await createProject(ws, { project_id: 'dji', name: 'DJI' });
    await svc.editTimeline({ project_id: 'dji', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: vid }, start_ms: 0, duration_ms: 1000 }] });
    const res = await renderProject(ws, { project_id: 'dji', output_name: 'dji.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast', fps: 60 } });
    expect(res.status).toBe('completed');
    const out = path.join(ws.root, (await listOutputs(ws, 'dji'))[0]!.rel);
    const o = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,avg_frame_rate', '-select_streams', 'v:0', '-of', 'json', out], { windowsHide: true }).toString());
    expect(o.streams[0]).toMatchObject({ codec_name: 'h264', avg_frame_rate: '60/1' });
    const px = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const at = (x: number, y: number) => [px[(y * 360 + x) * 3]!, px[(y * 360 + x) * 3 + 2]!];
    expect(at(180, 100)[0]).toBeGreaterThan(150); // red top from the original
    expect(at(180, 540)[1]).toBeGreaterThan(150); // blue bottom
  }, 120_000);
});
