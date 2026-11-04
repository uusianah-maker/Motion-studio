import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { backupStatusOf, registerBackupLocation, verifyBackupLocation } from '../src/storage/backup.js';
import { DAY_MS } from '../src/storage/clock.js';
import { isStorageError } from '../src/storage/errors.js';
import { PURGE_PHRASE, executePurge, preparePurge } from '../src/storage/purge.js';
import { loadRegistry, setProtection } from '../src/storage/registry.js';
import { scanCandidates } from '../src/storage/scanner.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { buildManifest, fixtureWorkspace, oldVersion } from './fixtures.js';
import { tempDir } from './helpers.js';
import { readProject } from '../src/storage/workspace.js';

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? `${e.code}:${String(e.details?.reason ?? '')}` : `RAW:${String(e)}`;
  }
};

async function trashed(n = 1) {
  const fx = await fixtureWorkspace();
  const refs = [];
  for (let i = 0; i < n; i++) refs.push(await oldVersion(fx.ws, fx.src, `proj${i}`));
  fx.clock.advance(30 * DAY_MS);
  const t = await runAutoTrash(fx.ws, { actor: 'scheduler' });
  if (t.moved.length !== n) throw new Error('fixture');
  return { ...fx, refs, moved: t.moved };
}

describe('ST-08 manual permanent delete', () => {
  it('GC-08: prepare shows full details; execute needs token + typed phrase; fresh locked audit; deletes', async () => {
    const fx = await trashed(1);
    const id = fx.refs[0]!.version_id;
    fx.clock.advance(DAY_MS); // only 1 day in Trash: no minimum wait (Option A)
    const plan = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    expect(plan).toMatchObject({ irreversible: true, required_phrase: PURGE_PHRASE });
    expect(plan.items[0]).toMatchObject({ version_id: id, purgeable: true, blockers: [], referenced_by: [], backup: { status: 'unverified' } });
    expect(plan.items[0]!.filename).toMatch(/\.mp4$/);
    expect(plan.items[0]!.size).toBeGreaterThan(0);
    // The raw token is never persisted.
    expect(await fsp.readFile(path.join(fx.ws.root, '.motionstudio', 'purge_requests.json'), 'utf8')).not.toContain(plan.confirmation_token);

    const r = await executePurge(fx.ws, { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(r.purged).toEqual([id]);
    expect(r.freed_bytes).toBe(plan.items[0]!.size);
    expect(await exists(path.join(fx.ws.root, fx.moved[0]!.to))).toBe(false);
    expect((await loadRegistry(fx.ws)).versions[id]).toMatchObject({ lifecycle: 'purged', trash: null });
    expect(await readAudit(fx.ws, (e) => e.op === 'purge.item' && e.outcome === 'ok')).toHaveLength(1);
    // Audit never contains the token.
    expect(await fsp.readFile(path.join(fx.ws.root, '.motionstudio', 'audit.log.jsonl'), 'utf8')).not.toContain(plan.confirmation_token);
  });

  it('wrong token, wrong phrase, expired, replayed or unknown requests are refused and audited', async () => {
    const fx = await trashed(1);
    const id = fx.refs[0]!.version_id;
    const ok = (p: Awaited<ReturnType<typeof preparePurge>>) => ({ request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' as const });
    let p = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    expect(await code(executePurge(fx.ws, { ...ok(p), confirmation_token: 'f'.repeat(64) }))).toBe('FORBIDDEN:TOKEN_MISMATCH');
    expect(await code(executePurge(fx.ws, ok(p)))).toBe('FORBIDDEN:REQUEST_ALREADY_USED'); // burned by the failed attempt
    p = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    expect(await code(executePurge(fx.ws, { ...ok(p), typed_phrase: 'hapus permanen' }))).toBe('FORBIDDEN:PHRASE_MISMATCH');
    p = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    fx.clock.advance(11 * 60 * 1000);
    expect(await code(executePurge(fx.ws, ok(p)))).toBe('FORBIDDEN:REQUEST_EXPIRED');
    expect(await code(executePurge(fx.ws, { ...ok(p), request_id: 'pr_nope' }))).toBe('FORBIDDEN:REQUEST_UNKNOWN');
    expect((await loadRegistry(fx.ws)).versions[id]!.lifecycle).toBe('trashed');
    expect((await readAudit(fx.ws, (e) => e.op === 'purge.execute' && e.outcome === 'blocked')).length).toBe(5);
  });

  it('GC-12 / Option A: AI and scheduler can never purge (prepare or execute)', async () => {
    const fx = await trashed(1);
    const id = fx.refs[0]!.version_id;
    expect(await code(preparePurge(fx.ws, { version_ids: [id], actor: 'ai' }))).toBe('FORBIDDEN:');
    expect(await code(preparePurge(fx.ws, { version_ids: [id], actor: 'scheduler' }))).toBe('FORBIDDEN:');
    const p = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    expect(await code(executePurge(fx.ws, { request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'ai' }))).toBe('FORBIDDEN:');
    expect(await readAudit(fx.ws, (e) => e.op === 'denied.purge')).toHaveLength(3);
    expect((await loadRegistry(fx.ws)).versions[id]!.lifecycle).toBe('trashed');
  });

  it('protection added after prepare, or an invalid index, blocks at execute (fresh locked audit)', async () => {
    const fx = await trashed(2);
    const [a, b] = fx.refs.map((r) => r.version_id) as [string, string];
    const p = await preparePurge(fx.ws, { version_ids: [a, b], actor: 'user' });
    expect(p.items.every((i) => i.purgeable)).toBe(true);
    await setProtection(fx.ws, { version_id: a, legal_hold: true, actor: 'user' });
    const r = await executePurge(fx.ws, { request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(r.purged).toEqual([b]);
    expect(r.blocked).toEqual([{ version_id: a, reasons: ['PROTECTED (LEGAL_HOLD)'] }]);

    // A manifest that (externally) references the trashed item makes the index invalid → block all.
    await setProtection(fx.ws, { version_id: a, legal_hold: false, actor: 'user' });
    const base = await readProject(fx.ws, 'proj0');
    await fsp.writeFile(path.join(fx.ws.root, 'PROJECTS/proj0/03_PROJECT/project.json'), JSON.stringify(buildManifest(base, { timeline: [fx.refs[0]!] })));
    const p2 = await preparePurge(fx.ws, { version_ids: [a], actor: 'user' });
    expect(p2.items[0]!.blockers).toContain('INDEX_INVALID');
    const r2 = await executePurge(fx.ws, { request_id: p2.request_id, confirmation_token: p2.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(r2).toMatchObject({ purged: [], blocked: [{ version_id: a, reasons: ['INDEX_INVALID'] }] });
  });

  it('non-trashed, tampered or hard-linked items are blocked', async () => {
    const fx = await trashed(2);
    const [a, b] = fx.refs.map((r) => r.version_id) as [string, string];
    const reg = await loadRegistry(fx.ws);
    const current = reg.media[reg.versions[a]!.media_id]!.current_version_id;
    const aAbs = path.join(fx.ws.root, reg.versions[a]!.rel_path);
    await fsp.chmod(aAbs, 0o666);
    await fsp.writeFile(aAbs, 'tampered');
    await fsp.link(path.join(fx.ws.root, reg.versions[b]!.rel_path), path.join(await tempDir(), 'hl.mp4'));
    const p = await preparePurge(fx.ws, { version_ids: [a, b, current], actor: 'user' });
    expect(p.items.find((i) => i.version_id === current)!.blockers.join()).toMatch(/NOT_IN_TRASH.*PROTECTED \(CURRENT\)/);
    const r = await executePurge(fx.ws, { request_id: p.request_id, confirmation_token: p.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
    expect(r.purged).toEqual([]);
    const reasons = Object.fromEntries(r.blocked.map((x) => [x.version_id, x.reasons.join()]));
    expect(reasons[a]).toBe('HASH_MISMATCH');
    expect(reasons[b]).toBe('HARD_LINKED');
    expect(await exists(aAbs)).toBe(true);
  });

  it('design checks: Trash item held 365 days is never auto-purged by scans or Auto Trash', async () => {
    const fx = await trashed(1);
    const id = fx.refs[0]!.version_id;
    for (let d = 0; d < 365; d += 73) {
      fx.clock.advance(73 * DAY_MS);
      await scanCandidates(fx.ws, { actor: 'scheduler' });
      await runAutoTrash(fx.ws, { actor: 'scheduler' });
    }
    expect((await loadRegistry(fx.ws)).versions[id]!.lifecycle).toBe('trashed');
    expect(await exists(path.join(fx.ws.root, fx.moved[0]!.to))).toBe(true);
    expect(await readAudit(fx.ws, (e) => e.op.startsWith('purge.'))).toEqual([]);
  });
});

describe('manual backup verification (shown in purge dialog)', () => {
  it('only a hash-verified copy counts as backed up; folder must be outside the workspace', async () => {
    const fx = await trashed(1);
    const id = fx.refs[0]!.version_id;
    const reg = await loadRegistry(fx.ws);
    const bytes = await fsp.readFile(path.join(fx.ws.root, reg.versions[id]!.rel_path));
    const backupDir = await tempDir('backup-');
    await fsp.mkdir(path.join(backupDir, 'deep', 'er'), { recursive: true });
    await fsp.writeFile(path.join(backupDir, 'deep', 'er', 'renamed.mp4'), bytes);
    await fsp.writeFile(path.join(backupDir, 'wrong.mp4'), Buffer.alloc(bytes.length, 1)); // same size, different bytes
    expect(await code(registerBackupLocation(fx.ws, { path: path.join(fx.ws.root, 'SHARED_ASSETS'), actor: 'user' }))).toBe('PRECONDITION:');
    expect(await code(registerBackupLocation(fx.ws, { path: backupDir, actor: 'ai' }))).toBe('FORBIDDEN:');
    const loc = await registerBackupLocation(fx.ws, { path: backupDir, actor: 'user' });
    expect((await backupStatusOf(fx.ws, id)).status).toBe('unverified');
    const v = await verifyBackupLocation(fx.ws, { location_id: loc.location_id, actor: 'user' });
    expect(v.matched).toContain(id);
    expect(v.hashed).toBeGreaterThanOrEqual(2);
    expect(await backupStatusOf(fx.ws, id)).toMatchObject({ status: 'verified', backup_rel: path.join('deep', 'er', 'renamed.mp4') });
    const plan = await preparePurge(fx.ws, { version_ids: [id], actor: 'user' });
    expect(plan.items[0]!.backup.status).toBe('verified');
  });
});
