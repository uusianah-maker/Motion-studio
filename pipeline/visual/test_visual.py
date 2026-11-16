"""Tes R24 Visual Tools (tanpa dependensi): .venv/Scripts/python -m unittest pipeline/visual/test_visual.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jalur_posisi as jp  # noqa: E402
import reframe as rf  # noqa: E402


def doc_jalur(titik, jenis="wajah", lebar=1920, tinggi=1080, durasi=None):
    j = {"id": f"{jenis}-1", "jenis": jenis, "label": "face", "titik": titik}
    return {"schema": jp.SCHEMA, "video": "x.mp4", "lebar": lebar, "tinggi": tinggi, "fps": 30.0,
            "durasi": durasi if durasi is not None else titik[-1]["t"], "sumber": "manual", "usulan": True, "jalur": [j]}


class JalurPosisi(unittest.TestCase):
    def test_titik_dijepit_ke_frame(self):
        p = jp.titik(0, -0.1, 0.9, 0.3, 0.3)
        self.assertEqual((p["x"], p["y"]), (0.0, 0.9))
        self.assertAlmostEqual(p["w"], 0.2)
        self.assertAlmostEqual(p["h"], 0.1)

    def test_validasi(self):
        d = doc_jalur([jp.titik(0, .1, .1, .2, .2), jp.titik(1, .2, .1, .2, .2)])
        self.assertEqual(jp.validasi(d), [])
        d["jalur"][0]["titik"][1]["t"] = 0
        self.assertTrue(any("naik" in s for s in jp.validasi(d)))

    def test_interpolasi_dan_celah(self):
        j = doc_jalur([jp.titik(0, 0, 0, .2, .2), jp.titik(.4, .4, 0, .2, .2), jp.titik(2, .4, 0, .2, .2)])["jalur"][0]
        self.assertAlmostEqual(jp.kotak_di(j, .2)[0], .2)
        self.assertIsNone(jp.kotak_di(j, 1.0))   # celah 1,6 dtk > MAKS_CELAH = subjek hilang
        self.assertIsNotNone(jp.kotak_di(j, 2.0))
        self.assertIsNone(jp.kotak_di(j, 3.0))

    def test_gabung_deteksi_memberi_id_stabil(self):
        per = [(t / 10, [(0.1 + t * 0.005, 0.2, 0.1, 0.1, 0.9), (0.7, 0.2, 0.1, 0.1, 0.8)]) for t in range(10)]
        jalur = jp.gabung_deteksi(per, "wajah", "face", "wajah")
        self.assertEqual(len(jalur), 2)
        self.assertEqual([len(j["titik"]) for j in jalur], [10, 10])
        self.assertLess(jalur[0]["titik"][0]["x"], 0.5)

    def test_subjek_utama_yang_dominan(self):
        d = doc_jalur([jp.titik(0, .1, .1, .1, .1), jp.titik(5, .1, .1, .1, .1)])
        d["jalur"].append({"id": "objek-1", "jenis": "objek", "label": "person",
                           "titik": [jp.titik(0, .5, .1, .4, .8), jp.titik(5, .5, .1, .4, .8)]})
        self.assertEqual(jp.subjek_utama(d)["id"], "objek-1")


class Reframe(unittest.TestCase):
    def test_ukuran_crop(self):
        cw, ch = rf.ukuran_crop(1920, 1080, (9, 16))
        self.assertAlmostEqual(cw, 1080 * 9 / 16 / 1920)
        self.assertEqual(ch, 1.0)
        self.assertEqual(rf.ukuran_crop(1080, 1920, (9, 16)), (1.0, 1.0))
        cw, ch = rf.ukuran_crop(1080, 1920, (1, 1))
        self.assertEqual(cw, 1.0)
        self.assertAlmostEqual(ch, 1080 / 1920)

    def test_subjek_diam_satu_keyframe(self):
        d = doc_jalur([jp.titik(t / 10, .70 + (t % 3) * .005, .2, .1, .15) for t in range(50)])
        out = rf.reframe(d)
        self.assertEqual(out["mode"], "diam")
        self.assertEqual(len(out["keyframe"]), 1)
        cx = out["keyframe"][0]["x"] + out["lebar_crop"] / 2
        self.assertAlmostEqual(cx, .755, delta=.02)   # wajah di tengah jendela
        self.assertTrue(out["usulan"])

    def test_subjek_berjalan_diikuti_halus(self):
        d = doc_jalur([jp.titik(t / 10, .05 + t * .008, .2, .1, .15) for t in range(100)])  # 10 dtk kiri->kanan
        out = rf.reframe(d)
        self.assertEqual(out["mode"], "ikut")
        kf = out["keyframe"]
        self.assertLess(len(kf), 30)                        # sedikit keyframe, enak diedit
        xs = [k["x"] for k in kf]
        self.assertEqual(xs, sorted(xs))                    # tidak bolak-balik
        self.assertTrue(all(0 <= x <= 1 - out["lebar_crop"] + 1e-4 for x in xs))
        for a, b in zip(kf, kf[1:]):                        # pan tidak melebihi batas kecepatan
            self.assertLessEqual(abs(b["x"] - a["x"]) / (b["t"] - a["t"]), rf.MAKS_PAN + 1e-3)
        # subjek tetap di dalam jendela sepanjang klip
        for t in range(0, 100, 5):
            x, _ = rf.posisi_di(out, t / 10)
            k = jp.kotak_di(d["jalur"][0], t / 10)
            self.assertTrue(x - 0.02 <= k[0] + k[2] / 2 <= x + out["lebar_crop"] + 0.02, t)

    def test_tanpa_subjek_tengah(self):
        d = doc_jalur([jp.titik(0, .1, .1, .1, .1)])
        d["jalur"] = []
        d["durasi"] = 3
        out = rf.reframe(d)
        self.assertEqual(out["mode"], "tengah")
        self.assertAlmostEqual(out["keyframe"][0]["x"], (1 - out["lebar_crop"]) / 2, places=3)

    def test_sumber_sudah_916(self):
        d = doc_jalur([jp.titik(0, .1, .1, .1, .1), jp.titik(1, .8, .1, .1, .1)], lebar=1080, tinggi=1920)
        self.assertEqual(rf.reframe(d)["mode"], "tengah")


def titik_kanvas(u, v, sumber, kanvas, fit, kf):
    """Simulasi render app (render.ts fit + keyframes.ts overlay): titik sumber (pecahan) -> piksel kanvas."""
    (sw, sh), (W, H) = sumber, kanvas
    f = (max if fit == "isi" else min)(W / sw, H / sh)
    dw, dh = sw * f, sh * f
    return (W / 2 + kf["scale"] * dw * (u - 0.5) + kf["x"] * W, H / 2 + kf["scale"] * dh * (v - 0.5) + kf["y"] * H)


class KeyframeApp(unittest.TestCase):
    def _cek_memenuhi(self, sumber, kanvas, fit, x0):
        rasio = (9, 16) if kanvas[0] < kanvas[1] else (16, 9)
        cw, ch = rf.ukuran_crop(*sumber, rasio)
        r = {"lebar_crop": cw, "tinggi_crop": ch, "keyframe": [{"t": 1.5, "x": x0, "y": 0.0}]}
        kf = rf.ke_keyframe_app(r, sumber, kanvas, fit=fit, awal_ms=500)[0]
        self.assertEqual(kf["at_ms"], 1000)
        kiri_atas = titik_kanvas(x0, 0, sumber, kanvas, fit, kf)
        kanan_bawah = titik_kanvas(x0 + cw, ch, sumber, kanvas, fit, kf)
        self.assertAlmostEqual(kiri_atas[0], 0, delta=3)        # 3 px: pembulatan 3 desimal di app
        self.assertAlmostEqual(kiri_atas[1], 0, delta=3)
        self.assertAlmostEqual(kanan_bawah[0], kanvas[0], delta=3)
        self.assertAlmostEqual(kanan_bawah[1], kanvas[1], delta=3)
        return kf

    def test_169_ke_916_pas_dan_isi(self):
        for fit in ("pas", "isi"):
            for x0 in (0.1, 0.34, 0.6):
                kf = self._cek_memenuhi((1920, 1080), (1080, 1920), fit, x0)
                self.assertTrue(-1 <= kf["x"] <= 1 and 0.1 <= kf["scale"] <= 4)
        self.assertAlmostEqual(rf.ke_keyframe_app({"lebar_crop": .3164, "tinggi_crop": 1, "keyframe": [{"t": 0, "x": .3418, "y": 0}]},
                                                  (1920, 1080), (1080, 1920), "isi")[0]["scale"], 1.0, places=2)

    def test_tengah_identitas_di_isi(self):
        cw, _ = rf.ukuran_crop(1920, 1080, (9, 16))
        kf = rf.ke_keyframe_app({"lebar_crop": cw, "tinggi_crop": 1.0, "keyframe": [{"t": 0, "x": (1 - cw) / 2, "y": 0}]},
                                (1920, 1080), (1080, 1920), "isi")[0]
        self.assertEqual((kf["x"], kf["y"], kf["scale"]), (0, 0, 1))

    def test_pinggir_dipotong_ke_batas_app_tanpa_bolong(self):
        cw, ch = rf.ukuran_crop(1920, 1080, (9, 16))
        kf = rf.ke_keyframe_app({"lebar_crop": cw, "tinggi_crop": ch, "keyframe": [{"t": 0, "x": 0.0, "y": 0}]},
                                (1920, 1080), (1080, 1920), "pas")[0]
        self.assertEqual(kf["x"], 1.0)  # seharusnya 1,08: dipotong
        kiri = titik_kanvas(0, 0, (1920, 1080), (1080, 1920), "pas", kf)[0]
        self.assertLessEqual(kiri, 0.5)  # tepi kiri sumber tetap di luar/tepat di kiri kanvas: tidak ada bolong hitam

    def test_maks_20_keyframe(self):
        import math
        d = doc_jalur([jp.titik(t / 10, .4 + .35 * math.sin(t / 7), .2, .1, .15) for t in range(600)])  # 60 dtk zig-zag
        out = rf.reframe(d)
        self.assertLessEqual(len(out["keyframe"]), rf.MAKS_KEYFRAME)


if __name__ == "__main__":
    unittest.main()
