import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageError } from './errors.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Windows can briefly refuse rename/unlink while AV or indexers hold a handle. */
export async function withFsRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      last = e;
      await sleep(25 * (i + 1));
    }
  }
  throw last;
}

/** Atomic JSON write: tmp file → fsync → rename over target (ADR-001 D4). */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'wx');
  try {
    await fh.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await withFsRetry(() => fsp.rename(tmp, file));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** Read + parse + validate. Any failure is a typed error so callers can fail closed. */
export async function readJson<T>(file: string, validate: (x: unknown) => T, code: 'WORKSPACE_INVALID' | 'INDEX_INVALID' | 'PROJECT_INVALID' = 'WORKSPACE_INVALID'): Promise<T> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    throw new StorageError(code, `File metadata tidak bisa dibaca: ${path.basename(file)}`, { file, cause: String(e) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StorageError(code, `File metadata korup (JSON tidak valid): ${path.basename(file)}`, { file, cause: String(e) });
  }
  return validate(parsed);
}

// ---------------------------------------------------------------- workspace lock

interface LockInfo {
  pid: number;
  host: string;
  owner: string;
  acquired_at: number;
}

const held = new AsyncLocalStorage<Set<string>>();
const STALE_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryBreakStale(lockPath: string): Promise<boolean> {
  let info: Partial<LockInfo>;
  try {
    info = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as Partial<LockInfo>;
  } catch {
    // Unreadable lock: only break it once it is old enough by mtime.
    try {
      const st = await fsp.stat(lockPath);
      if (Date.now() - st.mtimeMs < STALE_MS) return false;
    } catch {
      return true;
    }
    await fsp.rm(lockPath, { force: true });
    return true;
  }
  const sameHost = info.host === os.hostname();
  const dead = sameHost && typeof info.pid === 'number' && !pidAlive(info.pid);
  const old = typeof info.acquired_at === 'number' && Date.now() - info.acquired_at > STALE_MS;
  if (dead || old) {
    await fsp.rm(lockPath, { force: true });
    return true;
  }
  return false;
}

/**
 * Exclusive cross-process lock on a workspace (file created with O_EXCL).
 * Re-entrant inside the same async call chain.
 */
export async function withLock<T>(lockPath: string, owner: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const key = path.resolve(lockPath).toLowerCase();
  const current = held.getStore();
  if (current?.has(key)) return fn();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      const info: LockInfo = { pid: process.pid, host: os.hostname(), owner, acquired_at: Date.now() };
      await fh.writeFile(JSON.stringify(info));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await tryBreakStale(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new StorageError('WORKSPACE_LOCKED', 'Workspace sedang dipakai operasi lain', { lockPath });
      }
      await sleep(30);
    }
  }
  const next = new Set(current ?? []);
  next.add(key);
  try {
    return await held.run(next, fn);
  } finally {
    await withFsRetry(() => fsp.rm(lockPath, { force: true }));
  }
}
