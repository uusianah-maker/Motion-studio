import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
