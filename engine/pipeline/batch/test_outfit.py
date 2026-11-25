"""Tes Beat Spot Ganti Outfit (§29). Jalankan (Python Batch: OpenCV + Pillow):
  <BATCH_PY> -m unittest pipeline/batch/test_outfit.py
Video & sound sintetis (ffmpeg), deteksi orang palsu; tanpa API, tanpa model.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import outfit  # noqa: E402


def ff(*a):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *a], check=True, stdin=subprocess.DEVNULL)


class Data:
    """Footage 1080x1920 (bergerak), sound klik 120 BPM, katalog 2 atasan + 2 bawahan."""

    def __init__(self, d: Path):
        from PIL import Image
        self.d = d
        self.vid = []
        for i, dur in enumerate((3.0, 1.8, 3.0)):
            p = d / f"f{i}.mp4"
            ff("-f", "lavfi", "-i", f"testsrc2=size=1080x1920:rate=30:duration={dur}", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p))
            self.vid.append(p)
        self.snd = d / "snd.wav"
        # Klik tajam tiap 0,5 dtk (120 BPM), mulai 0,25 dtk.
        ff("-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.012)\\,sin(2*PI*2000*t)\\,0)':s=22050:d=20", str(self.snd))
        kat = []
        for j, (jenis, nama, warna) in enumerate((("atasan", "Kemeja", [("biru", (120, 150, 230)), ("krem", (235, 215, 170))]),
                                                  ("bawahan", "Kulot", [("hitam", (20, 20, 20)), ("ivory", (240, 235, 220))]))):
            ws = []
            for wid, rgb in warna:
                im = Image.new("RGB", (400, 600), (255, 255, 255))
                im.paste(Image.new("RGB", (200, 400), rgb), (100, 100))
                f = d / f"{nama}-{wid}.png"
                im.save(f)
                ws.append({"id": wid, "nama": wid.title(), "path": str(f).replace("\\", "/")})
            kat.append({"id": nama.lower(), "nama": nama, "jenis": jenis, "deskripsi": "", "warna": ws})
        self.katalog = {"schema": "katalog-produk/1", "produk": kat}

    def job(self, nama: str, **o) -> Path:
        j = self.d / nama
        j.mkdir()
        (j / "katalog.json").write_text(json.dumps(self.katalog), encoding="utf-8")
        sumber = [{"kunci": f"$sumber:f{i}", "path": str(p)} for i, p in enumerate(self.vid)] + [{"kunci": "$sumber:snd", "path": str(self.snd)}]
        cfg = {"tahap": "siapkan", "sound": "$sumber:snd", "model_sendiri": True, "teks_atas": "uji", "seed": 1} | o
        (j / "job.json").write_text(json.dumps({"job_id": nama, "mode": "outfit", "katalog": "katalog.json", "sumber": sumber, "outfit": cfg}), encoding="utf-8")
        return j


def deteksi_palsu(video, tmp):
    """Satu orang di tengah, berjalan sedikit ke kanan, tinggi 45 % frame."""
    return [{"id": "person-1", "label": "person", "titik": [{"t": t / 6, "x": 0.35 + 0.01 * t / 6, "y": 0.35, "w": 0.2, "h": 0.45, "skor": 0.8} for t in range(0, 24)]}]


class GantiOutfit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="uji-outfit-"))
        cls.data = Data(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def siapkan(self, nama, **o):
        j = self.data.job(nama, **o)
        kode = outfit.jalankan(j, deteksi=deteksi_palsu)
        return j, kode

    def test_ketukan_presisi(self):
        bpm, k = outfit.ketukan_sound(self.data.snd)
        self.assertAlmostEqual(bpm, 120.0, delta=0.3)
        self.assertAlmostEqual(k[0], 0.25, delta=0.02)
        self.assertAlmostEqual(k[30] - k[0], 15.0, delta=0.03)  # tidak bergeser di akhir

    def test_tolak_tanpa_model_sendiri(self):
        j = self.data.job("tanpa_izin", model_sendiri=False)
        with self.assertRaises(outfit.Ditolak):
            outfit.jalankan(j, deteksi=deteksi_palsu)

    def test_tolak_lebih_dari_5(self):
        j = self.data.job("enam")
        d = json.loads((j / "job.json").read_text(encoding="utf-8"))
        d["sumber"] = [{"kunci": f"$sumber:x{i}", "path": str(self.data.vid[0])} for i in range(6)] + [{"kunci": "$sumber:snd", "path": str(self.data.snd)}]
        (j / "job.json").write_text(json.dumps(d), encoding="utf-8")
        with self.assertRaisesRegex(outfit.Ditolak, "maksimal 5"):
            outfit.jalankan(j, deteksi=deteksi_palsu)

    def test_usul_look_beda_tiap_footage(self):
        import random
        kat = {}
        for p in self.data.katalog["produk"]:
            for w in p["warna"]:
                kid = f"{p['id']}/{w['id']}"
                kat[kid] = {"id": kid, "produk": p["id"], "nama_produk": p["nama"], "jenis": p["jenis"], "deskripsi": "", "warna": w["nama"], "path": w["path"]}
        lk = outfit.usul_look(["a", "b"], kat, {}, random.Random(1))
        self.assertNotEqual(lk["a"]["atasan"]["id"], lk["b"]["atasan"]["id"])
        self.assertNotEqual(lk["a"]["bawahan"]["warna"], lk["b"]["bawahan"]["warna"])
        # Pilihan tim menang; null = tanpa ganti bawahan.
        lk = outfit.usul_look(["a"], kat, {"a": {"atasan": "kemeja/krem", "bawahan": None}}, random.Random(1))
        self.assertEqual(lk["a"]["atasan"]["id"], "kemeja/krem")
        self.assertIsNone(lk["a"]["bawahan"])
        self.assertEqual(lk["a"]["dipilih"], "tim")

    def test_bingkai_api_bolak_balik(self):
        import cv2
        import numpy as np
        d = self.tmp / "bolak"
        d.mkdir()
        f = d / "frame.png"
        ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=1", "-frames:v", "1", str(f))
        info = outfit.frame_api(f, d / "api.png")
        self.assertEqual(cv2.imread(str(d / "api.png")).shape[:2], (outfit.API_H, outfit.API_W))
        outfit.kembalikan_ukuran(d / "api.png", d / "balik.png", info["pad_kiri"], info["lebar_pad"])
        a, b = cv2.imread(str(f)).astype(float), cv2.imread(str(d / "balik.png")).astype(float)
        self.assertEqual(a.shape, b.shape)
        self.assertLess(np.abs(cv2.GaussianBlur(a, (0, 0), 3) - cv2.GaussianBlur(b, (0, 0), 3)).mean(), 6)  # tidak bergeser

    def test_hasil_9_16_diselaraskan(self):
        """beliapi mengembalikan 9:16 yang sedikit bergeser/membesar: tidak dipotong, lalu diselaraskan ke frame."""
        import cv2
        import numpy as np
        d = self.tmp / "selaras"
        d.mkdir()
        f = d / "frame.png"
        ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=1", "-frames:v", "1", str(f))
        a = cv2.imread(str(f))
        M = np.float32([[1.03, 0, -25], [0, 1.03, -40]])  # zoom 3 % + geser
        b = cv2.warpAffine(a, M, (1080, 1920), borderMode=cv2.BORDER_REPLICATE)
        cv2.imwrite(str(d / "api_hasil.png"), cv2.resize(b, (1536, 2752)))
        outfit.kembalikan_ukuran(d / "api_hasil.png", d / "diam.png", 100, 1280)
        self.assertEqual(cv2.imread(str(d / "diam.png")).shape[:2], (1920, 1080))
        sebelum = np.abs(cv2.imread(str(d / "diam.png")).astype(float) - a).mean()
        sel = outfit.selaraskan(f, d / "diam.png", {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.3})
        sesudah = np.abs(cv2.imread(str(d / "diam.png")).astype(float) - a).mean()
        self.assertTrue(sel["diselaraskan"], sel)
        self.assertLess(sesudah, sebelum / 3)

    def test_siapkan_lalu_rakit(self):
        import cv2
        import numpy as np
        j, kode = self.siapkan("alur")
        self.assertEqual(kode, 0)
        doc = json.loads((j / "out" / "outfit.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["status"], "menunggu_gambar")
        self.assertEqual(len(doc["items"]), 3)
        self.assertEqual([it["jalan"]["ketukan"] for it in doc["items"]], [4, 3, 4])  # footage 1,8 dtk -> 3 ketukan
        # Klip jalan tepat sejumlah frame segmennya; frame diam = frame terakhir klip.
        for it in doc["items"]:
            seg = next(s for s in doc["potongan"] if s["footage"] == it["footage"] and s["jenis"] == "jalan")
            n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames",
                                "-of", "csv=p=0", str(j / "out" / it["klip"])], capture_output=True, text=True).stdout.strip()
            self.assertEqual(int(n), seg["frame"] + 1)  # +1 frame cadangan (tidak tampil)
            self.assertIn("Change ONLY the clothes", it["prompt"])
            self.assertEqual(len(it["acuan_katalog"]), 2)
        # Batas potong menempel di grid ketukan (dibulatkan ke frame): selisih <= 1/60 dtk.
        k = doc["ketukan"]
        for s in doc["potongan"]:
            self.assertLessEqual(abs(s["frame_awal"] / 30 - k[s["ketukan_awal"]]), 1 / 60 + 1e-6)
        # "Gambar AI": frame + kotak warna di area baju (latar tetap) untuk 2 footage; footage 3 digeser (latar rusak).
        for i, it in enumerate(doc["items"]):
            api = cv2.imread(str(j / "out" / it["api"]["gambar"]))
            if i < 2:
                x0, x1 = int(0.45 * outfit.API_W), int(0.55 * outfit.API_W)
                api[int(0.45 * outfit.API_H):int(0.75 * outfit.API_H), x0:x1] = (30, 30, 30)
            else:
                api = np.roll(api, 120, axis=1)
            cv2.imwrite(str(j / "out" / it["hasil"]), api)
        r = self.data.job("alur_rakit", tahap="rakit", siapkan=str(j))
        self.assertEqual(outfit.jalankan(r), 0)
        hasil = json.loads((r / "out" / "outfit.json").read_text(encoding="utf-8"))
        qc = {it["footage"]: it["qc"] for it in hasil["items"]}
        self.assertTrue(qc["f0"]["lulus"], qc["f0"])
        lat = {c["cek"]: c["lulus"] for c in qc["f2"]["cek"]}
        self.assertFalse(lat["latar_tetap"])  # gambar yang bergeser ketahuan
        self.assertFalse(hasil["qc_lulus"])
        ops = json.loads((r / "out" / "ops.json").read_text(encoding="utf-8"))
        video = [o for o in ops["ops"] if o.get("track_kind") == "video"]
        self.assertEqual(len(video), 3 * 2 + 1)
        for a, b in zip(video, video[1:]):
            self.assertEqual(a["start_ms"] + a["duration_ms"], b["start_ms"])  # tanpa celah
        self.assertTrue(all(a["kunci"].startswith("$outfit:") and (r / a["path"]).exists() for a in ops["aset_lokal"]))
        musik = next(o for o in ops["ops"] if o.get("track_kind") == "music")
        self.assertEqual(musik["in_ms"], round(doc["sound_mulai_detik"] * 1000))
        self.assertTrue((r / "out" / "outfit" / "end_card.png").exists())
        for a in ops["aset_lokal"]:  # semua klip video (renderer: gambar hanya di track overlay)
            self.assertTrue(a["path"].endswith(".mp4"), a)
            info = outfit.probe(r / a["path"])
            o = next(x for x in video if x["media"] == a["kunci"])
            self.assertGreaterEqual(info["durasi"] * 1000 + 0.5, o["duration_ms"])
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from jaga_ops import validasi_motion_studio
        self.assertIsNone(validasi_motion_studio(r / "out" / "ops.json"))

    def test_rakit_tanpa_gambar_ditolak(self):
        j, kode = self.siapkan("kosong")
        self.assertEqual(kode, 0)
        r = self.data.job("kosong_rakit", tahap="rakit", siapkan=str(j))
        with self.assertRaisesRegex(outfit.Ditolak, "belum ada"):
            outfit.jalankan(r)


class PenutupBeatSpot(unittest.TestCase):
    """Beat Spot tahap 1: end card video tanpa durasi_ms (penutup pilihan job) tetap dipotong sepanjang filenya."""

    def test_durasi_file(self):
        import beatspot
        with tempfile.TemporaryDirectory() as d:
            v, g = Path(d) / "p.mp4", Path(d) / "p.png"
            ff("-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=1.37", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(v))
            ff("-f", "lavfi", "-i", "testsrc2=size=320x568:rate=1", "-frames:v", "1", str(g))
            self.assertAlmostEqual(beatspot.durasi_file_ms(v), 1370, delta=40)
            self.assertIsNone(beatspot.durasi_file_ms(g))  # gambar: panjang bebas
            self.assertIsNone(beatspot.durasi_file_ms(Path(d) / "tidak-ada.mp4"))
            ops, _, _ = beatspot.buat_ops([], None, 16.0, 18.0, {"penutup": {"aset": "$penutup", "detik": 2}, "aset": [{"kunci": "$penutup", "path": str(v)}]}, None, logo=False)
            pen = next(o for o in ops if o.get("media") == "$penutup")
            self.assertEqual(pen["duration_ms"], beatspot.durasi_file_ms(v) - 34)  # tidak melebihi file


if __name__ == "__main__":
    unittest.main()
