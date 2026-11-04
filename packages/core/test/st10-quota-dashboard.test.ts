import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/motion-storage.js';
import { readAudit } from '../src/storage/audit.js';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { writeJsonAtomic } from '../src/storage/jsonStore.js';
import { cleanupCache, estimateSpace, getDashboard, getStorageStats } from '../src/storage/quota.js';
import { loadRegistry } from '../src/storage/registry.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { DEFAULT_POLICY, createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, oldVersion } from './fixtures.js';
import { tempDir } from './helpers.js';

const GB = 1024 ** 3;

describe('ST-10 disk quota', () => {
  it('reports usage per area and real free space', async () => {
    const { ws, src } = await fixtureWorkspace();
    await oldVersion(ws, src, 'p1');
    await fsp.writeFile(path.join(ws.root, 'PROJECTS/p1/04_CACHE/thumb.jpg'), Buffer.alloc(1000));
    await fsp.writeFile(path.join(ws.root, 'PROJECTS/p1/05_OUTPUT/out.mp4'), Buffer.alloc(2000));
    const s = await getStorageStats(ws);
    expect(s.usage.project_cache).toBe(1000);
    expect(s.usage.project_output).toBe(2000);
    expect(s.usage.shared_media).toBeGreaterThan(0);
    expect(s.disk!.free_bytes).toBeGreaterThan(0);
    expect(s.disk!.total_bytes).toBeGreaterThanOrEqual(s.disk!.free_bytes);
  });

  it('design check: disk full / quotas only warn — never trash or purge anything', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    await oldVersion(ws, src, 'p1');
    clock.advance(30 * DAY_MS);
    await runAutoTrash(ws, { actor: 'scheduler' });
    await writeJsonAtomic(path.join(ws.root, '.motionstudio', 'policy.json'), { ...DEFAULT_POLICY, quota: { media_soft_bytes: 1, cache_max_bytes: 0, free_space_reserve_bytes: 10 * GB } });
    await fsp.writeFile(path.join(ws.root, 'PROJECTS/p1/04_CACHE/c.bin'), 'x'.repeat(10));
    const regBefore = await fsp.readFile(path.join(ws.root, '.motionstudio', 'registry.json'), 'utf8');
    const s = await getStorageStats(ws, { disk: { free_bytes: 1 * GB, total_bytes: 100 * GB } });
    expect(s.warnings.map((w) => w.code).sort()).toEqual(['CACHE_OVER_LIMIT', 'LOW_FREE_SPACE', 'MEDIA_SOFT_QUOTA', 'TRASH_REVIEW_SUGGESTED']);
    const d = await getDashboard(ws, { disk: { free_bytes: 0, total_bytes: 100 * GB } });
    expect(d.trash).toHaveLength(1);
    expect(await fsp.readFile(path.join(ws.root, '.motionstudio', 'registry.json'), 'utf8')).toBe(regBefore);
    expect(await readAudit(ws, (e) => e.op.startsWith('purge.'))).toEqual([]);
  });

  it('estimates import/render space against the reserve (fail closed when unknown)', async () => {
    const { ws } = await fixtureWorkspace();
    expect(await estimateSpace(ws, { bytes_needed: 1 * GB, disk: { free_bytes: 10 * GB, total_bytes: 50 * GB } })).toMatchObject({ ok: true, free_after: 9 * GB });
    expect(await estimateSpace(ws, { bytes_needed: 6 * GB, disk: { free_bytes: 10 * GB, total_bytes: 50 * GB } })).toMatchObject({ ok: false });
    expect(await estimateSpace(ws, { bytes_needed: 1, disk: null })).toMatchObject({ ok: false, free_bytes: null });
  });

  it('cache cleanup: only 04_CACHE, oldest first, skips in-use files, never originals; AI denied', async () => {
    const { ws, src } = await fixtureWorkspace();
    const m = await oldVersion(ws, src, 'p1');
    await createProject(ws, { project_id: 'p2', name: 'p2' });
    const mk = async (rel: string, size: number, ageMin: number) => {
      const p = path.join(ws.root, rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, Buffer.alloc(size));
      const t = new Date(Date.now() - ageMin * 60_000);
      await fsp.utimes(p, t, t);
    };
    await mk('PROJECTS/p1/04_CACHE/old.jpg', 100, 30);
    await mk('PROJECTS/p1/04_CACHE/proxy/in-use.mp4', 100, 20);
    await mk('PROJECTS/p2/04_CACHE/mid.jpg', 100, 10);
    await mk('PROJECTS/p2/04_CACHE/new.jpg', 100, 1);
    await mk('PROJECTS/p1/05_OUTPUT/final.mp4', 5000, 60);
    const r = await cleanupCache(ws, { actor: 'scheduler', target_bytes: 150, in_use: new Set(['PROJECTS/p1/04_CACHE/proxy/in-use.mp4']) });
    expect(r.removed).toEqual(['PROJECTS/p1/04_CACHE/old.jpg', 'PROJECTS/p2/04_CACHE/mid.jpg', 'PROJECTS/p2/04_CACHE/new.jpg']);
    expect(r.cache_bytes_after).toBe(100);
    const reg = await loadRegistry(ws);
    expect(await fsp.access(path.join(ws.root, reg.versions[m.version_id]!.rel_path)).then(() => true)).toBe(true);
    expect(await fsp.access(path.join(ws.root, 'PROJECTS/p1/05_OUTPUT/final.mp4')).then(() => true)).toBe(true);
    try {
      await cleanupCache(ws, { actor: 'ai' });
      expect.unreachable();
    } catch (e) {
      expect(isStorageError(e, 'FORBIDDEN')).toBe(true);
    }
  });
});

describe('ST-10 storage dashboard + CLI', () => {
  it('dashboard shows GC summary, upcoming eligibility, Trash with backup status, recent audit', async () => {
    const { ws, clock, src } = await fixtureWorkspace();
    await oldVersion(ws, src);
    clock.advance(30 * DAY_MS);
    await runAutoTrash(ws, { actor: 'scheduler' });
    const waiting = await oldVersion(ws, src);
    const d = await getDashboard(ws);
    expect(d.gc.ok).toBe(true);
    expect(d.gc.candidates).toBe(0);
    expect(d.gc.next_eligible).toEqual([{ version_id: waiting.version_id, eligible_at: clock.now() + 30 * DAY_MS }]);
    expect(d.trash[0]).toMatchObject({ backup: 'unverified' });
    expect(d.pending_operations).toBe(0);
    expect(d.recent_audit.length).toBeGreaterThan(0);
  });

  it('CLI: init → dashboard → scan → recover; bad usage returns 2', async () => {
    const root = path.join(await tempDir(), 'ws');
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await runCli(['init', root], out)).toBe(0);
    expect(await runCli(['dashboard', root], out)).toBe(0);
    expect(await runCli(['scan', root, '--json'], out)).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, dry_run: true });
    expect(await runCli(['recover', root], out)).toBe(0);
    expect(await runCli(['purge', root], out)).toBe(2); // destructive ops are not exposed
    expect(await runCli(['dashboard', path.join(root, 'nope')], out)).toBe(1);
    expect(lines.join('\n')).toMatch(/Workspace dibuat/);
    expect(lines.join('\n')).toMatch(/GC: 0 kandidat/);
  });
});
