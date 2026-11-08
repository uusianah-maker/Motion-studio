import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';
import { type BackupStatus, backupStatusOf } from './backup.js';
import { type Holder, buildIndex, holdersOf } from './deps.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { newId } from './ids.js';
import { clearJournal, journalBusy, listJournal, writeJournal } from './journal.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import type { Actor } from './permissions.js';
import { type Registry, loadRegistry, saveRegistry } from './registry.js';
import { readTrashManifest } from './trash.js';
import { META_FILES, type Workspace, metaPath, withWorkspaceLock } from './workspace.js';

/** Must be typed by the user: a distinct confirmation, not implied by any cleanup approval (PRD v0.8 §F). */
export const PURGE_PHRASE = 'HAPUS PERMANEN';
export const PURGE_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface PurgePlanItem {
  version_id: string;
  media_id: string;
  filename: string;
  size: number;
  trash_rel_path: string;
  original_rel_path: string;
  trashed_at: number | null;
  referenced_by: Holder[];
  protected_by: string[];
  backup: BackupStatus;
  purgeable: boolean;
  blockers: string[];
}

export interface PurgePlan {
  request_id: string;
  /** Shown once to the UI; only its hash is stored. */
  confirmation_token: string;
  required_phrase: typeof PURGE_PHRASE;
  expires_at: number;
  irreversible: true;
  items: PurgePlanItem[];
  total_bytes: number;
}

interface StoredRequest {
  request_id: string;
  token_sha256: string;
  version_ids: string[];
  created_at: number;
  expires_at: number;
  used: boolean;
}
interface RequestFile {
  schema_version: 1;
  requests: StoredRequest[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const loadRequests = (ws: Workspace) =>
  readJson(metaPath(ws, META_FILES.purgeRequests), (x) => {
    const o = x as RequestFile;
    if (o?.schema_version !== 1 || !Array.isArray(o.requests)) throw new StorageError('INDEX_INVALID', 'purge_requests.json tidak valid');
    return o;
  }, 'INDEX_INVALID');
const saveRequests = (ws: Workspace, f: RequestFile) => writeJsonAtomic(metaPath(ws, META_FILES.purgeRequests), f);

/** Any unreadable journal = an unknown operation in flight → every purge item is blocked (review C-M1). */
async function corruptJournal(ws: Workspace): Promise<boolean> {
  return (await listJournal(ws)).some((j) => !j.entry);
}

/** Evaluate every purge blocker for one version against fresh data. */
async function blockersFor(ws: Workspace, reg: Registry, versionId: string, holders: Holder[], busy: ReadonlySet<string>): Promise<{ blockers: string[]; protectedBy: string[] }> {
  const blockers: string[] = [];
  const protectedBy: string[] = [];
  const v = reg.versions[versionId];
  if (!v) return { blockers: ['NOT_FOUND'], protectedBy };
  if (v.lifecycle !== 'trashed' || !v.trash) blockers.push(`NOT_IN_TRASH (${v.lifecycle})`);
  if (holders.length) blockers.push('REFERENCED');
  if (reg.media[v.media_id]?.current_version_id === v.version_id) protectedBy.push('CURRENT');
  if (v.keep) protectedBy.push('KEEP');
  if (v.pin) protectedBy.push('PIN');
  if (v.legal_hold) protectedBy.push('LEGAL_HOLD');
  if (protectedBy.length) blockers.push(`PROTECTED (${protectedBy.join(', ')})`);
  if (busy.has(versionId)) blockers.push('BUSY');
  return { blockers, protectedBy };
}

/**
 * Step 1: build the purge dialog content (filename, size, IDs, referencing projects,
 * irreversibility, backup verification) and issue a single-use confirmation token.
 */
export async function preparePurge(ws: Workspace, input: { version_ids: string[]; actor: Actor }): Promise<PurgePlan> {
  await guard(ws, input.actor, 'purge', { version_ids: input.version_ids, step: 'prepare' });
  if (!input.version_ids.length) throw new StorageError('PRECONDITION', 'Pilih minimal satu item Trash');
  return withWorkspaceLock(ws, 'preparePurge', async () => {
    const idx = await buildIndex(ws);
    const reg = await loadRegistry(ws);
    const busy = await journalBusy(ws);
    const journalCorrupt = await corruptJournal(ws);
    const items: PurgePlanItem[] = [];
    for (const id of [...new Set(input.version_ids)]) {
      const v = reg.versions[id];
      if (!v) throw new StorageError('NOT_FOUND', 'Versi tidak ditemukan', { version_id: id });
      const holders = idx.ok ? holdersOf(idx.index, id) : [];
      const { blockers, protectedBy } = await blockersFor(ws, reg, id, holders, busy);
      if (!idx.ok) blockers.push('INDEX_INVALID');
      if (journalCorrupt) blockers.push('JOURNAL_CORRUPT');
      items.push({
        version_id: id,
        media_id: v.media_id,
        filename: v.original_name,
        size: v.size,
        trash_rel_path: v.rel_path,
        original_rel_path: v.trash?.original_rel_path ?? v.rel_path,
        trashed_at: v.trash?.trashed_at ?? null,
        referenced_by: holders,
        protected_by: protectedBy,
        backup: await backupStatusOf(ws, id),
        purgeable: blockers.length === 0,
        blockers,
      });
    }
    const token = randomBytes(32).toString('hex');
    const now = ws.clock.now();
    const req: StoredRequest = { request_id: newId('pr'), token_sha256: sha(token), version_ids: items.map((i) => i.version_id), created_at: now, expires_at: now + PURGE_REQUEST_TTL_MS, used: false };
    const f = await loadRequests(ws);
    f.requests = f.requests.filter((r) => !r.used && r.expires_at > now); // drop stale requests
    f.requests.push(req);
    await saveRequests(ws, f);
    await audit(ws, { op: 'purge.prepare', actor: input.actor, outcome: 'info', request_id: req.request_id, items: items.map((i) => ({ version_id: i.version_id, purgeable: i.purgeable, blockers: i.blockers, backup: i.backup.status })) });
    return { request_id: req.request_id, confirmation_token: token, required_phrase: PURGE_PHRASE, expires_at: req.expires_at, irreversible: true, items, total_bytes: items.reduce((a, i) => a + i.size, 0) };
  });
}

export interface PurgeResult {
  request_id: string;
  purged: string[];
  blocked: { version_id: string; reasons: string[] }[];
  freed_bytes: number;
}

/**
 * Step 2: permanent delete. Requires the single-use token AND the typed phrase, then runs a
 * fresh, locked dependency audit; any reference, protection, unknown index, active job or
 * integrity error blocks that item. Never callable by AI or scheduler. Every attempt audited.
 */
export async function executePurge(ws: Workspace, input: { request_id: string; confirmation_token: string; typed_phrase: string; actor: Actor }): Promise<PurgeResult> {
  await guard(ws, input.actor, 'purge', { request_id: input.request_id, step: 'execute' });
  return withWorkspaceLock(ws, 'executePurge', async () => {
    const now = ws.clock.now();
    const f = await loadRequests(ws);
    const req = f.requests.find((r) => r.request_id === input.request_id);
    const deny = async (reason: string): Promise<never> => {
      await audit(ws, { op: 'purge.execute', actor: input.actor, outcome: 'blocked', request_id: input.request_id, reason });
      throw new StorageError('FORBIDDEN', `Penghapusan permanen ditolak: ${reason}`, { reason });
    };
    if (!req) return deny('REQUEST_UNKNOWN');
    if (req.used) return deny('REQUEST_ALREADY_USED');
    // Burn the request on any attempt so a token can never be retried or replayed. Consequence
    // (documented): any wrong attempt cancels the request and the user must prepare again.
    req.used = true;
    await saveRequests(ws, f);
    if (now > req.expires_at) return deny('REQUEST_EXPIRED');
    const a = Buffer.from(sha(input.confirmation_token ?? ''), 'hex');
    const b = Buffer.from(req.token_sha256, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny('TOKEN_MISMATCH');
    if (input.typed_phrase !== PURGE_PHRASE) return deny('PHRASE_MISMATCH');

    const result: PurgeResult = { request_id: req.request_id, purged: [], blocked: [], freed_bytes: 0 };
    const idx = await buildIndex(ws);
    if (!idx.ok) {
      for (const id of req.version_ids) result.blocked.push({ version_id: id, reasons: ['INDEX_INVALID'] });
      await audit(ws, { op: 'purge.execute', actor: input.actor, outcome: 'blocked', request_id: req.request_id, reason: 'INDEX_INVALID', errors: idx.errors });
      return result;
    }
    const reg = await loadRegistry(ws);
    const busy = await journalBusy(ws);
    const journalCorrupt = await corruptJournal(ws);
    for (const id of req.version_ids) {
      const { blockers } = await blockersFor(ws, reg, id, holdersOf(idx.index, id), busy);
      if (journalCorrupt) blockers.push('JOURNAL_CORRUPT');
      const v = reg.versions[id];
      let fileRel: string | null = null;
      let manifestRel: string | null = null;
      if (!blockers.length && v?.trash) {
        try {
          const m = await readTrashManifest(ws, v.trash.manifest_rel_path);
          if (m.version_id !== id || m.content_hash !== v.content_hash) blockers.push('MANIFEST_MISMATCH');
          manifestRel = await ws.blobs.resolve(v.trash.manifest_rel_path, ['trash']);
          fileRel = await ws.blobs.resolve(v.rel_path, ['trash']);
          const st = await ws.blobs.stat(fileRel);
          if (!st) throw new StorageError('NOT_FOUND', 'File Trash tidak ditemukan');
          if (!st.isFile) blockers.push('NOT_A_FILE');
          else if (st.multiLinked) blockers.push('HARD_LINKED');
          else if ((await ws.blobs.hash(fileRel)).hash !== v.content_hash) blockers.push('HASH_MISMATCH');
        } catch (e) {
          blockers.push(`UNVERIFIABLE: ${e instanceof StorageError ? e.code : ((e as NodeJS.ErrnoException)?.code ?? "IO_ERROR")}`);
        }
      }
      if (blockers.length || !v || !fileRel || !manifestRel) {
        result.blocked.push({ version_id: id, reasons: blockers.length ? blockers : ['UNKNOWN'] });
        await audit(ws, { op: 'purge.item', actor: input.actor, outcome: 'blocked', request_id: req.request_id, version_id: id, reasons: blockers });
        continue;
      }
      const trashPath = v.rel_path;
      const journal = { schema_version: 1 as const, op_id: req.request_id, kind: 'purge' as const, version_id: id, from_rel: trashPath, to_rel: trashPath, manifest_rel: v.trash!.manifest_rel_path, content_hash: v.content_hash, started_at: now };
      // Journal + "started" audit BEFORE deleting, so a crash is never silent (review C-M2).
      await writeJournal(ws, journal);
      await audit(ws, { op: 'purge.item', actor: input.actor, outcome: 'info', phase: 'started', request_id: req.request_id, media_id: v.media_id, version_id: id, deleted_path: trashPath, checksum: v.content_hash, size: v.size });
      await ws.blobs.remove(fileRel);
      await ws.blobs.remove(manifestRel, { missingOk: true });
      await ws.blobs.pruneEmptyParents(manifestRel, 2);
      reg.versions[id] = { ...v, lifecycle: 'purged', trash: null, unreferenced_since: null };
      await saveRegistry(ws, reg);
      await clearJournal(ws, journal);
      result.purged.push(id);
      result.freed_bytes += v.size;
      await audit(ws, { op: 'purge.item', actor: input.actor, outcome: 'ok', phase: 'done', request_id: req.request_id, media_id: v.media_id, version_id: id, deleted_path: trashPath, checksum: v.content_hash, size: v.size });
    }
    await audit(ws, { op: 'purge.execute', actor: input.actor, outcome: 'ok', request_id: req.request_id, purged: result.purged.length, blocked: result.blocked.length, freed_bytes: result.freed_bytes });
    return result;
  });
}
