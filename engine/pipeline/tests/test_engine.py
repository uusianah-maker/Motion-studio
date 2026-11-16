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

    def test_r18_audio_pilihan_ke_edit(self):
        job = {"brand_kit": "brand_kit.json", "brief": {}, "audio_pilihan": "vo"}
        cmd = engine.argumen_edit(job, Path("J"), Path("J/out/transkrip.json"), Path("D:/v.mp4"), Path("J/out"))
        self.assertEqual(cmd[cmd.index("--audio") + 1], "vo")
        job["audio_pilihan"] = "lain"
        self.assertNotIn("--audio", engine.argumen_edit(job, Path("J"), Path("t"), Path("v"), Path("o")))

    def test_r20_skrip_absolut_dari_folder_kode(self):
        cmd = engine.skrip_absolut(["py", "pipeline/edit.py", "pipeline/x.json", "--out", "o"])
        self.assertEqual(cmd[1], str(engine.ROOT / "pipeline/edit.py"))
        self.assertEqual(cmd[2:], ["pipeline/x.json", "--out", "o"])  # bukan skrip .py: tidak diubah

    def test_r20_data_bawaan_root(self):
        import os
        if not os.environ.get("MOTION_ENGINE_DATA"):
            self.assertEqual(engine.DATA, engine.ROOT)



class PerintahTts(unittest.TestCase):
    """R24f: engine tts <job_dir> -> out/vo/NN.wav + out/tts.json (tts/1). Jalan juga dari folder rilis (R20)."""

    PIPE = Path(__file__).resolve().parents[1]

    def _jalan(self, engine_py: Path, job: dict, env_data: str | None = None):
        import os
        import subprocess
        d = Path(tempfile.mkdtemp())
        (d / "job.json").write_text(json.dumps(job), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "MOTION_ENGINE_DATA"}
        if env_data:
            env["MOTION_ENGINE_DATA"] = env_data
        r = subprocess.run([sys.executable, str(engine_py), "tts", str(d)], capture_output=True, text=True,
                           encoding="utf-8", env=env)
        lap = json.loads((d / "out" / "tts.json").read_text(encoding="utf-8")) if (d / "out" / "tts.json").exists() else None
        return r, lap, d

    def test_teks_kosong_ditolak(self):
        r, lap, _ = self._jalan(self.PIPE / "engine.py", {"schema": "engine-job/1", "tts": {"kalimat": ["  ", ""]}})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(lap["status"], "ditolak")
        self.assertIn("kosong", lap["alasan"])

    def test_kecepatan_di_luar_batas_ditolak(self):
        r, lap, _ = self._jalan(self.PIPE / "engine.py", {"tts": {"teks": "halo", "kecepatan": 5}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("kecepatan", lap["alasan"])

    @unittest.skipUnless(sys.platform == "win32", "suara Windows")
    def test_suara_tidak_ada_ditolak(self):
        r, lap, _ = self._jalan(self.PIPE / "engine.py", {"tts": {"teks": "halo", "suara": "TidakAdaSuaraIni"}})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("tidak terpasang", lap["alasan"])

    @unittest.skipUnless(sys.platform == "win32", "suara Windows")
    def test_dari_folder_rilis_menulis_wav(self):
        import shutil
        rilis = Path(tempfile.mkdtemp()) / "mesin"
        shutil.copytree(self.PIPE, rilis / "pipeline", ignore=shutil.ignore_patterns("__pycache__", "tests"))
        data = tempfile.mkdtemp()
        r, lap, d = self._jalan(rilis / "pipeline" / "engine.py",
                                {"tts": {"kalimat": ["Halo kak.", "Celana ini adem banget."], "suara": "Andika"}},
                                env_data=data)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(lap["status"], "selesai")
        self.assertEqual([f["file"] for f in lap["file"]], ["out/vo/01.wav", "out/vo/02.wav"])
        self.assertTrue(all(f["durasi"] > 0.3 for f in lap["file"]))
        self.assertTrue((d / "out" / "vo" / "02.wav").exists())
        self.assertEqual(list(Path(data).iterdir()), [])  # tidak menulis apa pun ke folder data
        progres = [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]
        self.assertEqual(progres[-1]["tahap"], "selesai")



class PerintahVisual(unittest.TestCase):
    """R24: engine visual <job_dir> lewat visual-venv; jalan dari folder rilis + MOTION_ENGINE_DATA (R20)."""

    PIPE = Path(__file__).resolve().parents[1]

    def _jalan(self, engine_py: Path, job: dict, env_data: str | None = None):
        import os
        import subprocess
        d = Path(tempfile.mkdtemp())
        (d / "job.json").write_text(json.dumps(job), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "MOTION_ENGINE_DATA"}
        if env_data:
            env["MOTION_ENGINE_DATA"] = env_data
        r = subprocess.run([sys.executable, str(engine_py), "visual", str(d)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=env)
        return r, d

    @unittest.skipUnless(Path(engine.VISUAL_PY).exists(), "visual-venv belum dipasang")
    def test_alat_salah_dan_masuk_kosong_ditolak(self):
        r, d = self._jalan(self.PIPE / "engine.py", {"visual": {"alat": "sulap"}})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(json.loads((d / "out" / "visual.json").read_text(encoding="utf-8"))["status"], "ditolak")
        r, _ = self._jalan(self.PIPE / "engine.py", {"visual": {"alat": "hapus_latar"}})
        self.assertEqual(r.returncode, 2)
        r, _ = self._jalan(self.PIPE / "engine.py", {"visual": {"alat": "lacak", "masuk": __file__, "kotak": [0.1, 0.1]}})
        self.assertEqual(r.returncode, 2)

    @unittest.skipUnless(Path(engine.VISUAL_PY).exists(), "visual-venv belum dipasang")
    def test_deteksi_lalu_reframe_dari_folder_rilis(self):
        import shutil
        import subprocess
        rilis = Path(tempfile.mkdtemp()) / "mesin"
        shutil.copytree(self.PIPE, rilis / "pipeline", ignore=shutil.ignore_patterns("__pycache__", "tests"))
        data = Path(tempfile.mkdtemp())
        (data / "konten").mkdir()
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=2",
                        "-pix_fmt", "yuv420p", str(data / "konten" / "uji.mp4")], check=True)
        r, d = self._jalan(rilis / "pipeline" / "engine.py",
                           {"visual": {"alat": "deteksi", "masuk": "konten/uji.mp4", "jenis": ["wajah", "objek"], "hz": 5}},
                           env_data=str(data))
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        jl = json.loads((d / "out" / "jalur.json").read_text(encoding="utf-8"))
        self.assertEqual((jl["schema"], jl["video"], jl["lebar"]), ("jalur-posisi/1", "konten/uji.mp4", 640))
        job = {"visual": {"alat": "reframe", "jalur": str(d / "out" / "jalur.json"), "kanvas": [1080, 1920], "fit": "isi"}}
        (d / "job.json").write_text(json.dumps(job), encoding="utf-8")
        import os
        env = {**os.environ, "MOTION_ENGINE_DATA": str(data)}
        r = subprocess.run([sys.executable, str(rilis / "pipeline" / "engine.py"), "visual", str(d)], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", env=env)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        rf = json.loads((d / "out" / "reframe.json").read_text(encoding="utf-8"))
        self.assertEqual(rf["schema"], "reframe/1")
        self.assertEqual(rf["keyframe_app"][0]["scale"], 1.0)  # tanpa subjek: tengah, fit isi = identitas
        self.assertEqual(sorted(p.name for p in data.iterdir()), ["konten"])  # tidak menulis apa pun ke folder data


if __name__ == "__main__":
    unittest.main()
