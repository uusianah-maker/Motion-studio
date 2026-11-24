"""§26 Video Iklan dengan banyak footage: gabung berurutan jadi satu video yang seragam."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PIPE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPE))
import engine  # noqa: E402
import gabung  # noqa: E402


def buat(path: Path, ukuran: str, fps: int, dtk: float, suara: str | None) -> Path:
    """Video uji. suara: None (bisu) atau 'rate:ch' mis. '44100:1'."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={ukuran}:rate={fps}:duration={dtk}"]
    if suara:
        rate, ch = suara.split(":")
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={rate}:duration={dtk}", "-ac", ch]
    cmd += ["-pix_fmt", "yuv420p", "-shortest", str(path)]
    subprocess.run(cmd, check=True)
    return path


def probe(path: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "stream=codec_type,width,height,r_frame_rate,sample_rate,channels,duration:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


class Gabung(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = Path(tempfile.mkdtemp())
        cls.a = buat(cls.d / "Konten 1 (1).mp4", "1080x1920", 30, 2.0, "48000:2")
        cls.b = buat(cls.d / "Konten 2 (2).mp4", "720x1280", 25, 1.5, None)  # bisu, resolusi & fps lain
        cls.c = buat(cls.d / "Konten 3 (1).mp4", "1920x1080", 60, 2.5, "44100:1")  # mendatar, mono 44,1 kHz

    def job(self, *paths):
        return {"sumber": [{"kunci": f"$sumber:f{i + 1:02d}", "path": str(p)} for i, p in enumerate(paths)]}

    def test_satu_footage_perilaku_lama(self):
        self.assertIsNone(gabung.gabung({"sumber": [{"kunci": "$sumber", "path": str(self.a)}]}, self.d / "o1"))
        video, gab = engine.sumber_video({"sumber": [{"kunci": "$sumber", "path": str(self.a)}]}, self.d / "o1", True)
        self.assertEqual((video, gab), (self.a, None))

    def test_urutan_daftar_dan_vo_tidak_ikut(self):
        job = self.job(self.c, self.a)
        job["sumber"].append({"kunci": "$vo:x", "path": str(self.a)})
        self.assertEqual([s["kunci"] for s in gabung.daftar_footage(job)], ["$sumber:f01", "$sumber:f02"])

    def test_gabung_tiga_footage_seragam_dan_durasi_pas(self):
        out = self.d / "o3"
        h = gabung.gabung(self.job(self.b, self.a, self.c), out, log=lambda *_: None)
        self.assertEqual([b["nama"] for b in h["bagian"]], ["Konten 2 (2).mp4", "Konten 1 (1).mp4", "Konten 3 (1).mp4"])
        mulai = [b["mulai_ms"] for b in h["bagian"]]
        self.assertEqual(mulai[0], 0)
        for m, harap in zip(mulai[1:], (1500, 3500)):
            self.assertAlmostEqual(m, harap, delta=40)  # 25 fps -> frame 30 fps terdekat
        self.assertEqual([b["suara"] for b in h["bagian"]], [False, True, True])
        self.assertAlmostEqual(h["durasi"], 6.0, delta=0.05)
        info = probe(out / "gabungan.mp4")
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = next(s for s in info["streams"] if s["codec_type"] == "audio")
        self.assertEqual((v["width"], v["height"], v["r_frame_rate"]), (1080, 1920, "30/1"))
        self.assertEqual((a["sample_rate"], a["channels"]), ("48000", 2))
        self.assertAlmostEqual(float(v["duration"]), 6.0, delta=0.05)
        self.assertAlmostEqual(float(a["duration"]), float(v["duration"]), delta=0.06)  # suara tidak bergeser
        self.assertEqual(json.loads((out / "gabungan.json").read_text(encoding="utf-8"))["sidik"], h["sidik"])

    def test_dipakai_ulang_bila_sama_digabung_lagi_bila_urutan_berubah(self):
        out = self.d / "o4"
        pesan = []
        gabung.gabung(self.job(self.a, self.b), out, log=pesan.append)
        t0 = (out / "gabungan.mp4").stat().st_mtime_ns
        gabung.gabung(self.job(self.a, self.b), out, log=pesan.append)
        self.assertEqual((out / "gabungan.mp4").stat().st_mtime_ns, t0)
        self.assertTrue(any("dipakai ulang" in p for p in pesan))
        h = gabung.gabung(self.job(self.b, self.a), out, log=pesan.append)
        self.assertEqual(h["bagian"][0]["nama"], "Konten 2 (2).mp4")

    def test_semua_bisu_ditolak_kecuali_vo(self):
        job = self.job(self.b, self.b)
        with self.assertRaises(gabung.Ditolak):
            engine.sumber_video(job, self.d / "o5", butuh_suara=True)
        video, gab = engine.sumber_video(job, self.d / "o5", butuh_suara=False)
        self.assertEqual(video.name, "gabungan.mp4")
        self.assertAlmostEqual(gab["durasi"], 2 * 46 / 30, delta=0.002)  # 1,52 dtk -> 46 frame @30 fps, dua kali

    def test_file_rusak_dan_kebanyakan_ditolak(self):
        rusak = self.d / "rusak.mp4"
        rusak.write_bytes(b"bukan video")
        with self.assertRaises(gabung.Ditolak):
            gabung.gabung(self.job(self.a, rusak), self.d / "o6")
        with self.assertRaises(gabung.Ditolak):
            gabung.gabung(self.job(*([self.a] * (gabung.MAKS_FOOTAGE + 1))), self.d / "o6")

    def test_pasang_di_ops_ganti_sumber_dan_aset_lokal(self):
        out = self.d / "o7"
        out.mkdir()
        (out / "ops.json").write_text(json.dumps({"schema": "ms-ops/1", "aset_lokal": [{"kunci": "$sfx:pop", "path": "p.wav"}],
                                                  "ops": [{"op": "add_clip", "track_kind": "video", "media": "$sumber", "start_ms": 0},
                                                          {"op": "add_clip", "track_kind": "sfx", "media": "$sfx:pop"}]}), encoding="utf-8")
        (out / "rencana.json").write_text(json.dumps({"status": "siap"}), encoding="utf-8")
        h = {"kunci": gabung.KUNCI, "path": "J/out/gabungan.mp4", "bagian": [], "durasi": 6.0, "kanvas": [1080, 1920], "fps": 30}
        self.assertEqual(gabung.pasang_di_ops(out, h), 1)
        doc = json.loads((out / "ops.json").read_text(encoding="utf-8"))
        self.assertEqual([o["media"] for o in doc["ops"]], ["$gabungan:video", "$sfx:pop"])
        self.assertEqual(doc["aset_lokal"][-1], {"kunci": "$gabungan:video", "path": "J/out/gabungan.mp4"})
        self.assertEqual(json.loads((out / "rencana.json").read_text(encoding="utf-8"))["sumber_gabungan"]["durasi"], 6.0)


if __name__ == "__main__":
    unittest.main()
