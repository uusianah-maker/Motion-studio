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
  token: string;
  acquired_at: number;
}

export const LOCK_TIMING = {
  /** A lock whose file has not been touched for this long is considered abandoned. */
  staleMs: 10 * 60 * 1000,
  /** Holders refresh the lock file mtime at this interval (heartbeat). */
  heartbeatMs: 30 * 1000,
};

/** In-process registry of currently held locks: key -> token. Cleared on release. */
const active = new Map<string, string>();
/** Async context: which (key, token) pairs this call chain holds. */
const held = new AsyncLocalStorage<Map<string, string>>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<Partial<LockInfo> | null> {
  try {
    return JSON.parse(await fsp.readFile(lockPath, 'utf8')) as Partial<LockInfo>;
  } catch {
    return null;
  }
}

async function isStale(lockPath: string, info: Partial<LockInfo> | null): Promise<boolean> {
  let mtime: number;
  try {
    mtime = (await fsp.stat(lockPath)).mtimeMs;
  } catch {
    return false; // vanished: just retry acquiring
  }
  const silentTooLong = Date.now() - mtime > LOCK_TIMING.staleMs;
  // Owner process on this host is gone: stale regardless of age.
  if (info && info.host === os.hostname() && typeof info.pid === 'number' && !pidAlive(info.pid)) return true;
  // Otherwise (live pid, other host, unreadable/partial file) only a stopped heartbeat makes it stale.
  return silentTooLong;
}

/**
 * Break a stale lock without deleting a *fresh* one created in between:
 * rename it aside, verify the renamed file is the one judged stale, otherwise
 * put it back with link() (atomic create-if-absent).
 */
async function breakStale(lockPath: string, expectedToken: string | undefined): Promise<void> {
  const aside = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await fsp.rename(lockPath, aside);
  } catch {
    return; // someone else already moved it
  }
  const got = await readLock(aside);
  if (got?.token !== expectedToken) {
    // We grabbed a lock that is not the stale one: restore it if the slot is still free.
    await fsp.link(aside, lockPath).catch(() => undefined);
  }
  await fsp.rm(aside, { force: true });
}

async function createLock(lockPath: string, info: LockInfo): Promise<boolean> {
  let fh;
  try {
    fh = await fsp.open(lockPath, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(JSON.stringify(info));
    await fh.sync();
    await fh.close();
    return true;
  } catch (e) {
    await fh.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true });
    throw e;
  }
}

/**
 * Exclusive cross-process lock (file created with O_EXCL, owner token, heartbeat).
 * Re-entrant only for the call chain that currently holds it; work that outlives
 * the critical section does NOT inherit the lock.
 */
export async function withLock<T>(lockPath: string, owner: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const key = path.resolve(lockPath).toLowerCase();
  const ctx = held.getStore();
  const myToken = ctx?.get(key);
  if (myToken !== undefined && active.get(key) === myToken) return fn();

  const info: LockInfo = { pid: process.pid, host: os.hostname(), owner, token: randomBytes(16).toString('hex'), acquired_at: Date.now() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await createLock(lockPath, info)) break;
    const current = await readLock(lockPath);
    if (await isStale(lockPath, current)) {
      await breakStale(lockPath, current?.token);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new StorageError('WORKSPACE_LOCKED', 'Workspace sedang dipakai operasi lain', { lockPath, holder: current?.owner });
    }
    await sleep(30);
  }
  active.set(key, info.token);
  const beat = setInterval(() => {
    const now = new Date();
    fsp.utimes(lockPath, now, now).catch(() => undefined);
  }, LOCK_TIMING.heartbeatMs);
  beat.unref();
  const next = new Map(ctx ?? []);
  next.set(key, info.token);
  try {
    return await held.run(next, fn);
  } finally {
    clearInterval(beat);
    if (active.get(key) === info.token) active.delete(key);
    const onDisk = await readLock(lockPath);
    if (onDisk?.token === info.token) await withFsRetry(() => fsp.rm(lockPath, { force: true }));
  }
}
