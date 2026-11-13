import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from posisi_caption import BATAS_BAWAH, SETENGAH_TINGGI, pilih_y  # noqa: E402


class PosisiCaption(unittest.TestCase):
    def test_tanpa_wajah_pakai_default(self):
        y, _ = pilih_y([[]] * 10, default=0.72)
        self.assertEqual(y, 0.72)

    def test_wajah_di_bawah_caption_pindah_ke_atas(self):
        # talking head close-up: wajah di 0.55-0.85 hampir di semua frame
        y, _ = pilih_y([[(0.55, 0.85)]] * 10, default=0.72)
        self.assertLess(y + SETENGAH_TINGGI, 0.55)

    def test_produk_bawah_dihindari_kalau_wajah_tidak_kena(self):
        y, _ = pilih_y([[(0.05, 0.25)]] * 10, default=0.72, area_produk="bawah")
        self.assertLess(y + SETENGAH_TINGGI, 0.50)

    def test_wajah_lebih_penting_dari_produk(self):
        # wajah di 0.30-0.50, produk di bawah: caption boleh di area produk, tidak di wajah
        y, _ = pilih_y([[(0.30, 0.50)]] * 10, default=0.72, area_produk="bawah")
        self.assertGreater(y - SETENGAH_TINGGI, 0.50)

    def test_deteksi_sesekali_diabaikan(self):
        frames = [[(0.65, 0.80)]] + [[]] * 19  # 5% frame: kemungkinan salah deteksi
        y, _ = pilih_y(frames, default=0.72)
        self.assertEqual(y, 0.72)

    def test_tidak_pernah_masuk_15_persen_bawah(self):
        y, lap = pilih_y([[]] * 5, default=0.80)
        self.assertLessEqual(y + SETENGAH_TINGGI, BATAS_BAWAH)
        self.assertTrue(all(k["y"] + SETENGAH_TINGGI <= BATAS_BAWAH for k in lap["kandidat"]))


if __name__ == "__main__":
    unittest.main()
