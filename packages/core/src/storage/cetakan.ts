/**
 * 25 Nov (owner: Copilot "template visual per kalimat"). Each spoken sentence is "read by its
 * shape" (not its meaning) and paired with a visual template (cetakan):
 *  - first sentence → intro (big hook text + push-in)       - 3+ short points → list (points pop as spoken)
 *  - two things joined by "dan/atau/vs" → samping (A ⟷ B)   - an on-screen action → aksi (👉 + click SFX)
 *  - a price / discount → sale                              - the closing call → cta
 *  - a story / estimate / comparison → broll (an unused Media video under it)
 *  - anything else → polos (left as it is)
 * Pure and browser-safe: the editor shows the choices, the team changes / drops them, and only the
 * ticked rows become ordinary clips (one edit = one undo). AI may re-pick the templates (server).
 */
import type { EditOp, Timeline } from './timeline.js';
import { TEXT_PRESETS } from './textPresets.js';

export const CETAKAN = ['intro', 'list', 'samping', 'aksi', 'sale', 'cta', 'broll', 'polos'] as const;
export type CetakanId = (typeof CETAKAN)[number];
export const CETAKAN_LABEL: Record<CetakanId, string> = {
  intro: 'Intro / Hook',
  list: 'Icon List',
  samping: 'Icon Samping',
  aksi: 'Motion graphic (aksi)',
  sale: 'Sale / harga',
  cta: 'CTA',
  broll: 'B-roll',
  polos: 'Polos (tanpa cetakan)',
};

export interface Kata {
  text: string;
  start_ms: number;
  end_ms: number;
}
export interface Kalimat {
  teks: string;
  start_ms: number;
  end_ms: number;
  kata?: Kata[];
}
export interface Usulan {
  cetakan: CetakanId;
  alasan: string;
  /** list / samping: the parts as spoken. */
  bagian?: string[];
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const low = (s: string) => s.toLowerCase();
const AKSI = /\b(buka|klik|tap|pencet|cek|check ?out|keranjang|swipe|geser|scroll|follow|ikuti|notif|link|komen|save|simpan|share)\b/;
const SALE = /(\d+\s?%|\bdiskon\b|\bpromo\b|\bharga\b|\bcuma\b|\bhanya\b|\bribu\b|\brb\b|\bk\b|\brp\b|gratis ongkir|\bflash ?sale\b|\bmurah\b)/;
const CTA = /\b(beli|order|pesan|checkout|buruan|sekarang|jangan sampai|klik keranjang|langsung|yuk|ayo)\b/;
const BROLL = /\b(dulu|pernah|bayangin|bayangkan|kayak|seperti|misalnya|contohnya|kira-kira|kira kira|biasanya|cerita|waktu itu)\b/;
const URUT = /\b(pertama|kedua|ketiga|satu|dua|tiga)\b/g;

/** Split "A, B, dan C" / "pertama … kedua … ketiga …" into short parts (null = not a list). */
export function listParts(teks: string): string[] | null {
  const t = teks.replace(/[.!?]+$/, '');
  const byComma = t.split(/\s*,\s*|\s+dan\s+(?=[^,]*$)/i).map((x) => x.trim().replace(/^(dan|atau|serta)\s+/i, '')).filter(Boolean);
  if (byComma.length >= 3 && byComma.every((x) => words(x).length <= 5)) return byComma;
  const marks = low(t).match(URUT);
  if (marks && new Set(marks).size >= 3) {
    const parts = t.split(/\b(?:pertama|kedua|ketiga)\b/i).map((x) => x.replace(/^[\s,:]+|[\s,]+$/g, '')).filter(Boolean);
    if (parts.length >= 3) return parts.slice(-3);
  }
  return null;
}

/** "A dan B" / "A atau B" / "A vs B" with two short sides (null = not a pair). */
export function pairParts(teks: string): string[] | null {
  const t = teks.replace(/[.!?]+$/, '');
  const m = /^(.*?)\s+(dan|atau|vs\.?|versus|sama)\s+(.*)$/i.exec(t);
  if (!m) return null;
  const a = m[1]!.trim();
  const b = m[3]!.trim();
  if (!a || !b || words(a).length > 6 || words(b).length > 6 || /,/.test(t)) return null;
  return [a, b];
}

/** Local rules: the template of every sentence (priority: cta > sale > aksi > list > samping > intro > broll). */
export function pilihCetakan(kalimat: readonly Kalimat[]): Usulan[] {
  const n = kalimat.length;
  return kalimat.map((k, i) => {
    const t = low(k.teks);
    const last = i === n - 1;
    if (last && n > 1 && (CTA.test(t) || AKSI.test(t))) return { cetakan: 'cta', alasan: 'kalimat penutup berisi ajakan' };
    if (SALE.test(t) && /\d|diskon|promo|gratis/.test(t)) return { cetakan: 'sale', alasan: 'menyebut harga / diskon' };
    if (AKSI.test(t)) return { cetakan: 'aksi', alasan: 'ada aksi di layar (buka/klik/cek …)' };
    const list = listParts(k.teks);
    if (list) return { cetakan: 'list', alasan: `${list.length} poin pendek beruntun`, bagian: list };
    const pair = pairParts(k.teks);
    if (pair) return { cetakan: 'samping', alasan: 'dua hal disambung "dan/atau"', bagian: pair };
    if (i === 0) return { cetakan: 'intro', alasan: 'kalimat pertama' };
    if (CTA.test(t) && last) return { cetakan: 'cta', alasan: 'ajakan di akhir' };
    if (BROLL.test(t)) return { cetakan: 'broll', alasan: 'cerita / perumpamaan / perkiraan' };
    return { cetakan: 'polos', alasan: 'tidak ada bentuk khusus' };
  });
}

/** Word times of a sentence: its own, else spread by length over the sentence (estimate). */
export function kataOf(k: Kalimat): Kata[] {
  if (k.kata?.length) return k.kata;
  const ws = words(k.teks);
  const total = ws.reduce((s, w) => s + w.length + 1, 0) || 1;
  const span = Math.max(1, k.end_ms - k.start_ms);
  let acc = 0;
  return ws.map((w) => {
    const a = k.start_ms + Math.round((acc / total) * span);
    acc += w.length + 1;
    return { text: w, start_ms: a, end_ms: k.start_ms + Math.round((acc / total) * span) };
  });
}

/** Short on-screen line from a sentence (max `n` words, no trailing punctuation). */
export const ringkas = (s: string, n = 7) => {
  const w = words(s.replace(/[.!?…]+$/, ''));
  return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' ');
};

export interface CetakanCtx {
  timeline: Timeline;
  /** Brand SFX (by tag): a click for `aksi`, a whoosh for the intro push-in, a pop for sale/list. */
  sfx?: { klik?: Ref; whoosh?: Ref; muncul?: Ref };
  /** Unused videos in Media for `broll` (in order of preference). */
  broll?: { ref: Ref; durasi_ms: number }[];
}
type Ref = { media_id: string; version_id: string; durasi_ms?: number };

const presetStyle = (id: string) => ({ ...(TEXT_PRESETS.find((p) => p.id === id)?.style ?? {}) });

/**
 * Ops for the ticked sentences. Every track keeps one clip at a time (the server refuses
 * overlaps), so a row whose text / zoom / SFX would overlap something already there (or an
 * earlier row) skips just that piece and says so in `catatan`.
 */
export function opsCetakan(kalimat: readonly Kalimat[], pilihan: readonly (Usulan | null)[], ctx: CetakanCtx): { ops: EditOp[]; catatan: string[] } {
  const taken: Record<string, [number, number][]> = {};
  for (const tr of ctx.timeline.tracks) for (const c of tr.clips) (taken[tr.kind] ??= []).push([c.start_ms, c.end_ms]);
  const free = (kind: string, a: number, b: number) => b > a && !(taken[kind] ?? []).some(([x, y]) => a < y && x < b);
  const take = (kind: string, a: number, b: number) => (taken[kind] ??= []).push([a, b]);
  const ops: EditOp[] = [];
  const catatan: string[] = [];
  const brolls = [...(ctx.broll ?? [])];
  const text = (i: number, a: number, b: number, teks: string, style: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    if (!free('text', a, b)) return void catatan.push(`Kalimat ${i + 1}: teks dilewati (sudah ada teks di waktu itu)`);
    take('text', a, b);
    ops.push({ op: 'add_clip', track_kind: 'text', text: teks, style, start_ms: a, duration_ms: b - a, ...extra } as EditOp);
  };
  const zoom = (a: number, len: number, scale: number) => {
    const b = a + len;
    if (!free('effects', a, b)) return;
    take('effects', a, b);
    ops.push({ op: 'add_clip', track_kind: 'effects', start_ms: a, duration_ms: len, effect: { type: 'zoom', scale, mode: 'smooth', x: 0.5, y: 0.5, ramp_ms: Math.min(600, Math.floor(len / 2)) } } as EditOp);
  };
  const sfx = (ref: Ref | undefined, at: number) => {
    if (!ref) return;
    const len = Math.max(100, Math.min(ref.durasi_ms ?? 800, 3000));
    if (!free('sfx', at, at + len)) return;
    take('sfx', at, at + len);
    ops.push({ op: 'add_clip', track_kind: 'sfx', media: { media_id: ref.media_id, version_id: ref.version_id }, start_ms: at, duration_ms: len } as EditOp);
  };
  kalimat.forEach((k, i) => {
    const u = pilihan[i];
    if (!u || u.cetakan === 'polos') return;
    const a = k.start_ms;
    const b = Math.max(k.end_ms, a + 600);
    const kata = kataOf(k);
    switch (u.cetakan) {
      case 'intro':
        text(i, a, b, ringkas(k.teks, 7).toUpperCase(), { ...presetStyle('hook'), anim: 'pop' });
        zoom(a, Math.min(1800, b - a), 1.15);
        sfx(ctx.sfx?.whoosh, a);
        break;
      case 'list': {
        const parts = u.bagian?.length ? u.bagian : listParts(k.teks) ?? [k.teks];
        const lines = parts.map((p) => `✓ ${ringkas(p, 5)}`);
        // one clip per point, back to back, each showing the points so far: the list builds up as
        // it is spoken (one text track = no two texts at the same time). Point j starts at the time
        // of its first word (estimated over the sentence when the words are not known).
        const ws = kataOf(k).map((w) => low(w.text).replace(/[^\p{L}\p{N}]/gu, ''));
        let from = 0;
        const at = parts.map((p, j) => {
          if (j === 0) return a;
          const first = low(words(p)[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '');
          const idx = ws.indexOf(first, from);
          if (idx > 0) from = idx;
          return idx > 0 ? kataOf(k)[idx]!.start_ms : Math.round(a + ((b - a) * j) / parts.length);
        });
        const style = { ...presetStyle('usp'), align: 'left', y: 0.45 };
        at.forEach((t0, j) => {
          const t1 = j < at.length - 1 ? Math.max(t0 + 200, at[j + 1]!) : b;
          text(i, t0, Math.min(t1, b), lines.slice(0, j + 1).join('\n'), { ...style, anim: j === 0 ? 'pop' : 'none' });
        });
        sfx(ctx.sfx?.muncul, a);
        break;
      }
      case 'samping': {
        const [x, y] = u.bagian?.length === 2 ? u.bagian : pairParts(k.teks) ?? [k.teks, ''];
        text(i, a, b, y ? `${ringkas(x!, 4)}  ⟷  ${ringkas(y, 4)}` : ringkas(x!, 7), { ...presetStyle('usp'), y: 0.42, anim: 'pop' });
        break;
      }
      case 'aksi': {
        const hit = kata.find((w) => AKSI.test(low(w.text))) ?? kata[0];
        text(i, a, b, `👉 ${ringkas(k.teks, 6)}`, { ...presetStyle('cta'), y: 0.62, anim: 'pop' });
        if (hit) {
          sfx(ctx.sfx?.klik, hit.start_ms);
          zoom(hit.start_ms, Math.min(1200, Math.max(400, b - hit.start_ms)), 1.1);
        }
        break;
      }
      case 'sale': {
        const angka = kata.filter((w) => /\d|%|diskon|promo|gratis|ribu|rb/i.test(w.text)).map((w) => w.text.replace(/[.,!?]+$/, ''));
        text(i, a, b, (angka.length ? angka.join(' ') : ringkas(k.teks, 5)).toUpperCase(), { ...presetStyle('sale'), anim: 'pop' });
        sfx(ctx.sfx?.muncul, a);
        break;
      }
      case 'cta':
        text(i, a, b, ringkas(k.teks, 7), { ...presetStyle('cta'), anim: 'pop' });
        zoom(a, Math.min(1500, b - a), 1.08);
        break;
      case 'broll': {
        const pick = brolls.shift();
        if (!pick) return void catatan.push(`Kalimat ${i + 1}: B-roll dilewati (tidak ada video lain di Media)`);
        const len = Math.min(b - a, pick.durasi_ms);
        if (!free('broll', a, a + len)) return void catatan.push(`Kalimat ${i + 1}: B-roll dilewati (sudah ada b-roll di waktu itu)`);
        take('broll', a, a + len);
        ops.push({ op: 'add_clip', track_kind: 'broll', media: { media_id: pick.ref.media_id, version_id: pick.ref.version_id }, start_ms: a, duration_ms: len, volume: 0 } as EditOp);
        break;
      }
    }
  });
  return { ops, catatan };
}

/** "Highlight kata penting": words worth marking (numbers, prices, product-ish nouns from the sentences). */
export function kataPenting(kalimat: readonly Kalimat[], max = 8): string[] {
  const stop = new Set(['yang', 'dan', 'atau', 'ini', 'itu', 'kamu', 'aku', 'kita', 'buat', 'untuk', 'dengan', 'jadi', 'banget', 'sih', 'aja', 'juga', 'lagi', 'ada', 'kalau', 'karena', 'tapi', 'bisa', 'nggak', 'gak', 'udah', 'sudah', 'di', 'ke', 'dari', 'pas', 'kak', 'guys', 'cuma', 'hanya', 'bahannya', 'pakai', 'mau', 'sekarang']);
  const score = new Map<string, number>();
  for (const k of kalimat)
    for (const w0 of words(k.teks)) {
      const w = low(w0).replace(/[^\p{L}\p{N}%]/gu, '');
      if ((w.length < 3 && !/\d/.test(w)) || stop.has(w)) continue;
      score.set(w, (score.get(w) ?? 0) + (/\d|%/.test(w) ? 5 : SALE.test(w) ? 3 : 1));
    }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}
