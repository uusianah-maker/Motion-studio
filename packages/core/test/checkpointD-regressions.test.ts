// Regression tests for Checkpoint D (independent review of W01–W05).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { getDashboard } from '../src/storage/quota.js';
import { IMPORT_TEMP_RE, recoverOnStartup } from '../src/storage/recovery.js';
import { addVersion, importMedia, loadRegistry, saveRegistry } from '../src/storage/registry.js';
import { restoreVersion } from '../src/storage/restore.js';
import { GcScheduler } from '../src/storage/scheduler.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { createProject } from '../src/storage/workspace.js';
import { commit, fixtureWorkspace, oldVersion } from './fixtures.js';
import { tryLink } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

async function trashed() {
  const fx = await fixtureWorkspace();
  const old = await oldVersion(fx.ws, fx.src, 'proj');
  fx.clock.advance(30 * DAY_MS);
  const t = await runAutoTrash(fx.ws, { actor: 'scheduler' });
  if (t.moved.length !== 1) throw new Error('fixture: expected one trashed version');
  return { ...fx, old };
}

describe('Checkpoint D F1: recovery can never delete live media', () => {
  it('restore refuses hidden/temp-looking names and destinations outside the media scope', async () => {
    const fx = await trashed();
    const vid = fx.old.version_id;
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'SHARED_MEDIA/.importing-keep.mp4' }))).toBe('PATH_INVALID');
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'SHARED_MEDIA/sub/.hidden.mp4' }))).toBe('PATH_INVALID');
    await createProject(fx.ws, { project_id: 'other', name: 'Other' });
    // Shared media may not be restored into a project's input (registry would still say "shared").
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'PROJECTS/other/01_INPUT/x.mp4' }))).toBe('FORBIDDEN');
    expect((await loadRegistry(fx.ws)).versions[vid]!.lifecycle).toBe('trashed'); // nothing moved
    const ok = await restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'SHARED_MEDIA/kept/clip.mp4' });
    expect(ok.status).toBe('restored');
  });

  it('project media can only be restored into its own project input', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'a', name: 'A' });
    await createProject(fx.ws, { project_id: 'b', name: 'B' });
    const file = async (tag: string) => {
      const p = path.join(fx.src, `${tag}.mp4`);
      await fsp.writeFile(p, `${tag}-${Math.random()}`);
      return p;
    };
    const r = await importMedia(fx.ws, { sourcePath: await file('v1'), scope: { kind: 'project', project_id: 'a' }, actor: 'user' });
    await addVersion(fx.ws, { media_id: r.media.media_id, sourcePath: await file('v2'), actor: 'user' });
    const ref = { media_id: r.media.media_id, version_id: r.version.version_id };
    await commit(fx.ws, 'a', { timeline: [ref] });
    await commit(fx.ws, 'a', { timeline: [] });
    fx.clock.advance(30 * DAY_MS);
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved.map((m) => m.version_id)).toEqual([ref.version_id]);
    const vid = ref.version_id;
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'PROJECTS/b/01_INPUT/x.mp4' }))).toBe('FORBIDDEN');
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'SHARED_MEDIA/x.mp4' }))).toBe('FORBIDDEN');
    expect(await code(restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'PROJECTS/a/02_ASSETS/x.mp4' }))).toBe('FORBIDDEN');
    expect((await restoreVersion(fx.ws, { version_id: vid, actor: 'user', destination: 'PROJECTS/a/01_INPUT/restored.mp4' })).status).toBe('restored');
  });

  it('a registered file is never swept, even when its name looks like an import temp', async () => {
    const fx = await fixtureWorkspace();
    const p = path.join(fx.src, 'a.mp4');
    await fsp.writeFile(p, `bytes-${Math.random()}`);
    const r = await importMedia(fx.ws, { sourcePath: p, scope: { kind: 'shared' }, actor: 'user' });
    // Simulate a registered file sitting under a temp-like name (e.g. written by an older build).
    const tempLike = 'SHARED_MEDIA/.importing-op_aaaaaaaaaaaaaaaa';
    const from = path.join(fx.ws.root, r.version.rel_path);
    const to = path.join(fx.ws.root, tempLike);
    await fsp.chmod(from, 0o666);
    await fsp.rename(from, to);
    const old = new Date(Date.now() - 3 * DAY_MS);
    await fsp.utimes(to, old, old);
    const reg = await loadRegistry(fx.ws);
    reg.versions[r.version.version_id]!.rel_path = tempLike;
    await saveRegistry(fx.ws, reg);
    const rep = await recoverOnStartup(fx.ws);
    expect(rep.removed_temp_files).toEqual([]);
    expect(await fsp.readFile(to, 'utf8')).toMatch(/^bytes-/);
  });

  it('only the exact staging name format counts as a temp file', () => {
    expect(IMPORT_TEMP_RE.test('.importing-op_0123456789abcdef')).toBe(true);
    for (const n of ['.importing-keep.mp4', '.importing-op_dead', '.importing-op_0123456789abcdef.mp4', 'x.importing-op_0123456789abcdef']) {
      expect(IMPORT_TEMP_RE.test(n), n).toBe(false);
    }
  });
});

describe('Checkpoint D F2: odd folders never break startup or the dashboard', () => {
  it('invalid project folder name: dashboard warns, recovery skips, scheduler starts', async () => {
    const fx = await fixtureWorkspace();
    await fsp.mkdir(path.join(fx.ws.root, 'PROJECTS', 'Old~1', '01_INPUT'), { recursive: true });
    const d = await getDashboard(fx.ws, { disk: { free_bytes: 100 * 1024 ** 3, total_bytes: 200 * 1024 ** 3 } });
    expect(d.stats.warnings.map((w) => w.code)).toContain('AREA_UNREADABLE');
    expect(d.gc.ok).toBe(false); // the dependency index still fails closed on an unknown project folder
    const rep = await recoverOnStartup(fx.ws);
    expect(rep.skipped.map((s) => s.path)).toEqual(['PROJECTS/Old~1']);
    const sch = new GcScheduler(fx.ws, { timers: { setInterval: () => 1, clearInterval: () => undefined } });
    const first = await sch.start();
    expect(first.status).toBe('blocked'); // GC blocked (fail closed), but the app starts
    sch.stop();
  });

  it('a junctioned project input is refused, reported and never followed', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'p1', name: 'P1' });
    const input = path.join(fx.ws.root, 'PROJECTS', 'p1', '01_INPUT');
    const outside = path.join(fx.src, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, '.importing-op_bbbbbbbbbbbbbbbb'), 'user data outside');
    const old = new Date(Date.now() - 3 * DAY_MS);
    await fsp.utimes(path.join(outside, '.importing-op_bbbbbbbbbbbbbbbb'), old, old);
    await fsp.rmdir(input);
    expect(await tryLink(outside, input, 'junction')).toBe(true);
    const rep = await recoverOnStartup(fx.ws);
    expect(rep.skipped.map((s) => s.path)).toContain('PROJECTS/p1/01_INPUT');
    expect(rep.removed_temp_files).toEqual([]);
    expect(await fsp.readFile(path.join(outside, '.importing-op_bbbbbbbbbbbbbbbb'), 'utf8')).toBe('user data outside');
    const d = await getDashboard(fx.ws, { disk: null });
    expect(d.stats.warnings.find((w) => w.code === 'AREA_UNREADABLE')).toBeTruthy();
  });
});

describe('Checkpoint D F8: moves never replace', () => {
  it('move onto an existing destination is a CONFLICT and leaves both files intact', async () => {
    const fx = await fixtureWorkspace();
    const b = fx.ws.blobs;
    const mk = async (rel: string, content: string) => b.commit(await b.stage('SHARED_MEDIA', await (async () => {
      const p = path.join(fx.src, `${Math.random()}.mp4`);
      await fsp.writeFile(p, content);
      return p;
    })()), rel);
    const a = await mk('SHARED_MEDIA/m/a.mp4', 'aaa');
    const c = await mk('SHARED_MEDIA/m/c.mp4', 'ccc');
    const ha = (await b.hash(a)).hash;
    expect(await code(b.move(a, c, ha))).toBe('CONFLICT');
    expect((await b.hash(c)).hash).not.toBe(ha);
    expect((await b.hash(a)).hash).toBe(ha);
    // A successful move keeps the file read-only.
    await b.move(a, 'SHARED_MEDIA/m/a2.mp4', ha);
    await expect(fsp.writeFile(path.join(fx.ws.root, 'SHARED_MEDIA/m/a2.mp4'), 'x')).rejects.toThrow();
  });
});
