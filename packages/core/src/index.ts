/** Public API of the storage core for apps (server, CLI). Apps import only from here. */
export { type AuditEntry, audit, readAudit } from './storage/audit.js';
export type { BlobStat, StagedBlob, StorageBackend } from './storage/backend.js';
export { type Clock, DAY_MS, ManualClock, systemClock } from './storage/clock.js';
export { StorageError, type StorageErrorCode, isStorageError } from './storage/errors.js';
export { LocalFsBackend } from './storage/localfs.js';
export type { Actor, Area, Operation } from './storage/permissions.js';
export { recoverOnStartup, type RecoveryReport } from './storage/recovery.js';
export { StorageService } from './storage/service.js';
export { type Workspace, type WorkspaceOptions, initWorkspace, openWorkspace } from './storage/workspace.js';
