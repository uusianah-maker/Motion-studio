export type StorageErrorCode =
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_LINK_REJECTED'
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_LOCKED'
  | 'PROJECT_INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTEGRITY'
  | 'FORBIDDEN'
  | 'INDEX_INVALID'
  | 'PRECONDITION'
  /** A timeline edit that would produce an invalid timeline (overlap, too short, unknown clip…). */
  | 'EDIT_INVALID';

/** Typed error so callers (UI/IPC) can react without parsing messages. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export const isStorageError = (e: unknown, code?: StorageErrorCode): e is StorageError =>
  e instanceof StorageError && (code === undefined || e.code === code);
