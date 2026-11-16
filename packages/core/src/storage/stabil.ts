/**
 * R23f stabilisasi (owner 16 Nov, alat edit gaya CapCut — teknik saja, FFmpeg vid.stab). A shaky
 * clip gets a stabilised copy of its media version, made ONCE in the background (two passes:
 * vidstabdetect → vidstabtransform), cached per version + strength in `.motionstudio/stabil/`.
 * The render uses that copy for clips marked `stabil`; the preview plays it too (same picture).
 * The original is never touched; turning stabilisation off simply uses the original again.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageError } from './errors.js';
import { ffmpegBin } from './ffmpeg.js';
import { isSafeId } from './ids.js';
import { MEDIA_AREAS } from './permissions.js';
import { lowerPriority } from './priority.js';
import { loadRegistry } from './registry.js';
import { LAYOUT, type Workspace } from './workspace.js';

import { STABIL_LEVELS, type StabilLevel } from './clipMotion.js';
export { STABIL_LEVELS, type StabilLevel } from './clipMotion.js';
/** Own numbers: how hard the camera path is smoothed (frames) and how shaky the input is assumed. */
export const STABIL_SETTINGS: Record<StabilLevel, { shakiness: number; smoothing: number }> = { ringan: { shakiness: 5, smoothing: 12 }, kuat: { shakiness: 8, smoothing: 30 } };
/** vid.stab keeps every transform in memory and is slow: one clip of at most this length. */
export const STABIL_MAX_S = 120;

export const stabilPath = (ws: Workspace, versionId: string, level: StabilLevel): string => {
  if (!isSafeId(versionId) || !STABIL_LEVELS.includes(level)) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  return path.join(ws.root, LAYOUT.meta, 'stabil', `${versionId}-${level}.mp4`);
};
export async function stabilReady(ws: Workspace, versionId: string, level: StabilLevel): Promise<boolean> {
  const st = await fsp.stat(stabilPath(ws, versionId, level)).catch(() => null);
  return !!st?.isFile() && st.size > 0;
}

/** Both FFmpeg commands (pure; tests check them). The transforms file is relative to the work dir. */
export function stabilArgs(src: string, out: string, level: StabilLevel): { detect: string[]; transform: string[] } {
  const s = STABIL_SETTINGS[level];
  return {
    detect: ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src, '-vf', `vidstabdetect=shakiness=${s.shakiness}:accuracy=15:result=transforms.trf`, '-f', 'null', '-'],
    transform: [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      // optzoom=1: just enough zoom to hide the moving edges; a light sharpen after the resample.
      '-vf', `vidstabtransform=input=transforms.trf:smoothing=${s.smoothing}:optzoom=1:zoomspeed=0.25:interpol=bicubic,unsharp=5:5:0.6:3:3:0.4,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'copy',
      '-map_metadata', '-1', '-movflags', '+faststart', '-threads', '2', out,
    ],
  };
}

function run(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    lowerPriority(child);
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-2000)));
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(new StorageError('RENDER_FAILED', `Stabilisasi gagal: ${err.trim().split('\n').pop() ?? code}`));
    });
  });
}

/** Make the stabilised copy (idempotent). */
export async function makeStabil(ws: Workspace, versionId: string, level: StabilLevel, opts: { signal?: AbortSignal } = {}): Promise<'dibuat' | 'sudah_ada'> {
  const out = stabilPath(ws, versionId, level);
  if (await stabilReady(ws, versionId, level)) return 'sudah_ada';
  const reg = await loadRegistry(ws);
  const v = reg.versions[versionId];
  if (!v) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', 'Media tidak aktif (di Trash)');
  if (!v.probe?.video_codec) throw new StorageError('PRECONDITION', 'Stabilisasi hanya untuk video');
  if (v.probe.duration_ms > STABIL_MAX_S * 1000) throw new StorageError('PRECONDITION', `Stabilisasi maksimal ${STABIL_MAX_S / 60} menit per video; potong dulu`);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-stabil-'));
  try {
    const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
    await ws.blobs.withLocalFile(rel, async (src) => {
      const tmp = path.join(work, `hasil-${randomBytes(4).toString('hex')}.mp4`);
      const a = stabilArgs(src, tmp, level);
      await run(a.detect, work, opts.signal);
      await run(a.transform, work, opts.signal);
      await fsp.rename(tmp, out).catch(async () => {
        await fsp.copyFile(tmp, out);
      });
    });
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  return 'dibuat';
}
