import type { Area } from './permissions.js';

/**
 * Where media bytes live (ADR-002, plan v2.0 W02). The storage core keeps all *metadata*
 * (registry, journal, audit, leases, project manifests, cache) on the server's local disk;
 * only blob areas go through this interface: shared/project media, Trash (bytes + manifests)
 * and render outputs. `LocalFs` is today's behaviour; a Google Drive backend implements the
 * same contract later (W10).
 *
 * Every path is workspace-relative ("rel", forward slashes). Implementations MUST:
 * - re-validate and contain every rel on every call (no links/aliases, no escape);
 * - never overwrite on `commit` / `moveNoOverwrite` (CONFLICT instead);
 * - verify the content hash whenever bytes are copied rather than moved atomically;
 * - keep media read-only for the app after commit.
 * Area/permission decisions stay in the core; `resolve` only returns the canonical form they need.
 */
export interface BlobStat {
  /** False for folders/devices/anything that is not plain bytes. */
  isFile: boolean;
  size: number;
  mtimeMs: number;
  /** Other names share these exact bytes (e.g. a hard link): destructive ops must refuse. */
  multiLinked: boolean;
}

export interface StagedBlob {
  /** Backend-private handle of the staged temp object. */
  readonly token: string;
  readonly hash: string;
  readonly size: number;
}

export interface StorageBackend {
  readonly kind: 'local-fs';

  /** Canonical rel + area check. With `allowMissing`, trailing components may not exist yet. */
  resolve(rel: string, allowed: readonly Area[], opts?: { allowMissing?: boolean }): Promise<string>;
  /** null when missing. */
  stat(rel: string): Promise<BlobStat | null>;
  exists(rel: string): Promise<boolean>;
  hash(rel: string): Promise<{ hash: string; size: number }>;
  /** True only when both names are proven to be the same stored object. */
  sameObject(a: string, b: string): Promise<boolean>;

  /** Copy a local source file into `dirRel` under a temp name while hashing the written bytes. */
  stage(dirRel: string, sourceAbs: string): Promise<StagedBlob>;
  /** Give the staged object its final name (no overwrite) and make it read-only. */
  commit(staged: StagedBlob, rel: string): Promise<string>;
  discard(staged: StagedBlob): Promise<void>;

  /** Move to a fresh path; never replaces (CONFLICT). Cross-device: copy → verify hash → remove source. */
  move(fromRel: string, toRel: string, expectedHash: string): Promise<{ renamed: boolean }>;
  /** Move that fails with CONFLICT if anything exists at the destination; result is read-only. */
  moveNoOverwrite(fromRel: string, toRel: string, expectedHash: string): Promise<void>;
  /** Permanent removal of one blob (purge / proven duplicates / own manifests only). */
  remove(rel: string, opts?: { missingOk?: boolean }): Promise<void>;
  setReadOnly(rel: string): Promise<void>;
  /** Remove up to `levels` parent folders of `rel`, each only if empty. */
  pruneEmptyParents(rel: string, levels: number): Promise<void>;

  /** Atomic replace of a small JSON object; creates missing parent folders. */
  writeJson(rel: string, data: unknown): Promise<void>;
  readJson<T>(rel: string, validate: (x: unknown) => T, code: 'INDEX_INVALID' | 'PROJECT_INVALID'): Promise<T>;

  /** Every regular file under `dirRel` (links skipped, bounded depth). Missing folder = none; a linked/invalid folder throws. */
  listFiles(dirRel: string, maxDepth: number): Promise<{ rel: string; name: string; size: number; mtimeMs: number }[]>;
  /** Total bytes under `dirRel` (0 when missing). */
  usage(dirRel: string): Promise<number>;
  /** Throws when a new object cannot be created in `dirRel`. */
  probeWritable(dirRel: string): Promise<void>;
}
