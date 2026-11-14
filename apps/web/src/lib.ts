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

/** Login error codes the server puts in `/#auth_error=CODE` after a failed Google login (W09). */
export const AUTH_ERRORS: Record<string, string> = {
  ACCESS_DENIED: 'Login dibatalkan di halaman Google.',
  EMAIL_NOT_ALLOWED: 'Akun Google ini tidak ada di daftar email yang diizinkan. Masuk dengan akun lain atau minta owner menambahkan email Anda.',
  EMAIL_UNVERIFIED: 'Email akun Google ini belum terverifikasi.',
  STATE_INVALID: 'Sesi login tidak cocok atau kedaluwarsa (mis. login dimulai di tab/browser lain). Coba masuk lagi.',
  TOKEN_EXCHANGE_FAILED: 'Server gagal menghubungi Google. Coba lagi sebentar.',
  ID_TOKEN_INVALID: 'Jawaban Google tidak valid. Coba lagi.',
  GOOGLE_ERROR: 'Google menolak permintaan login. Coba lagi.',
};

/** Read and strip `auth_error` from the fragment. Unknown codes are ignored (the page shows a generic message). */
export function takeAuthError(hash: string): { code: string | null; rest: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const c = params.get('auth_error');
  params.delete('auth_error');
  const rest = params.toString();
  return { code: c && /^[A-Z_]{1,40}$/.test(c) ? c : null, rest: rest ? `#${rest}` : '' };
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
const PROTECTED_BY: Record<string, string> = { CURRENT: 'versi yang sedang dipakai', KEEP: 'ditandai Simpan', PIN: 'disematkan', LEGAL_HOLD: 'ditahan (legal hold)' };
export function blockerText(code: string): string {
  if (code.startsWith('NOT_IN_TRASH')) return 'Tidak ada di Trash';
  // Audit 14 Nov: no raw codes for the team.
  if (code === 'REFERENCED') return 'Masih dipakai (proyek, Brand Kit, atau job)';
  if (code.startsWith('PROTECTED')) {
    const why = code.slice('PROTECTED'.length).replace(/[()]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    return `Dilindungi: ${why.map((w) => PROTECTED_BY[w] ?? w).join(', ') || 'aturan penyimpanan'}`;
  }
  if (code === 'MANIFEST_MISMATCH') return 'Catatan file tidak cocok dengan isinya — dihentikan demi aman';
  if (code === 'NOT_A_FILE') return 'Bukan file biasa di disk';
  if (code.startsWith('UNVERIFIABLE')) return 'File tidak bisa diperiksa di disk';
  if (code === 'NOT_FOUND') return 'Tidak dikenal (mungkin sudah dihapus)';
  if (code === 'BUSY') return 'Sedang dipakai proses lain';
  if (code === 'INDEX_INVALID') return 'Data dependensi rusak — dihentikan demi aman';
  if (code === 'JOURNAL_CORRUPT') return 'Ada operasi tertunda yang tidak terbaca';
  if (code === 'HASH_MISMATCH') return 'Isi file berubah';
  if (code === 'HARD_LINKED') return 'File punya salinan link lain';
  return `Tidak bisa dihapus (${code})`;
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

/**
 * Ruler ticks: a "nice" step so there are at most ~10 labels in view. With timeline zoom only
 * `visibleMs` is on screen, so the step follows that while ticks still cover the whole duration.
 */
export function rulerTicks(durationMs: number, visibleMs = durationMs): number[] {
  const steps = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = steps.find((s) => visibleMs / s <= 10) ?? 600_000;
  const out: number[] = [];
  for (let t = 0; t <= durationMs; t += step) out.push(t);
  return out;
}

// ------------------------------------------------------------------ timeline zoom (paket 1)

export const TIMELINE_ZOOM = { min: 1, max: 40 } as const;

/** Clamp a scroll offset (px) so the zoomed lane never leaves an empty gap at either end. */
export const clampScroll = (scrollPx: number, viewPx: number, zoom: number): number => Math.min(Math.max(0, viewPx * zoom - viewPx), Math.max(0, scrollPx));

/**
 * Change zoom while keeping the time under `anchorPx` (px from the left of the view) in place —
 * Ctrl+scroll zooms "into the cursor" like video editors do. Returns the new zoom and scroll.
 */
export function zoomAround(zoom: number, nextZoom: number, scrollPx: number, anchorPx: number, viewPx: number): { zoom: number; scrollPx: number } {
  const z = Math.min(TIMELINE_ZOOM.max, Math.max(TIMELINE_ZOOM.min, nextZoom));
  const contentX = (scrollPx + anchorPx) * (z / zoom);
  return { zoom: z, scrollPx: clampScroll(contentX - anchorPx, viewPx, z) };
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

/** Text of any error for the team (an ApiError, our own `new Error('…')`, or something unknown). */
export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const { message, code } = e as { message: string; code?: unknown };
    return `${message}${typeof code === 'string' && code && code !== 'UNKNOWN' ? ` (${code})` : ''}`;
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Terjadi kesalahan yang tidak dikenal.';
}

/** A number typed by an Indonesian user ("0,5", "3.5", " 2 "); null when empty or not a number. */
export function parseDecimal(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Next free `preset-N` id (deleting one must never make the next id a duplicate). */
export function nextPresetId(ids: string[]): string {
  let n = ids.length + 1;
  while (ids.includes(`preset-${n}`)) n++;
  return `preset-${n}`;
}

/** Poll delay after `failures` failed status checks in a row: keeps trying, slower and slower. */
export function pollDelay(failures: number): number {
  return failures <= 0 ? 800 : Math.min(15_000, 1000 * 2 ** Math.min(failures, 4));
}

/**
 * Is `job` the finished ("siap") state of the job on screen? While switching jobs the previous
 * job's status lingers for a render; acting on it loaded / applied the wrong job (audit 14 Nov).
 */
export function readyJobShown(job: { job_id: string; state: string } | null | undefined, shown: { job_id: string } | null | undefined): boolean {
  return !!job && !!shown && job.state === 'siap' && job.job_id === shown.job_id;
}
