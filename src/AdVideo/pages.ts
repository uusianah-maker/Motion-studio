import type { Caption } from "@remotion/captions";

export type CaptionPage = {
  startMs: number;
  endMs: number;
  words: (Caption & { emphasis?: boolean })[];
};

const BREAK_GAP_MS = 250; // jeda antar kata yang memaksa halaman baru
const MAX_PAGE_MS = 1600; // satu halaman maksimal tampil segini
const LINGER_MS = 350; // halaman terakhir sebelum jeda tetap tampil sebentar

/**
 * Kelompokkan kata jadi halaman caption: maks N kata.
 * Kalau pipeline sudah memasang `pageBreakAfter` (edit.py), itu yang dipakai
 * supaya frasa kata kunci tidak terbelah. Kalau belum, pecah di akhir
 * kalimat/koma/jeda.
 */
export const buildPages = (captions: CaptionPage["words"], maxWords: number): CaptionPage[] => {
  const explicit = captions.some((c) => c.pageBreakAfter !== undefined);
  const pages: CaptionPage[] = [];
  let cur: CaptionPage["words"] = [];

  const flush = () => {
    if (cur.length === 0) return;
    pages.push({ startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs, words: cur });
    cur = [];
  };

  captions.forEach((c, i) => {
    const prev = captions[i - 1];
    if (cur.length > 0 && !explicit) {
      const gap = c.startMs - prev.endMs;
      const tooLong = c.endMs - cur[0].startMs > MAX_PAGE_MS;
      if (gap > BREAK_GAP_MS || tooLong) flush();
    }
    if (cur.length >= maxWords) flush();
    cur.push(c);
    if (explicit ? c.pageBreakAfter : /[.,?!;:]$/.test(c.text.trim())) flush();
  });
  flush();

  // Tampil sampai halaman berikut muncul (tanpa kedip), tapi jangan lama-lama.
  return pages.map((p, i) => {
    const next = pages[i + 1];
    const end = next ? Math.min(next.startMs, p.endMs + LINGER_MS) : p.endMs + LINGER_MS;
    return { ...p, endMs: Math.max(end, p.endMs) };
  });
};
