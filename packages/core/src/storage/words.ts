/**
 * Word timings of a caption clip (U3b, KONTRAK-ENGINE v0.3 `Clip.words`). Pure module (the web
 * preview imports it too). Times are RELATIVE to the clip start, so moving a clip never touches
 * them; trims, splits and cuts re-base them with `sliceWords`.
 */
import { StorageError } from './errors.js';

export interface Word {
  text: string;
  /** ms from the clip start. */
  start_ms: number;
  end_ms: number;
}

export const MAX_WORDS_PER_CLIP = 30;
export const MAX_WORD_LEN = 40;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

/** Sorted, non-overlapping, inside [0, clipLen], one token each (no spaces). */
export function validateWords(raw: unknown, clipLen: number, where = 'words'): Word[] {
  if (!Array.isArray(raw)) return bad(`${where} harus daftar kata`);
  if (raw.length === 0 || raw.length > MAX_WORDS_PER_CLIP) bad(`${where}: 1–${MAX_WORDS_PER_CLIP} kata per klip`);
  let last = 0;
  return raw.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object' || Object.keys(o).some((k) => !['text', 'start_ms', 'end_ms'].includes(k))) bad(`${where}[${i}] tidak valid`);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || text.length > MAX_WORD_LEN || /\s/.test(text)) bad(`${where}[${i}]: satu kata 1–${MAX_WORD_LEN} huruf tanpa spasi`);
    const s = o.start_ms;
    const e = o.end_ms;
    if (typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e)) return bad(`${where}[${i}]: waktu harus angka ms`);
    const start = Math.round(s);
    const end = Math.round(e);
    if (start < last || end <= start || end > clipLen) bad(`${where}[${i}] "${text}": waktu harus urut, tidak tumpang tindih, di dalam klip (0–${clipLen} ms)`);
    last = end;
    return { text, start_ms: start, end_ms: end };
  });
}

/**
 * The words of [from, to) (relative to the OLD clip start), re-based to `from` and clipped to the
 * new length. Words that end up shorter than 1 ms are dropped.
 */
export function sliceWords(words: readonly Word[], from: number, to: number): Word[] {
  return words
    .map((w) => ({ text: w.text, start_ms: Math.max(w.start_ms, from) - from, end_ms: Math.min(w.end_ms, to) - from }))
    .filter((w) => w.end_ms > w.start_ms && w.start_ms >= 0);
}

/** Cut [cutFrom, cutTo) (relative) out of a clip's words: later words move left by the cut length. */
export function cutWords(words: readonly Word[], cutFrom: number, cutTo: number): Word[] {
  const len = cutTo - cutFrom;
  const out: Word[] = [];
  for (const w of words) {
    if (w.end_ms <= cutFrom) out.push({ ...w });
    else if (w.start_ms >= cutTo) out.push({ ...w, start_ms: w.start_ms - len, end_ms: w.end_ms - len });
    else if (w.start_ms < cutFrom) out.push({ ...w, end_ms: w.end_ms > cutTo ? w.end_ms - len : cutFrom }); // started before the cut: keep its spoken part
    else if (w.end_ms > cutTo) out.push({ ...w, start_ms: cutFrom, end_ms: w.end_ms - len }); // ends after the cut: its tail is still heard
    // a word entirely inside the cut is gone with the audio
  }
  return out;
}

/** Normalised word for keyword matching: lower case, no accents, no punctuation around it. */
export const wordKey = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Which words of a caption are visible at `t` (relative ms): all spoken so far. */
export const spokenCount = (words: readonly Word[], t: number) => words.filter((w) => w.start_ms <= t).length;
