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
        k["id"], k["saran_buang"], k["teknis"], k["brand_lain"] = i, None, None, None
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


class KecualikanShot(unittest.TestCase):
    def test_broll_tidak_memakai_shot_dikecualikan(self):
        rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        x = {f"B#{i:02d}" for i in range(10)} | {"C#01", "C#03"}
        h = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3), kecuali=x)
        self.assertFalse({p["shot"] for p in h["potongan"]} & x)
        self.assertTrue(any(p["jenis"] == "broll" for p in h["potongan"]))

    def test_shot_kreator_dikecualikan_jadi_broll(self):
        rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        x = {f"A#{i:02d}" for i in range(10)}
        h = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3), kecuali=x)
        self.assertTrue(all(p["jenis"] == "broll" and p["footage"] != "A" for p in h["potongan"]))


class KalimatVarian(unittest.TestCase):
    def test_kalimat_dan_shot_per_kalimat(self):
        import perencana
        rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        h = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3))
        ks = perencana.kalimat_varian(rv["kalimat"], h)
        self.assertEqual(len(ks), len(rv["kalimat"]))
        self.assertEqual(ks[0]["dari"], 0)
        for k in ks:
            self.assertTrue(k["teks"] and k["shot"])
            self.assertLess(k["dari"], k["sampai"])
        semua = {p["shot"] or f"{p['footage']}@{p['in']:.1f}" for p in h["potongan"]}
        self.assertTrue({s for k in ks for s in k["shot"]} <= semua)


class DaftarBatch(unittest.TestCase):
    def test_hitung_dan_status(self):
        import json
        import tempfile
        import daftar
        with tempfile.TemporaryDirectory() as tmp:
            k = Path(tmp)
            (k / "1-upload" / "baru").mkdir(parents=True)
            (k / "1-upload" / "baru" / "a.mp4").write_bytes(b"x")
            d = k / "2-dipisah" / "lama"
            for sub, f in (("video-bisu", "a.mp4"), ("vokal", "a.wav"), ("musik", "a.wav")):
                (d / sub).mkdir(parents=True)
                (d / sub / f).write_bytes(b"x")
            (d / "shots.json").write_text(json.dumps({"shots": [{"id": "a#00", "thumb": "t.jpg"}, {"id": "a#01"}]}))
            lama_konten, daftar.KONTEN = daftar.KONTEN, k
            try:
                r = {x["batch"]: x for x in daftar.daftar()}
            finally:
                daftar.KONTEN = lama_konten
        self.assertEqual(r["baru"]["upload"], 1)
        self.assertFalse(r["baru"]["dipisah"])
        self.assertFalse(r["baru"]["siap_batch"])
        self.assertEqual((r["lama"]["footage"], r["lama"]["vo"], r["lama"]["jumlah_shot"], r["lama"]["thumb"]), (1, 1, 2, 1))
        self.assertTrue(r["lama"]["siap_batch"])


class JalurPortabel(unittest.TestCase):
    def test_venv_py_windows_dan_linux(self):
        import tempfile
        import jalur
        with tempfile.TemporaryDirectory() as tmp:
            lin = Path(tmp) / "lin"
            (lin / "bin").mkdir(parents=True)
            (lin / "bin" / "python").write_text("")
            win = Path(tmp) / "win"
            (win / "Scripts").mkdir(parents=True)
            (win / "Scripts" / "python.exe").write_text("")
            self.assertEqual(jalur.venv_py(lin), lin / "bin" / "python")
            self.assertEqual(jalur.venv_py(win), win / "Scripts" / "python.exe")

    def test_relatif_ke_root_pakai_garis_miring(self):
        import jalur
        r = jalur.relatif(jalur.KONTEN / "2-dipisah" / "b" / "thumb" / "x__00.jpg")
        self.assertEqual(r, "konten/2-dipisah/b/thumb/x__00.jpg")

    def test_nama_aman_diterima_app(self):
        import re
        import jalur
        pola = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
        for n in ("uji klip", "Video (1) #final", "...", "a" * 90, "dji_0017", "ÆØÅ ñ"):
            self.assertRegex(jalur.nama_aman(n), pola)
        self.assertEqual(jalur.nama_aman("dji_0017"), "dji_0017")
        self.assertEqual(jalur.nama_aman("uji klip"), "uji_klip")

    def test_nama_unik_tidak_saling_menimpa(self):
        import re
        import jalur
        pola = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
        panjang = "x" * 45
        stems = [panjang, panjang + "-2", "uji klip", "uji_klip", "Uji Klip", "dji_0017", "a" * 40, "a" * 40 + " b"]
        m = jalur.nama_unik(stems)
        self.assertEqual(len(set(v.lower() for v in m.values())), len(stems))
        for v in m.values():
            self.assertRegex(v, pola)
        self.assertEqual(m["dji_0017"], "dji_0017")  # nama yang sudah aman tidak berubah
        self.assertEqual(m["uji_klip"], "uji_klip")
        self.assertEqual(m["a" * 40], "a" * 40)

    def test_akhiran_tidak_terpotong(self):
        import jalur
        base = jalur.nama_aman("x" * 45)
        self.assertEqual(len(jalur.dengan_akhiran(base, 2)), 40)
        self.assertTrue(jalur.dengan_akhiran(base, 12).endswith("-12"))
        # Kasus temuan Jenius: hasil salinan kedua di jalankan_job tetap beda sesudah nama_aman.
        self.assertNotEqual(jalur.nama_aman(jalur.dengan_akhiran(base, 2)), base)


class BrandLain(unittest.TestCase):
    def setUp(self):
        import brand_lain
        self.bl = brand_lain
        # Nama brand diambil dari data (brand kit job + akun watermark), bukan dari kode.
        self.d = brand_lain.Pendeteksi(["Aysilla Factory", "@aysillafactoryid"],
                                       ["@aln_store.id", "@aysilla_factory", "@vionaputri_17", "Toko Kain Jaya"])

    def test_ejaan_whisper_nama_toko_lain(self):
        for t in ("Ini Loose Pants dari ALN Store, warnanya", "dari ILN Store. Aku mulai dari celana",
                  "Kenalin Loose Pants dari A .L .N. Store dengan", "Udah pasti, hanya di ILM Store.",
                  "celana dari A .L .A. Store ini", "Island Store. Aku udah taruh di keranjang.",
                  "Nama brandnya ALN Store. Nah", "beli di aln aja", "kain jaya juga bagus"):
            self.assertIsNotNone(self.d.cek(t), t)

    def test_brand_sendiri_dan_kata_umum_lolos(self):
        for t in ("Loose Pants dari Aysilla Factory adem banget", "cek di Aisila Factory ya",
                  "Langsung checkout di TikTok Shop", "ada di official store kami", "cek keranjang kuning sekarang",
                  "bahannya adem, jatuh, dan nggak nerawang", "beli di Play Store", "follow @aysillafactoryid",
                  "ini fashion store terbaik", "outfit shop murah", "cari di hijab store langganan",
                  "beli di distro shop dekat rumah", "grosir outlet tanah abang"):
            self.assertIsNone(self.d.cek(t), t)

    def test_akun_watermark_sendiri_tidak_dianggap_lain(self):
        self.assertNotIn(("aysilla",), self.d.lain)
        self.assertIn(("aln",), self.d.lain)

    def test_dari_job_baca_brandkit_lain(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            k = Path(tmp)
            (k / "a.json").write_text(json.dumps({"nama": "Aysilla Factory"}))
            (k / "b.json").write_text(json.dumps({"schema": "brand-kit-export/1", "brand": {"nama": "Kain Kita", "kode": "KK",
                                                                                         "handle": {"tiktok": "@kainkita.id"}}}))
            raw = {"schema": "brand-kit-export/1", "brand": {"nama": "Aysilla Factory", "kode": "AYS", "handle": {"tiktok": "@aysillafactoryid"}}}
            d = self.bl.dari_job(raw, {}, [], ["@aln_store.id"], brandkit_dir=k)
        self.assertIsNotNone(d.cek("celana dari Kain Kita"))
        self.assertIsNotNone(d.cek("dari ALN Store"))
        self.assertIsNone(d.cek("dari Aysilla Factory"))

    def test_nama_terpecah_di_batas_kalimat(self):
        # "dari A.L.A." | "Store ini sejak 2023" : Whisper memecah di titik singkatan.
        self.assertIsNone(self.d.cek("Nggak nyangka aku beli celana dari A.L.A."))
        self.assertIsNotNone(self.d.cek("Nggak nyangka aku beli celana dari A.L.A. Store ini sejak 2023"))

    def test_qc_gagal_kalau_brand_lain_lolos(self):
        import perencana
        v = {"durasi": 10.0, "hook": {"teks": "Celana adem", "dari": 0.0, "sampai": 2.0},
             "rv": {"kalimat": [{"teks": "Ini Loose Pants dari ALN Store"}]}}
        ops = [{"op": "add_clip", "track_kind": "text", "start_ms": 0, "duration_ms": 2000, "text": "Celana adem"}]
        q = perencana.qc(v, ops, None, {}, [], {}, self.d)
        cek = {c["cek"]: c for c in q["cek"]}
        self.assertFalse(cek["brand_lain"]["lulus"])
        self.assertFalse(q["lulus"])
        v["rv"]["kalimat"][0]["teks"] = "Loose Pants dari Aysilla Factory"
        self.assertTrue({c["cek"]: c for c in perencana.qc(v, ops, None, {}, [], {}, self.d)["cek"]}["brand_lain"]["lulus"])

    def test_kalimat_brand_lain_dibuang_dari_varian(self):
        v = vo_sintetis()
        v["kalimat"][1]["brand_lain"] = "brand lain: aln store"
        rv = vo.susun(v, random.Random(1))
        self.assertNotIn(v["kalimat"][1]["id"], [k["id"] for k in rv["kalimat"]])
        self.assertTrue(any(d["jenis"].startswith("brand lain") for d in rv["dibuang"]))


class TeksLatar(unittest.TestCase):
    def test_teks_kecil_atau_diam_satu_take_bukan_teks_bawaan(self):
        import importlib.util
        if importlib.util.find_spec("cv2") is None:
            self.skipTest("shotlib butuh OpenCV (Python Batch Remix)")
        import shotlib
        buku = {"teks": "VOGUE", "kotak": [0.77, 0.33, 0.07, 0.02]}
        caption = {"teks": "REVIEW JUJUR", "kotak": [0.1, 0.7, 0.8, 0.05]}
        poster = {"teks": "SALE", "kotak": [0.1, 0.2, 0.3, 0.05], "statis": True}
        self.assertTrue(shotlib.is_latar(buku, False))
        self.assertFalse(shotlib.is_latar(caption, True))
        self.assertTrue(shotlib.is_latar(poster, True))
        self.assertFalse(shotlib.is_latar(poster, False))


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


class ShotBeku(unittest.TestCase):
    """KORSET 14 Nov: footage A_18 diam 2,3-4,2 dtk -> render terlihat beku. Shot beku tidak dipakai."""

    def test_aturan_beku(self):
        from beku import shot_beku
        self.assertTrue(shot_beku(2.07, 4.13, [(2.31, 4.17)]))
        self.assertFalse(shot_beku(5.0, 8.0, [(7.8, 8.2)]))
        self.assertTrue(shot_beku(0.0, 1.0, [(0.5, 0.9)]))

    def test_matcher_melewati_shot_beku(self):
        import inspect
        import matcher
        src = inspect.getsource(matcher)
        self.assertEqual(src.count('not s.get("beku")'), 2)


if __name__ == "__main__":
    unittest.main()
