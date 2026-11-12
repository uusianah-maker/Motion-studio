import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cek_ucapan import cek_ucapan  # noqa: E402


def tr(teks: str, detik: float) -> dict:
    kata = teks.split()
    step = int(detik * 1000 / max(len(kata), 1))
    return {
        "durationMs": int(detik * 1000),
        "words": [{"text": k, "startMs": i * step, "endMs": (i + 1) * step, "prob": 0.9} for i, k in enumerate(kata)],
    }


class CekUcapan(unittest.TestCase):
    def test_halusinasi_terima_kasih_ditolak(self):
        self.assertEqual(cek_ucapan(tr("Terima kasih telah menonton!", 17))["status"], "ditolak")

    def test_intro_berulang_ditolak(self):
        self.assertEqual(cek_ucapan(tr("Intro Intro Intro Intro Intro", 29))["status"], "ditolak")

    def test_kosong_ditolak(self):
        self.assertEqual(cek_ucapan(tr("", 20))["status"], "ditolak")

    def test_terlalu_jarang_ditolak(self):
        # 5 kata dalam 15 detik: bukan orang bicara
        self.assertEqual(cek_ucapan(tr("Latte. Saki. Yeah, sorry. Talk.", 15))["status"], "ditolak")

    def test_ucapan_indonesia_ok(self):
        t = "Kalian pernah gak sih males nyetrika celana? Nah ini Loose Pants, bahannya anti kusut, adem, flowy banget."
        self.assertEqual(cek_ucapan(tr(t, 6))["status"], "ok")

    def test_lirik_inggris_peringatan(self):
        t = "If you like to do the things you know that we shouldn't do then baby I'm perfect for you"
        self.assertEqual(cek_ucapan(tr(t, 8))["status"], "peringatan")

    def test_campur_sedikit_inggris_ok(self):
        t = "Ini celana korset, bahannya super stretch, adem, dan nyaman banget buat dipakai sehari-hari, worth it"
        self.assertEqual(cek_ucapan(tr(t, 6))["status"], "ok")

    def test_ucapan_dengan_terima_kasih_di_akhir_ok(self):
        t = "Bahannya adem banget nggak nerawang ukurannya lengkap cek keranjang kuning ya terima kasih"
        self.assertEqual(cek_ucapan(tr(t, 6))["status"], "ok")


if __name__ == "__main__":
    unittest.main()
