// R14: light preview copies — 540 px short side, H.264 ~1.2 Mbps, a keyframe every second,
// AAC 96k; made once, skipped for files already that light; the original is untouched.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeProxy, needsProxy, proxyPath, proxyReady } from '../src/storage/proxy.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { fixtureWorkspace } from './fixtures.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('R14 preview proxy', () => {
  it('decides when a proxy is needed', () => {
    expect(needsProxy({ video_codec: 'h264', width: 2160, height: 3840, duration_ms: 49_000 }, 130 * 1024 * 1024)).toBe(true); // 4K, 21 Mbps
    expect(needsProxy({ video_codec: 'h264', width: 540, height: 960, duration_ms: 10_000 }, 1_200_000)).toBe(false); // already light
    expect(needsProxy({ video_codec: 'h264', width: 540, height: 960, duration_ms: 10_000 }, 10_000_000)).toBe(true); // small but 8 Mbps
    expect(needsProxy({ video_codec: null, width: null, height: null, duration_ms: 5000 }, 80_000)).toBe(false); // audio only
    expect(needsProxy({ video_codec: 'hevc', width: 540, height: 960, duration_ms: 10_000 }, 1_200_000)).toBe(true); // light but HEVC: the browser cannot play it
  });

  it.skipIf(!hasFfmpeg)('makes a 540p, 1 s-keyframe H.264/AAC copy once; the original version stays as it was', async () => {
    const { ws, src } = await fixtureWorkspace();
    const svc = new StorageService(ws);
    const f = path.join(src, 'besar.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1080x1920:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-g', '90', '-b:v', '8M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', 'title=rahasia-kamera', f], { windowsHide: true });
    const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    const vid = imp.version.version_id;
    const before = (await loadRegistry(ws)).versions[vid]!;
    expect(await proxyReady(ws, vid)).toBe(false);
    expect(await makeProxy(ws, vid)).toBe('dibuat');
    expect(await proxyReady(ws, vid)).toBe(true);
    const out = proxyPath(ws, vid);
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format_tags', '-of', 'json', out], { windowsHide: true }).toString());
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    const a = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
    expect([v.codec_name, v.width, v.height]).toEqual(['h264', 540, 960]);
    expect(a.codec_name).toBe('aac');
    expect(JSON.stringify(info.format?.tags ?? {})).not.toContain('rahasia-kamera');
    const keys = execFileSync(FFPROBE, ['-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', out], { windowsHide: true })
      .toString()
      .trim()
      .split(/\s+/)
      .map((x) => Number(x.replace(',', '')));
    expect(keys.length).toBeGreaterThanOrEqual(3); // ~0, 1, 2 s (the source had one keyframe per 3 s)
    expect((await fsp.stat(out)).size).toBeLessThan(before.size);
    expect(await makeProxy(ws, vid)).toBe('sudah_ada');
    expect((await loadRegistry(ws)).versions[vid]).toEqual(before); // the original is never touched

    // A file that is already light needs none.
    const kecil = path.join(src, 'kecil.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=2', '-c:v', 'libx264', '-b:v', '300k', '-pix_fmt', 'yuv420p', kecil], { windowsHide: true });
    const k = await svc.importMedia({ sourcePath: kecil, scope: { kind: 'shared' }, actor: 'user' });
    expect(await makeProxy(ws, k.version.version_id)).toBe('tidak_perlu');
    expect(await proxyReady(ws, k.version.version_id)).toBe(false);
  }, 90_000);
});
