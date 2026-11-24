"""§28 pembaca neural, gaya, ubah suara: .venv/Scripts/python -m unittest pipeline/tests/test_tts_gaya.py
Model asli (Chatterbox/ZONOS/Applio) diganti tiruan: yang diuji alur, validasi, cap waktu, dan laporan."""

import json
import math
import shutil
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

PIPE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPE))
import tts  # noqa: E402


def nada(p: Path, detik: float, sr: int = 24000, sunyi: float = 0.2) -> None:
    n, s = int(sr * detik), int(sr * sunyi)
    data = [0] * s + [int(8000 * math.sin(2 * math.pi * 220 * i / sr)) for i in range(n)] + [0] * s
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(data)}h", *data))


class TesGaya(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d, True)
        self.panggilan = []

        def neural(model, profil, gaya, item, perkuat, tmp):
            self.panggilan.append((model, profil, gaya, perkuat, [t for t, _ in item]))
            for t, p in item:
                nada(p, 0.05 * len(t))
        siap = mock.patch.object(tts.Owner, "daftar", lambda s: [{"id": f"{s.nama}:x"}])
        siap.start()
        self.addCleanup(siap.stop)
        n = mock.patch.object(tts, "ucapkan_neural", neural)
        n.start()
        self.addCleanup(n.stop)

    def jalan(self, cfg, **job):
        (self.d / "job.json").write_text(json.dumps({"tts": cfg, **job}, ensure_ascii=False), encoding="utf-8")
        k = tts.jalankan(self.d)
        return k, json.loads((self.d / "out" / "tts.json").read_text(encoding="utf-8"))

    def test_chatterbox_gaya_dan_kata_perkiraan(self):
        k, lap = self.jalan({"kalimat": ["Halo kak, ini Aysilla.", "Bahannya adem banget!"], "suara": "grace:Suara Grace",
                             "model": "chatterbox", "gaya": "jualan", "jeda_ms": 200, "pelafalan": {"Aysilla": "Ai sila"}})
        self.assertEqual(k, 0, lap)
        self.assertEqual(self.panggilan[0][:4], ("chatterbox", "grace", "jualan", True))
        self.assertEqual(self.panggilan[0][4][0], "Halo kak, ini Ai sila.")  # pelafalan ikut ke model
        self.assertTrue(lap["kata_perkiraan"])
        self.assertEqual((lap["model"], lap["gaya"]), ("chatterbox", "jualan"))
        kata = lap["file"][0]["kata"]
        self.assertEqual([w["teks"] for w in kata], ["Halo", "kak,", "ini", "Aysilla."])  # subtitle tetap tulisan asli
        self.assertGreater(kata[0]["mulai"], 0.1)  # sunyi awal dilewati
        self.assertLessEqual(kata[-1]["akhir"], lap["file"][0]["durasi"])
        self.assertTrue(all(a["akhir"] <= b["mulai"] + 1e-3 for a, b in zip(kata, kata[1:])))
        self.assertTrue((self.d / "out" / "vo" / "gabungan.wav").exists())

    def test_kecepatan_memendekkan(self):
        _, a = self.jalan({"teks": "Satu kalimat yang cukup panjang untuk diuji.", "suara": "owner:x", "model": "zonos"})
        _, b = self.jalan({"teks": "Satu kalimat yang cukup panjang untuk diuji.", "suara": "owner:x", "model": "zonos", "kecepatan": 1.5})
        self.assertLess(b["total_durasi"], a["total_durasi"] * 0.8)

    def test_penolakan(self):
        for cfg, pesan in [({"teks": "halo", "model": "chatterbox", "suara": "windows:Andika"}, "profil"),
                           ({"teks": "halo", "model": "elevenlabs", "suara": "grace:x"}, "tidak dikenal"),
                           ({"teks": "halo", "model": "zonos", "suara": "grace:x", "gaya": "marah"}, "gaya"),
                           ({"audio": "$media:x", "suara": "grace:x"}, "job.sumber"),
                           ({"audio": "$media:x", "suara": "windows:Andika"}, "profil")]:
            k, lap = self.jalan(cfg)
            self.assertEqual(k, 2, cfg)
            self.assertIn(pesan, lap["alasan"])
        self.assertEqual(self.panggilan, [])

    def test_ubah_suara(self):
        rekaman = self.d / "vo_tim.wav"
        nada(rekaman, 2.0, sr=44100)

        def ubah(perintah, isi, rentang=(0, 100)):
            self.assertEqual(perintah, "ubah")
            self.assertTrue(isi["model_dir"].replace("\\", "/").endswith("suara/niar/model"))
            for a, b in zip(isi["masuk"], isi["keluar"]):
                shutil.copy2(a, b)
        with mock.patch("suara_profil.jalan_mesin", ubah):
            k, lap = self.jalan({"audio": "$media:vo1", "suara": "niar:Suara Niar", "kecepatan": 1.25},
                                sumber=[{"kunci": "$media:vo1", "path": str(rekaman)}])
        self.assertEqual(k, 0, lap)
        self.assertEqual(lap["model"], "ubah_suara")
        self.assertAlmostEqual(lap["total_durasi"], 2.4 / 1.25, delta=0.1)
        self.assertEqual(self.panggilan, [])

    def test_daftar_berisi_model_dan_gaya(self):
        k, lap = self.jalan({"daftar_suara": True})
        self.assertEqual(k, 0)
        self.assertEqual([m["id"] for m in lap["model"]], ["andika", "chatterbox", "zonos"])
        self.assertEqual([g["id"] for g in lap["gaya"]], list(tts.GAYA))
        for g in tts.GAYA.values():
            self.assertEqual(set(g), {"label", "chatterbox", "zonos", "jeda_ms"})


if __name__ == "__main__":
    unittest.main()
