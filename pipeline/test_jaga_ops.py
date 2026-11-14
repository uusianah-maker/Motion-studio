"""Uji pengaman jaga_ops: .venv/Scripts/python -m unittest pipeline/test_jaga_ops.py"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jaga_ops import SISA_MS, buang_teks_kosong, rapikan_kata, cek_durasi, durasi_file_ms, jaga_durasi  # noqa: E402


class JagaDurasi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wav = str(Path(cls.tmp.name) / "musik.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.0", cls.wav], check=True)
        cls.ms = durasi_file_ms(cls.wav)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def path_of(self, k):
        return self.wav if k == "$musik:x" else None

    def test_klip_kelebihan_beberapa_ms_dipendekkan(self):
        # Kasus KORSET: musik 3 ms lebih panjang dari file -> Motion Studio menolak seluruh keputusan batch.
        ops = [{"op": "add_clip", "track_kind": "music", "media": "$musik:x", "start_ms": 0, "duration_ms": self.ms + 3, "in_ms": 0}]
        catatan = jaga_durasi(ops, self.path_of)
        self.assertEqual(len(catatan), 1)
        self.assertLessEqual(ops[0]["duration_ms"], self.ms - SISA_MS)
        self.assertEqual(cek_durasi(ops, self.path_of), [])

    def test_klip_yang_sumbernya_habis_dibuang(self):
        ops = [{"op": "add_clip", "track_kind": "music", "media": "$musik:x", "start_ms": 0, "duration_ms": 500, "in_ms": self.ms - 50}]
        jaga_durasi(ops, self.path_of)
        self.assertEqual(ops, [])

    def test_klip_valid_dan_tanpa_media_tidak_diubah(self):
        ops = [{"op": "add_clip", "track_kind": "music", "media": "$musik:x", "start_ms": 0, "duration_ms": 400, "in_ms": 100},
               {"op": "add_clip", "track_kind": "text", "text": "hai", "start_ms": 0, "duration_ms": 9000},
               {"op": "add_clip", "track_kind": "video", "media": "$sumber:tidak-dikenal", "start_ms": 0, "duration_ms": 9000}]
        self.assertEqual(jaga_durasi(ops, self.path_of), [])
        self.assertEqual([o["duration_ms"] for o in ops], [400, 9000, 9000])

    def test_gerbang_akhir_melaporkan_yang_masih_lebih(self):
        ops = [{"op": "add_clip", "track_kind": "music", "media": "$musik:x", "start_ms": 0, "duration_ms": self.ms + 200, "in_ms": 0}]
        self.assertEqual(len(cek_durasi(ops, self.path_of)), 1)


class TeksKosong(unittest.TestCase):
    def test_cta_kosong_dibuang_teks_berisi_tetap(self):
        # Brand Kit tanpa CTA -> klip teks "" ditolak validator Motion Studio ("Teks wajib 1-500 karakter").
        ops = [{"op": "add_clip", "track_kind": "text", "text": "", "start_ms": 1000, "duration_ms": 2500},
               {"op": "add_clip", "track_kind": "text", "text": "Cek keranjang kuning", "start_ms": 0, "duration_ms": 900},
               {"op": "add_clip", "track_kind": "subtitle", "text": "x" * 600, "start_ms": 0, "duration_ms": 900}]
        catatan = buang_teks_kosong(ops)
        self.assertEqual(len(catatan), 2)
        self.assertEqual([o["text"][:5] for o in ops], ["Cek k", "xxxxx"])
        self.assertEqual(len(ops[1]["text"]), 500)


class WaktuKata(unittest.TestCase):
    def test_kata_di_luar_klip_dan_tumpang_tindih_dirapikan(self):
        # KORSET varian-003: kata "paling" di luar klip 0-520 ms -> validator menolak seluruh varian.
        o = {"op": "add_clip", "track_kind": "subtitle", "text": "yang paling enak", "start_ms": 0, "duration_ms": 520,
             "words": [{"text": "yang", "start_ms": 0, "end_ms": 300}, {"text": "paling", "start_ms": 250, "end_ms": 600},
                       {"text": "enak", "start_ms": 700, "end_ms": 900}]}
        self.assertEqual(len(rapikan_kata([o])), 1)
        w = o["words"]
        self.assertTrue(all(0 <= x["start_ms"] < x["end_ms"] <= 520 for x in w))
        self.assertTrue(all(w[i]["end_ms"] <= w[i + 1]["start_ms"] for i in range(len(w) - 1)))


if __name__ == "__main__":
    unittest.main()
