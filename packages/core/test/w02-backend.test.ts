import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StorageBackend } from '../src/storage/backend.js';
import { DAY_MS, ManualClock } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { LocalFsBackend } from '../src/storage/localfs.js';
import { PURGE_PHRASE, executePurge, preparePurge } from '../src/storage/purge.js';
import { loadRegistry } from '../src/storage/registry.js';
import { restoreVersion } from '../src/storage/restore.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { type Workspace, initWorkspace } from '../src/storage/workspace.js';
import { T0, oldVersion } from './fixtures.js';
import { tempDir } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

async function sourceFile(content: string): Promise<string> {
  const p = path.join(await tempDir('src-'), `clip-${Math.random()}.mp4`);
  await fsp.writeFile(p, content);
  return p;
}

/**
 * Contract every StorageBackend must satisfy (W02). The Google Drive backend (W10) runs
 * this same suite against its own factory.
 */
function backendContract(name: string, make: (root: string) => StorageBackend) {
  describe(`StorageBackend contract: ${name}`, () => {
    const setup = async () => {
      const ws = await initWorkspace(path.join(await tempDir(), 'ws'), { backend: make });
      return { ws, b: ws.blobs };
    };
    const commitClip = async (b: StorageBackend, rel: string, content = `bytes-${Math.random()}`) => {
      const staged = await b.stage('SHARED_MEDIA', await sourceFile(content));
      return { rel: await b.commit(staged, rel), staged };
    };

    it('stage hashes the written bytes; commit names it and never overwrites', async () => {
      const { b } = await setup();
      const staged = await b.stage('SHARED_MEDIA', await sourceFile('hello'));
      expect(staged.size).toBe(5);
      expect(staged.hash).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
      const rel = await b.commit(staged, 'SHARED_MEDIA/m_1/v_1.mp4');
      expect(rel).toBe('SHARED_MEDIA/m_1/v_1.mp4');
      expect(await b.hash(rel)).toEqual({ hash: staged.hash, size: 5 });
      const again = await b.stage('SHARED_MEDIA', await sourceFile('other'));
      expect(await code(b.commit(again, rel))).toBe('CONFLICT');
      await b.discard(again);
      expect((await b.hash(rel)).hash).toBe(staged.hash); // untouched
      expect((await b.listFiles('SHARED_MEDIA', 4)).map((f) => f.name)).toEqual(['v_1.mp4']); // no temp left
    });

    it('resolve enforces areas and rejects escapes', async () => {
      const { b } = await setup();
      expect(await b.resolve('SHARED_MEDIA/x.mp4', ['shared_media'], { allowMissing: true })).toBe('SHARED_MEDIA/x.mp4');
      expect(await code(b.resolve('SHARED_MEDIA/x.mp4', ['trash'], { allowMissing: true }))).toBe('FORBIDDEN');
      expect(await code(b.resolve('../outside.mp4', ['shared_media'], { allowMissing: true }))).toBe('PATH_INVALID');
      expect(await code(b.resolve('SHARED_MEDIA/missing.mp4', ['shared_media']))).toBe('NOT_FOUND');
    });

    it('missing blobs: stat null, exists false, hash NOT_FOUND, remove only with missingOk', async () => {
      const { b } = await setup();
      const rel = 'SHARED_MEDIA/none.mp4';
      expect(await b.stat(rel)).toBeNull();
      expect(await b.exists(rel)).toBe(false);
      expect(await code(b.hash(rel))).toBe('NOT_FOUND');
      expect(await code(b.remove(rel, { missingOk: true }))).toBe('OK');
      expect(await code(b.remove(rel))).not.toBe('OK');
    });

    it('stat reports a single plain file', async () => {
      const { b } = await setup();
      const { rel } = await commitClip(b, 'SHARED_MEDIA/m/v.mp4', 'abc');
      expect(await b.stat(rel)).toMatchObject({ isFile: true, size: 3, multiLinked: false });
      expect(await b.sameObject(rel, rel)).toBe(true);
    });

    it('move keeps the bytes; moveNoOverwrite refuses an occupied destination', async () => {
      const { b } = await setup();
      const a = await commitClip(b, 'SHARED_MEDIA/m/a.mp4', 'aaa');
      const c = await commitClip(b, 'SHARED_MEDIA/m/c.mp4', 'ccc');
      await b.move(a.rel, '.trash/op_1/v_a/a.mp4', a.staged.hash);
      expect(await b.exists(a.rel)).toBe(false);
      expect((await b.hash('.trash/op_1/v_a/a.mp4')).hash).toBe(a.staged.hash);
      expect(await code(b.moveNoOverwrite('.trash/op_1/v_a/a.mp4', c.rel, a.staged.hash))).toBe('CONFLICT');
      expect((await b.hash(c.rel)).hash).toBe(c.staged.hash); // occupant untouched
      expect(await b.exists('.trash/op_1/v_a/a.mp4')).toBe(true); // source intact
      await b.moveNoOverwrite('.trash/op_1/v_a/a.mp4', a.rel, a.staged.hash);
      expect((await b.hash(a.rel)).hash).toBe(a.staged.hash);
      expect(await b.exists('.trash/op_1/v_a/a.mp4')).toBe(false);
    });

    it('json round trip, validation, prune of empty parents only', async () => {
      const { b } = await setup();
      await b.writeJson('.trash/op_9/v_9/manifest.json', { ok: 1 });
      expect(await b.readJson('.trash/op_9/v_9/manifest.json', (x) => x as { ok: number }, 'INDEX_INVALID')).toEqual({ ok: 1 });
      expect(await code(b.readJson('.trash/op_9/v_9/manifest.json', () => { throw new Error('bad'); }, 'INDEX_INVALID'))).not.toBe('OK');
      await b.writeJson('.trash/op_9/other.json', { keep: true });
      await b.remove('.trash/op_9/v_9/manifest.json');
      await b.pruneEmptyParents('.trash/op_9/v_9/manifest.json', 2);
      expect(await b.exists('.trash/op_9/v_9')).toBe(false); // empty → removed
      expect(await b.exists('.trash/op_9/other.json')).toBe(true); // non-empty parent kept
    });

    it('usage, listFiles and probeWritable', async () => {
      const { b } = await setup();
      await commitClip(b, 'SHARED_MEDIA/m/a.mp4', '12345');
      await commitClip(b, 'SHARED_MEDIA/m/b.mp4', '123');
      expect(await b.usage('SHARED_MEDIA')).toBe(8);
      expect(await b.usage('SHARED_ASSETS')).toBe(0);
      expect((await b.listFiles('SHARED_MEDIA', 4)).map((f) => f.rel).sort()).toEqual(['SHARED_MEDIA/m/a.mp4', 'SHARED_MEDIA/m/b.mp4']);
      await expect(b.probeWritable('SHARED_MEDIA')).resolves.toBeUndefined();
      expect(await b.listFiles('SHARED_MEDIA', 4)).toHaveLength(2); // probe left nothing
      expect(await code(b.probeWritable('SHARED_MEDIA/does-not-exist'))).not.toBe('OK');
    });
  });
}

backendContract('LocalFs', (root) => new LocalFsBackend(root));

/** Wrap a backend and record every call, to prove the core routes all blob I/O through it. */
function recording(inner: StorageBackend, calls: string[], fail?: Partial<Record<keyof StorageBackend, true>>): StorageBackend {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        if (fail?.[prop as keyof StorageBackend]) return Promise.reject(new Error(`injected failure: ${String(prop)}`));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe('W02 storage core uses the injected backend', () => {
  async function setup(fail?: Partial<Record<keyof StorageBackend, true>>) {
    const calls: string[] = [];
    const clock = new ManualClock(T0);
    const ws: Workspace = await initWorkspace(path.join(await tempDir(), 'ws'), { clock, backend: (root) => recording(new LocalFsBackend(root), calls, fail) });
    return { ws, clock, calls, src: await tempDir('src-') };
  }

  it('import → Auto Trash → restore → Trash → purge all go through the backend', async () => {
    const fx = await setup();
    const old = await oldVersion(fx.ws, fx.src, 'proj');
    expect(fx.calls).toEqual(expect.arrayContaining(['stage', 'commit', 'discard']));
    fx.clock.advance(30 * DAY_MS);
    fx.calls.length = 0;
    const t1 = await runAutoTrash(fx.ws, { actor: 'scheduler' });
    expect(t1.moved.map((m) => m.version_id)).toEqual([old.version_id]);
    expect(fx.calls).toEqual(expect.arrayContaining(['resolve', 'stat', 'hash', 'move', 'writeJson']));
    fx.calls.length = 0;
    const r = await restoreVersion(fx.ws, { version_id: old.version_id, actor: 'user' });
    expect(r.status).toBe('restored');
    expect(fx.calls).toEqual(expect.arrayContaining(['readJson', 'hash', 'exists', 'moveNoOverwrite', 'remove', 'pruneEmptyParents']));
    // Restore restarts the 30-day period from zero: the next run only starts the clock.
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved).toHaveLength(0);
    fx.clock.advance(30 * DAY_MS);
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved).toHaveLength(1);
    fx.calls.length = 0;
    const plan = await preparePurge(fx.ws, { version_ids: [old.version_id], actor: 'user' });
    const done = await executePurge(fx.ws, { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(done.purged).toEqual([old.version_id]);
    expect(fx.calls).toEqual(expect.arrayContaining(['stat', 'hash', 'remove', 'pruneEmptyParents']));
    expect((await loadRegistry(fx.ws)).versions[old.version_id]!.lifecycle).toBe('purged');
  });

  it('blob-only modules never touch the filesystem directly', async () => {
    const dir = path.resolve(__dirname, '../src/storage');
    for (const f of ['trash.ts', 'restore.ts', 'purge.ts', 'scanner.ts', 'preflight.ts', 'eligibility.ts', 'service.ts']) {
      const src = await fsp.readFile(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from 'node:fs'|from "node:fs"|resolveInArea\(ws\.root|hashFile\(/);
    }
  });

  it('fails closed: a backend that cannot hash blocks Auto Trash (nothing moved)', async () => {
    const fx = await setup();
    const old = await oldVersion(fx.ws, fx.src, 'proj');
    fx.clock.advance(30 * DAY_MS);
    const broken: Workspace = { ...fx.ws, blobs: recording(fx.ws.blobs, [], { hash: true }) };
    const t = await runAutoTrash(broken, { actor: 'scheduler' });
    expect(t.moved).toEqual([]);
    expect(t.skipped.map((s) => s.version_id)).toEqual([old.version_id]);
    expect((await loadRegistry(fx.ws)).versions[old.version_id]!.lifecycle).toBe('active');
  });
});
