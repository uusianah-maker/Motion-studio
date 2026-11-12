/** Public API of the storage core for apps (server, CLI). Apps import only from here. */
export { type AuditEntry, audit, readAudit } from './storage/audit.js';
export type { BlobStat, StagedBlob, StorageBackend } from './storage/backend.js';
export { type Clock, DAY_MS, ManualClock, systemClock } from './storage/clock.js';
export { StorageError, type StorageErrorCode, isStorageError } from './storage/errors.js';
export { LocalFsBackend } from './storage/localfs.js';
export { type Actor, type Area, MEDIA_AREAS, type Operation } from './storage/permissions.js';
export { BROWSER_VIDEO_CODECS, type MediaProbe } from './storage/probe.js';
export { type CleanCheck, type ToolCheck, checkTools, findFont, runFfmpeg, verifyCleanOutput } from './storage/ffmpeg.js';
export {
  DEFAULT_RENDER,
  RENDER_TMP_PREFIX,
  type RenderOutcome,
  type RenderOutput,
  type RenderPhase,
  type RenderSettings,
  buildRenderPlan,
  canvasSize,
  listOutputs,
  renderProject,
  visualSegments,
} from './storage/render.js';
export { loadLeases, releaseOrphanLeases } from './storage/deps.js';
export type { PreflightProblem, PreflightResult } from './storage/preflight.js';
export type { Clip, ProjectManifest, Track } from './storage/project.js';
export { PURGE_PHRASE, type PurgePlan, type PurgeResult } from './storage/purge.js';
export { type Dashboard, diskSpace, estimateSpace, getDashboard } from './storage/quota.js';
export { type ImportResult, type MediaRecord, type MediaScope, type Registry, type VersionRecord, loadRegistry } from './storage/registry.js';
export type { RestoreResult } from './storage/restore.js';
export { type CycleResult, GcScheduler } from './storage/scheduler.js';
export { recoverOnStartup, type RecoveryReport } from './storage/recovery.js';
export { StorageService, describeOps } from './storage/service.js';
export { type ClipEffect, RAMP_MS, validateEffect, zoomAt } from './storage/effects.js';
export { type BlurRegion, type Crop, fillCrop, validateBlur, validateCrop } from './storage/framing.js';
export {
  type EngineConfig,
  type EngineJobInput,
  type EngineMode,
  type EnginePlan,
  type EngineStatus,
  engineConfigFromEnv,
  isJobId,
  listEngineJobs,
  loadEnginePlan,
  prepareEngineJob,
  readBatchDecisions,
  decideBatch,
  type BatchDecision,
  readEngineBatch,
  readEngineLog,
  readEngineStatus,
  runEngineJob,
  settleOrphanJob,
  validateEngineJob,
} from './storage/engine.js';
export { type Word as CaptionWord, sliceWords } from './storage/words.js';
export { MAX_VARIANTS_PER_RUN, type VariantState, validateBriefs, variantOps, variantState } from './storage/variants.js';
export { type BrandGuard, EMPTY_GUARD, GUARD_LIMITS, type GuardIssue, bannedIn, checkBrandGuard, localDate } from './storage/brandGuard.js';
export { ANALYSIS_LIMITS, type AnalysisParams, DEFAULT_ANALYSIS, MAX_CUTS, type MediaAnalysis, analyzeMedia, cutOps } from './storage/analysis.js';
export {
  type BrandKit,
  type BrandLogo,
  type BrandPreset,
  ASSET_KINDS,
  type BrandAsset,
  CAPITALS,
  LICENSE_STATUS,
  SUGGESTED_TAGS,
  DISCLAIMER_WHEN,
  EMPTY_BRAND,
  LANGS,
  LOGO_CORNERS,
  LOGO_LIMITS,
  LOGO_SHOW,
  MAX_BRAND_COLORS,
  PLATFORMS,
  TEXT_FREE_AREAS,
  brandRenderRefs,
  readBrandFor,
  readBrandKit,
} from './storage/brand.js';
export { EXPORT_FORMAT, MAX_PROJECT_NAME, type ProjectExport, assertEditable, cleanName } from './storage/projectAdmin.js';
export { COLOR_WORDS, type PresetId, TEXT_PRESETS, TONES, type TextPreset, presetById } from './storage/textPresets.js';
export {
  DEFAULT_STYLES,
  type TextAlign,
  type TextKind,
  type TextStyle,
  aspectOverShort,
  effectiveStyle,
  layoutText,
  validateStyle,
  wrapCharsFor,
} from './storage/textStyle.js';
export { type EditOp, MAX_SERVER_OPS, MIN_CLIP_MS, UNDO_LIMIT, applyOps, historyCounts } from './storage/timeline.js';
export {
  type Cue,
  MAX_CUES,
  type Transcript,
  type Word,
  buildCues,
  cuesToSubtitleOps,
  listTranscripts,
  readTranscript,
  saveNewTranscript,
  updateCues,
  validateCues,
} from './storage/transcript.js';
export {
  type DiffItem,
  type EditPlan,
  LOCAL_EXAMPLES,
  MAX_PROMPT_LEN,
  PLAN_SCHEMA_VERSION,
  type PlanContext,
  type PlanOperation,
  type PlanSource,
  checkPlan,
  describeOps as describePlanOps,
  diffTimelines,
  fmtTime,
  parseTime,
  pickOps,
  planLocal,
  timelineEndMs,
  type BrandContext,
} from './storage/copilot.js';
export { type Workspace, type WorkspaceOptions, createProject, initWorkspace, listProjectIds, openWorkspace, readProject } from './storage/workspace.js';
