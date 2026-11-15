import { type StorageErrorCode, isStorageError } from './core.js';

/** Error codes the HTTP layer adds on top of the storage core's codes. */
export type HttpErrorCode =
  | StorageErrorCode
  | 'UNAUTHORIZED'
  | 'CLIENT_CLOSED'
  | 'HOST_REJECTED'
  | 'ORIGIN_REJECTED'
  | 'ACTOR_NOT_ALLOWED'
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'LENGTH_REQUIRED'
  | 'INSUFFICIENT_STORAGE'
  | 'METHOD_NOT_ALLOWED'
  | 'BUSY'
  | 'AI_UNAVAILABLE'
  | 'AI_OUTPUT_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'ENGINE_MISSING'
  | 'NOT_RUNNING'
  | 'NOT_READY'
  | 'NOT_APPROVED'
  | 'ALREADY_MEMBER'
  | 'MANAGED_BY_ENV'
  | 'SELF_CHANGE'
  | 'LAST_OWNER'
  | 'TEAM_FULL'
  | 'INTERNAL';

/** Typed API error: `{ error: { code, message } }` with a fitting HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const STORAGE_STATUS: Record<StorageErrorCode, number> = {
  PATH_INVALID: 400,
  PATH_OUTSIDE_WORKSPACE: 400,
  PATH_LINK_REJECTED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTEGRITY: 409,
  PRECONDITION: 422,
  EDIT_INVALID: 422,
  RENDER_UNAVAILABLE: 503,
  RENDER_FAILED: 500,
  CANCELLED: 409,
  WORKSPACE_LOCKED: 503,
  // Data problems: fail closed and tell the user, never guess.
  WORKSPACE_INVALID: 500,
  INDEX_INVALID: 500,
  PROJECT_INVALID: 500,
};

/**
 * Map anything thrown by a handler to a safe response. Storage error *details* are never
 * sent (they can contain absolute paths); unknown errors become a generic INTERNAL.
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isStorageError(e)) return new ApiError(STORAGE_STATUS[e.code] ?? 500, e.code, e.message);
  return new ApiError(500, 'INTERNAL', 'Terjadi kesalahan internal di server');
}
