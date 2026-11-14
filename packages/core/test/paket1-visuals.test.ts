import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEDIA_AREAS } from '../src/storage/permissions.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { MIN_THUMB_INTERVAL_MS, PEAK_BUCKET_MS, THUMB_HEIGHT, mediaVisuals } from '../src/storage/visuals.js';
import { fixtureWorkspace } from './fixtures.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('paket 1: timeline waveform + thumbnails', () => {
  it.skipIf(!hasFfmpeg)('waveform shows the pause, thumbnails follow the video, result cached; audio-only has no thumbs', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const file = path.join(fx.src, 'talk.mp4');
    // tone 1 s · silence 1.5 s · tone 1 s ; red 1.75 s → blue 1.75 s (9:16)
    execFileSync(
      FFMPEG,
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=1.75', '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=1.75',
        '-filter_complex', '[1]atrim=0:1.5[s];[0][s][2]concat=n=3:v=0:a=1[a];[3][4]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-g', '15', '-c:a', 'aac', file],
      { windowsHide: true },
    );
    const imp = await svc.importMedia({ sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
    const v = await mediaVisuals(fx.ws, { version_id: imp.version.version_id });
    expect(v.cached).toBe(false);

    const peaks = Buffer.from(v.peaks!.data, 'base64');
    expect(v.peaks!.bucket_ms).toBe(PEAK_BUCKET_MS);
    expect(peaks.length).toBeGreaterThan(3000 / PEAK_BUCKET_MS);
    const at = (ms: number) => peaks[Math.floor(ms / PEAK_BUCKET_MS)]!;
    expect(at(500)).toBeGreaterThan(150); // tone
    expect(at(1750)).toBeLessThan(10); // the pause
    expect(at(3000)).toBeGreaterThan(150); // tone again
    expect(Math.max(...peaks)).toBe(255); // normalised

    const t = v.thumbs!;
    expect(t.interval_ms).toBe(MIN_THUMB_INTERVAL_MS);
    expect(t.count).toBe(4);
    expect(t.frame_h).toBe(THUMB_HEIGHT);
    expect(t.frame_w).toBe(40); // 72 * 9/16 → even
    const jpg = Buffer.from(t.jpeg, 'base64');
    expect(jpg.subarray(0, 2).toString('hex')).toBe('ffd8');

    expect((await mediaVisuals(fx.ws, { version_id: imp.version.version_id })).cached).toBe(true);
    expect(await mediaVisuals(fx.ws, { version_id: 'v_nope' }).then(() => 'OK', (e) => e.code)).toBe('NOT_FOUND');

    const wav = path.join(fx.src, 'tone.wav');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=0.5', wav], { windowsHide: true });
    const a = await svc.importMedia({ sourcePath: wav, scope: { kind: 'shared' }, actor: 'user' });
    const av = await mediaVisuals(fx.ws, { version_id: a.version.version_id });
    expect(av.thumbs).toBeNull();
    expect(av.peaks).not.toBeNull();
  });

  // Regression (W05 UI-19 / W15 EJ-12, FFmpeg 9): a short clip with ONE keyframe made the MJPEG
  // encoder refuse the strip ("Non full-range YUV", -22) → 422 and no visuals at all.
  it.skipIf(!hasFfmpeg)('one-keyframe clips (the W05 MP4s) get a real thumbnail strip, frames follow the video', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'audit', 'T01', 'fixtures');
    for (const [name, wantPeaks] of [['sample_3s_16x9.mp4', false], ['sample_8s_9x16.mp4', true]] as const) {
      const imp = await svc.importMedia({ sourcePath: path.join(FIX, name), scope: { kind: 'shared' }, actor: 'user' });
      const v = await mediaVisuals(fx.ws, { version_id: imp.version.version_id });
      expect(v.gagal, name).toBeUndefined();
      expect(v.thumbs, name).not.toBeNull();
      expect(Buffer.from(v.thumbs!.jpeg, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(v.peaks !== null, name).toBe(wantPeaks);
      expect((await mediaVisuals(fx.ws, { version_id: imp.version.version_id })).cached).toBe(true);
    }
    // Red 2 s → blue 2 s with a single keyframe (phone-style long GOP): the strip shows both colours.
    const file = path.join(fx.src, 'satu-keyframe.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=2', '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-x264-params', 'scenecut=0:keyint=600', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
    const keys = execFileSync(process.env.MOTION_FFPROBE || 'ffprobe', ['-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { windowsHide: true }).toString().trim().split(/\s+/);
    expect(keys).toHaveLength(1); // the trigger shape
    const imp = await svc.importMedia({ sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
    const t = (await mediaVisuals(fx.ws, { version_id: imp.version.version_id })).thumbs!;
    expect(t.count).toBe(4);
    const jpg = path.join(fx.src, 'strip.jpg');
    await fsp.writeFile(jpg, Buffer.from(t.jpeg, 'base64'));
    const rgb = execFileSync(FFMPEG, ['-v', 'error', '-i', jpg, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 24 });
    const px = (frame: number) => {
      const x = frame * t.frame_w + t.frame_w / 2;
      const i = (Math.floor(t.frame_h / 2) * t.frame_w * t.count + x) * 3;
      return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!];
    };
    expect(px(0)[0]).toBeGreaterThan(180); // red at 0 s
    expect(px(0)[2]).toBeLessThan(80);
    expect(px(3)[2]).toBeGreaterThan(180); // blue at 3 s (not a copy of the first keyframe)
    expect(px(3)[0]).toBeLessThan(80);

    // A file FFmpeg cannot read (damaged on disk after import): the error the browser sees names
    // no local path (input file, temp JPEG).
    const rusak = path.join(fx.src, 'rusak.mp4'); // own content (not deduplicated with the cached one)
    await fsp.writeFile(rusak, Buffer.concat([await fsp.readFile(path.join(FIX, 'sample_3s_16x9.mp4')), Buffer.from('#rusak')]));
    const bad = await svc.importMedia({ sourcePath: rusak, scope: { kind: 'shared' }, actor: 'user' });
    const reg = await loadRegistry(fx.ws);
    const ver = reg.versions[bad.version.version_id]!;
    await fx.ws.blobs.withLocalFile(await fx.ws.blobs.resolve(ver.rel_path, MEDIA_AREAS), async (abs) => {
      await fsp.chmod(abs, 0o666); // media files are stored read-only
      await fsp.writeFile(abs, Buffer.alloc(4096, 7));
    });
    const msg = await mediaVisuals(fx.ws, { version_id: ver.version_id }).then(
      (r) => JSON.stringify(r.gagal ?? null),
      (e: Error) => e.message,
    );
    expect(msg).toMatch(/FFmpeg gagal/);
    expect(msg).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(msg).not.toContain(os.tmpdir());
    expect(msg).not.toContain('ms-thumbs-');
  });
});
