import * as deps from './deps.js';
import { type SyncResult, syncClocks } from './eligibility.js';
import type { Actor } from './permissions.js';
import type { ProjectManifest } from './project.js';
import * as registry from './registry.js';
import * as backup from './backup.js';
import * as render from './preflight.js';
import { executePurge, preparePurge } from './purge.js';
import { recoverOnStartup } from './recovery.js';
import { restoreVersion } from './restore.js';
import { GcScheduler } from './scheduler.js';
import { scanCandidates } from './scanner.js';
import { runAutoTrash } from './trash.js';
import { type EditOp, editManifest, stepHistory, validateOps } from './timeline.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { newId } from './ids.js';
import { type Workspace, readProject, withWorkspaceLock } from './workspace.js';

/**
 * Single entry point for the UI/IPC layer (ADR-001 D1/D2).
 * Every mutation that can change references or protection reconciles the 30-day clocks
 * inside the same workspace lock, so the clock starts exactly when the last
 * reference/protection disappears (PRD v0.8 §B "Eligibility start").
 */
export interface Mutation<T> {
  result: T;
  /** Clock reconciliation outcome; `ok:false` means the index is invalid (clocks untouched, fail closed). */
  clocks: SyncResult;
}

async function mutate<T>(ws: Workspace, op: string, actor: Actor, fn: () => Promise<T>): Promise<Mutation<T>> {
  return withWorkspaceLock(ws, op, async () => {
    const result = await fn();
    const clocks = await syncClocks(ws, actor === 'ai' ? 'system' : actor);
    return { result, clocks };
  });
}

export class StorageService {
  constructor(readonly ws: Workspace) {}

  importMedia(input: Parameters<typeof registry.importMedia>[1]) {
    return registry.importMedia(this.ws, input); // new media never-used: no clock to reconcile
  }

  addVersion(input: Parameters<typeof registry.addVersion>[1]) {
    return mutate(this.ws, 'svc.addVersion', input.actor, () => registry.addVersion(this.ws, input));
  }

  setCurrentVersion(input: Parameters<typeof registry.setCurrentVersion>[1]) {
    return mutate(this.ws, 'svc.setCurrentVersion', input.actor, () => registry.setCurrentVersion(this.ws, input));
  }

  setProtection(input: Parameters<typeof registry.setProtection>[1]) {
    return mutate(this.ws, 'svc.setProtection', input.actor, () => registry.setProtection(this.ws, input));
  }

  commitProject(input: { manifest: ProjectManifest; expected_revision: number; actor: Actor }) {
    return mutate(this.ws, 'svc.commitProject', input.actor, () => deps.commitProject(this.ws, input));
  }

  /**
   * Manual timeline edit (W06): validate ops, apply them with the shared reducer, keep the old
   * timeline as a retained undo step, then commit through the normal path (revision check,
   * media usable, clocks reconciled). Atomic: an invalid op changes nothing.
   */
  async editTimeline(input: { project_id: string; expected_revision: number; ops: unknown; label?: string; actor: Actor }) {
    await guard(this.ws, input.actor, 'commit_project', { project_id: input.project_id, step: 'edit' });
    const ops = validateOps(input.ops);
    const current = await this.revisionOrConflict(input.project_id, input.expected_revision);
    const next = editManifest(current, ops, input.label?.slice(0, 80) || describeOps(ops), { now: this.ws.clock.now(), newId: () => newId('snap'), newClipId: () => newId('c') });
    return this.commitProject({ manifest: next, expected_revision: input.expected_revision, actor: input.actor });
  }

  async undoTimeline(input: { project_id: string; expected_revision: number; actor: Actor }) {
    return this.step(input, 'undo');
  }

  async redoTimeline(input: { project_id: string; expected_revision: number; actor: Actor }) {
    return this.step(input, 'redo');
  }

  private async step(input: { project_id: string; expected_revision: number; actor: Actor }, direction: 'undo' | 'redo') {
    await guard(this.ws, input.actor, 'commit_project', { project_id: input.project_id, step: direction });
    const current = await this.revisionOrConflict(input.project_id, input.expected_revision);
    const next = stepHistory(current, direction, { now: this.ws.clock.now(), newId: () => newId('snap') });
    return this.commitProject({ manifest: next, expected_revision: input.expected_revision, actor: input.actor });
  }

  private async revisionOrConflict(projectId: string, expected: number) {
    const current = await readProject(this.ws, projectId);
    if (current.revision !== expected) throw new StorageError('CONFLICT', 'Revisi proyek sudah berubah; muat ulang dulu', { expected, actual: current.revision });
    return current;
  }

  createLease(input: Parameters<typeof deps.createLease>[1]) {
    return mutate(this.ws, 'svc.createLease', input.actor, () => deps.createLease(this.ws, input));
  }

  setLeaseStatus(input: Parameters<typeof deps.setLeaseStatus>[1]) {
    return deps.setLeaseStatus(this.ws, input);
  }

  releaseLease(input: Parameters<typeof deps.releaseLease>[1]) {
    return mutate(this.ws, 'svc.releaseLease', input.actor, () => deps.releaseLease(this.ws, input));
  }

  verifyVersion(versionId: string) {
    return registry.verifyVersion(this.ws, versionId);
  }

  scan(opts: Parameters<typeof scanCandidates>[1]) {
    return scanCandidates(this.ws, opts);
  }

  autoTrash(opts: Parameters<typeof runAutoTrash>[1]) {
    return runAutoTrash(this.ws, opts);
  }

  /** Restore + clock sync: a restored, still-unreferenced version starts a brand-new 30-day period. */
  restore(input: Parameters<typeof restoreVersion>[1]) {
    return mutate(this.ws, 'svc.restore', input.actor, () => restoreVersion(this.ws, input));
  }

  /** Step 1 of manual permanent delete (user only): dialog details + single-use token. */
  preparePurge(input: Parameters<typeof preparePurge>[1]) {
    return preparePurge(this.ws, input);
  }

  /** Step 2: token + typed phrase + fresh locked dependency audit. Never automatic. */
  executePurge(input: Parameters<typeof executePurge>[1]) {
    return executePurge(this.ws, input);
  }

  registerBackupLocation(input: Parameters<typeof backup.registerBackupLocation>[1]) {
    return backup.registerBackupLocation(this.ws, input);
  }

  verifyBackupLocation(input: Parameters<typeof backup.verifyBackupLocation>[1]) {
    return backup.verifyBackupLocation(this.ws, input);
  }

  recover() {
    return recoverOnStartup(this.ws);
  }

  createScheduler(opts?: ConstructorParameters<typeof GcScheduler>[1]) {
    return new GcScheduler(this.ws, opts);
  }

  renderPreflight(input: Parameters<typeof render.renderPreflight>[1]) {
    return render.renderPreflight(this.ws, input);
  }

  /** Preflight + render lease pinning the exact dependency snapshot (clock reset via lease). */
  startRender(input: Parameters<typeof render.startRender>[1]) {
    return mutate(this.ws, 'svc.startRender', input.actor, () => render.startRender(this.ws, input));
  }

  verifyRenderSnapshot(leaseId: string) {
    return render.verifyRenderSnapshot(this.ws, leaseId);
  }

  /** Release the render lease; the 30-day clock restarts if nothing else holds the media. */
  finishRender(input: Parameters<typeof render.finishRender>[1]) {
    return mutate(this.ws, 'svc.finishRender', input.actor, () => render.finishRender(this.ws, input));
  }
}

const OP_LABEL: Record<EditOp['op'], string> = {
  add_clip: 'Tambah klip',
  move_clip: 'Geser klip',
  trim_clip: 'Trim klip',
  split_clip: 'Split klip',
  delete_clip: 'Hapus klip',
};

/** Short human label for the undo history ("Geser klip", "3 perubahan"). */
export function describeOps(ops: EditOp[]): string {
  return ops.length === 1 ? OP_LABEL[ops[0]!.op] : `${ops.length} perubahan`;
}
