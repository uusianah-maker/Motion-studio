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

// ------------------------------------------------------------------ timeline editing (W06)

export const SNAP_MS = 100;
export const MIN_CLIP_MS = 100;
export const DEFAULT_CLIP_MS = 5000;

export type DragMode = 'move' | 'trim-start' | 'trim-end';
export interface ClipSpan {
  start_ms: number;
  end_ms: number;
  in_ms?: number;
  hasMedia?: boolean;
  /** Length of the source media when known (W07): trim-end never runs past it. */
  sourceMs?: number;
}

export const snap = (ms: number, step = SNAP_MS): number => Math.max(0, Math.round(ms / step) * step);

/**
 * Where a clip would be after dragging by `deltaMs` (ghost while dragging, op on release).
 * Mirrors the server rules: minimum length, never before 0, trim-start never before the source start.
 */
export function dragSpan(mode: DragMode, c: ClipSpan, deltaMs: number): { start_ms: number; end_ms: number } {
  const len = c.end_ms - c.start_ms;
  if (mode === 'move') {
    const start = snap(Math.max(0, c.start_ms + deltaMs));
    return { start_ms: start, end_ms: start + len };
  }
  if (mode === 'trim-end') {
    const latest = c.hasMedia && c.sourceMs !== undefined ? c.start_ms + c.sourceMs - (c.in_ms ?? 0) : Infinity;
    return { start_ms: c.start_ms, end_ms: Math.min(latest, Math.max(c.start_ms + MIN_CLIP_MS, snap(c.end_ms + deltaMs))) };
  }
  const earliest = c.hasMedia ? c.start_ms - (c.in_ms ?? 0) : 0;
  const start = Math.min(c.end_ms - MIN_CLIP_MS, Math.max(Math.max(0, earliest), snap(c.start_ms + deltaMs)));
  return { start_ms: start, end_ms: c.end_ms };
}

/** Ruler ticks: a "nice" step so there are at most ~10 labels. */
export function rulerTicks(durationMs: number): number[] {
  const steps = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = steps.find((s) => durationMs / s <= 10) ?? 600_000;
  const out: number[] = [];
  for (let t = 0; t <= durationMs; t += step) out.push(t);
  return out;
}

/** Timeline length shown: at least 30 s and always 5 s of room after the last clip. */
export const visibleDuration = (endMs: number): number => Math.max(30_000, Math.ceil((endMs + 5000) / 5000) * 5000);

// ------------------------------------------------------------------ preview (W07)

export type CanvasRatio = '9:16' | '3:4' | '1:1' | '16:9';
export const CANVAS_RATIOS: CanvasRatio[] = ['9:16', '3:4', '1:1', '16:9'];

/** The clip under the playhead (start inclusive, end exclusive). */
export function clipAt<T extends { start_ms: number; end_ms: number }>(clips: readonly T[], t: number): T | null {
  return clips.find((c) => t >= c.start_ms && t < c.end_ms) ?? null;
}

/** Position inside the source media (seconds) for timeline time `t`. */
export const sourceSeconds = (c: { start_ms: number; in_ms?: number }, t: number): number => ((c.in_ms ?? 0) + (t - c.start_ms)) / 1000;

/**
 * Safe area as insets in % of the canvas (top, right, bottom, left). 9:16 keeps clear of the
 * usual short-video UI (caption bottom, action buttons right); other ratios use a 5% title-safe margin.
 */
export function safeInsets(ratio: CanvasRatio): [number, number, number, number] {
  return ratio === '9:16' ? [12, 14, 20, 6] : [5, 5, 5, 5];
}

export const aspectCss = (ratio: CanvasRatio): string => ratio.replace(':', ' / ');
