import { promises as fsp } from 'node:fs';
import { readBrand } from './brand.js';
import { commitProject } from './deps.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { isSafeId } from './ids.js';
import type { Actor } from './permissions.js';
import { type MediaRef, type ProjectManifest, type Timeline, type VariantInfo, PROJECT_SCHEMA_VERSION, validateProjectManifest } from './project.js';
import { loadRegistry } from './registry.js';
import { resolveInside } from './paths.js';
import { type Workspace, createProject, projectRel, readProject } from './workspace.js';

/**
 * Project management (X05, PRD §6 "project manager"): rename, archive, duplicate, export/import.
 * Everything goes through `commitProject`, so media references, dependency checks and the
 * 30-day clocks behave exactly like an edit. Export never contains files or paths (PC-13: files
 * stay on the PC) — only the timeline and which media versions it uses (ids + content hash).
 */

export const EXPORT_FORMAT = 'motion-studio-project';
export const EXPORT_VERSION = 1;
export const MAX_PROJECT_NAME = 120;

export interface ProjectExport {
  format: typeof EXPORT_FORMAT;
  format_version: typeof EXPORT_VERSION;
  exported_at: number;
  project: { name: string; timeline: Timeline };
  media: { media_id: string; version_id: string; content_hash: string; display_name: string; duration_ms: number | null }[];
}

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};

export function cleanName(x: unknown): string {
  if (typeof x !== 'string') return bad('Nama proyek wajib teks');
  // Control characters (newlines, tabs, NUL…) become spaces: a name is one plain line.
  const name = [...x].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').trim();
  if (!name) bad('Nama proyek tidak boleh kosong');
  if (name.length > MAX_PROJECT_NAME) bad(`Nama proyek maksimal ${MAX_PROJECT_NAME} karakter`);
  return name;
}

const clipRefs = (t: Timeline): MediaRef[] => t.tracks.flatMap((tr) => tr.clips.flatMap((c) => (c.media ? [c.media] : [])));

/** Rename and/or archive/activate. History (undo/redo) is kept; the revision moves on. */
export async function updateProjectMeta(ws: Workspace, input: { project_id: string; expected_revision: number; name?: unknown; status?: unknown; brand_id?: unknown; actor: Actor }): Promise<ProjectManifest> {
  await guard(ws, input.actor, 'commit_project', { project_id: input.project_id, step: 'meta' });
  if (input.name === undefined && input.status === undefined && input.brand_id === undefined) bad('Tidak ada yang diubah');
  // U1: brand per project (null = back to the workspace default brand).
  if (input.brand_id !== undefined && input.brand_id !== null) await readBrand(ws, typeof input.brand_id === 'string' ? input.brand_id : '');
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') bad('Status harus active atau archived');
  const current = await readProject(ws, input.project_id);
  if (current.revision !== input.expected_revision) throw new StorageError('CONFLICT', 'Revisi proyek sudah berubah; muat ulang dulu', { expected: input.expected_revision, actual: current.revision });
  const next: ProjectManifest = {
    ...current,
    ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
    ...(input.status !== undefined ? { status: input.status as ProjectManifest['status'] } : {}),
  };
  if (input.brand_id === null) delete next.brand_id;
  else if (input.brand_id !== undefined) next.brand_id = input.brand_id as string;
  return commitProject(ws, { manifest: next, expected_revision: input.expected_revision, actor: input.actor });
}

/**
 * A brand-new project (fresh id, empty history) with `timeline` committed as its first revision.
 * If the commit is refused (e.g. a media version is in Trash) the half-made project is removed,
 * so a failed duplicate/import leaves nothing behind.
 */
export async function createWithTimeline(ws: Workspace, input: { project_id: string; name: string; timeline: Timeline; actor: Actor; variant?: VariantInfo; brand_id?: string }): Promise<ProjectManifest> {
  const fresh = await createProject(ws, { project_id: input.project_id, name: input.name });
  try {
    return await commitProject(ws, { manifest: { ...fresh, timeline: input.timeline, ...(input.variant ? { variant: input.variant } : {}), ...(input.brand_id ? { brand_id: input.brand_id } : {}) }, expected_revision: 0, actor: input.actor });
  } catch (e) {
    // Checkpoint G G-3: the folder was created by this call a moment ago (fresh, unguessable id;
    // `createProject` refuses an existing one), so it is removed whatever step failed — even if the
    // manifest was already written before a later step threw.
    await fsp.rm(await resolveInside(ws.root, projectRel(fresh.project_id)), { recursive: true, force: true });
    throw e;
  }
}

export async function duplicateProject(ws: Workspace, input: { project_id: string; new_project_id: string; name?: unknown; actor: Actor }): Promise<ProjectManifest> {
  await guard(ws, input.actor, 'commit_project', { project_id: input.project_id, step: 'duplicate' });
  const src = await readProject(ws, input.project_id);
  const name = input.name === undefined ? cleanName(`${src.name} (salinan)`.slice(0, MAX_PROJECT_NAME)) : cleanName(input.name);
  return createWithTimeline(ws, { project_id: input.new_project_id, name, timeline: structuredClone(src.timeline), actor: input.actor, ...(src.brand_id ? { brand_id: src.brand_id } : {}) });
}

export async function exportProject(ws: Workspace, projectId: string, now: number): Promise<ProjectExport> {
  const p = await readProject(ws, projectId);
  const reg = await loadRegistry(ws);
  const seen = new Set<string>();
  const media: ProjectExport['media'] = [];
  for (const ref of clipRefs(p.timeline)) {
    if (seen.has(ref.version_id)) continue;
    seen.add(ref.version_id);
    const v = reg.versions[ref.version_id];
    const m = reg.media[ref.media_id];
    media.push({ media_id: ref.media_id, version_id: ref.version_id, content_hash: v?.content_hash ?? '', display_name: m?.display_name ?? ref.media_id, duration_ms: v?.probe?.duration_ms ?? null });
  }
  return { format: EXPORT_FORMAT, format_version: EXPORT_VERSION, exported_at: now, project: { name: p.name, timeline: structuredClone(p.timeline) }, media };
}

/**
 * Import an exported project as a NEW project. Media must already be in this workspace (files are
 * never inside the export): a reference is kept when that exact version exists here, otherwise it
 * is matched by content hash (same file imported on another PC). Anything else is refused as a
 * whole with the list of missing files.
 */
export async function importProject(ws: Workspace, input: { data: unknown; new_project_id: string; name?: unknown; actor: Actor }): Promise<{ project: ProjectManifest; remapped: number }> {
  await guard(ws, input.actor, 'commit_project', { project_id: input.new_project_id, step: 'import' });
  const d = input.data;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return bad('File impor bukan proyek Motion Studio');
  const o = d as Record<string, unknown>;
  if (o.format !== EXPORT_FORMAT) bad('File impor bukan proyek Motion Studio (format tidak dikenal)');
  if (o.format_version !== EXPORT_VERSION) bad(`Versi file impor ${String(o.format_version)} belum didukung`);
  const proj = o.project as Record<string, unknown> | undefined;
  if (typeof proj !== 'object' || proj === null) return bad('File impor tidak berisi proyek');
  const name = cleanName(input.name ?? proj.name);
  // Same validator as a stored manifest: shapes, ids, styles, volumes, clip limits.
  let timeline: Timeline;
  try {
    timeline = validateProjectManifest({
      schema_version: PROJECT_SCHEMA_VERSION,
      project_id: 'import',
      name,
      status: 'active',
      revision: 0,
      created_at: 0,
      updated_at: 0,
      timeline: proj.timeline,
      snapshots: [],
    }).timeline;
  } catch (e) {
    throw new StorageError('EDIT_INVALID', `Linimasa di file impor tidak valid: ${e instanceof Error ? e.message : String(e)}`);
  }
  const listed = Array.isArray(o.media) ? (o.media as unknown[]) : [];
  const hashOf = new Map<string, { hash: string; name: string }>();
  for (const m of listed) {
    const x = m as Record<string, unknown>;
    if (x && isSafeId(x.version_id) && typeof x.content_hash === 'string') hashOf.set(x.version_id, { hash: x.content_hash, name: typeof x.display_name === 'string' ? x.display_name.slice(0, 120) : x.version_id });
  }
  const reg = await loadRegistry(ws);
  const byHash = new Map<string, MediaRef>();
  for (const v of Object.values(reg.versions)) if (v.lifecycle === 'active' && v.integrity === 'ok' && !byHash.has(v.content_hash)) byHash.set(v.content_hash, { media_id: v.media_id, version_id: v.version_id });
  const missing = new Set<string>();
  let remapped = 0;
  for (const tr of timeline.tracks) {
    for (const c of tr.clips) {
      if (!c.media) continue;
      const here = reg.versions[c.media.version_id];
      // Checkpoint G G-2: keep the id only when that version is usable; otherwise try the same bytes.
      if (here && here.media_id === c.media.media_id && here.lifecycle === 'active' && here.integrity === 'ok') continue;
      const info = hashOf.get(c.media.version_id);
      const match = info?.hash ? byHash.get(info.hash) : undefined;
      if (match) {
        c.media = { ...match };
        remapped++;
      } else if (!here || here.media_id !== c.media.media_id) missing.add(info?.name ?? c.media.version_id);
      // else: known here but in Trash/damaged and no other copy — the commit below explains which.
    }
  }
  if (missing.size) throw new StorageError('PRECONDITION', `Media belum ada di workspace ini: ${[...missing].join(', ')}. Impor file videonya dulu, lalu impor proyek lagi.`, { missing: [...missing] });
  const project = await createWithTimeline(ws, { project_id: input.new_project_id, name, timeline, actor: input.actor });
  return { project, remapped };
}

/** Archived projects are read-only for the timeline (activate to edit again). */
export function assertEditable(m: ProjectManifest): void {
  if (m.status === 'archived') throw new StorageError('PRECONDITION', 'Proyek diarsipkan (hanya-baca). Aktifkan lagi untuk mengedit.', { project_id: m.project_id });
}
