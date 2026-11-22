"""§25 tanpa GPU: .venv/Scripts/python -m unittest pipeline/tests/test_suara_lanjut.py"""

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import suara_lanjut as L  # noqa: E402


def muat(p: Path) -> int:
    """Checkpoint palsu: teks 'ckpt:<epoch>'. Selain itu dianggap rusak."""
    t = p.read_text(encoding="utf-8")
    if not t.startswith("ckpt:"):
        raise L.CheckpointRusak(f"{p.name}: rusak")
    return int(t[5:])


class Lanjut(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.kerja = self.tmp / "_kerja"
        self.exp = self.kerja / "logs" / "owner"
        self.exp.mkdir(parents=True)
        L.tulis_manifest(self.kerja, {"schema": "suara-lanjut/1", "sidik": "S"})

    def ckpt(self, e: int, d: int | None = None):
        (self.exp / L.NAMA_G).write_text(f"ckpt:{e}", encoding="utf-8")
        (self.exp / L.NAMA_D).write_text(f"ckpt:{e if d is None else d}", encoding="utf-8")

    def test_sidik_ikut_isi_bukan_urutan(self):
        a, b = self.tmp / "a.wav", self.tmp / "b.wav"
        a.write_bytes(b"a"), b.write_bytes(b"b")
        self.assertEqual(L.sidik_latih([a, b], 4, 40000), L.sidik_latih([b, a], 4, 40000))
        self.assertNotEqual(L.sidik_latih([a], 4, 40000), L.sidik_latih([a, b], 4, 40000))
        self.assertNotEqual(L.sidik_latih([a], 4, 40000), L.sidik_latih([a], 2, 40000))

    def test_cadangan_lalu_lanjut_dan_pulihkan(self):
        self.ckpt(10)
        L.cadangkan(self.kerja, self.exp, 10, muat)
        self.assertEqual(L.putuskan(self.kerja, self.exp, "S", 150, muat), {"aksi": "lanjut", "epoch": 10})
        self.ckpt(17)  # file kerja berubah/tidak utuh: yang dipulihkan tetap cadangan
        (self.exp / "G_999.pth").write_text("ckpt:999", encoding="utf-8")
        self.assertEqual(L.pulihkan(self.kerja, self.exp), 10)
        self.assertEqual(sorted(p.name for p in self.exp.glob("*.pth")), sorted([L.NAMA_G, L.NAMA_D]))
        self.assertEqual(muat(self.exp / L.NAMA_G), 10)

    def test_hanya_dua_cadangan_terakhir(self):
        for e in (10, 20, 30):
            self.ckpt(e)
            L.cadangkan(self.kerja, self.exp, e, muat)
        self.assertEqual(sorted(p.name for p in (self.kerja / "cadangan").iterdir()), ["e0020", "e0030"])

    def test_gagal_keras(self):
        self.ckpt(10, 0)  # G dan D beda epoch
        with self.assertRaises(L.CheckpointRusak):
            L.cadangkan(self.kerja, self.exp, 10, muat)
        self.assertIsNone(L.baca_manifest(self.kerja).get("cadangan"))
        self.ckpt(10)
        L.cadangkan(self.kerja, self.exp, 10, muat)
        g = self.kerja / "cadangan" / "e0010" / "G.pth"
        g.write_text("rusak", encoding="utf-8")
        with self.assertRaises(L.CheckpointRusak):
            L.putuskan(self.kerja, self.exp, "S", 150, muat)
        self.assertTrue(g.exists())  # tidak dihapus

    def test_checkpoint_tanpa_catatan_tidak_dihapus_diam_diam(self):
        self.ckpt(30)
        with self.assertRaises(L.CheckpointRusak):
            L.putuskan(self.kerja, self.exp, "S", 150, muat)  # manifest ada, cadangan belum
        (self.kerja / "lanjut.json").unlink()
        with self.assertRaises(L.CheckpointRusak):
            L.putuskan(self.kerja, self.exp, "S", 150, muat)

    def test_keputusan_baru(self):
        self.assertEqual(L.putuskan(self.tmp / "tidak-ada", self.exp, "S", 150, muat), {"aksi": "baru"})
        self.assertEqual(L.putuskan(self.kerja, self.exp, "S", 150, muat), {"aksi": "baru"})  # belum ada checkpoint
        self.ckpt(10)
        L.cadangkan(self.kerja, self.exp, 10, muat)
        self.assertEqual(L.putuskan(self.kerja, self.exp, "LAIN", 150, muat), {"aksi": "baru"})  # contoh berubah

    def test_penjaga_cadangkan_setelah_epoch_berikutnya(self):
        p = L.Penjaga(self.kerja, self.exp, 150, muat=muat)
        for e in range(1, 11):
            self.assertFalse(p(e))
        self.assertIsNone(L.baca_manifest(self.kerja).get("cadangan"))  # epoch 10 dicetak sebelum disimpan
        self.ckpt(10)
        self.assertFalse(p(11))
        self.assertEqual(L.baca_manifest(self.kerja)["cadangan"]["epoch"], 10)

    def test_penjaga_jeda_sebelum_jam_batas(self):
        t = [1000.0]
        p = L.Penjaga(self.kerja, self.exp, 150, jeda_pada=1000.0 + 250, muat=muat, jam=lambda: t[0])
        self.ckpt(10)
        t[0] = 1100.0
        self.assertFalse(p(11))  # blok berikutnya selesai 1200, masih sebelum batas
        self.ckpt(20)
        t[0] = 1200.0
        self.assertTrue(p(21))  # blok berikutnya 1300 melewati batas
        self.assertEqual(p.epoch_aman, 20)

    def test_penjaga_tolak_applio_mulai_dari_nol(self):
        p = L.Penjaga(self.kerja, self.exp, 150, mulai_dari=20, muat=muat)
        with self.assertRaises(L.CheckpointRusak):
            p(1)
        ok = L.Penjaga(self.kerja, self.exp, 150, mulai_dari=20, muat=muat)
        self.assertFalse(ok(21))  # checkpoint 20 sudah ada, tidak dicadangkan ulang

    def test_waktu_jeda(self):
        t = time.mktime((2026, 11, 23, 23, 0, 0, 0, 0, -1))
        self.assertEqual(time.localtime(L.waktu_jeda("06:00", t))[2:5], (24, 6, 0))
        self.assertEqual(time.localtime(L.waktu_jeda("23:30", t))[2:5], (23, 23, 30))
        self.assertIsNone(L.waktu_jeda(None, t))
        with self.assertRaises(ValueError):
            L.waktu_jeda("25:00", t)

    def test_manifest_rusak(self):
        (self.kerja / "lanjut.json").write_text("{bukan json", encoding="utf-8")
        with self.assertRaises(L.CheckpointRusak):
            L.putuskan(self.kerja, self.exp, "S", 150, muat)
        self.assertEqual((self.kerja / "lanjut.json").read_text(encoding="utf-8"), "{bukan json")
        json.dumps({})


if __name__ == "__main__":
    unittest.main()
