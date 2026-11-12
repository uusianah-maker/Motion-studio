import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine  # noqa: E402


class Engine(unittest.TestCase):
    def test_file_tidak_ada_ditolak(self):
        with self.assertRaises(engine.Ditolak):
            engine.cek_input(Path("D:/tidak/ada/video.mp4"))

    def test_job_schema_salah(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "job.json").write_text(json.dumps({"schema": "lain"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                engine.baca_job(Path(d))

    def test_sumber_utama_wajib(self):
        with self.assertRaises(ValueError):
            engine.sumber_utama({"sumber": [{"kunci": "$sumber:IN1", "path": "x.mp4"}]})
        self.assertEqual(engine.sumber_utama({"sumber": [{"kunci": "$sumber", "path": "D:/a.mp4"}]}), Path("D:/a.mp4"))

    def test_argumen_edit_dari_brief(self):
        job = {"brand_kit": "brand_kit.json", "preset": "ays-konversi",
               "brief": {"placement": "shopee", "area_produk": "bawah"}}
        cmd = engine.argumen_edit(job, Path("J"), Path("J/out/transkrip.json"), Path("D:/v.mp4"), Path("J/out"))
        s = " ".join(cmd)
        self.assertIn("--placement shopee", s)
        self.assertIn("--preset ays-konversi", s)
        self.assertIn("--area-produk bawah", s)
        self.assertIn("--mode-ops kompat", s)

    def test_tulis_ditolak(self):
        with tempfile.TemporaryDirectory() as d:
            engine.tulis_ditolak(Path(d, "out"), "tidak ada ucapan")
            r = json.loads(Path(d, "out", "rencana.json").read_text(encoding="utf-8"))
            self.assertEqual((r["status"], r["alasan"]), ("ditolak", "tidak ada ucapan"))


if __name__ == "__main__":
    unittest.main()
