/**
 * 25 Nov (Video AI): the bytes of one usable media version (active, integrity ok), for sending a
 * picture / clip to an AI provider as a reference. Never a path to the browser.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { StorageError } from './errors.js';
import { MEDIA_AREAS } from './permissions.js';
import type { MediaRef } from './project.js';
import { loadRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

export async function readMediaBytes(ws: Workspace, ref: MediaRef, maxBytes: number): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[ref.version_id];
  if (!v || v.media_id !== ref.media_id) throw new StorageError('NOT_FOUND', 'Media tidak dikenal');
  if (v.lifecycle !== 'active' || v.integrity !== 'ok') throw new StorageError('PRECONDITION', `Media "${v.original_name}" tidak bisa dipakai (${v.lifecycle} / ${v.integrity})`);
  const ext = path.extname(v.original_name).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new StorageError('PRECONDITION', `Jenis file "${v.original_name}" tidak didukung (png, jpg, webp, mp4, mov)`);
  if (v.size > maxBytes) throw new StorageError('PRECONDITION', `"${v.original_name}" lebih dari ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  const bytes = await ws.blobs.withLocalFile(rel, (abs) => fsp.readFile(abs));
  return { bytes, mime, name: v.original_name };
}
