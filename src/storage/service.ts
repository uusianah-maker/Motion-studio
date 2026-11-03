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
import { type Workspace, withWorkspaceLock } from './workspace.js';

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
