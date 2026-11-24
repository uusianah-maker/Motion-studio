import { describe, expect, it } from 'vitest';
import { MAKS_FOOTAGE, geser, tambahFootage } from '../src/views/FootageList';

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified: 1 });

describe('§26 daftar footage Video Iklan', () => {
  it('several files at once, then more later; the order is the pick order', () => {
    const a = tambahFootage([], [file('Konten 1 (1).mp4'), file('Konten 2 (2).mp4')]);
    const b = tambahFootage(a.list, [file('Konten 3 (1).mp4')]);
    expect(b.list.map((f) => f.file.name)).toEqual(['Konten 1 (1).mp4', 'Konten 2 (2).mp4', 'Konten 3 (1).mp4']);
    expect(new Set(b.list.map((f) => f.id)).size).toBe(3);
  });
  it('the same file twice is skipped with a note; the limit is kept', () => {
    const a = tambahFootage([], [file('A.mp4')]);
    const b = tambahFootage(a.list, [file('A.mp4'), file('A.mp4', 11)]);
    expect(b.list).toHaveLength(2); // same name, other size = another file
    expect(b.dilewati).toEqual(['A.mp4 sudah ada di daftar']);
    const full = tambahFootage([], Array.from({ length: MAKS_FOOTAGE + 2 }, (_, i) => file(`${i}.mp4`)));
    expect(full.list).toHaveLength(MAKS_FOOTAGE);
    expect(full.dilewati).toHaveLength(2);
  });
  it('move up / down; out of range = unchanged', () => {
    expect(geser(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(geser(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(geser(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(geser(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
