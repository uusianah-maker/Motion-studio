"""Uji efek & SFX otomatis: .venv/Scripts/python -m unittest pipeline/test_efek_otomatis.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from efek_otomatis import efek_batch, kandidat_sfx, pilih_sfx, saring_sfx  # noqa: E402

ASET = [
    {"jenis": "sfx", "kunci": "$sfx:klik", "tag": ["transisi", "click"], "durasi_ms": 12},  # dulu terpilih -> dibuang
    {"jenis": "sfx", "kunci": "$sfx:wus-1", "tag": ["transisi"], "durasi_ms": 400},
    {"jenis": "sfx", "kunci": "$sfx:wus-2", "tag": ["switch"], "durasi_ms": 600},
    {"jenis": "sfx", "kunci": "$sfx:eror", "tag": ["transisi", "error"], "durasi_ms": 300},
    {"jenis": "sfx", "kunci": "$sfx:pop-1", "tag": ["kata-kunci"], "durasi_ms": 150},
    {"jenis": "sfx", "kunci": "$sfx:dilarang", "tag": ["transisi"], "durasi_ms": 400, "lisensi_iklan": False},
]


class PilihSfx(unittest.TestCase):
    def test_bunyi_terlalu_pendek_negatif_dan_tanpa_lisensi_tidak_dipilih(self):
        kunci = [a["kunci"] for a in kandidat_sfx(ASET, "whoosh")]
        self.assertEqual(kunci, ["$sfx:wus-1", "$sfx:wus-2"])

    def test_bervariasi_antar_kejadian(self):
        dipakai = {pilih_sfx(ASET, "whoosh", i, "varian-001")["kunci"] for i in range(4)}
        self.assertEqual(dipakai, {"$sfx:wus-1", "$sfx:wus-2"})

    def test_tanpa_kandidat_kembali_none(self):
        self.assertIsNone(pilih_sfx([ASET[0]], "whoosh", 0))


class AturanWaktu(unittest.TestCase):
    def test_jarak_minimal_dan_prioritas_hook(self):
        hasil = saring_sfx([(100, "muncul"), (900, "pop"), (2500, "whoosh"), (29900, "pop")], 30000)
        self.assertEqual(hasil, [(100, "muncul"), (2500, "whoosh")])

    def test_efek_tidak_di_hook_dan_cta(self):
        framing, zt = efek_batch([1500, 6000, 12000, 18000, 29000], [(0, 3000), (3000, 8000), (8000, 20000), (20000, 30000)], 3000, 30000)
        self.assertTrue(all(3000 + 500 <= z <= 30000 - 1500 for z in zt))
        self.assertTrue(all(f["atMs"] >= 3000 for f in framing))
        self.assertLessEqual(len(zt), 2)


if __name__ == "__main__":
    unittest.main()
