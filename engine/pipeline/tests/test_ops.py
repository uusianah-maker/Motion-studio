import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from ops import MIN_CLIP_MS, efek_video, susun  # noqa: E402

BK = {"warna": {"caption": "#FFFFFF", "outline": "#000000", "aksen": "#FFFFFF", "latar_gelap": "#000000"},
      "kapital": "kata_kunci", "superlatif_dilarang": ["termurah"], "logo": ""}


def contoh():
    caps = []
    t = 0
    for i, w in enumerate("Males nyetrika celana? Ini Loose Pants anti kusut, cek keranjang kuning sekarang!".split()):
        caps.append({"text": w, "startMs": t, "endMs": t + 350, "pageBreakAfter": i % 3 == 2, "emphasis": w in ("Loose", "Pants")})
        t += 400
    props = {
        "segments": [{"startFrame": 0, "endFrame": 120}, {"startFrame": 150, "endFrame": 300}],
        "captions": caps,
        "style": {"captionCenterY": 0.72},
        "hook": {"text": "Males nyetrika celana?", "startMs": 0, "endMs": 1200},
        "outroTagline": "Cek keranjang kuning sekarang",
        "outroSeconds": 2.5,
        "sfx": [],
        "framing": [{"atMs": 3000, "scale": 1.07, "mode": "cut"}],
        "zoomThroughs": [4000],
    }
    laporan = {"originalSec": 10.0, "originalMs": 10000, "totalWithOutroSec": 11.5, "removed": [], "kataKunci": [],
               "superlatifDisembunyikan": [], "doubts": [], "peringatan": [],
               "posisiCaption": {"y": 0.72, "kandidat": [{"y": 0.72, "kenaWajah": 0.0}]}}
    return props, laporan


class Ops(unittest.TestCase):
    def setUp(self):
        props, laporan = contoh()
        self.rencana, self.doc, self.qc = susun(props, laporan, BK, placement="tiktok", root=ROOT)
        self.ops = self.doc["ops"]

    def per_track(self, kind):
        return sorted((o for o in self.ops if o.get("track_kind") == kind), key=lambda o: o["start_ms"])

    def test_kanvas_dan_logo_di_awal(self):
        self.assertEqual(self.ops[0], {"op": "set_canvas", "ratio": "9:16"})
        self.assertEqual(self.ops[1]["op"], "set_brand_logo")

    def test_video_bersambung_dan_in_ms_dari_sumber(self):
        v = self.per_track("video")
        self.assertEqual([(o["start_ms"], o["in_ms"]) for o in v], [(0, 0), (4000, 5000)])
        self.assertEqual(v[0]["start_ms"] + v[0]["duration_ms"], v[1]["start_ms"])

    def test_tidak_ada_tumpang_tindih_dan_min_100ms(self):
        for kind in ("video", "subtitle", "text", "audio", "music", "sfx", "broll", "effects"):
            prev = -1
            for o in self.per_track(kind):
                self.assertGreaterEqual(o["start_ms"], prev, kind)
                self.assertGreaterEqual(o["duration_ms"], MIN_CLIP_MS)
                prev = o["start_ms"] + o["duration_ms"]

    def test_tidak_merujuk_clip_id_sendiri(self):
        self.assertFalse(any("clip_id" in o for o in self.ops))

    def test_semua_fitur_u3_dipakai(self):
        self.assertIn({"op": "set_loudness", "lufs": -14}, self.ops[:3])
        hook = [o for o in self.per_track("text") if o["start_ms"] == 0][0]
        self.assertGreater(hook["style"]["bg_blur"], 0)  # kotak kaca
        fx = self.per_track("effects")
        self.assertTrue(fx and all("effect" in o for o in fx))
        # Keluhan tim 24 Nov: zoom-through Generate = keyframe klip video (naik sebelum potong, turun sesudahnya, ease)
        kf = [k for o in self.per_track("video") for k in o.get("keyframes", [])]
        self.assertTrue(any(k["scale"] >= 1.3 and k["ease"] == "ease" for k in kf))
        self.assertIn("zoom_through", {e["jenis"] for e in self.rencana["efek"]})
        # yang tersisa hanya kekurangan data Brand Kit (aset penutup), bukan fitur Motion Studio
        self.assertTrue(all("penutup" in m for m in self.rencana["menunggu_u3"]))

    def test_kata_kunci_kapital(self):
        teks = " ".join(o["text"] for o in self.per_track("subtitle"))
        self.assertIn("LOOSE PANTS", teks)

    def test_cta_di_akhir_video(self):
        cta = [o for o in self.per_track("text") if o["text"].startswith("Cek")][0]
        v = self.per_track("video")[-1]
        self.assertEqual(cta["start_ms"] + cta["duration_ms"], v["start_ms"] + v["duration_ms"])
        # potongan terakhir sampai akhir sumber dipotong 1 frame (34 ms) supaya tidak melewati file
        self.assertEqual(v["in_ms"] + v["duration_ms"], 10000 - 34)

    def test_durasi_tanpa_batas_default(self):
        # keputusan owner 13 Nov 2026: durasi preset hanya saran, video 9 dtk tetap "siap"
        self.assertEqual(self.rencana["status"], "siap")
        self.assertIsNone(self.rencana["durasi"]["target"])
        self.assertEqual(self.rencana["durasi"]["saran"], [15, 30])
        self.assertTrue(next(b for b in self.qc["butir"] if b["butir"] == "durasi sesuai target")["lulus"])

    def test_batas_durasi_dari_job(self):
        props, laporan = contoh()
        rencana, _, qc = susun(props, laporan, BK, placement="tiktok", root=ROOT, batas_durasi=[15, 30])
        self.assertEqual(rencana["status"], "perlu_keputusan")
        self.assertFalse(qc["lulus"])

    def test_sfx_dan_penutup_dari_library_brand(self):
        props, laporan = contoh()
        props["sfx"] = [{"src": "sfx/pop.wav", "atMs": 1000, "volume": 0.35}, {"src": "sfx/whoosh.wav", "atMs": 4000, "volume": 0.3}]
        bk = dict(BK, sfx_dilarang=["kartun"], penutup={"aset": "$penutup:outro", "detik": 2.5}, aset=[
            {"kunci": "$sfx:pop-01", "jenis": "sfx", "tag": ["kata-kunci"], "lisensi_iklan": True, "durasi_ms": 180},
            {"kunci": "$sfx:boing", "jenis": "sfx", "tag": ["transisi", "kartun"], "lisensi_iklan": True, "durasi_ms": 400},
            {"kunci": "$sfx:swoosh", "jenis": "sfx", "tag": ["transisi"], "lisensi_iklan": False, "durasi_ms": 300},
            {"kunci": "$penutup:outro", "jenis": "penutup", "tag": [], "lisensi_iklan": True, "durasi_ms": 3000},
        ])
        rencana, doc, _ = susun(props, laporan, bk, placement="tiktok", root=ROOT)
        media = [o["media"] for o in doc["ops"] if "media" in o]
        self.assertIn("$sfx:pop-01", media)  # SFX brand bertag kata-kunci
        self.assertNotIn("$sfx:boing", media)  # dilarang (kartun)
        self.assertNotIn("$sfx:swoosh", media)  # tanpa lisensi iklan
        self.assertIn("$sfx:whoosh", [a["kunci"] for a in doc["aset_lokal"]])  # jatuh ke SFX bawaan mesin
        pen = [o for o in doc["ops"] if o.get("track_kind") == "broll"]
        v = self.per_track("video")[-1]
        self.assertEqual((pen[0]["start_ms"], pen[0]["duration_ms"]), (v["start_ms"] + v["duration_ms"], 2500))
        cta = [o for o in doc["ops"] if o.get("track_kind") == "text" and o["text"].startswith("Cek")][0]
        self.assertEqual(cta["start_ms"], pen[0]["start_ms"])
        self.assertFalse(any("penutup" in m for m in rencana["menunggu_u3"]))

    def test_musik_hanya_instrumental_berlisensi(self):
        props, laporan = contoh()
        props["sfx"] = [{"src": "sfx/pop.wav", "atMs": 1000, "volume": 0.35}]
        aset = [
            {"kunci": "$musik:lirik", "jenis": "musik", "tag": [], "lisensi_iklan": True, "instrumental": False, "durasi_ms": 60000},
            {"kunci": "$musik:unduhan", "jenis": "musik", "tag": [], "lisensi_iklan": False, "instrumental": True, "durasi_ms": 60000},
            {"kunci": "$musik:ceria", "jenis": "musik", "tag": ["pop-ceria"], "lisensi_iklan": True, "instrumental": True,
             "durasi_ms": 60000, "nama": "Pop Ceria", "sumber_lisensi": "Artlist"},
        ]
        rencana, doc, _ = susun(props, laporan, dict(BK, aset=aset), placement="tiktok", root=ROOT)
        audio = [o for o in doc["ops"] if o.get("track_kind") == "music"]
        self.assertEqual([o["media"] for o in audio], ["$musik:ceria"])
        self.assertLess(audio[0]["volume"], 0.3)
        sfx = [o for o in doc["ops"] if o.get("track_kind") == "sfx"]
        self.assertTrue(sfx and all("volume" in o for o in sfx))  # SFX di track sfx (U3a), bersamaan dengan musik
        self.assertEqual(rencana["audio"]["musik"], "Pop Ceria")
        _, doc2, _ = susun(props, laporan, dict(BK, aset=aset[:2]), placement="tiktok", root=ROOT)
        self.assertFalse([o for o in doc2["ops"] if o.get("track_kind") == "music"])

    def test_r8_fade_sambungan_dan_musik_ducking(self):
        props, laporan = contoh()
        aset = [{"kunci": "$musik:ceria", "jenis": "musik", "tag": ["pop-ceria"], "lisensi_iklan": True,
                 "instrumental": True, "durasi_ms": 60000, "nama": "Pop Ceria", "sumber_lisensi": "Artlist"}]
        _, doc, _ = susun(props, laporan, dict(BK, aset=aset), placement="tiktok", root=ROOT)
        video = [o for o in doc["ops"] if o.get("track_kind") == "video"]
        self.assertNotIn("fade_in_ms", video[0])  # awal video tidak di-fade
        self.assertNotIn("fade_out_ms", video[-1])
        if len(video) > 1:
            self.assertEqual(video[1]["fade_in_ms"], 20)
            self.assertEqual(video[0]["fade_out_ms"], 20)
        musik = [o for o in doc["ops"] if o.get("track_kind") == "music"][0]
        self.assertGreater(musik["fade_in_ms"], 0)
        self.assertGreater(musik["fade_out_ms"], 0)
        self.assertIn({"op": "set_ducking", "on": True, "level": 0.3}, doc["ops"])
        _, doc2, _ = susun(props, laporan, BK, placement="tiktok", root=ROOT)
        self.assertFalse([o for o in doc2["ops"] if o["op"] == "set_ducking"])  # tanpa musik: tanpa ducking

    def test_r3_cta_kosong_diberi_peringatan(self):
        props, laporan = contoh()
        props["outroTagline"] = ""
        rencana, _, _ = susun(props, laporan, BK, placement="tiktok", root=ROOT)
        self.assertTrue(any(p["jenis"] == "cta" for p in rencana["peringatan"]))
        self.assertFalse(any("CTA ditampilkan" in m for m in rencana["menunggu_u3"]))

    def test_r18_preset_gaya_caption_hook_watermark_endcard(self):
        props, laporan = contoh()
        preset = {"caption": {"warna": "#F5EFA0", "kotak": False}, "hook": {"ukuran": 4.5, "warna": "#111111"},
                  "penutup": {"end_card": True}}
        bk = dict(BK, watermark={"teks": "AYSILLA FACTORY", "y": 0.07, "lebar": 0.25})
        rencana, doc, _ = susun(props, laporan, bk, placement="tiktok", root=ROOT, preset=preset)
        sub = [o for o in doc["ops"] if o.get("track_kind") == "subtitle"]
        self.assertTrue(sub and all(o["style"]["color"] == "#f5efa0" for o in sub))
        teks = [o for o in doc["ops"] if o.get("track_kind") == "text"]
        hook = [o for o in teks if o["start_ms"] == 0 and o["text"] != "AYSILLA FACTORY"][0]
        self.assertEqual((hook["style"]["size"], hook["style"]["color"]), (8.0, "#111111"))
        self.assertTrue(any(o["text"] == "AYSILLA FACTORY" for o in teks))
        self.assertTrue(any(p["jenis"] == "penutup" for p in rencana["peringatan"]))
        # Tanpa preset: perilaku lama.
        rencana2, doc2, _ = susun(props, laporan, BK, placement="tiktok", root=ROOT)
        self.assertFalse(any(p["jenis"] == "penutup" for p in rencana2["peringatan"]))
        self.assertFalse(any(o.get("text") == "AYSILLA FACTORY" for o in doc2["ops"]))

    def test_r18_punch_in_memecah_shot_panjang(self):
        from ops import punch_in
        klip = [{"start_ms": 0, "duration_ms": 9000}, {"start_ms": 9000, "duration_ms": 2000}]
        fr = punch_in([], klip, 3500)
        self.assertEqual([f["scale"] for f in fr], [1.1, 1.0])  # 9 dtk > 3,5 dtk: 2 titik, kembali normal
        self.assertTrue(all(0 < f["atMs"] < 9000 for f in fr))
        self.assertEqual(punch_in([{"atMs": 1000, "scale": 1.2}], klip, 3500), [{"atMs": 1000, "scale": 1.2}])

    def test_efek_video_tidak_tumpang_tindih(self):
        fr = [{"atMs": 0, "scale": 1.07, "mode": "cut"}, {"atMs": 3000, "scale": 1.0, "mode": "cut"},
              {"atMs": 6000, "scale": 1.1, "mode": "smooth"}]
        fx = efek_video(fr, [2000, 7000], 9000)
        prev = 0
        for a, b, e in fx:
            self.assertGreaterEqual(a, prev)
            self.assertGreaterEqual(b - a, MIN_CLIP_MS)
            prev = b
        self.assertEqual([e["type"] for _, _, e in fx].count("zoom_through"), 2)
        self.assertFalse(any(a < 6000 and b > 3000 and e["type"] == "zoom" for a, b, e in fx))  # skala 1.0 = tanpa zoom

    def test_highlight_kotak_kalau_aksen_sama_dengan_caption(self):
        hl = [o["style"]["highlight"] for o in self.per_track("subtitle") if "highlight" in o["style"]]
        self.assertTrue(hl and all(h["box"] for h in hl))  # BK: aksen == caption (#ffffff)

    def test_caption_per_kata_u3b(self):
        subs = self.per_track("subtitle")
        for o in subs:
            self.assertEqual(o["style"]["anim"], "pop")
            self.assertEqual(o["text"], " ".join(w["text"] for w in o["words"]))
            prev = 0
            for w in o["words"]:
                self.assertNotIn(" ", w["text"])
                self.assertGreaterEqual(w["start_ms"], prev)
                self.assertLessEqual(w["start_ms"], w["end_ms"])
                self.assertLessEqual(w["end_ms"], o["duration_ms"])
                prev = w["end_ms"]
        hl = [o["style"]["highlight"]["words"] for o in subs if "highlight" in o["style"]]
        self.assertIn(["loose", "pants"], hl)  # kata kunci per kata, huruf kecil tanpa tanda baca


if __name__ == "__main__":
    unittest.main()
