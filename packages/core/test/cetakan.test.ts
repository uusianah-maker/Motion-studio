import { describe, expect, it } from 'vitest';
import { kataPenting, listParts, opsCetakan, pairParts, pilihCetakan, type Kalimat } from '../src/storage/cetakan.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';

let n = 0;
const ids = () => `c_${++n}`;
const K = (teks: string, a: number, b: number): Kalimat => ({ teks, start_ms: a, end_ms: b });
const NASKAH = [
  K('Celana ini lagi viral banget di TikTok.', 0, 2500),
  K('Bahannya adem, jatuh, dan nggak nerawang.', 2500, 5200),
  K('Mau warna hitam atau coklat.', 5200, 7000),
  K('Dulu aku kira celana kulot itu ribet dipakai.', 7000, 9500),
  K('Sekarang diskon 50% cuma 99 ribu.', 9500, 11500),
  K('Klik keranjang kuning sekarang ya!', 11500, 13500),
];

describe('cetakan visual per kalimat', () => {
  it('reads every sentence by its shape', () => {
    expect(pilihCetakan(NASKAH).map((u) => u.cetakan)).toEqual(['intro', 'list', 'samping', 'broll', 'sale', 'cta']);
    expect(listParts('Bahannya adem, jatuh, dan nggak nerawang.')).toEqual(['Bahannya adem', 'jatuh', 'nggak nerawang']);
    expect(pairParts('Mau warna hitam atau coklat.')).toEqual(['Mau warna hitam', 'coklat']);
    expect(pilihCetakan([K('Halo semua.', 0, 1000), K('Cek link di bio buat lihat ukurannya.', 1000, 3000), K('Makasih udah nonton.', 3000, 4000)])[1]!.cetakan).toBe('aksi');
  });
  it('builds ordinary, valid clips; skips what would overlap; one apply', () => {
    const V = { media_id: 'm_1', version_id: 'v_1' };
    const B = { media_id: 'm_2', version_id: 'v_2' };
    const S = { media_id: 'm_3', version_id: 'v_3', durasi_ms: 500 };
    const t0 = applyOps({ tracks: [] }, validateOps([
      { op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 13500 },
      { op: 'add_clip', track_kind: 'text', text: 'sudah ada', start_ms: 5300, duration_ms: 1200 }, // overlaps sentence 3
    ]), ids);
    const u = pilihCetakan(NASKAH);
    const { ops, catatan } = opsCetakan(NASKAH, u, { timeline: t0, sfx: { klik: S, whoosh: S, muncul: S }, broll: [{ ref: B, durasi_ms: 4000 }] });
    expect(catatan.some((c) => c.startsWith('Kalimat 3'))).toBe(true);
    const t1 = applyOps(t0, validateOps(ops), ids);
    const texts = t1.tracks.find((x) => x.kind === 'text')!.clips;
    expect(texts.map((c) => c.text)).toEqual(expect.arrayContaining(['CELANA INI LAGI VIRAL BANGET DI TIKTOK', 'DISKON 50% 99 RIBU', 'Klik keranjang kuning sekarang ya']));
    const list = texts.filter((c) => c.text?.startsWith('✓')).sort((x, y) => x.start_ms - y.start_ms);
    expect(list.map((c) => c.text!.split('\n').length)).toEqual([1, 2, 3]); // builds up point by point
    expect(list[0]!.start_ms).toBe(2500);
    expect(list[2]!.end_ms).toBe(5200);
    expect(t1.tracks.find((x) => x.kind === 'broll')!.clips[0]).toMatchObject({ start_ms: 7000, media: B });
    expect(t1.tracks.find((x) => x.kind === 'effects')!.clips.length).toBeGreaterThanOrEqual(2);
    // polos / unticked rows add nothing
    expect(opsCetakan(NASKAH, NASKAH.map(() => null), { timeline: t0 }).ops).toEqual([]);
  });
  it('important words: numbers and prices first', () => {
    expect(kataPenting(NASKAH).slice(0, 2)).toEqual(expect.arrayContaining(['50%', '99']));
  });
});
