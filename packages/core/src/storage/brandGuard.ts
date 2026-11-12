import { StorageError } from './errors.js';
import type { Timeline, TrackKind } from './project.js';

/**
 * Brand guard (X08, PRD §4 "Brand guardrails: price validity window, restricted claims"):
 * before a render, every text/subtitle on the timeline is checked against the Brand Kit's
 * promo prices (with an end date) and its banned-claims list. Pure, local, no AI.
 */

export interface PriceRule {
  /** As written in the video, e.g. "Rp99.000" or "DISKON 50%". */
  text: string;
  /** Last valid day, YYYY-MM-DD (inclusive, server's local date). */
  valid_until: string;
}

export interface BrandGuard {
  prices: PriceRule[];
  /** Words/phrases that must not appear, e.g. "paling murah", "100% menyembuhkan". */
  banned: string[];
  /** Expired prices always block; banned claims block by default, or only warn. */
  banned_level: 'block' | 'warn';
}

export const EMPTY_GUARD: BrandGuard = { prices: [], banned: [], banned_level: 'block' };
export const GUARD_LIMITS = { prices: 50, banned: 200, price_len: [1, 60], banned_len: [2, 80] } as const;

export interface GuardIssue {
  level: 'block' | 'warn';
  kind: 'PRICE_EXPIRED' | 'BANNED_CLAIM';
  clip_id: string;
  track_kind: TrackKind;
  start_ms: number;
  end_ms: number;
  /** The clip's text (shortened). */
  text: string;
  /** The price / phrase that matched. */
  match: string;
  valid_until?: string;
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', `Brand guard: ${msg}`);
};
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const oneLine = (s: string) => [...s].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();

export function validateGuard(raw: unknown): BrandGuard {
  if (raw === undefined || raw === null) return { ...EMPTY_GUARD, prices: [], banned: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('harus objek');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['prices', 'banned', 'banned_level'].includes(k));
  if (extra.length) bad(`field tidak dikenal ${extra.join(', ')}`);
  const prices = o.prices === undefined ? [] : Array.isArray(o.prices) ? o.prices : bad('prices harus daftar');
  const banned = o.banned === undefined ? [] : Array.isArray(o.banned) ? o.banned : bad('banned harus daftar');
  if (prices.length > GUARD_LIMITS.prices) bad(`maksimal ${GUARD_LIMITS.prices} harga`);
  if (banned.length > GUARD_LIMITS.banned) bad(`maksimal ${GUARD_LIMITS.banned} klaim terlarang`);
  const level = o.banned_level ?? 'block';
  if (level !== 'block' && level !== 'warn') bad('banned_level harus block | warn');
  return {
    prices: prices.map((p, i) => {
      const r = (p ?? {}) as Record<string, unknown>;
      if (typeof r !== 'object' || Object.keys(r).some((k) => k !== 'text' && k !== 'valid_until')) bad(`harga ${i + 1} tidak valid`);
      const text = typeof r.text === 'string' ? oneLine(r.text) : '';
      if (text.length < GUARD_LIMITS.price_len[0] || text.length > GUARD_LIMITS.price_len[1]) bad(`harga ${i + 1}: teks 1–60 karakter`);
      if (typeof r.valid_until !== 'string' || !DATE.test(r.valid_until)) bad(`harga ${i + 1}: tanggal berlaku harus YYYY-MM-DD`);
      return { text, valid_until: r.valid_until as string };
    }),
    banned: [
      ...new Set(
        banned.map((b, i) => {
          const t = typeof b === 'string' ? oneLine(b) : '';
          if (t.length < GUARD_LIMITS.banned_len[0] || t.length > GUARD_LIMITS.banned_len[1]) bad(`klaim ${i + 1}: 2–80 karakter`);
          return t;
        }),
      ),
    ],
    banned_level: level as BrandGuard['banned_level'],
  };
}

/** Lower-case, no accents, single spaces — what matching compares. */
export const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Prices ignore spaces, dots and commas: "Rp 99.000" = "rp99000" = "RP99,000". */
const compact = (s: string) => normalize(s).replace(/[\s.,]/g, '');

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Phrase occurs as whole words (so "murah" does not hit "termurahnya"... unless listed so). */
export function containsPhrase(text: string, phrase: string): boolean {
  const t = normalize(text);
  const p = normalize(phrase);
  if (!p) return false;
  for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) {
    if (!isWordChar(t[i - 1]) && !isWordChar(t[i + p.length])) return true;
  }
  return false;
}

/** Price occurs, not as part of a longer number ("50%" must not hit "150%"). */
export function containsPrice(text: string, price: string): boolean {
  const t = compact(text);
  const p = compact(price);
  if (!p) return false;
  for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) {
    const before = t[i - 1];
    const after = t[i + p.length];
    const digitEdge = (c: string | undefined, edge: string | undefined) => !!c && /\d/.test(c) && !!edge && /\d/.test(edge);
    if (!digitEdge(before, p[0]) && !digitEdge(after, p[p.length - 1])) return true;
  }
  return false;
}

/** YYYY-MM-DD of `now` in the server's local time zone. */
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Check every text/subtitle clip. `today` = YYYY-MM-DD. */
export function checkBrandGuard(t: Timeline, guard: BrandGuard, today: string): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const tr of t.tracks) {
    if (tr.kind !== 'text' && tr.kind !== 'subtitle') continue;
    for (const c of tr.clips) {
      if (!c.text?.trim()) continue;
      const base = { clip_id: c.clip_id, track_kind: tr.kind, start_ms: c.start_ms, end_ms: c.end_ms, text: c.text.length > 80 ? `${c.text.slice(0, 77)}…` : c.text };
      for (const p of guard.prices) {
        if (today > p.valid_until && containsPrice(c.text, p.text)) issues.push({ ...base, level: 'block', kind: 'PRICE_EXPIRED', match: p.text, valid_until: p.valid_until });
      }
      for (const b of guard.banned) {
        if (containsPhrase(c.text, b)) issues.push({ ...base, level: guard.banned_level, kind: 'BANNED_CLAIM', match: b });
      }
    }
  }
  return issues.sort((a, b) => a.start_ms - b.start_ms);
}

/** Banned phrases in a piece of new text (Copilot refuses to write them). */
export const bannedIn = (text: string, guard: BrandGuard): string[] => guard.banned.filter((b) => containsPhrase(text, b));
