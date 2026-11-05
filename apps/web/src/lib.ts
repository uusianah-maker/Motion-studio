/** Pure helpers (no DOM, no network) so they can be unit-tested in Node. */

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * The server prints `http://127.0.0.1:<port>/#token=<64 hex>`. Read it from the fragment
 * (never sent to any server) and return the fragment without it, so it can be wiped from the
 * address bar and history right away.
 */
export function takeTokenFromHash(hash: string): { token: string | null; rest: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const t = params.get('token');
  params.delete('token');
  const rest = params.toString();
  return { token: t && TOKEN_RE.test(t) ? t : null, rest: rest ? `#${rest}` : '' };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '–';
  return new Date(ms).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "dalam 3 hari" / "hari ini" for a future timestamp, relative to `now`. */
export function relativeDays(at: number, now: number): string {
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return 'sudah lewat';
  if (days === 1) return 'besok';
  return `dalam ${days} hari`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Human labels for storage states (Bahasa Indonesia, simple). */
export const LIFECYCLE_LABEL: Record<string, string> = { active: 'Aktif', trashed: 'Di Trash', purged: 'Dihapus permanen' };
export const INTEGRITY_LABEL: Record<string, string> = { ok: 'Utuh', missing: 'Hilang', changed: 'Berubah' };

export const AREA_LABEL: Record<string, string> = {
  shared_media: 'Media bersama',
  shared_assets: 'Aset bersama',
  project_input: 'Media proyek',
  project_assets: 'Aset proyek',
  project_cache: 'Cache',
  project_output: 'Hasil render',
  trash: 'Trash',
  backup_projects: 'Backup proyek',
};

/** Purge blocker codes from the server → plain explanation. */
export function blockerText(code: string): string {
  if (code.startsWith('NOT_IN_TRASH')) return 'Tidak ada di Trash';
  if (code === 'REFERENCED') return 'Masih dipakai proyek';
  if (code.startsWith('PROTECTED')) return `Dilindungi ${code.slice('PROTECTED'.length).trim()}`;
  if (code === 'BUSY') return 'Sedang dipakai proses lain';
  if (code === 'INDEX_INVALID') return 'Data dependensi rusak — dihentikan demi aman';
  if (code === 'JOURNAL_CORRUPT') return 'Ada operasi tertunda yang tidak terbaca';
  if (code === 'HASH_MISMATCH') return 'Isi file berubah';
  if (code === 'HARD_LINKED') return 'File punya salinan link lain';
  return code;
}

export function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
