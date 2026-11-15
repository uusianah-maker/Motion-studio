import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from teks_bawaan import atur_hook, pilih_top, teks_penting  # noqa: E402

HOOK = {"text": "Celana anti kusut", "startMs": 0, "endMs": 3000}


class TeksBawaan(unittest.TestCase):
    def test_tanpa_teks_hook_tetap(self):
        self.assertEqual(atur_hook(HOOK, [], 0.72), (HOOK, None))

    def test_teks_di_posisi_hook_digeser(self):
        hook, catatan = atur_hook(HOOK, [[0.1, 0.32, 0.8, 0.06]], 0.72)
        self.assertNotEqual(hook.get("top"), 0.30)
        self.assertIn("teks bawaan", catatan)

    def test_teks_penuh_hook_dilewati(self):
        kotak = [[0.1, y, 0.8, 0.07] for y in (0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75)]
        hook, catatan = atur_hook(HOOK, kotak, 0.72)
        self.assertIsNone(hook)
        self.assertIn("dilewati", catatan)

    def test_label_tipis_panjang_dihitung_teks(self):
        # "Fitted Dress x With Corset Pants": tinggi 1,6 %, lebar 44 % (klip audit 14 Nov).
        self.assertEqual(len(teks_penting([[0.48, 0.15, 0.44, 0.016]])), 1)
        self.assertEqual(teks_penting([[0.4, 0.5, 0.08, 0.012]]), [])  # judul buku kecil di latar

    def test_hindari_wajah_kalau_bisa(self):
        top, juga_wajah = pilih_top([], 0.72, wajah=[(0.20, 0.45)])
        self.assertTrue(juga_wajah)
        self.assertTrue(top + 0.12 < 0.20 or top > 0.45)

    def test_teks_menang_atas_wajah(self):
        # Semua posisi kena wajah: tetap pilih posisi yang bebas teks.
        top, juga_wajah = pilih_top([[0.1, 0.10, 0.8, 0.05]], 0.72, wajah=[(0.0, 0.85)])
        self.assertIsNotNone(top)
        self.assertFalse(juga_wajah)

    def test_tidak_menimpa_caption(self):
        top, _ = pilih_top([[0.1, 0.28, 0.8, 0.2]], 0.55)
        self.assertFalse(top - 0.015 < 0.62 and top + 0.135 > 0.48)


if __name__ == "__main__":
    unittest.main()
