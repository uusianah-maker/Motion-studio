import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import autocut as ac  # noqa: E402


def db_dengan(sunyi: list[tuple[int, int]], panjang_ms=4000):
    db = np.full(panjang_ms // 10, -20.0)
    for a, b in sunyi:
        db[a // 10 : b // 10] = -60.0
    return db


def seg(a, b, lo, hi, ka, kb):
    return {"srcStartMs": a, "srcEndMs": b, "lo": lo, "hi": hi, "kataAwal": ka, "kataAkhir": kb}


class SnapJeda(unittest.TestCase):
    def test_awal_digeser_ke_hening_sebelum_kata(self):
        # Whisper bilang kata mulai 1000, padahal suara mulai 900; hening 700-900.
        db = db_dengan([(700, 900)])
        out = ac.snap_ke_jeda([seg(920, 2000, 500, 3000, 1000, 1880)], [], db)
        self.assertLessEqual(out[0]["srcStartMs"], 900)
        self.assertGreaterEqual(out[0]["srcStartMs"], 800)

    def test_titik_sudah_sunyi_tidak_digeser(self):
        db = db_dengan([(800, 1000)])
        out = ac.snap_ke_jeda([seg(900, 2000, 500, 3000, 1000, 1880)], [], db)
        self.assertEqual(out[0]["srcStartMs"], 900)

    def test_tidak_melewati_kata_tetangga(self):
        db = db_dengan([(300, 500)])
        out = ac.snap_ke_jeda([seg(920, 2000, 880, 3000, 1000, 1880)], [], db)
        self.assertGreaterEqual(out[0]["srcStartMs"], 880)

    def test_potongan_bertetangga_tetap_terpisah(self):
        db = db_dengan([(1950, 2100)])
        a = seg(500, 1900, 0, 2400, 600, 1800)
        b = seg(2150, 3000, 1800, 4000, 2230, 2900)
        out = ac.snap_ke_jeda([a, b], [], db)
        self.assertGreaterEqual(out[1]["srcStartMs"] - out[0]["srcEndMs"], 0)
        self.assertLess(out[0]["srcEndMs"], out[1]["srcStartMs"])

    def test_tanpa_audio_tidak_berubah(self):
        s = [seg(900, 2000, 500, 3000, 1000, 1880)]
        self.assertEqual(ac.snap_ke_jeda(s, [], None), s)


if __name__ == "__main__":
    unittest.main()
