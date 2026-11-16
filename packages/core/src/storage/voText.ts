/**
 * R34 — the browser-safe part of "Suara dari Teks" (no Node modules): sentence splitting and
 * subtitles from a VO's known text + word times (no Whisper).
 */
import type { EditOp } from './timeline.js';

/** Paragraph → sentences (ends at . ! ? … or a new line); empty pieces dropped. */
export function splitKalimat(teks: string): string[] {
  return teks
    .replace(/\r/g, '')
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export interface VoWord {
  teks: string;
  mulai: number;
  akhir: number;
}
/** What a VO media carries for subtitles without Whisper. */
export interface VoIndex {
  schema: 'vo-index/1';
  job_id: string;
  teks: string;
  /** Sentences with their position in THIS file (seconds) and word times relative to the sentence. */
  kalimat: { teks: string; mulai: number; akhir: number; kata: VoWord[] }[];
}

/**
 * Subtitle clips for a VO clip placed at `startMs` (timeline) that starts `inMs` into the VO media:
 * one clip per sentence with its words (no Whisper — the text is known). Only what falls inside
 * [inMs, inMs + lenMs) is kept.
 */
export function voSubtitleOps(index: VoIndex, startMs: number, inMs = 0, lenMs = Infinity): EditOp[] {
  const ops: EditOp[] = [];
  for (const k of index.kalimat) {
    const a = Math.max(Math.round(k.mulai * 1000), inMs);
    const b = Math.min(Math.round(k.akhir * 1000), inMs + lenMs);
    if (b - a < 200 || !k.teks.trim()) continue;
    const base = Math.round(k.mulai * 1000);
    const ws = k.kata
      .map((w) => ({ text: w.teks, start_ms: base + Math.round(w.mulai * 1000) - a, end_ms: base + Math.round(w.akhir * 1000) - a }))
      .filter((w) => w.end_ms > 0 && w.start_ms < b - a)
      .map((w) => ({ text: w.text, start_ms: Math.max(0, w.start_ms), end_ms: Math.min(b - a, Math.max(w.end_ms, w.start_ms + 1)) }));
    ops.push({ op: 'add_clip', track_kind: 'subtitle', text: k.teks.slice(0, 500), ...(ws.length ? { words: ws } : {}), start_ms: startMs + (a - inMs), duration_ms: b - a } as EditOp);
  }
  return ops;
}

