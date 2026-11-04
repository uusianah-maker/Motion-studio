import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit, redact } from '../src/storage/audit.js';
import { ManualClock } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import {
  addVersion,
  importMedia,
  loadRegistry,
  setCurrentVersion,
  setProtection,
  verifyVersion,
} from '../src/storage/registry.js';
import { createProject, initWorkspace } from '../src/storage/workspace.js';
import { tempDir, tryLink } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const sha = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function setup() {
  const clock = new ManualClock(Date.UTC(2026, 10, 1));
  const ws = await initWorkspace(path.join(await tempDir(), 'ws'), { clock });
  const src = await tempDir('src-');
  const file = async (name: string, content: string | Buffer) => {
    const p = path.join(src, name);
    await fsp.writeFile(p, content);
    return p;
  };
  return { ws, clock, file, src };
}

describe('ST-02 import', () => {
  it('imports shared media: stable IDs, sha256, read-only file, new-protected state, audit', async () => {
    const { ws, file } = await setup();
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7); // multi-chunk stream
    const r = await importMedia(ws, { sourcePath: await file('Clip A.MP4', big), scope: { kind: 'shared' }, actor: 'user' });
    expect(r.duplicate).toBe(false);
    expect(r.media.media_id).toMatch(/^m_[0-9a-f]{16}$/);
    expect(r.version.version_id).toMatch(/^v_[0-9a-f]{16}$/);
    expect(r.version).toMatchObject({
      content_hash: sha(big),
      size: big.length,
      rel_path: `SHARED_MEDIA/${r.media.media_id}/${r.version.version_id}.mp4`,
      original_name: 'Clip A.MP4',
      lifecycle: 'active',
      integrity: 'ok',
      ever_referenced: false,
      unreferenced_since: null,
    });
    expect(r.media.current_version_id).toBe(r.version.version_id);
    const abs = path.join(ws.root, r.version.rel_path);
    expect((await fsp.readFile(abs)).equals(big)).toBe(true);
    await expect(fsp.writeFile(abs, 'tamper')).rejects.toThrow(); // read-only
    // No temp files left in the media area.
    expect((await fsp.readdir(path.join(ws.root, 'SHARED_MEDIA'))).filter((n) => n.startsWith('.importing'))).toEqual([]);
    const log = await readAudit(ws, (e) => e.op === 'media.import');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: 'ok', version_id: r.version.version_id, content_hash: sha(big) });
  });

  it('imports into a project 01_INPUT; unknown project is rejected', async () => {
    const { ws, file } = await setup();
    await createProject(ws, { project_id: 'p1', name: 'P1' });
    const r = await importMedia(ws, { sourcePath: await file('a.mov', 'aaa'), scope: { kind: 'project', project_id: 'p1' }, actor: 'user' });
    expect(r.version.rel_path).toBe(`PROJECTS/p1/01_INPUT/${r.media.media_id}/${r.version.version_id}.mov`);
    expect(await code(importMedia(ws, { sourcePath: await file('b.mov', 'b'), scope: { kind: 'project', project_id: 'nope' }, actor: 'user' }))).toBe('NOT_FOUND');
    expect(await code(importMedia(ws, { sourcePath: await file('c.mov', 'c'), scope: { kind: 'project', project_id: '../x' }, actor: 'user' }))).toBe('PATH_INVALID');
  });

  it('duplicate bytes return the existing version (also under concurrent imports)', async () => {
    const { ws, file } = await setup();
    const a = await importMedia(ws, { sourcePath: await file('a.mp4', 'same-bytes'), scope: { kind: 'shared' }, actor: 'user' });
    const b = await importMedia(ws, { sourcePath: await file('b-renamed.mp4', 'same-bytes'), scope: { kind: 'shared' }, actor: 'user' });
    expect(b.duplicate).toBe(true);
    expect(b.version.version_id).toBe(a.version.version_id);

    const p1 = await file('c1.mp4', 'concurrent');
    const p2 = await file('c2.mp4', 'concurrent');
    const [x, y] = await Promise.all([
      importMedia(ws, { sourcePath: p1, scope: { kind: 'shared' }, actor: 'user' }),
      importMedia(ws, { sourcePath: p2, scope: { kind: 'shared' }, actor: 'user' }),
    ]);
    expect(x.version.version_id).toBe(y.version.version_id);
    const reg = await loadRegistry(ws);
    expect(Object.keys(reg.versions)).toHaveLength(2);
    expect(Object.keys(reg.media)).toHaveLength(2);
  });

  it('rejects bad sources and non-user actors', async () => {
    const { ws, file, src } = await setup();
    expect(await code(importMedia(ws, { sourcePath: path.join(src, 'missing.mp4'), scope: { kind: 'shared' }, actor: 'user' }))).toBe('NOT_FOUND');
    expect(await code(importMedia(ws, { sourcePath: src, scope: { kind: 'shared' }, actor: 'user' }))).toBe('PRECONDITION');
    expect(await code(importMedia(ws, { sourcePath: await file('empty.mp4', ''), scope: { kind: 'shared' }, actor: 'user' }))).toBe('PRECONDITION');
    const inside = path.join(ws.root, 'SHARED_ASSETS', 'x.mp4');
    await fsp.writeFile(inside, 'x');
    expect(await code(importMedia(ws, { sourcePath: inside, scope: { kind: 'shared' }, actor: 'user' }))).toBe('PRECONDITION');
    const linkDir = path.join(await tempDir(), 'lnk');
    expect(await tryLink(src, linkDir, 'junction')).toBe(true);
    // A file reached through a junction is still a regular file: allowed as a *source* (read only).
    const viaJunction = await file('ok.mp4', 'ok');
    expect(await code(importMedia(ws, { sourcePath: path.join(linkDir, path.basename(viaJunction)), scope: { kind: 'shared' }, actor: 'user' }))).toBe('OK');
    expect(await code(importMedia(ws, { sourcePath: await file('ai.mp4', 'ai'), scope: { kind: 'shared' }, actor: 'ai' }))).toBe('FORBIDDEN');
    expect(await code(importMedia(ws, { sourcePath: await file('s.mp4', 's'), scope: { kind: 'shared' }, actor: 'scheduler' }))).toBe('FORBIDDEN');
  });
});

describe('ST-02 immutable versions', () => {
  it('addVersion creates a new version; old bytes untouched; duplicate of same media is reused', async () => {
    const { ws, file } = await setup();
    const v1 = await importMedia(ws, { sourcePath: await file('look.mp4', 'v1-bytes'), scope: { kind: 'shared' }, actor: 'user' });
    const v2 = await addVersion(ws, { media_id: v1.media.media_id, sourcePath: await file('look-recut.mp4', 'v2-bytes'), actor: 'user' });
    expect(v2.version.version_id).not.toBe(v1.version.version_id);
    expect(v2.media.current_version_id).toBe(v2.version.version_id);
    expect(await fsp.readFile(path.join(ws.root, v1.version.rel_path), 'utf8')).toBe('v1-bytes');
    const reg = await loadRegistry(ws);
    expect(reg.versions[v1.version.version_id]!.content_hash).toBe(sha('v1-bytes'));

    const again = await addVersion(ws, { media_id: v1.media.media_id, sourcePath: await file('again.mp4', 'v1-bytes'), actor: 'user' });
    expect(again.duplicate).toBe(true);
    expect(again.version.version_id).toBe(v1.version.version_id);

    const v3 = await addVersion(ws, { media_id: v1.media.media_id, sourcePath: await file('alt.mp4', 'v3'), makeCurrent: false, actor: 'user' });
    expect(v3.media.current_version_id).toBe(v2.version.version_id);
    expect(await code(addVersion(ws, { media_id: 'm_missing', sourcePath: await file('z.mp4', 'z'), actor: 'user' }))).toBe('NOT_FOUND');
  });

  it('setCurrentVersion and setProtection are user-only and audited', async () => {
    const { ws, file } = await setup();
    const v1 = await importMedia(ws, { sourcePath: await file('a.mp4', '1'), scope: { kind: 'shared' }, actor: 'user' });
    const v2 = await addVersion(ws, { media_id: v1.media.media_id, sourcePath: await file('b.mp4', '2'), actor: 'user' });
    expect((await setCurrentVersion(ws, { media_id: v1.media.media_id, version_id: v1.version.version_id, actor: 'user' })).current_version_id).toBe(v1.version.version_id);
    expect(await code(setCurrentVersion(ws, { media_id: v1.media.media_id, version_id: v2.version.version_id, actor: 'ai' }))).toBe('FORBIDDEN');
    const p = await setProtection(ws, { version_id: v2.version.version_id, keep: true, legal_hold: true, actor: 'user' });
    expect(p).toMatchObject({ keep: true, pin: false, legal_hold: true });
    expect(await code(setProtection(ws, { version_id: v2.version.version_id, keep: false, actor: 'ai' }))).toBe('FORBIDDEN');
    expect(await readAudit(ws, (e) => e.op === 'media.set_protection')).toHaveLength(1);
  });

  it('GC-11: replaced bytes without a new version → CHANGED alert, recorded hash never updated', async () => {
    const { ws, file, clock } = await setup();
    const r = await importMedia(ws, { sourcePath: await file('a.mp4', 'original'), scope: { kind: 'shared' }, actor: 'user' });
    const abs = path.join(ws.root, r.version.rel_path);
    expect((await verifyVersion(ws, r.version.version_id)).integrity).toBe('ok');

    await fsp.chmod(abs, 0o666);
    await fsp.writeFile(abs, 'swapped behind our back');
    clock.advance(1000);
    const v = await verifyVersion(ws, r.version.version_id);
    expect(v).toMatchObject({ integrity: 'changed', expected_hash: sha('original'), actual_hash: sha('swapped behind our back') });
    const reg = await loadRegistry(ws);
    expect(reg.versions[r.version.version_id]).toMatchObject({ integrity: 'changed', content_hash: sha('original') });
    expect(await readAudit(ws, (e) => e.op === 'media.verify' && e.outcome === 'alert')).toHaveLength(1);
    // A changed version cannot become current.
    expect(await code(setCurrentVersion(ws, { media_id: r.media.media_id, version_id: r.version.version_id, actor: 'user' }))).toBe('PRECONDITION');

    await fsp.rm(abs);
    expect((await verifyVersion(ws, r.version.version_id)).integrity).toBe('missing');
  });

  it('corrupt registry fails closed with INDEX_INVALID', async () => {
    const { ws, file } = await setup();
    await importMedia(ws, { sourcePath: await file('a.mp4', 'a'), scope: { kind: 'shared' }, actor: 'user' });
    const regPath = path.join(ws.root, '.motionstudio', 'registry.json');
    const reg = JSON.parse(await fsp.readFile(regPath, 'utf8'));
    const vid = Object.keys(reg.versions)[0]!;
    reg.versions[vid].content_hash = 'md5:abc';
    await fsp.writeFile(regPath, JSON.stringify(reg));
    expect(await code(loadRegistry(ws))).toBe('INDEX_INVALID');
    await fsp.writeFile(regPath, '{"schema_version":1');
    expect(await code(loadRegistry(ws))).toBe('INDEX_INVALID');
    expect(await code(importMedia(ws, { sourcePath: await file('b.mp4', 'b'), scope: { kind: 'shared' }, actor: 'user' }))).toBe('INDEX_INVALID');
  });
});

describe('audit redaction', () => {
  it('never writes secret-looking fields', () => {
    expect(redact({ api_key: 'sk-1', nested: { Authorization: 'Bearer x', ok: 1 }, list: [{ secret: 's' }], confirmation_token: 't' })).toEqual({
      api_key: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', ok: 1 },
      list: [{ secret: '[REDACTED]' }],
      confirmation_token: '[REDACTED]',
    });
  });
});
