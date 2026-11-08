import { randomBytes } from 'node:crypto';
import { StorageError } from './errors.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export const newId = (prefix: 'm' | 'v' | 'op' | 'lease' | 'pr' | 'ws' | 'snap' | 'c'): string =>
  `${prefix}_${randomBytes(8).toString('hex')}`;

/** IDs end up as directory names, so they must be safe path segments everywhere. */
export function assertSafeId(id: unknown, what = 'ID'): string {
  if (typeof id !== 'string' || !ID_RE.test(id) || WIN_RESERVED.test(id)) {
    throw new StorageError('PATH_INVALID', `${what} tidak valid: gunakan huruf/angka/_/- (maks 64)`, { id });
  }
  return id;
}

export const isSafeId = (id: unknown): id is string => {
  try {
    assertSafeId(id);
    return true;
  } catch {
    return false;
  }
};
