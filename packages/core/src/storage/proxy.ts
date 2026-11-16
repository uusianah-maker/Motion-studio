/**
 * R14: light preview copies ("proxy") so the editor plays smoothly through the tunnel. A 4K
 * 21 Mbps original needs ~2.6 MB/s; the proxy is 540 px on the short side, H.264 ~1.2 Mbps,
 * a keyframe every second (fast seeking), AAC 96 kbps, metadata stripped. Made once per media
 * version in the background; the editor preview uses it when it exists, RENDER ALWAYS USES THE
 * ORIGINAL. Stored outside the media areas (`.motionstudio/proxy/<version_id>.mp4`): never a
 * source, never in a project, and it can always be made again.
 */
import { spawn } from 'node:child_process';
import { lowerPriority } from './priority.js';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from './errors.js';
import { ffmpegBin } from './ffmpeg.js';
import { isSafeId } from './ids.js';
import { MEDIA_AREAS } from './permissions.js';
import { BROWSER_VIDEO_CODECS, probeFile } from './probe.js';
import { loadRegistry } from './registry.js';
import { LAYOUT, type Workspace } from './workspace.js';

export const PROXY_SHORT_SIDE = 540;
export const PROXY_VIDEO_KBPS = 1200;
export const PROXY_AUDIO_KBPS = 96;

export const proxyPath = (ws: Workspace, versionId: string): string => {
  if (!isSafeId(versionId)) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  return path.join(ws.root, LAYOUT.meta, 'proxy', `${versionId}.mp4`);
};

export async function proxyReady(ws: Workspace, versionId: string): Promise<boolean> {
  const st = await fsp.stat(proxyPath(ws, versionId)).catch(() => null);
  return !!st?.isFile() && st.size > 0;
}

export type ProxyResult = 'dibuat' | 'sudah_ada' | 'tidak_perlu';

/** R25b: a pixel format the browser cannot decode (10/12-bit, 4:2:2 / 4:4:4 from cameras). */
export const isHeavyPixFmt = (f: string | null | undefined): boolean => !!f && (/(p(10|12|16)|^p01[026])(le|be)?$/.test(f) || /^yuv4(22|44)/.test(f));
/** Above this the browser struggles (DJI 59,94 fps, 4K): always a light copy. */
export const PROXY_MAX_FPS = 30.5;
export const PROXY_MAX_LONG_SIDE = 1920;

/** A file already this light plays fine as it is (no proxy). */
export function needsProxy(p: { video_codec: string | null; width: number | null; height: number | null; duration_ms: number; pix_fmt?: string | null; fps?: number | null }, size: number): boolean {
  if (!p.video_codec || p.duration_ms <= 0) return false;
  // A codec the browser cannot play (HEVC from DJI/iPhone) always needs the h264 copy, whatever its size.
  if (!BROWSER_VIDEO_CODECS.has(p.video_codec)) return true;
  // R25b: 10-bit / 4:2:2 even in h264, high frame rate, or a long side over 1920 px.
  if (isHeavyPixFmt(p.pix_fmt) || (p.fps ?? 0) > PROXY_MAX_FPS || Math.max(p.width ?? 0, p.height ?? 0) > PROXY_MAX_LONG_SIDE) return true;
  const short = Math.min(p.width ?? 0, p.height ?? 0) || Infinity;
  const kbps = (size * 8) / (p.duration_ms / 1000) / 1000;
  return short > PROXY_SHORT_SIDE || kbps > PROXY_VIDEO_KBPS * 1.5;
}

/** Make the proxy of one active video version (idempotent). */
export async function makeProxy(ws: Workspace, versionId: string, opts: { signal?: AbortSignal } = {}): Promise<ProxyResult> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[versionId];
  if (!v) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', 'Media tidak aktif (di Trash)');
  const out = proxyPath(ws, versionId);
  if (await proxyReady(ws, versionId)) return 'sudah_ada';
  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  return ws.blobs.withLocalFile(rel, async (src) => {
    const probe = v.probe ?? (await probeFile(src));
    // R25b: older registry probes lack pix_fmt/fps — read them from the file then.
    const full = probe && probe.pix_fmt === undefined && probe.video_codec ? ((await probeFile(src)) ?? probe) : probe;
    if (!full || !needsProxy(full, v.size)) return 'tidak_perlu' as const;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${randomBytes(4).toString('hex')}.tmp.mp4`;
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      // R25b: 59,94 fps footage gets a 30 fps copy (preview only; render reads the original).
      '-vf', `${(full.fps ?? 0) > PROXY_MAX_FPS ? 'fps=30,' : ''}scale='if(gte(iw,ih),-2,${PROXY_SHORT_SIDE})':'if(gte(iw,ih),${PROXY_SHORT_SIDE},-2)',format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${PROXY_VIDEO_KBPS}k`, '-maxrate', `${Math.round(PROXY_VIDEO_KBPS * 1.25)}k`, '-bufsize', `${PROXY_VIDEO_KBPS * 2}k`,
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-c:a', 'aac', '-b:a', `${PROXY_AUDIO_KBPS}k`, '-ac', '2',
      '-map_metadata', '-1', '-movflags', '+faststart',
      // A background job: two threads at below-normal priority leave the PC usable.
      '-threads', '2',
      tmp,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        lowerPriority(child);
        let err = '';
        child.stderr.on('data', (b: Buffer) => {
          if (err.length < 2000) err += b.toString();
        });
        const abort = () => child.kill('SIGKILL');
        opts.signal?.addEventListener('abort', abort, { once: true });
        child.on('error', (e) => reject(new StorageError('PRECONDITION', `FFmpeg tidak bisa dijalankan: ${e.message}`)));
        child.on('close', (code) => {
          opts.signal?.removeEventListener('abort', abort);
          if (code === 0) resolve();
          else reject(new StorageError('PRECONDITION', `Pratinjau ringan gagal dibuat (FFmpeg ${code})`));
        });
      });
      await fsp.rename(tmp, out);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
    return 'dibuat' as const;
  });
}
