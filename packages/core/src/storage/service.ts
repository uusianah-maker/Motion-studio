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
import { type EditOp, MAX_EDIT_OPS, MAX_SERVER_OPS, editManifest, stepHistory, validateOps } from './timeline.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { newId } from './ids.js';
import * as admin from './projectAdmin.js';
import * as brand from './brand.js';
import * as variants from './variants.js';
import * as engine from './engine.js';
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

/** Same id shape as `POST /api/projects` (safe folder name, unguessable). */
const newProjectId = () => `p-${newId('c').slice(2, 14)}`;

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
  async editTimeline(input: { project_id: string; expected_revision: number; ops: unknown; label?: string; actor: Actor; max_ops?: number }) {
    await guard(this.ws, input.actor, 'commit_project', { project_id: input.project_id, step: 'edit' });
    const ops = validateOps(input.ops, Math.min(input.max_ops ?? MAX_EDIT_OPS, MAX_SERVER_OPS));
    const current = await this.revisionOrConflict(input.project_id, input.expected_revision);
    admin.assertEditable(current);
    const reg = await registry.loadRegistry(this.ws);
    const sourceDuration = (ref: { version_id: string }) => reg.versions[ref.version_id]?.probe?.duration_ms;
    const next = editManifest(current, ops, input.label?.slice(0, 80) || describeOps(ops), { now: this.ws.clock.now(), newId: () => newId('snap'), newClipId: () => newId('c'), sourceDuration });
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
    admin.assertEditable(current);
    const next = stepHistory(current, direction, { now: this.ws.clock.now(), newId: () => newId('snap') });
    return this.commitProject({ manifest: next, expected_revision: input.expected_revision, actor: input.actor });
  }

  // ---- X05 project management (rename/archive, duplicate, export/import)
  updateProjectMeta(input: Parameters<typeof admin.updateProjectMeta>[1]) {
    return mutate(this.ws, 'svc.updateProjectMeta', input.actor, () => admin.updateProjectMeta(this.ws, input));
  }

  duplicateProject(input: Omit<Parameters<typeof admin.duplicateProject>[1], 'new_project_id'> & { new_project_id?: string }) {
    return mutate(this.ws, 'svc.duplicateProject', input.actor, () => admin.duplicateProject(this.ws, { ...input, new_project_id: input.new_project_id ?? newProjectId() }));
  }

  exportProject(projectId: string) {
    return admin.exportProject(this.ws, projectId, this.ws.clock.now());
  }

  importProject(input: Omit<Parameters<typeof admin.importProject>[1], 'new_project_id'> & { new_project_id?: string }) {
    return mutate(this.ws, 'svc.importProject', input.actor, () => admin.importProject(this.ws, { ...input, new_project_id: input.new_project_id ?? newProjectId() }));
  }

  // ---- X09 variants
  createVariants(input: { master_id: string; briefs: unknown; actor: Actor }) {
    return mutate(this.ws, 'svc.createVariants', input.actor, () => variants.createVariants(this.ws, { ...input, newId: newProjectId }));
  }

  setVariantApproval(input: Parameters<typeof variants.setVariantApproval>[1]) {
    return mutate(this.ws, 'svc.setVariantApproval', input.actor, () => variants.setVariantApproval(this.ws, input));
  }

  listVariants(masterId: string) {
    return variants.listVariants(this.ws, masterId);
  }

  // ---- U5 Batch Remix: approve / strike rows of an engine batch
  decideBatch(input: { project_id: string; job_id: string; rows: unknown; config: engine.EngineConfig | null; actor: Actor }) {
    if (input.actor !== 'user') throw new StorageError('FORBIDDEN', 'Hanya pengguna yang boleh menyetujui batch');
    // Audit Jenius #6: nothing is imported from a job that is not a finished batch.
    return engine
      .readEngineStatus(this.ws, input.project_id, input.job_id)
      .then((s) => {
        if (s.mode !== 'batch') throw new StorageError('EDIT_INVALID', 'Job ini bukan Batch Remix');
        if (s.state !== 'siap') throw new StorageError('EDIT_INVALID', 'Batch belum siap');
      })
      .then(() => engine.loadBatchPlans(this.ws, input.config, input.project_id, input.job_id, input.rows).then((plans) =>
      mutate(this.ws, 'svc.decideBatch', input.actor, () => engine.decideBatch(this.ws, input.config, { ...input, actor: 'user', newId: newProjectId, plans })),
    ));
  }

  // ---- X06 Brand Kit (workspace level). Saving reconciles clocks: font/logo become held.
  readBrandKit() {
    return brand.readBrandKit(this.ws);
  }

  // ---- U1 multi-brand
  listBrands() {
    return brand.listBrands(this.ws);
  }

  defaultBrandId() {
    return brand.defaultBrandId(this.ws);
  }

  readBrand(brandId: string) {
    return brand.readBrand(this.ws, brandId);
  }

  readBrandFor(brandId: string | null | undefined) {
    return brand.readBrandFor(this.ws, brandId);
  }

  duplicateBrand(input: { brand_id: string; name: unknown; kode?: unknown; actor: Actor }) {
    return mutate(this.ws, 'svc.duplicateBrand', input.actor, () => brand.duplicateBrand(this.ws, { ...input, newId: () => `b-${newId('c').slice(2, 14)}` }));
  }

  createBrand(input: { kit: unknown; actor: Actor }) {
    return mutate(this.ws, 'svc.createBrand', input.actor, () => brand.createBrand(this.ws, { ...input, newId: () => `b-${newId('c').slice(2, 14)}` }));
  }

  setDefaultBrand(input: Parameters<typeof brand.setDefaultBrand>[1]) {
    return brand.setDefaultBrand(this.ws, input);
  }

  deleteBrand(input: Parameters<typeof brand.deleteBrand>[1]) {
    return mutate(this.ws, 'svc.deleteBrand', input.actor, () => brand.deleteBrand(this.ws, input));
  }

  exportBrandKit(brandId: string, opts: { paths: boolean }) {
    return brand.exportBrandKit(this.ws, brandId, opts);
  }

  setBrandKit(input: Parameters<typeof brand.setBrandKit>[1]) {
    return mutate(this.ws, 'svc.setBrandKit', input.actor, () => brand.setBrandKit(this.ws, input));
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

  /** Probe versions imported before W07 / without ffprobe (metadata only, bounded). */
  backfillProbes(opts?: { limit?: number }) {
    return registry.backfillProbes(this.ws, opts);
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
  set_text: 'Ubah teks',
  set_canvas: 'Ubah rasio',
  set_style: 'Ubah gaya teks',
  set_volume: 'Ubah volume',
  set_framing: 'Crop / blur',
  set_brand_logo: 'Logo brand',
  remove_range: 'Hapus jeda',
  set_loudness: 'Loudness',
  split_at: 'Potong di adegan',
  set_track_mute: 'Bisukan/nyalakan track',
  set_audio: 'Fade / reduksi noise',
  set_picture: 'Tampilan gambar',
  set_ducking: 'Ducking musik',
  set_keyframes: 'Keyframe',
  set_motion: 'Putar / kecepatan / mundur',
  freeze_frame: 'Bekukan frame',
  delete_clips: 'Hapus beberapa klip',
  shift_clips: 'Geser beberapa klip',
  set_style_many: 'Ubah gaya beberapa teks',
  duplicate_clip: 'Duplikat klip',
  set_media: 'Ganti file klip',
};

/** Short human label for the undo history ("Geser klip", "3 perubahan"). */
export function describeOps(ops: EditOp[]): string {
  return ops.length === 1 ? OP_LABEL[ops[0]!.op] : `${ops.length} perubahan`;
}
