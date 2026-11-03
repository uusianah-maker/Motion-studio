import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DAY_MS, ManualClock } from '../src/storage/clock.js';
import type { MediaRef, ProjectManifest } from '../src/storage/project.js';
import { addVersion, importMedia } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { type Workspace, createProject, initWorkspace, readProject } from '../src/storage/workspace.js';
import { tempDir } from './helpers.js';

export const T0 = Date.UTC(2026, 10, 1);
export { DAY_MS };

export async function fixtureWorkspace(): Promise<{ ws: Workspace; clock: ManualClock; src: string }> {
  const clock = new ManualClock(T0);
  const ws = await initWorkspace(path.join(await tempDir(), 'ws'), { clock });
  return { ws, clock, src: await tempDir('src-') };
}

let n = 0;
/** Import unique bytes as shared media and return its ref. */
export async function importShared(ws: Workspace, src: string, label = 'clip'): Promise<MediaRef> {
  const p = path.join(src, `${label}-${++n}.mp4`);
  await fsp.writeFile(p, `${label}-${n}-${Math.random()}`);
  const r = await importMedia(ws, { sourcePath: p, scope: { kind: 'shared' }, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
}

export interface ProjectSpec {
  timeline?: MediaRef[];
  retained?: MediaRef[];
  undo?: MediaRef[];
  dropped?: MediaRef[]; // non-retained snapshot: must NOT hold media
  status?: 'active' | 'archived';
}

export function buildManifest(base: ProjectManifest, spec: ProjectSpec): ProjectManifest {
  return {
    ...base,
    status: spec.status ?? base.status,
    timeline: {
      tracks: [
        { track_id: 'video', kind: 'video', clips: (spec.timeline ?? []).map((m, i) => ({ clip_id: `c${i}`, start_ms: i * 1000, end_ms: i * 1000 + 1000, media: m })) },
      ],
    },
    snapshots: [
      ...(spec.retained?.length ? [{ snapshot_id: 'snap1', kind: 'snapshot' as const, retained: true, created_at: base.created_at, media: spec.retained }] : []),
      ...(spec.undo?.length ? [{ snapshot_id: 'undo1', kind: 'undo' as const, retained: true, created_at: base.created_at, media: spec.undo }] : []),
      ...(spec.dropped?.length ? [{ snapshot_id: 'old1', kind: 'snapshot' as const, retained: false, created_at: base.created_at, media: spec.dropped }] : []),
    ],
  };
}

/** Create the project if needed and commit the given references through the service (clocks reconciled). */
export async function commit(ws: Workspace, projectId: string, spec: ProjectSpec): Promise<ProjectManifest> {
  let base: ProjectManifest;
  try {
    base = await readProject(ws, projectId);
  } catch {
    base = await createProject(ws, { project_id: projectId, name: projectId });
  }
  const r = await new StorageService(ws).commitProject({ manifest: buildManifest(base, spec), expected_revision: base.revision, actor: 'user' });
  if (!r.clocks.ok) throw new Error(`clock sync failed: ${r.clocks.errors.join('; ')}`);
  return r.result;
}

let k = 0;
/** An old, non-current, previously referenced version whose clock started now. */
export async function oldVersion(ws: Workspace, src: string, project = `p${++k}`): Promise<MediaRef> {
  const old = await importShared(ws, src, 'old');
  const p = path.join(src, `new-${++k}-${Math.random()}.mp4`);
  await fsp.writeFile(p, `new-${k}-${Math.random()}`);
  await addVersion(ws, { media_id: old.media_id, sourcePath: p, actor: 'user' });
  await commit(ws, project, { timeline: [old] });
  await commit(ws, project, { timeline: [] });
  return old;
}

