import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from transfer import bagi_adegan, prompt_gambar  # noqa: E402


class MotionTransfer(unittest.TestCase):
    def test_adegan_pendek_digabung(self):
        self.assertEqual(bagi_adegan([2.0, 2.3, 5.0], 8.0), [(0.0, 2.3), (2.3, 5.0), (5.0, 8.0)])

    def test_adegan_panjang_dipecah(self):
        a = bagi_adegan([], 10.0)
        self.assertEqual(len(a), 3)
        self.assertTrue(all(b - x <= 4.0 for x, b in a))
        self.assertEqual((a[0][0], a[-1][1]), (0.0, 10.0))

    def test_tanpa_celah(self):
        a = bagi_adegan([1.0, 1.5, 3.2, 3.4, 7.9], 9.0)
        self.assertTrue(all(x[1] == y[0] for x, y in zip(a, a[1:])))

    def test_prompt_menyebut_produk_dan_larangan_teks(self):
        p = prompt_gambar("Celana Korset Aysilla", "hitam, high waist")
        self.assertIn("Celana Korset Aysilla", p)
        self.assertIn("Jangan tambahkan teks", p)


if __name__ == "__main__":
    unittest.main()
