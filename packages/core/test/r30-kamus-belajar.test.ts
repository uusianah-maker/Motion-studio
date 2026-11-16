import { describe, expect, it } from 'vitest';
import { kamusBelajar, mirip, pasanganDari } from '../src/storage/kamusBelajar.js';

const kor = (sebelum: string, sesudah: string, at = 1) => ({ jenis: 'koreksi', bagian: 'kata', track: 'subtitle', op: 'set_text', sebelum, sesudah, at });

describe('R30 kamus belajar dari koreksi subtitle', () => {
  it('mengambil kata yang diganti, bukan perubahan huruf besar/tanda baca', () => {
    expect(pasanganDari('mau punya cana', 'mau punya celana')).toEqual([{ salah: 'cana', benar: 'celana' }]);
    expect(pasanganDari('Icy Love Factory.', 'Aysilla Factory.')).toEqual([{ salah: 'icy love', benar: 'Aysilla' }]);
    expect(pasanganDari('Join Live sekarang yuk!!', 'Join Live Sekarang Yuk!!')).toEqual([]);
    expect(pasanganDari('ok ya', 'oke ya')).toEqual([]); // terlalu pendek
    expect(pasanganDari('satu dua tiga empat lima', 'enam tujuh delapan sembilan sepuluh')).toEqual([]); // ditulis ulang
  });

  it('mirip = huruf terpotong dengan urutan sama', () => {
    expect(mirip('cana', 'celana')).toBe(true);
    expect(mirip('janganlah', 'Join Live')).toBe(false);
    expect(mirip('kulot', 'celana')).toBe(false);
  });

  it('otomatis hanya untuk pasangan aman; kamus tim selalu menang', () => {
    const notes = [
      kor('mau punya cana', 'mau punya celana'),
      kor('Icy Love Factory.', 'Aysilla Factory.'),
      kor('Janganlah sekarang yuk', 'Join Live sekarang yuk!!'),
      { jenis: 'koreksi', bagian: 'gaya', track: 'text', sebelum: 'a', sesudah: 'b' },
    ];
    const out = kamusBelajar(notes, ['Aysilla Factory']);
    const by = Object.fromEntries(out.map((p) => [p.salah, p]));
    expect(by['cana']!.otomatis).toBe(true);
    expect(by['icy love']!.otomatis).toBe(true);
    expect(by['janganlah']!.otomatis).toBe(false); // kata asli, baru sekali → usulan
    expect(kamusBelajar([...notes, kor('Janganlah sekarang', 'Join Live sekarang', 2)], ['Aysilla Factory']).find((p) => p.salah === 'janganlah')!.otomatis).toBe(true);
    expect(kamusBelajar(notes, ['Aysilla Factory'], [{ salah: 'cana' }]).some((p) => p.salah === 'cana')).toBe(false);
  });
});
