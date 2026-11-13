"""Uji modul Batch Remix: .venv/Scripts/python -m unittest pipeline/batch/test_batch.py"""

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import alasan_buang, kalimat  # noqa: E402
import matcher  # noqa: E402
import vo  # noqa: E402


def kata(teks, mulai=0.0, step=0.4):
    return [{"text": t, "startMs": int((mulai + i * step) * 1000), "endMs": int((mulai + (i + 1) * step) * 1000), "prob": 0.9}
            for i, t in enumerate(teks.split())]


class Kalimat(unittest.TestCase):
    def test_singkatan_digabung(self):
        ks = kalimat(kata("Kenalin Loose Pants dari A .L .N. Store ini."))
        self.assertIn("A.L.N.", ks[0]["teks"])

    def test_pecah_di_titik(self):
        self.assertEqual(len(kalimat(kata("Satu dua. Tiga empat?"))), 2)


class AlasanBuang(unittest.TestCase):
    def test_urgensi(self):
        self.assertEqual(alasan_buang("Cek sekarang sebelum kehabisan.", []), "urgensi")

    def test_superlatif(self):
        self.assertEqual(alasan_buang("Ini celana paling nyaman.", []), "superlatif")

    def test_musiman(self):
        self.assertEqual(alasan_buang("Cocok buat buber dan silaturahmi.", []), "musiman")

    def test_terlarang_brand(self):
        self.assertTrue(alasan_buang("Ini termurah se-Indonesia.", []).startswith("kata terlarang"))

    def test_kalimat_biasa(self):
        self.assertIsNone(alasan_buang("Bahannya adem dan jatuh.", []))


class Judul(unittest.TestCase):
    def test_berhenti_di_koma(self):
        self.assertEqual(vo.judul_hook(kata("Beneran deh, berasa gak pake celana.")), "Beneran deh, berasa gak pake celana")

    def test_tidak_berakhir_kata_gantung(self):
        self.assertEqual(vo.judul_hook(kata("Akhirnya aku nemuin Loose Pants High Waist yang bakal")), "Akhirnya aku nemuin Loose Pants")


def lib_sintetis():
    shots = []
    for f in ("A", "B", "C"):
        for i in range(10):
            shots.append({"id": f"{f}#{i:02d}", "footage": f, "dari": i * 3.0, "sampai": i * 3.0 + 3.0,
                          "framing": "closeup_produk" if f != "A" else "medium", "wajah_bicara": f == "A",
                          "teks_bawaan": f == "C" and i == 0, "buram": False, "tag": ["bahan"] if i % 2 else [], "teks": []})
    wm = {"tiktok": True, "pindah_detik": 5.0, "kotak_awal": [0, .4, .3, .5], "kotak_akhir": [.7, .6, 1, .8],
          "footer": False, "kotak_footer": [0, .93, 1, .98]}
    return {"footage": {f: {"durasi": 30.0, "watermark": wm} for f in ("A", "B", "C")}, "shots": shots}


def vo_sintetis():
    ks = kalimat(kata("Bahannya adem banget dan jatuh. " * 3 + "Modelnya high waist rapi sekali deh. "
                      "Kalau mau langsung cek keranjang kuning ya.", step=0.45))
    for i, k in enumerate(ks):
        k["id"], k["saran_buang"], k["teknis"] = i, None, None
    return {"id": "A", "kalimat": ks, "durasi": 30.0}


class Matcher(unittest.TestCase):
    def setUp(self):
        self.rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        self.hasil = matcher.susun_shot(self.rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3), beats=[x * 0.5 for x in range(80)])

    def test_tanpa_celah_dan_tanpa_kedip(self):
        ps = self.hasil["potongan"]
        self.assertEqual(ps[0]["start"], 0)
        for a, b in zip(ps, ps[1:]):
            self.assertAlmostEqual(a["start"] + a["dur"], b["start"], places=2)
        self.assertGreaterEqual(min(p["dur"] for p in ps), 1.0)
        self.assertAlmostEqual(ps[-1]["start"] + ps[-1]["dur"], self.hasil["durasi"], places=2)

    def test_broll_aman(self):
        lib = lib_sintetis()
        by = {s["id"]: s for s in lib["shots"]}
        for p in self.hasil["potongan"]:
            if p["jenis"] == "broll":
                self.assertFalse(by[p["shot"]]["wajah_bicara"])
                self.assertFalse(by[p["shot"]]["teks_bawaan"])
                self.assertNotEqual(p["footage"], "A")

    def test_sinkron_bibir(self):
        # Potongan sinkron: waktu sumber = waktu ucapan VO di detik yang sama.
        for p in self.hasil["potongan"]:
            if p["jenis"] != "sinkron":
                continue
            vk = max((v for v in self.hasil["vo_klip"] if v["start"] <= p["start"] + 1e-6), key=lambda v: v["start"])
            self.assertAlmostEqual(p["in"] - vk["in"], p["start"] - vk["start"], places=2)

    def test_hook_dan_cta_sinkron(self):
        ps = self.hasil["potongan"]
        self.assertEqual(ps[0]["jenis"], "sinkron")
        self.assertEqual(ps[-1]["jenis"], "sinkron")

    def test_blur_watermark_pindah(self):
        b = matcher._blur_watermark(lib_sintetis()["footage"]["A"], 4.0, 7.0)
        self.assertEqual(len(b), 2)


def vo_dengan_saran():
    v = vo_sintetis()
    v["kalimat"][1]["saran_buang"] = "urgensi"
    v["kalimat"][2]["saran_buang"] = "kata terlarang: termurah"
    return v


class TanpaBatas(unittest.TestCase):
    """Keputusan owner: default tidak ada kalimat VO yang dibuang dan tanpa batas durasi."""

    def test_default_semua_kalimat_dipakai(self):
        v = vo_dengan_saran()
        rv = vo.susun(v, random.Random(0))
        self.assertEqual(len(rv["kalimat"]), len(v["kalimat"]))
        self.assertEqual(rv["dibuang"], [])
        self.assertEqual({s["jenis"] for s in rv["saran_buang"]}, {"urgensi", "kata terlarang: termurah"})

    def test_buang_otomatis_kalau_dinyalakan(self):
        rv = vo.susun(vo_dengan_saran(), random.Random(0), None, {"urgensi", "superlatif"})
        self.assertEqual({d["jenis"] for d in rv["dibuang"]}, {"urgensi", "kata terlarang: termurah"})

    def test_potongan_teknis_tetap_dibuang(self):
        v = vo_sintetis()
        v["kalimat"][1]["teknis"] = "terlalu_pendek"
        rv = vo.susun(v, random.Random(0))
        self.assertEqual(len(rv["kalimat"]), len(v["kalimat"]) - 1)


class SusunVO(unittest.TestCase):
    def test_hook_dan_cta_tidak_dibuang(self):
        v = vo_sintetis()
        rv = vo.susun(v, random.Random(0), (5, 8))
        self.assertEqual(rv["kalimat"][0]["id"], 0)
        self.assertIn("cta", rv["kalimat"][-1]["topik"])


if __name__ == "__main__":
    unittest.main()
