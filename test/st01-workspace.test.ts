import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { withLock, writeJsonAtomic } from '../src/storage/jsonStore.js';
import { isInside, normalizeRelative, resolveInside, toRelative } from '../src/storage/paths.js';
import { areaOf, assertAllowed, assertArea, isAllowed } from '../src/storage/permissions.js';
import {
  createProject,
  initWorkspace,
  listProjectIds,
  openWorkspace,
  readPolicy,
  readProject,
  withWorkspaceLock,
} from '../src/storage/workspace.js';
import { listTree, tempDir, tryLink } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const codeSync = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('ST-01 workspace schema', () => {
  it('init creates the exact PRD v0.8 §C layout (directory fixture)', async () => {
    const root = path.join(await tempDir(), 'MOTION_STUDIO');
    await initWorkspace(root, { clock: new ManualClock(1_000) });
    expect(await listTree(root)).toEqual([
      '.motionstudio/',
      '.motionstudio/journal/',
      '.motionstudio/leases.json',
      '.motionstudio/policy.json',
      '.motionstudio/purge_requests.json',
      '.motionstudio/registry.json',
      '.motionstudio/workspace.json',
      '.trash/',
      'BACKUP_PROJECTS/',
      'PROJECTS/',
      'SHARED_ASSETS/',
      'SHARED_MEDIA/',
    ]);
  });

  it('refuses to init into a non-empty folder or an existing workspace', async () => {
    const root = await tempDir();
    await fsp.writeFile(path.join(root, 'user-file.txt'), 'x');
    expect(await code(initWorkspace(root))).toBe('CONFLICT');
    const root2 = path.join(await tempDir(), 'ws');
    await initWorkspace(root2);
    expect(await code(initWorkspace(root2))).toBe('CONFLICT');
  });

  it('open validates metadata and layout, fails closed on corruption', async () => {
    const root = path.join(await tempDir(), 'ws');
    const ws = await initWorkspace(root);
    const reopened = await openWorkspace(root);
    expect(reopened.meta.workspace_id).toBe(ws.meta.workspace_id);
    expect((await readPolicy(reopened)).gc.scan_interval_minutes).toBe(360);

    await fsp.rm(path.join(root, 'SHARED_ASSETS'), { recursive: true });
    expect(await code(openWorkspace(root))).toBe('WORKSPACE_INVALID');
    await fsp.mkdir(path.join(root, 'SHARED_ASSETS'));

    await fsp.writeFile(path.join(root, '.motionstudio', 'workspace.json'), '{not json');
    expect(await code(openWorkspace(root))).toBe('WORKSPACE_INVALID');
    expect(await code(openWorkspace(path.join(root, 'nope')))).toBe('WORKSPACE_INVALID');
  });

  it('open rejects a layout folder replaced by a junction', async () => {
    const root = path.join(await tempDir(), 'ws');
    await initWorkspace(root);
    const outside = await tempDir();
    await fsp.rm(path.join(root, 'SHARED_MEDIA'), { recursive: true });
    const linked = await tryLink(outside, path.join(root, 'SHARED_MEDIA'), 'junction');
    expect(linked).toBe(true);
    expect(await code(openWorkspace(root))).toBe('WORKSPACE_INVALID');
  });

  it('createProject builds 01..05 folders + valid manifest; rejects bad/duplicate IDs', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'), { clock: new ManualClock(5_000) });
    const m = await createProject(ws, { project_id: 'lucy-elegant_01', name: 'Lucy — Elegant Look' });
    expect(m).toMatchObject({ project_id: 'lucy-elegant_01', status: 'active', revision: 0, created_at: 5_000 });
    expect(await listTree(ws.root, 'PROJECTS')).toEqual([
      'PROJECTS/lucy-elegant_01/',
      'PROJECTS/lucy-elegant_01/01_INPUT/',
      'PROJECTS/lucy-elegant_01/02_ASSETS/',
      'PROJECTS/lucy-elegant_01/03_PROJECT/',
      'PROJECTS/lucy-elegant_01/03_PROJECT/project.json',
      'PROJECTS/lucy-elegant_01/04_CACHE/',
      'PROJECTS/lucy-elegant_01/05_OUTPUT/',
    ]);
    expect((await readProject(ws, 'lucy-elegant_01')).name).toBe('Lucy — Elegant Look');
    expect(await listProjectIds(ws)).toEqual(['lucy-elegant_01']);

    for (const bad of ['../evil', 'a/b', 'a\\b', '', 'CON', 'nul', '-x', 'x'.repeat(65), 'with space', 'C:']) {
      expect(await code(createProject(ws, { project_id: bad, name: 'x' }))).toBe('PATH_INVALID');
    }
    expect(await code(createProject(ws, { project_id: 'lucy-elegant_01', name: 'dup' }))).toBe('CONFLICT');
    // No stray folders were created by rejected attempts.
    expect(await listProjectIds(ws)).toEqual(['lucy-elegant_01']);
  });

  it('readProject fails closed on a manifest whose id does not match its folder', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    await createProject(ws, { project_id: 'p1', name: 'P1' });
    const file = path.join(ws.root, 'PROJECTS/p1/03_PROJECT/project.json');
    const m = JSON.parse(await fsp.readFile(file, 'utf8'));
    await writeJsonAtomic(file, { ...m, project_id: 'p2' });
    expect(await code(readProject(ws, 'p1'))).toBe('PROJECT_INVALID');
  });
});

describe('ST-01 path containment (traversal tests)', () => {
  it.each([
    '../outside.txt',
    'PROJECTS/../../outside',
    'PROJECTS/p1/../../..',
    '/etc/passwd',
    '\\Windows\\System32',
    'C:\\Windows',
    'C:relative',
    '\\\\server\\share\\x',
    '//server/share',
    'a\u0000b',
    'clip.mp4:hidden_stream',
    'NUL',
    'aux.txt',
    'COM1.log',
    'dir /x',
    'trailing.',
    'a//b',
    './a',
    '',
  ])('rejects %j', (rel) => {
    expect(codeSync(() => normalizeRelative(rel))).toBe('PATH_INVALID');
  });

  it('normalizes accepted paths to forward slashes', () => {
    expect(normalizeRelative('PROJECTS\\p1\\01_INPUT\\clip.mp4')).toBe('PROJECTS/p1/01_INPUT/clip.mp4');
    expect(normalizeRelative('SHARED_MEDIA/m_1/v_1.mp4')).toBe('SHARED_MEDIA/m_1/v_1.mp4');
  });

  it('resolveInside rejects junctions (pointing outside AND inside) and missing paths', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    const outside = await tempDir();
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    expect(await tryLink(outside, path.join(ws.root, 'SHARED_MEDIA', 'escape'), 'junction')).toBe(true);
    expect(await code(resolveInside(ws.root, 'SHARED_MEDIA/escape/secret.txt'))).toBe('PATH_LINK_REJECTED');
    expect(await code(resolveInside(ws.root, 'SHARED_MEDIA/escape/new.txt', { allowMissing: true }))).toBe('PATH_LINK_REJECTED');

    expect(await tryLink(path.join(ws.root, 'SHARED_ASSETS'), path.join(ws.root, 'SHARED_MEDIA', 'inner'), 'junction')).toBe(true);
    expect(await code(resolveInside(ws.root, 'SHARED_MEDIA/inner'))).toBe('PATH_LINK_REJECTED');

    expect(await code(resolveInside(ws.root, 'SHARED_MEDIA/none.mp4'))).toBe('NOT_FOUND');
    const ok = await resolveInside(ws.root, 'SHARED_MEDIA/a/b/none.mp4', { allowMissing: true });
    expect(isInside(ws.root, ok)).toBe(true);
  });

  it('resolveInside rejects file symlinks (when the OS allows creating them)', async (ctx) => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    const outside = path.join(await tempDir(), 'target.txt');
    await fsp.writeFile(outside, 'x');
    const ok = await tryLink(outside, path.join(ws.root, 'SHARED_MEDIA', 'link.txt'), 'file');
    if (!ok) {
      ctx.skip(); // Windows without Developer Mode cannot create file symlinks; junction tests above cover reparse points.
      return;
    }
    expect(await code(resolveInside(ws.root, 'SHARED_MEDIA/link.txt'))).toBe('PATH_LINK_REJECTED');
  });

  it('isInside is case-insensitive on Windows and not fooled by prefix siblings', () => {
    const base = path.resolve(os.tmpdir(), 'ws');
    expect(isInside(base, path.join(base, 'a'))).toBe(true);
    expect(isInside(base, base + '-evil')).toBe(false);
    expect(isInside(base, path.dirname(base))).toBe(false);
    if (process.platform === 'win32') expect(isInside(base, base.toUpperCase() + '\\x')).toBe(true);
  });

  it('toRelative refuses paths outside the workspace', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    expect(toRelative(ws.root, path.join(ws.root, 'SHARED_MEDIA', 'x.mp4'))).toBe('SHARED_MEDIA/x.mp4');
    expect(codeSync(() => toRelative(ws.root, path.dirname(ws.root)))).toBe('PATH_OUTSIDE_WORKSPACE');
  });
});

describe('ST-01 permissions', () => {
  it('actor matrix: AI cannot trash/purge/restore/import; scheduler cannot purge', () => {
    for (const op of ['auto_trash', 'purge', 'restore', 'import', 'commit_project', 'set_protection'] as const) {
      expect(isAllowed('ai', op)).toBe(false);
    }
    expect(isAllowed('ai', 'scan_dry_run')).toBe(true);
    expect(isAllowed('scheduler', 'purge')).toBe(false);
    expect(isAllowed('scheduler', 'auto_trash')).toBe(true);
    expect(isAllowed('user', 'purge')).toBe(true);
    expect(codeSync(() => assertAllowed('ai', 'purge'))).toBe('FORBIDDEN');
  });

  it('areas classify paths; operations can be restricted to areas', () => {
    expect(areaOf('SHARED_MEDIA/m/v.mp4')).toBe('shared_media');
    expect(areaOf('PROJECTS/p1/01_INPUT/a.mp4')).toBe('project_input');
    expect(areaOf('PROJECTS/p1/04_CACHE/t.jpg')).toBe('project_cache');
    expect(areaOf('PROJECTS/p1/05_OUTPUT/r.mp4')).toBe('project_output');
    expect(areaOf('PROJECTS/p1')).toBe('other');
    expect(areaOf('.trash/x')).toBe('trash');
    expect(areaOf('.motionstudio/registry.json')).toBe('meta');
    expect(codeSync(() => assertArea('PROJECTS/p1/01_INPUT/a.mp4', ['project_cache']))).toBe('FORBIDDEN');
    expect(assertArea('PROJECTS/p1/04_CACHE/a.jpg', ['project_cache'])).toBe('project_cache');
  });
});

describe('ST-01 workspace lock & atomic writes', () => {
  it('serializes concurrent critical sections and is re-entrant', async () => {
    const ws = await initWorkspace(path.join(await tempDir(), 'ws'));
    const order: string[] = [];
    const task = (name: string) =>
      withWorkspaceLock(ws, name, async () => {
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 30));
        await withWorkspaceLock(ws, `${name}-nested`, async () => order.push(`${name}:nested`));
        order.push(`${name}:out`);
      });
    await Promise.all([task('a'), task('b')]);
    expect(order).toHaveLength(6);
    // No interleaving: each in/nested/out triple is contiguous.
    expect(order.slice(0, 3).every((s) => s.startsWith(order[0]!.split(':')[0]!))).toBe(true);
  });

  it('times out on a live foreign lock, recovers a stale (dead pid) lock', async () => {
    const dir = await tempDir();
    const lock = path.join(dir, 'x.lock');
    await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), owner: 'other', acquired_at: Date.now() }));
    expect(await code(withLock(lock, 't', async () => 1, 150))).toBe('WORKSPACE_LOCKED');
    await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), owner: 'dead', acquired_at: Date.now() }));
    expect(await withLock(lock, 't', async () => 42, 500)).toBe(42);
    await expect(fsp.access(lock)).rejects.toThrow();
  });

  it('atomic write leaves no temp files and replaces content', async () => {
    const dir = await tempDir();
    const f = path.join(dir, 'a.json');
    await writeJsonAtomic(f, { v: 1 });
    await writeJsonAtomic(f, { v: 2 });
    expect(JSON.parse(await fsp.readFile(f, 'utf8'))).toEqual({ v: 2 });
    expect(await fsp.readdir(dir)).toEqual(['a.json']);
  });
});
