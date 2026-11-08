// Regression tests for Checkpoint A review findings (H1, H2, M1, M2, M3, low items).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { LOCK_TIMING, withLock, writeJsonAtomic } from '../src/storage/jsonStore.js';
import { normalizeRelative, resolveCanonical } from '../src/storage/paths.js';
import { isAllowed, resolveInArea } from '../src/storage/permissions.js';
import { initWorkspace, openWorkspace } from '../src/storage/workspace.js';
import { tempDir, tryLink } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('H1 area aliasing', () => {
  it('rejects 8.3 short-name segments', () => {
    for (const rel of ['SHARED~1/clip.mp4', 'MOTION~1/registry.json', 'clip~12.mp4', 'PROJEC~2/p1', 'CLIP~1.MP4']) {
      expect(() => normalizeRelative(rel), rel).toThrow(/8\.3/);
    }
    expect(normalizeRelative('my~clip.mp4')).toBe('my~clip.mp4');
  });

  it.runIf(process.platform === 'win32')('classifies case variants by canonical path, not input string', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    await fsp.writeFile(path.join(ws.root, 'SHARED_MEDIA', 'clip.mp4'), 'x');
    const r = await resolveCanonical(ws.root, 'shared_media/clip.mp4');
    expect(r.rel).toBe('SHARED_MEDIA/clip.mp4');
    expect((await resolveInArea(ws.root, 'shared_media/clip.mp4', ['shared_media'])).area).toBe('shared_media');
    // A path that really is the media area cannot pass an "other-only" gate via case tricks.
    expect(await code(resolveInArea(ws.root, 'shared_media/clip.mp4', ['other']))).toBe('FORBIDDEN');
    expect(await code(resolveInArea(ws.root, '.MotionStudio/registry.json', ['other']))).toBe('FORBIDDEN');
  });

  it('unknown/prototype operation names fail closed without raw TypeError', () => {
    expect(isAllowed('user', '__proto__' as never)).toBe(false);
    expect(isAllowed('user', 'nope' as never)).toBe(false);
  });
});

describe('H2/M1/M2/M3 lock safety', () => {
  it('H2: many contenders breaking one stale lock never overlap', async () => {
    const lock = path.join(await tempDir(), 'w.lock');
    await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), owner: 'dead', token: 'old', acquired_at: 0 }));
    let inside = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withLock(lock, `c${i}`, async () => {
          inside++;
          max = Math.max(max, inside);
          await sleep(15);
          inside--;
        }, 5000),
      ),
    );
    expect(max).toBe(1);
    expect(await exists(lock)).toBe(false);
  });

  it('M2: a live owner with a fresh heartbeat is not broken even if acquired long ago', async () => {
    const lock = path.join(await tempDir(), 'w.lock');
    await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), owner: 'live', token: 't', acquired_at: 0 }));
    expect(await code(withLock(lock, 'me', async () => 1, 150))).toBe('WORKSPACE_LOCKED');
    // Same live pid but heartbeat silent for > staleMs: treated as hung and broken.
    const old = new Date(Date.now() - LOCK_TIMING.staleMs - 60_000);
    await fsp.utimes(lock, old, old);
    expect(await withLock(lock, 'me', async () => 2, 500)).toBe(2);
  });

  it('M2: holder heartbeat refreshes lock mtime', async () => {
    const lock = path.join(await tempDir(), 'w.lock');
    const prev = LOCK_TIMING.heartbeatMs;
    LOCK_TIMING.heartbeatMs = 20;
    try {
      await withLock(lock, 'hb', async () => {
        const old = new Date(Date.now() - 3_600_000);
        await fsp.utimes(lock, old, old);
        await sleep(120);
        expect(Date.now() - (await fsp.stat(lock)).mtimeMs).toBeLessThan(60_000);
      });
    } finally {
      LOCK_TIMING.heartbeatMs = prev;
    }
  });

  it('M1: release does not delete a lock it no longer owns', async () => {
    const lock = path.join(await tempDir(), 'w.lock');
    await withLock(lock, 'a', async () => {
      await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), owner: 'b', token: 'foreign', acquired_at: Date.now() }));
    });
    expect(JSON.parse(await fsp.readFile(lock, 'utf8')).token).toBe('foreign');
  });

  it('M3: work leaked out of a critical section must re-acquire the lock', async () => {
    const lock = path.join(await tempDir(), 'w.lock');
    let leaked: Promise<boolean> | undefined;
    await withLock(lock, 'a', async () => {
      leaked = new Promise((resolve, reject) => {
        setTimeout(() => {
          withLock(lock, 'leak', async () => exists(lock)).then(resolve, reject);
        }, 30);
      });
    });
    expect(await leaked).toBe(true); // it held a real lock file, not a phantom re-entry
  });

  it('atomic write cleans its temp file when the target cannot be written', async () => {
    const dir = await tempDir();
    await fsp.mkdir(path.join(dir, 'target.json')); // rename onto a directory fails
    await expect(writeJsonAtomic(path.join(dir, 'target.json'), { a: 1 })).rejects.toThrow();
    expect(await fsp.readdir(dir)).toEqual(['target.json']);
  });
});

describe('workspace metadata & root links', () => {
  it('open rejects a root that is a junction and a metadata file replaced by a link', async () => {
    const real = path.join(await tempDir(), 'ws');
    await initWorkspace(real);
    const alias = path.join(await tempDir(), 'alias');
    expect(await tryLink(real, alias, 'junction')).toBe(true);
    expect(await code(openWorkspace(alias))).toBe('WORKSPACE_INVALID');

    const reg = path.join(real, '.motionstudio', 'registry.json');
    const outsideDir = await tempDir();
    await fsp.rm(reg);
    await fsp.mkdir(path.join(outsideDir, 'd'));
    expect(await tryLink(path.join(outsideDir, 'd'), reg, 'junction')).toBe(true);
    expect(await code(openWorkspace(real))).toBe('WORKSPACE_INVALID');
  });
});

describe('W07 finding: Windows "delete pending" while acquiring the lock', () => {
  it('EPERM/EBUSY from creating the lock file means "retry", not a crash', async () => {
    const dir = await tempDir();
    const lock = path.join(dir, 'x.lock');
    const real = fsp.open.bind(fsp);
    let calls = 0;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      if (String(args[0]) === lock && calls++ < 2) throw Object.assign(new Error(calls === 1 ? 'EPERM' : 'EBUSY'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      return real(...args);
    });
    try {
      expect(await withLock(lock, 't', async () => 'ran')).toBe('ran');
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });
});
