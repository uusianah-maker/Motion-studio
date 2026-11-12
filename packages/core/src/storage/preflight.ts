import path from 'node:path';
import { type GuardIssue, checkBrandGuard, localDate } from './brandGuard.js';
import { brandRenderRefs, readBrandKit } from './brand.js';
import { audit } from './audit.js';
import { type Lease, createLease, loadLeases, releaseLease } from './deps.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { journalBusy } from './journal.js';
import { normalizeRelative } from './paths.js';
import { type Actor, MEDIA_AREAS } from './permissions.js';
import type { MediaRef } from './project.js';
import { estimateSpace } from './quota.js';
import { loadRegistry } from './registry.js';
import { type Workspace, projectRel, readProject, withWorkspaceLock } from './workspace.js';

export interface SnapshotItem extends MediaRef {
  content_hash: string;
}

export type PreflightProblem =
  | { code: 'MEDIA_UNKNOWN' | 'MEDIA_TRASHED' | 'MEDIA_PURGED' | 'MEDIA_BUSY'; ref: MediaRef }
  | { code: 'MEDIA_MISSING' | 'MEDIA_CHANGED'; ref: MediaRef; relink_options: MediaRef[] }
  | { code: 'OUTPUT_NOT_WRITABLE'; detail: string }
  | { code: 'INSUFFICIENT_DISK'; free_bytes: number | null; needed_bytes: number; reserve_bytes: number }
  | { code: 'NO_MEDIA' }
  /** X08: an expired promo price or a banned claim (block level) is on screen. */
  | { code: 'BRAND_BLOCKED'; issues: GuardIssue[] }
  /** X08: warn-level brand issues the user has not accepted for this render. */
  | { code: 'BRAND_WARNING'; issues: GuardIssue[] };

export interface PreflightResult {
  ok: boolean;
  project_id: string;
  project_revision: number;
  /** Exact media versions + hashes the render will use (immutable dependency snapshot). */
  snapshot: SnapshotItem[];
  output_rel: string;
  /** True when the requested name was taken and a versioned name was chosen instead. */
  output_versioned: boolean;
  problems: PreflightProblem[];
  /** Informational: e.g. a newer version exists but is NOT used automatically. */
  notes: string[];
}

function safeOutputName(name: string): string {
  const n = normalizeRelative(name);
  if (n.includes('/')) throw new StorageError('PATH_INVALID', 'Nama output tidak boleh berisi folder', { name });
  return n;
}

async function freeOutputName(ws: Workspace, dirRel: string, name: string, reserved: ReadonlySet<string>): Promise<{ name: string; versioned: boolean }> {
  const ext = path.posix.extname(name);
  const base = path.posix.basename(name, ext);
  const taken = async (n: string) => reserved.has(n.toLowerCase()) || ws.blobs.exists(`${dirRel}/${n}`);
  if (!(await taken(name))) return { name, versioned: false };
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}_v${i}${ext}`;
    if (!(await taken(cand))) return { name: cand, versioned: true };
  }
  throw new StorageError('CONFLICT', 'Tidak ada nama output versi yang bebas');
}

/**
 * Render preflight (PRD v0.8 §H): availability + fresh hash of every locked version,
 * no silent upgrade/relink, versioned output path in 05_OUTPUT (no overwrite of finals
 * without explicit approval), write permission and disk space checks.
 */
export async function renderPreflight(
  ws: Workspace,
  input: { project_id: string; output_name: string; estimated_bytes: number; approve_overwrite?: boolean; accept_brand_warnings?: boolean; actor: Actor; disk?: { free_bytes: number; total_bytes: number } | null },
): Promise<PreflightResult> {
  await guard(ws, input.actor, 'render_preflight', { project_id: input.project_id });
  if (input.approve_overwrite && input.actor !== 'user') {
    // Overwriting a final needs an explicit *user* decision (review C-M3).
    await audit(ws, { op: 'render.preflight', actor: input.actor, outcome: 'blocked', reason: 'OVERWRITE_NOT_USER', project_id: input.project_id });
    throw new StorageError('FORBIDDEN', 'Hanya user yang boleh menyetujui overwrite output');
  }
  if (input.accept_brand_warnings && input.actor !== 'user') throw new StorageError('FORBIDDEN', 'Hanya user yang boleh menerima peringatan Brand guard');
  const project = await readProject(ws, input.project_id);
  const reg = await loadRegistry(ws);
  const busy = await journalBusy(ws);
  const problems: PreflightProblem[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const snapshot: SnapshotItem[] = [];

  const refs: MediaRef[] = [];
  for (const t of project.timeline.tracks) for (const c of t.clips) if (c.media) refs.push(c.media);
  if (!refs.length) problems.push({ code: 'NO_MEDIA' });
  // X06: Brand Kit font/logo this render uses are verified and leased like clip media.
  const kit = await readBrandKit(ws);
  const brand = brandRenderRefs(project.timeline, kit);
  // X08 Brand guard: expired prices / banned claims on screen.
  const issues = checkBrandGuard(project.timeline, kit.guard, localDate(ws.clock.now()));
  const blocking = issues.filter((i) => i.level === 'block');
  const warning = issues.filter((i) => i.level === 'warn');
  if (blocking.length) problems.push({ code: 'BRAND_BLOCKED', issues: blocking });
  if (warning.length && !input.accept_brand_warnings) problems.push({ code: 'BRAND_WARNING', issues: warning });
  else if (warning.length) notes.push(`Peringatan Brand guard diterima user untuk render ini: ${[...new Set(warning.map((w) => w.match))].join(', ')}`);
  if (brand.font) refs.push(brand.font);
  if (brand.logo) refs.push(brand.logo.ref);

  for (const ref of refs) {
    if (seen.has(ref.version_id)) continue;
    seen.add(ref.version_id);
    const v = reg.versions[ref.version_id];
    if (!v || v.media_id !== ref.media_id) {
      problems.push({ code: 'MEDIA_UNKNOWN', ref });
      continue;
    }
    if (v.lifecycle === 'trashed') {
      problems.push({ code: 'MEDIA_TRASHED', ref });
      continue;
    }
    if (v.lifecycle === 'purged') {
      problems.push({ code: 'MEDIA_PURGED', ref });
      continue;
    }
    if (busy.has(v.version_id)) {
      problems.push({ code: 'MEDIA_BUSY', ref });
      continue;
    }
    // Relink proposal = other intact, active versions of the same media. Never applied automatically.
    const relink_options = Object.values(reg.versions)
      .filter((o) => o.media_id === v.media_id && o.version_id !== v.version_id && o.lifecycle === 'active' && o.integrity === 'ok')
      .map((o) => ({ media_id: o.media_id, version_id: o.version_id }));
    try {
      const { hash } = await ws.blobs.hash(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS));
      if (hash !== v.content_hash) {
        problems.push({ code: 'MEDIA_CHANGED', ref, relink_options });
        continue;
      }
    } catch {
      problems.push({ code: 'MEDIA_MISSING', ref, relink_options });
      continue;
    }
    const current = reg.media[v.media_id]!.current_version_id;
    if (current !== v.version_id) notes.push(`Versi lebih baru tersedia untuk ${v.media_id} (${current}); render tetap memakai ${v.version_id} sesuai timeline`);
    snapshot.push({ media_id: v.media_id, version_id: v.version_id, content_hash: v.content_hash });
  }

  // Output: versioned, inside this project's 05_OUTPUT only.
  const name = safeOutputName(input.output_name);
  const outTarget = await ws.blobs.resolve(`${projectRel(input.project_id, '05_OUTPUT')}/${name}`, ['project_output'], { allowMissing: true });
  const dirRel = path.posix.dirname(outTarget);
  const outPrefix = `${projectRel(input.project_id, '05_OUTPUT')}/`.toLowerCase();
  const reserved = new Set(
    (await loadLeases(ws)).leases
      .map((l) => l.output_rel?.toLowerCase())
      .filter((r): r is string => !!r && r.startsWith(outPrefix))
      .map((r) => r.slice(outPrefix.length)),
  );
  let chosen = { name, versioned: false };
  if (!input.approve_overwrite) chosen = await freeOutputName(ws, dirRel, name, reserved);
  else if (reserved.has(name.toLowerCase())) problems.push({ code: 'OUTPUT_NOT_WRITABLE', detail: 'Nama output sedang dipakai render lain yang belum selesai' });
  else notes.push('Overwrite output disetujui eksplisit oleh user');
  const output_rel = `${projectRel(input.project_id, '05_OUTPUT')}/${chosen.name}`;

  // Write permission: create and remove a probe file (access() is unreliable on Windows).
  try {
    await ws.blobs.probeWritable(dirRel);
  } catch (e) {
    problems.push({ code: 'OUTPUT_NOT_WRITABLE', detail: String(e) });
  }

  const space = await estimateSpace(ws, { bytes_needed: input.estimated_bytes, ...(input.disk !== undefined ? { disk: input.disk } : {}) });
  if (!space.ok) problems.push({ code: 'INSUFFICIENT_DISK', free_bytes: space.free_bytes, needed_bytes: input.estimated_bytes, reserve_bytes: space.reserve_bytes });

  const result: PreflightResult = { ok: problems.length === 0, project_id: project.project_id, project_revision: project.revision, snapshot, output_rel, output_versioned: chosen.versioned, problems, notes };
  await audit(ws, { op: 'render.preflight', actor: input.actor, outcome: result.ok ? 'ok' : 'blocked', project_id: project.project_id, revision: project.revision, output_rel, problems: problems.map((p) => p.code), brand_issues: issues.map((x) => ({ kind: x.kind, level: x.level, clip_id: x.clip_id, match: x.match })), brand_warnings_accepted: !!input.accept_brand_warnings && warning.length > 0, snapshot });
  return result;
}

/**
 * Preflight + lease in ONE workspace lock: the hashes verified by preflight are the ones the
 * lease pins, and the output name is reserved atomically (no two renders share a final).
 * External byte changes after this point are caught by `verifyRenderSnapshot` before reading.
 */
export async function startRender(ws: Workspace, input: Parameters<typeof renderPreflight>[1] & { worker_pid?: number }): Promise<{ preflight: PreflightResult; lease: Lease | null }> {
  return withWorkspaceLock(ws, 'startRender', async () => {
    const preflight = await renderPreflight(ws, input);
    if (!preflight.ok) return { preflight, lease: null };
    const lease = await createLease(ws, {
      job: 'render',
      label: `${preflight.project_id}@${preflight.project_revision} → ${preflight.output_rel}`,
      media: preflight.snapshot.map(({ media_id, version_id }) => ({ media_id, version_id })),
      output_rel: preflight.output_rel,
      actor: input.actor,
      ...(input.worker_pid !== undefined ? { worker_pid: input.worker_pid } : {}),
    });
    return { preflight, lease };
  });
}

/** Right before the worker reads media: re-check every leased file is still intact and unmoved. */
export async function verifyRenderSnapshot(ws: Workspace, leaseId: string): Promise<{ ok: boolean; problems: string[] }> {
  const lease = (await loadLeases(ws)).leases.find((l) => l.lease_id === leaseId);
  if (!lease) return { ok: false, problems: ['LEASE_UNKNOWN'] };
  const reg = await loadRegistry(ws);
  const problems: string[] = [];
  for (const m of lease.media) {
    const v = reg.versions[m.version_id];
    if (!v || v.lifecycle !== 'active') {
      problems.push(`${m.version_id}: ${v?.lifecycle ?? 'unknown'}`);
      continue;
    }
    try {
      if ((await ws.blobs.hash(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS))).hash !== m.content_hash) problems.push(`${m.version_id}: CHANGED`);
    } catch {
      problems.push(`${m.version_id}: MISSING`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export const finishRender = (ws: Workspace, input: { lease_id: string; outcome: 'completed' | 'failed' | 'cancelled'; actor: Actor }) => releaseLease(ws, input);
