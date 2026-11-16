"""§22 VO dari Library: .venv/Scripts/python -m unittest pipeline/tests/test_vo_library.py"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PIPE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPE))
import vo_library as V  # noqa: E402


def idx(kalimat=None):
    return {"schema": "vo-index/1", "job_id": "x", "teks": "",
            "kalimat": kalimat or [
                {"teks": "Halo kak.", "mulai": 0.0, "akhir": 1.2, "kata": [{"teks": "Halo", "mulai": 0.1, "akhir": 0.5},
                                                                          {"teks": "kak.", "mulai": 0.5, "akhir": 1.0}]},
                {"teks": "Harganya cuma 99 ribu!", "mulai": 1.5, "akhir": 3.5, "kata": []}]}


class Index(unittest.TestCase):
    def tulis(self, d, isi):
        p = Path(d) / "vo_index.json"
        p.write_text(json.dumps(isi), encoding="utf-8")
        return p

    def test_sah_dan_tidak_sah(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(len(V.muat_index(self.tulis(d, idx()), 3.6)["kalimat"]), 2)
            for salah in ({"schema": "lain"}, {**idx(), "kalimat": []},
                          {**idx(), "kalimat": [{"teks": "a", "mulai": 2, "akhir": 1}]},
                          {**idx(), "kalimat": [{"teks": "", "mulai": 0, "akhir": 1}]}):
                with self.assertRaises(V.Ditolak):
                    V.muat_index(self.tulis(d, salah))
            with self.assertRaises(V.Ditolak):  # index lebih panjang dari file VO
                V.muat_index(self.tulis(d, idx()), 3.0)
            with self.assertRaises(V.Ditolak):
                V.muat_index(Path(d) / "tidak-ada.json")

    def test_konfigurasi(self):
        self.assertIsNone(V.konfigurasi({}))
        c = V.konfigurasi({"vo": {"media": "$vo:a"}})
        self.assertEqual((c["index"], c["suara_footage"], c["volume_footage"], c["subtitle"]), ("vo_index.json", "mati", 0.0, True))
        for salah in ({"vo": {"media": "$sumber"}}, {"vo": {"media": "$vo:a", "suara_footage": "keras"}},
                      {"vo": {"media": "$vo:a", "index": "../x.json"}}, {"vo": {"media": "$vo:a"}, "audio_pilihan": "musik"}):
            with self.assertRaises(V.Ditolak):
                V.konfigurasi(salah)


class Kata(unittest.TestCase):
    def test_kata_absolut_dan_dibagi_rata(self):
        k = V.kata_absolut(idx())
        self.assertEqual([w["text"] for w in k], ["Halo", "kak.", "Harganya", "cuma", "99", "ribu!"])
        self.assertEqual((k[0]["startMs"], k[1]["endMs"]), (100, 1000))
        self.assertEqual(k[2]["startMs"], 1500)  # kalimat tanpa cap waktu kata: dibagi rata menurut huruf
        self.assertEqual(k[-1]["endMs"], 3500)
        for a, b in zip(k, k[1:]):
            self.assertLessEqual(a["endMs"], b["startMs"])

    def test_halaman_pecah_di_kalimat_dan_maks_kata(self):
        pages = V.halaman(V.kata_absolut(idx()), maks_kata=3)
        self.assertEqual([[w["text"] for w in p] for p in pages], [["Halo", "kak."], ["Harganya", "cuma", "99"], ["ribu!"]])

    def test_segmen_footage_diulang(self):
        seg = V.segmen_footage(2000, 5000, 30)
        self.assertEqual(sum(s["endFrame"] - s["startFrame"] for s in seg), 150)
        self.assertTrue(all(s["startFrame"] == 0 for s in seg))
        self.assertEqual(len(V.segmen_footage(20000, 5000, 30)), 1)
        with self.assertRaises(V.Ditolak):
            V.segmen_footage(300, 5000, 30)

    def test_cut_vo_berbentuk_run_cut(self):
        c = V.cut_vo(idx(), 2000, 30)
        self.assertEqual(c["voMs"], 3500)
        self.assertEqual(c["captions"][0]["_word"], 0)
        self.assertEqual(c["removed"], [])
        self.assertAlmostEqual(c["to_out"](500), 500)


@unittest.skipUnless(sys.platform == "win32" and shutil.which("ffmpeg"), "suara Windows + ffmpeg")
class GenerateVO(unittest.TestCase):
    """engine generate dengan job.vo: tanpa Whisper, VO di track audio, footage diam boleh, validator Motion Studio."""

    def test_generate_vo_dari_library(self):
        d = Path(tempfile.mkdtemp())
        t = d / "tts"
        t.mkdir()
        (t / "job.json").write_text(json.dumps({"tts": {"kalimat": ["Celana ini adem banget.", "Harganya cuma 99 ribu!"]}}),
                                    encoding="utf-8")
        r = subprocess.run([sys.executable, str(PIPE / "engine.py"), "tts", str(t)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        lap = json.loads((t / "out" / "tts.json").read_text(encoding="utf-8"))
        g = d / "gen"
        g.mkdir()
        foot = g / "foot.mp4"  # footage TANPA suara, 2 dtk (lebih pendek dari VO -> diulang)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=2",
                        "-pix_fmt", "yuv420p", str(foot)], check=True)
        bk = json.loads((PIPE.parent / "brandkit" / "aysilla.export.json").read_text(encoding="utf-8"))
        # Seperti app (tts.ts): VO gabungan = aset Brand Kit jenis "vo" -> placeholder dikenal validator/runner.
        bk["aset"].append({"kunci": "$vo:vo-uji", "jenis": "vo", "nama": "VO uji", "tag": ["vo", "tts"], "lisensi_iklan": True,
                           "status_lisensi": "milik_sendiri", "durasi_ms": round(lap["gabungan"]["durasi"] * 1000),
                           "path": str(t / "out" / "vo" / "gabungan.wav")})
        (g / "brand_kit.json").write_text(json.dumps(bk, ensure_ascii=False), encoding="utf-8")
        (g / "vo_index.json").write_text(json.dumps({"schema": "vo-index/1", "job_id": "uji", "teks": "",
                                                     "kalimat": [{"teks": f["teks"], "mulai": f["mulai"], "akhir": f["akhir"],
                                                                  "kata": f["kata"]} for f in lap["file"]]}), encoding="utf-8")
        (g / "job.json").write_text(json.dumps({
            "schema": "engine-job/1", "job_id": "UJI-VO", "mode": "generate", "brand_kit": "brand_kit.json",
            "sumber": [{"kunci": "$sumber", "path": str(foot)}, {"kunci": "$vo:vo-uji", "path": str(t / "out" / "vo" / "gabungan.wav")}],
            "vo": {"media": "$vo:vo-uji"}, "brief": {}}), encoding="utf-8")
        r = subprocess.run([sys.executable, str(PIPE / "engine.py"), "generate", str(g)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", cwd=PIPE.parent)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        self.assertIn("tanpa Whisper", r.stdout)
        ops = json.loads((g / "out" / "ops.json").read_text(encoding="utf-8"))["ops"]
        audio = [o for o in ops if o.get("track_kind") == "audio"]
        self.assertEqual([(o["media"], o["start_ms"]) for o in audio], [("$vo:vo-uji", 0)])
        self.assertTrue(all(o.get("volume") == 0.0 for o in ops if o.get("track_kind") == "video"))
        sub = " ".join(o["text"] for o in ops if o.get("track_kind") == "subtitle")
        self.assertIn("Harganya", sub)
        rencana = json.loads((g / "out" / "rencana.json").read_text(encoding="utf-8"))
        self.assertEqual(rencana["sumber_suara"], "vo_library")
        self.assertIn("footage_kurang", [p["jenis"] for p in rencana["peringatan"]])
        aset_lokal = json.loads((g / "out" / "ops.json").read_text(encoding="utf-8")).get("aset_lokal", [])
        self.assertNotIn("$vo:vo-uji", [a["kunci"] for a in aset_lokal])  # VO di luar root: dikenal lewat Brand Kit

    def test_index_tidak_ada_ditolak(self):
        g = Path(tempfile.mkdtemp())
        foot = g / "foot.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=2",
                        "-pix_fmt", "yuv420p", str(foot)], check=True)
        (g / "job.json").write_text(json.dumps({"schema": "engine-job/1", "sumber": [{"kunci": "$sumber", "path": str(foot)},
                                                {"kunci": "$vo:a", "path": str(foot)}], "vo": {"media": "$vo:a"}}), encoding="utf-8")
        r = subprocess.run([sys.executable, str(PIPE / "engine.py"), "generate", str(g)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        self.assertEqual(r.returncode, 2, r.stderr[-500:])
        self.assertIn("index VO", json.loads((g / "out" / "rencana.json").read_text(encoding="utf-8"))["alasan"])


class BatchVO(unittest.TestCase):
    """§22 Batch: VO dari Library = satu kandidat VO berbentuk vo_mod.kandidat (kalimat utuh, urutan tetap)."""

    def test_kandidat_vo_library(self):
        sys.path.insert(0, str(PIPE / "batch"))
        import perencana
        import vo as vo_mod
        c = perencana.kandidat_vo_library(idx(), "$vo:x", {"superlatif_dilarang": ["terbaik"]})
        self.assertEqual(c["id"], "$vo:x")
        self.assertEqual([k["id"] for k in c["kalimat"]], [0, 1])
        self.assertEqual(c["kalimat"][1]["kata"][0]["startMs"], 1500)  # waktu ABSOLUT di file VO
        self.assertIn("harga", c["kalimat"][1]["topik"])
        rv = vo_mod._hasil(c, c["kalimat"], [], [], None)
        self.assertEqual(rv["urutan"], [0, 1])
        self.assertAlmostEqual(rv["durasi_ucapan"], 1.2 + 2.0 + vo_mod.JEDA)


if __name__ == "__main__":
    unittest.main()
