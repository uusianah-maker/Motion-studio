import { createHash } from 'node:crypto';
import { constants as fsc, createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStat, StagedBlob, StorageBackend } from './backend.js';
import { StorageError } from './errors.js';
import { hashFile } from './hash.js';
import { newId } from './ids.js';
import { readJson, withFsRetry, writeJsonAtomic } from './jsonStore.js';
import { resolveCanonical } from './paths.js';
import { type Area, resolveInArea } from './permissions.js';

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const isNotFound = (e: unknown) => (e instanceof StorageError && e.code === 'NOT_FOUND') || isEnoent(e);

/** Copy while hashing the exact bytes written, then fsync. Never overwrites (`wx`). */
async function copyHashing(src: string, dest: string): Promise<{ hash: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createWriteStream(dest, { flags: 'wx' }));
  const fh = await fsp.open(dest, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { hash: `sha256:${h.digest('hex')}`, size };
}

const CONFLICT = (rel: string) => new StorageError('CONFLICT', 'Tujuan sudah ada; tidak ditimpa', { rel });

/**
 * Rename that never replaces (Checkpoint D F8: `rename` overwrites on Windows and POSIX).
 * Hard link fails atomically with EEXIST, then the old name is unlinked; the file mode is kept.
 * Where links are unsupported (exFAT, some network shares) fall back to check + rename — the
 * callers hold the workspace lock and use fresh random names, so that gap is not reachable by
 * concurrent writers of this app. EXDEV is rethrown for the caller's copy + verify path.
 */
async function renameNoReplace(fromAbs: string, toAbs: string, rel: string): Promise<void> {
  const mode = (await fsp.lstat(fromAbs)).mode & 0o777;
  try {
    await fsp.link(fromAbs, toAbs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw CONFLICT(rel);
    // exFAT on Windows answers link() with EISDIR (seen on the owner's D: workspace, 13 Nov 2026).
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EISDIR') throw e;
    if (await fsp.lstat(toAbs).then(() => true, () => false)) throw CONFLICT(rel);
    await withFsRetry(() => fsp.rename(fromAbs, toAbs));
    return;
  }
  await fsp.chmod(fromAbs, 0o666).catch(() => undefined); // Windows: read-only names cannot be unlinked
  await withFsRetry(() => fsp.unlink(fromAbs));
  await fsp.chmod(toAbs, mode).catch(() => undefined); // read-only flag is per file: restore it
}

/**
 * Blob storage on the local filesystem under the workspace root: today's behaviour,
 * moved behind `StorageBackend` (plan v2.0 W02). Every call re-resolves its paths with
 * `resolveCanonical` (link/junction rejection + containment) right before touching disk.
 */
export class LocalFsBackend implements StorageBackend {
  readonly kind = 'local-fs' as const;

  constructor(private readonly root: string) {}

  private async abs(rel: string, allowMissing = false): Promise<string> {
    return (await resolveCanonical(this.root, rel, { allowMissing })).abs;
  }

  async resolve(rel: string, allowed: readonly Area[], opts: { allowMissing?: boolean } = {}): Promise<string> {
    return (await resolveInArea(this.root, rel, allowed, opts)).rel;
  }

  async stat(rel: string): Promise<BlobStat | null> {
    try {
      const st = await fsp.lstat(await this.abs(rel));
      return { isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs, multiLinked: st.nlink > 1 };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async exists(rel: string): Promise<boolean> {
    const abs = await this.abs(rel, true);
    return fsp.lstat(abs).then(() => true, () => false);
  }

  async hash(rel: string): Promise<{ hash: string; size: number }> {
    return hashFile(await this.abs(rel));
  }

  async sameObject(a: string, b: string): Promise<boolean> {
    const [x, y] = await Promise.all([fsp.stat(await this.abs(a), { bigint: true }), fsp.stat(await this.abs(b), { bigint: true })]);
    return x.ino === y.ino && x.dev === y.dev && x.ino !== 0n;
  }

  async stage(dirRel: string, sourceAbs: string): Promise<StagedBlob> {
    const dir = await this.abs(dirRel);
    const tmpAbs = path.join(dir, `.importing-${newId('op')}`);
    try {
      const { hash, size } = await copyHashing(sourceAbs, tmpAbs);
      return { token: tmpAbs, hash, size };
    } catch (e) {
      await fsp.rm(tmpAbs, { force: true });
      throw e;
    }
  }

  async commit(staged: StagedBlob, rel: string): Promise<string> {
    const target = await resolveCanonical(this.root, rel, { allowMissing: true });
    await fsp.mkdir(path.dirname(target.abs), { recursive: true });
    await renameNoReplace(staged.token, target.abs, target.rel);
    await fsp.chmod(target.abs, 0o444); // media are read-only for the app (PRD v0.8 §C)
    return target.rel;
  }

  async discard(staged: StagedBlob): Promise<void> {
    await fsp.rm(staged.token, { force: true });
  }

  async move(fromRel: string, toRel: string, expectedHash: string): Promise<{ renamed: boolean }> {
    const fromAbs = await this.abs(fromRel);
    const toAbs = await this.abs(toRel, true);
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await renameNoReplace(fromAbs, toAbs, toRel);
      return { renamed: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    }
    await fsp.copyFile(fromAbs, toAbs, fsc.COPYFILE_EXCL);
    if ((await hashFile(toAbs)).hash !== expectedHash) {
      await fsp.chmod(toAbs, 0o666).catch(() => undefined);
      await fsp.rm(toAbs, { force: true });
      throw new StorageError('INTEGRITY', 'Salinan lintas-drive tidak cocok hash; original dibiarkan');
    }
    await fsp.chmod(fromAbs, 0o666);
    await fsp.rm(fromAbs);
    return { renamed: false };
  }

  /**
   * Hard-link to the destination (fails atomically with EEXIST if something is there), then
   * unlink the source. Cross-device / no link support: exclusive copy + hash check.
   */
  async moveNoOverwrite(fromRel: string, toRel: string, expectedHash: string): Promise<void> {
    const fromAbs = await this.abs(fromRel);
    const toAbs = await this.abs(toRel, true);
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await fsp.link(fromAbs, toAbs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new StorageError('CONFLICT', 'Tujuan sudah ada; tidak ditimpa', { toRel });
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw e;
      await fsp.copyFile(fromAbs, toAbs, fsc.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') throw new StorageError('CONFLICT', 'Tujuan sudah ada; tidak ditimpa', { toRel });
        throw err;
      });
      if ((await hashFile(toAbs)).hash !== expectedHash) {
        await fsp.chmod(toAbs, 0o666).catch(() => undefined);
        await fsp.rm(toAbs, { force: true });
        throw new StorageError('INTEGRITY', 'Salinan restore tidak cocok hash');
      }
    }
    await fsp.chmod(fromAbs, 0o666).catch(() => undefined);
    await fsp.rm(fromAbs);
    await fsp.chmod(toAbs, 0o444);
  }

  async remove(rel: string, opts: { missingOk?: boolean } = {}): Promise<void> {
    let abs: string;
    try {
      abs = await this.abs(rel);
    } catch (e) {
      if (opts.missingOk && isNotFound(e)) return;
      throw e;
    }
    await fsp.chmod(abs, 0o666).catch(() => undefined);
    try {
      await fsp.rm(abs);
    } catch (e) {
      if (opts.missingOk && isEnoent(e)) return;
      throw e;
    }
  }

  async setReadOnly(rel: string): Promise<void> {
    await fsp.chmod(await this.abs(rel), 0o444);
  }

  async pruneEmptyParents(rel: string, levels: number): Promise<void> {
    let dir = path.dirname(await this.abs(rel, true));
    for (let i = 0; i < levels && dir.length > this.root.length; i++) {
      await fsp.rmdir(dir).catch(() => undefined); // only succeeds when empty
      dir = path.dirname(dir);
    }
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    const abs = await this.abs(rel, true);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await writeJsonAtomic(abs, data);
  }

  async readJson<T>(rel: string, validate: (x: unknown) => T, code: 'INDEX_INVALID' | 'PROJECT_INVALID'): Promise<T> {
    return readJson(await this.abs(rel), validate, code);
  }

  async listFiles(dirRel: string, maxDepth: number): Promise<{ rel: string; name: string; size: number; mtimeMs: number }[]> {
    const out: { rel: string; name: string; size: number; mtimeMs: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile()) {
          const st = await fsp.stat(p).catch(() => null);
          if (st) out.push({ rel: path.relative(this.root, p).split(path.sep).join('/'), name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    // Start from a canonical, link-free path (a junctioned area is refused, not followed: Checkpoint D F2).
    await walk(await this.abs(dirRel, true), 0);
    return out;
  }

  async usage(dirRel: string): Promise<number> {
    return (await this.listFiles(dirRel, 16)).reduce((a, f) => a + f.size, 0);
  }

  async withLocalFile<T>(rel: string, fn: (absPath: string) => Promise<T>): Promise<T> {
    return fn(await this.abs(rel));
  }

  async readStream(rel: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const abs = await this.abs(rel);
    return createReadStream(abs, range ? { start: range.start, end: range.end } : {});
  }

  async probeWritable(dirRel: string): Promise<void> {
    const probe = await this.abs(`${dirRel}/.write-probe-${newId('op')}`, true);
    await fsp.writeFile(probe, '', { flag: 'wx' });
    await fsp.rm(probe, { force: true });
  }
}
