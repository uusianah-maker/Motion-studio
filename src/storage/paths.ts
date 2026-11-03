import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { StorageError } from './errors.js';

/**
 * Path rules (ADR-001 D3). Windows rules are applied on every OS so a workspace
 * stays portable and cannot hold names that are dangerous on Windows.
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const FORBIDDEN_PRINTABLE = /[<>:"|?*]/;
/** Printable forbidden chars (incl. ":" for NTFS streams/drives) and control chars < 0x20. */
const hasForbiddenChar = (seg: string): boolean =>
  FORBIDDEN_PRINTABLE.test(seg) || [...seg].some((ch) => ch.charCodeAt(0) < 0x20);
const MAX_REL_LENGTH = 1024;
/** 8.3 short names (PROGRA~1, MOTION~1) alias long names on Windows: reject any `~<digit>`. */
const SHORT_NAME = /~[0-9]/;
const isWin = process.platform === 'win32';
/** OS-level realpath: resolves junctions/symlinks and normalizes case on Windows. */
export const realpathNative = promisify(fs.realpath.native);

/** Validate a workspace-relative path and return its segments. Never touches the disk. */
export function relativeSegments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_LENGTH) {
    throw new StorageError('PATH_INVALID', 'Path kosong atau terlalu panjang', { rel });
  }
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new StorageError('PATH_INVALID', 'Path harus relatif terhadap workspace', { rel });
  }
  const segs = rel.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new StorageError('PATH_INVALID', `Segmen path tidak valid: "${seg}"`, { rel });
    }
    if (hasForbiddenChar(seg)) {
      throw new StorageError('PATH_INVALID', 'Path berisi karakter terlarang (termasuk ":" / stream NTFS)', { rel });
    }
    if (/[. ]$/.test(seg)) {
      throw new StorageError('PATH_INVALID', 'Segmen path tidak boleh berakhir titik/spasi', { rel });
    }
    if (SHORT_NAME.test(seg)) {
      throw new StorageError('PATH_INVALID', 'Nama pendek 8.3 (mis. "SHARED~1") tidak diizinkan', { rel });
    }
    if (WIN_RESERVED.test(seg)) {
      throw new StorageError('PATH_INVALID', `Nama perangkat Windows terlarang: ${seg}`, { rel });
    }
  }
  return segs;
}

/** Canonical form of a workspace-relative path (forward slashes). */
export function normalizeRelative(rel: string): string {
  return relativeSegments(rel).join('/');
}

const fold = (p: string): string => (isWin ? p.toLowerCase() : p);

/** True when `child` equals or lies inside `parent` (both absolute, already canonical). */
export function isInside(parent: string, child: string): boolean {
  const r = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  if (r === '') return true;
  if (path.isAbsolute(r)) return false;
  return r.split(path.sep)[0] !== '..';
}

export async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpathNative(path.resolve(root));
  } catch (e) {
    throw new StorageError('WORKSPACE_INVALID', 'Root workspace tidak bisa diakses', { root, cause: String(e) });
  }
}

export interface ResolveOptions {
  /** Allow the final (and trailing) components to not exist yet, e.g. a destination. */
  allowMissing?: boolean;
}

/**
 * Resolve a workspace-relative path to an absolute path that is guaranteed to be
 * inside `rootReal`. Every existing component is lstat'ed: symlinks and Windows
 * junctions/reparse points are rejected, then the deepest existing ancestor is
 * realpath'ed and checked for containment (defence in depth).
 */
export async function resolveInside(rootReal: string, rel: string, opts: ResolveOptions = {}): Promise<string> {
  return (await resolveCanonical(rootReal, rel, opts)).abs;
}

export interface Resolved {
  /** Canonical absolute path (OS case, no short names) — use this for I/O. */
  abs: string;
  /** Canonical workspace-relative path — use this for area/permission decisions. */
  rel: string;
}

/**
 * Like `resolveInside` but also returns the canonical relative path. Area checks MUST use
 * this `rel`, never the caller's input string: Windows resolves case variants
 * (`shared_media`) and could otherwise alias a protected area.
 */
export async function resolveCanonical(rootReal: string, rel: string, opts: ResolveOptions = {}): Promise<Resolved> {
  const segs = relativeSegments(rel);
  let cur = rootReal;
  let deepestExisting = rootReal;
  let existingCount = 0;
  let missing = false;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    if (missing) continue;
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        missing = true;
        continue;
      }
      throw new StorageError('PATH_INVALID', 'Path tidak bisa diperiksa', { rel, cause: String(e) });
    }
    if (st.isSymbolicLink()) {
      throw new StorageError('PATH_LINK_REJECTED', 'Symlink/junction di dalam workspace tidak diizinkan', { rel, at: cur });
    }
    deepestExisting = cur;
    existingCount++;
  }
  if (missing && !opts.allowMissing) {
    throw new StorageError('NOT_FOUND', 'Path tidak ditemukan', { rel });
  }
  const real = await realpathNative(deepestExisting);
  if (!isInside(rootReal, real)) {
    throw new StorageError('PATH_OUTSIDE_WORKSPACE', 'Path keluar dari workspace', { rel });
  }
  const abs = path.join(real, ...segs.slice(existingCount));
  return { abs, rel: toRelative(rootReal, abs) };
}

/** Convert an absolute path inside the workspace back to canonical relative form. */
export function toRelative(rootReal: string, abs: string): string {
  if (!isInside(rootReal, abs)) {
    throw new StorageError('PATH_OUTSIDE_WORKSPACE', 'Path keluar dari workspace', { abs });
  }
  const r = path.relative(rootReal, abs).split(path.sep).join('/');
  return normalizeRelative(r);
}
