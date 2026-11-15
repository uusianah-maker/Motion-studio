"""Uji modul Batch Remix: .venv/Scripts/python -m unittest pipeline/batch/test_batch.py"""

import json
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

    def test_pembuka_bukan_video_asli(self):
        # Owner 14 Nov: detik pertama tidak boleh sama dengan video asli -> pembuka selalu b-roll.
        for seed in range(8):
            h = matcher.susun_shot(self.rv, lib_sintetis(), {"A", "B", "C"}, random.Random(seed))
            self.assertEqual(h["potongan"][0]["jenis"], "broll")
            self.assertNotEqual(h["potongan"][0]["footage"], "A")

    def test_porsi_footage_asli_dibatasi(self):
        for seed in range(8):
            h = matcher.susun_shot(self.rv, lib_sintetis(), {"A", "B", "C"}, random.Random(seed))
            self.assertLessEqual(h["rasio_sinkron"], matcher.MAKS_SINKRON + 0.01)

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


class RiwayatLintasBatch(unittest.TestCase):
    """R6: konten yang sudah dipakai tidak dipakai berulang, termasuk antar batch (owner 15 Nov no. 16)."""

    def setUp(self):
        import os
        import tempfile
        import riwayat
        self.r = riwayat
        self.tmp = tempfile.TemporaryDirectory()
        self._lama = os.environ.get("MOTION_RIWAYAT_DIR")
        os.environ["MOTION_RIWAYAT_DIR"] = self.tmp.name

    def tearDown(self):
        import os
        if self._lama is None:
            os.environ.pop("MOTION_RIWAYAT_DIR", None)
        else:
            os.environ["MOTION_RIWAYAT_DIR"] = self._lama
        self.tmp.cleanup()

    def _entri(self, job, varian, pembuka="B#01", urutan=(0, 1, 2), shots=("B#01", "C#02")):
        sus = {"potongan": [{"jenis": "broll", "shot": s, "footage": s[0], "in": 0.0} for s in shots]}
        sus["potongan"].insert(0, {"jenis": "broll", "shot": pembuka, "footage": pembuka[0], "in": 0.0})
        rv = {"vo": "A", "urutan": list(urutan)}
        return self.r.entri_varian(job, "b1", "b1", {"id": varian}, sus, rv, {0: (pembuka,)})

    def test_kunci_brand_dari_kode(self):
        self.assertEqual(self.r.kunci_brand({"brand": {"kode": "AYS", "nama": "Aysilla Factory"}}), "AYS")
        self.assertEqual(self.r.kunci_brand({"nama": "Aysilla Factory"}), "Aysilla_Factory")
        with self.assertRaises(ValueError):
            self.r.path("../luar")

    def test_riwayat_dibaca_lintas_batch(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        rw = self.r.Riwayat(self.r.muat("AYS"), "b1", "b1", "JOB-2")
        self.assertEqual(rw.pembuka(), {"B#01"})
        self.assertEqual(rw.urutan("A"), {(0, 1, 2)})
        self.assertEqual(rw.shot_terpakai()["B#01"], 1)  # dihitung sekali per varian
        self.assertEqual(len(rw.sebanding("A")), 1)
        # Batch gambar lain: pembuka batch b1 tidak membatasi batch b2.
        self.assertEqual(self.r.Riwayat(self.r.muat("AYS"), "b2", "b1", "JOB-2").pembuka(), set())

    def test_jalan_ulang_job_sama_tidak_membatasi_diri(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        self.assertEqual(self.r.Riwayat(self.r.muat("AYS"), "b1", "b1", "JOB-1").pembuka(), set())
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001", pembuka="C#09")])
        d = self.r.muat("AYS")
        self.assertEqual(len(d["entri"]), 1)  # diganti, bukan ditumpuk
        self.assertEqual(d["entri"][0]["pembuka"], "b1|C#09")

    def test_dicoret_tidak_dihitung_dan_bertahan_saat_jalan_ulang(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001"), self._entri("JOB-1", "varian-002", pembuka="C#05")])
        self.assertEqual(self.r.tandai("AYS", "JOB-1", "dicoret", ["varian-001"]), 1)
        rw = self.r.Riwayat(self.r.muat("AYS"), "b1", "b1", "JOB-2")
        self.assertEqual(rw.pembuka(), {"C#05"})
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        self.assertEqual([e["status"] for e in self.r.muat("AYS")["entri"]], ["dicoret"])

    def test_jalan_ulang_tidak_menghapus_yang_sudah_dirender(self):
        # Audit venus: entri dirender/disetujui tidak boleh hilang saat job dijalankan ulang dengan isi lain.
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001", pembuka="B#01")])
        self.r.tandai("AYS", "JOB-1", "dirender", ["varian-001"])
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001", pembuka="C#09", urutan=(0, 2, 1))])
        d = self.r.muat("AYS")
        self.assertEqual(len(d["entri"]), 2)
        lama = next(e for e in d["entri"] if e["status"] == "dirender")
        baru = next(e for e in d["entri"] if e["status"] == "direncanakan")
        self.assertTrue(lama.get("diganti"))
        self.assertEqual(lama["pembuka"], "b1|B#01")
        self.assertEqual(baru["pembuka"], "b1|C#09")  # status "dirender" TIDAK ditempel ke isi baru
        # Jalan ulang berikutnya job yang sama tetap menghindari pembuka & urutan yang sudah dirender.
        rw = self.r.Riwayat(self.r.muat("AYS"), "b1", "b1", "JOB-1")
        self.assertIn("B#01", rw.pembuka())
        self.assertIn((0, 1, 2), rw.urutan("A"))
        self.assertNotIn("C#09", rw.pembuka())  # entri "direncanakan" job ini sendiri akan diganti

    def test_jalan_ulang_isi_identik_tidak_dobel(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        self.r.tandai("AYS", "JOB-1", "disetujui")
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        d = self.r.muat("AYS")
        self.assertEqual([(e["status"], e.get("diganti", False)) for e in d["entri"]], [("disetujui", False)])

    def test_status_dicoret_hanya_dibawa_kalau_isi_identik(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        self.r.tandai("AYS", "JOB-1", "dicoret")
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001", pembuka="C#07")])
        d = self.r.muat("AYS")
        self.assertEqual([e["status"] for e in d["entri"]], ["direncanakan"])  # varian baru dihitung
        self.assertIn("C#07", self.r.Riwayat(d, "b1", "b1", "JOB-2").pembuka())

    def test_file_rusak_tidak_menggagalkan_batch(self):
        p = self.r.path("AYS")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{rusak", encoding="utf-8")
        d = self.r.muat("AYS")
        self.assertEqual(d["entri"], [])
        self.assertIn("rusak", d["_peringatan"])
        self.assertFalse(p.exists())
        self.assertEqual(len(list(p.parent.glob("AYS.rusak-*.json"))), 1)
        self.assertIn("peringatan", self.r.Riwayat(d, "b1", "b1", "JOB-1").ringkas())
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])  # bisa dicatat lagi sesudahnya
        self.assertNotIn("_peringatan", json.loads(p.read_text(encoding="utf-8")))

    def test_catat_wajib_job_id(self):
        with self.assertRaises(ValueError):
            self.r.catat("AYS", None, [])

    def test_reset_per_brand_simpan_cadangan(self):
        self.r.catat("AYS", "JOB-1", [self._entri("JOB-1", "varian-001")])
        self.r.catat("KK", "JOB-9", [self._entri("JOB-9", "varian-001")])
        cadangan = self.r.reset("AYS")
        self.assertTrue(cadangan.exists())
        self.assertEqual(self.r.muat("AYS")["entri"], [])
        self.assertEqual(len(self.r.muat("KK")["entri"]), 1)  # brand lain tidak ikut di-reset

    def test_matcher_tidak_memakai_pembuka_riwayat(self):
        rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        awal = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3))["potongan"][0]["shot"]
        h = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3), hindari_pembuka={awal})
        self.assertNotEqual(h["potongan"][0]["shot"], awal)

    def test_susunan_vo_riwayat_tidak_diulang(self):
        v = vo_sintetis()
        rv = vo.susun(v, random.Random(1))
        r2 = vo.ragamkan(rv, v, random.Random(2), {tuple(rv["urutan"])})
        self.assertIsNotNone(r2)
        self.assertNotEqual(tuple(r2["urutan"]), tuple(rv["urutan"]))


def shots_bs(n_footage=4, per=4, dur=3.0):
    out = []
    for f in range(n_footage):
        for i in range(per):
            out.append({"id": f"f{f}#{i:02d}", "footage": f"f{f}", "dari": i * dur, "sampai": (i + 1) * dur,
                        "orang": 0.9, "framing": "full_body", "buram": False, "beku": False, "skor": 3.0 - 0.1 * i})
    return out


class BeatSpot(unittest.TestCase):
    """R16 Beat Spot tahap 1: pergantian orang tepat di ketukan sound."""

    def setUp(self):
        import beatspot
        self.bs = beatspot

    def test_langkah_auto_1_sampai_4_detik(self):
        for bpm in (70, 90, 120, 128, 150, 175):
            k = self.bs.langkah(bpm, "auto")
            self.assertTrue(0.9 <= k * 60 / bpm <= 4.0, (bpm, k))
        self.assertEqual(self.bs.langkah(120, 2), 2)
        self.assertEqual(self.bs.langkah(128, "auto"), 4)  # 0,47 dtk/ketukan -> 4 ketukan = 1,9 dtk

    def test_titik_potong_di_ketukan_dan_batas(self):
        ket = self.bs.ketukan_bpm(120, 30, mulai=0.37)
        pts = self.bs.titik_potong(ket, 4, 17.5)
        self.assertEqual(pts[0], 0)
        self.assertLessEqual(pts[-1], 17.5)
        for t in pts:  # tiap titik = ketukan asli (digeser ke 0)
            self.assertTrue(any(abs(t - (b - 0.37)) < 1e-6 for b in ket))

    def test_susun_orang_berganti_dan_shot_tidak_berulang(self):
        pts = self.bs.titik_potong(self.bs.ketukan_bpm(120, 30), 4, 16)
        pot, cat = self.bs.susun(pts, shots_bs(), {f"f{i}": 12.0 for i in range(4)}, random.Random(1))
        self.assertEqual(len(pot), len(pts) - 1)
        self.assertEqual(len({p["shot"] for p in pot}), len(pot))
        self.assertTrue(all(a["footage"] != b["footage"] for a, b in zip(pot, pot[1:])))
        for p in pot:
            self.assertGreaterEqual(p["in"], 0)

    def test_urutan_tim_dipakai_dulu(self):
        pts = self.bs.titik_potong(self.bs.ketukan_bpm(120, 30), 4, 8)
        pot, cat = self.bs.susun(pts, shots_bs(), {f"f{i}": 12.0 for i in range(4)}, random.Random(1),
                                 urutan=["f3#02", "tidak-ada#00", "f1#01"])
        self.assertEqual([p["shot"] for p in pot[:2]], ["f3#02", "f1#01"])
        self.assertEqual(pot[0]["alasan"], "urutan tim")
        self.assertTrue(any("tidak-ada#00" in c for c in cat))

    def test_kandidat_buang_buram_beku_tanpa_orang_wajah_dekat(self):
        sh = shots_bs(1, 5)
        sh[0]["buram"] = True
        sh[1]["beku"] = True
        sh[2]["orang"] = 0.2
        sh[3]["framing"] = "wajah_dekat"
        ok, buang = self.bs.kandidat_layak(sh, {"f0#04"})
        self.assertEqual(ok, [])
        self.assertEqual([b["alasan"] for b in buang], ["buram", "beku", "tanpa orang", "wajah dekat (orang lewat)",
                                                         "dikecualikan tim"])

    def _job(self, tmp, sumber, beatspot, brand=None):
        import json as _json
        j = Path(tmp)
        kit = brand or _json.loads((Path(__file__).resolve().parents[2] / "brandkit" / "aysilla.export.json").read_text(encoding="utf-8"))
        (j / "brand_kit.json").write_text(_json.dumps(kit))
        (j / "job.json").write_text(_json.dumps({"mode": "beatspot", "job_id": "T", "brand_kit": "brand_kit.json",
                                                 "sumber": sumber, "beatspot": beatspot}))
        return j

    def test_jalankan_tanpa_sound_pakai_bpm(self):
        import json as _json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            vids = []
            for i in range(4):
                v = Path(tmp) / f"v{i}.mp4"
                v.write_bytes(b"x")
                vids.append({"kunci": f"$sumber:f{i}", "path": str(v)})
            j = self._job(tmp, vids, {"bpm": 120, "tagline": "Tagline uji",
                                      "sumber_orang": {"f1": "kreator", "f2#00": "kreator", "f3": "salah"}})
            palsu = lambda footage, t: {"footage": {f: {"durasi": 12.0} for f in footage}, "shots": shots_bs()}  # noqa: E731
            kode = self.bs.jalankan(j, analisis=palsu)
            self.assertEqual(kode, 0)
            ops = _json.loads((j / "out" / "ops.json").read_text())["ops"]
            q = _json.loads((j / "out" / "qc_rencana.json").read_text())
            lap = _json.loads((j / "out" / "beatspot.json").read_text())
        self.assertTrue(q["lulus"], q)
        self.assertFalse(any(o.get("track_kind") == "music" for o in ops))  # sound tren dipasang tim di TikTok
        self.assertTrue(any(o.get("text") == "Tagline uji" for o in ops))
        self.assertEqual(lap["ketukan_per_potong"], 4)
        self.assertTrue(15 - 0.5 <= lap["durasi"] <= 20)
        # Tahap 2 nanti hanya memproses shot "kreator"; default "umum", nilai asing dianggap "umum".
        so = {k["id"]: k["sumber_orang"] for k in lap["kandidat"]}
        self.assertEqual((so["f1#00"], so["f2#00"], so["f2#01"], so["f3#00"], so["f0#00"]),
                         ("kreator", "kreator", "umum", "umum", "umum"))
        self.assertTrue(all(p["sumber_orang"] in ("kreator", "umum") for p in lap["potongan"]))

    def test_tolak_tanpa_footage(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            j = self._job(tmp, [], {"bpm": 120})
            self.assertEqual(self.bs.jalankan(j, analisis=lambda f, t: {}), 2)


class GayaR18(unittest.TestCase):
    """R18 (kontrak §17): preset hasil belajar Hanagaki + audio_pilihan. Field tidak ada = perilaku lama."""

    def setUp(self):
        import gaya
        import perencana
        self.g, self.pr = gaya, perencana
        rv = vo.susun(vo_sintetis(), random.Random(1), (10, 28))
        sus = matcher.susun_shot(rv, lib_sintetis(), {"A", "B", "C"}, random.Random(3))
        self.v = {"id": "varian-001", "vo": "A", "rv": rv, "susunan": sus, "musik": None, "durasi": sus["durasi"],
                  "hook": {"teks": "Celana adem", "dari": 0.0, "sampai": 2.0}, "cta": "Cek keranjang kuning",
                  "caption": perencana.frasa_caption(rv["kalimat"], sus["vo_klip"])}
        self.brand = {"warna": {"caption": "#ffffff", "outline": "#000000", "aksen": "#ffffff", "latar_gelap": "#111111"},
                      "preset": {}, "aset": [], "penutup": {}, "kata_kunci": [], "cta": {}}

    def _ops(self, gaya=None, v=None):
        return self.pr.buat_ops(v or self.v, self.brand, "u3", False, gaya)[0]

    def test_tanpa_field_sama_dengan_perilaku_lama(self):
        import json as _j
        lama = _j.dumps(self.pr.buat_ops(self.v, self.brand, "u3", False)[0], sort_keys=True)
        _, g = self.g.siapkan(self.brand, {}, {})
        self.assertEqual(lama, _j.dumps(self._ops(g), sort_keys=True))

    def test_preset_aktif_dari_job(self):
        b = dict(self.brand, preset={"x-interview": {"jenis": "street_interview", "caption": {"y": 0.76}}, "x-harian": {}})
        self.assertEqual(self.g.preset_aktif(b, {"preset": "x-interview"})["jenis"], "street_interview")
        self.assertEqual(self.g.preset_aktif(b, {}), {})  # kumpulan preset tanpa pilihan: tidak menebak

    def test_caption_hook_dari_preset(self):
        c = self.g.gaya_caption({"y": 0.76, "warna": "#F5EFA0", "kotak": True}, self.brand["warna"])
        self.assertEqual((c["y"], c["color"], c["bg"]), (0.76, "#f5efa0", "#111111"))
        h = self.g.gaya_hook({"y": 0.18, "ukuran": 4.5, "warna": "#FFFFFF"})
        self.assertEqual((h["y"], h["size"]), (0.18, 8.0))  # 4,5 % tinggi = 8 % sisi pendek 9:16
        ops = self._ops({"caption": {"y": 0.76, "warna": "#F5EFA0"}, "hook": {"y": 0.18}})
        sub = [o for o in ops if o.get("track_kind") == "subtitle"]
        self.assertTrue(sub and all(o["style"]["y"] == 0.76 and o["style"]["color"] == "#f5efa0" for o in sub))
        self.assertEqual(next(o for o in ops if o.get("track_kind") == "text")["style"]["y"], 0.18)

    def test_hook_dari_kalimat_kuat(self):
        rv = dict(self.v["rv"])
        rv["kalimat"] = [dict(k) for k in rv["kalimat"]]
        k = rv["kalimat"][2]
        k["teks"] = "Harganya cuma 80 ribu!"
        k["kata"] = kata("Harganya cuma 80 ribu!")
        self.assertEqual(self.g.teks_hook(rv, {"dari_kalimat_kuat": True}), "Harganya cuma 80 ribu!")
        self.assertEqual(len(self.g.teks_hook(rv, {"dari_kalimat_kuat": True, "baris": 1}).split()), 3)
        tanpa = dict(self.v, rv=self.v["rv"])
        self.assertEqual([p["jenis"] for p in self.g.peringatan(tanpa, {"hook": {"dari_kalimat_kuat": True}})], ["hook"])

    def test_shot_panjang_dipecah_dengan_punch_in(self):
        pot = [{"jenis": "sinkron", "footage": "A", "shot": "A#00", "start": 0.0, "dur": 7.0, "in": 2.0, "blur": []},
               {"jenis": "broll", "footage": "B", "shot": "B#01", "start": 7.0, "dur": 2.0, "in": 3.0, "blur": []}]
        out, punch = self.g.pecah_shot(pot, {"target_dtk": 1.9, "maks_dtk": 3.5})
        self.assertEqual(len(out), 5)  # 7 dtk -> 4 pecahan + shot B utuh
        self.assertTrue(all(p["dur"] <= 3.5 for p in out))
        self.assertAlmostEqual(sum(p["dur"] for p in out), 9.0, places=2)
        self.assertEqual(out[1]["in"] - out[0]["in"], out[1]["start"] - out[0]["start"])  # tetap sinkron bibir
        self.assertEqual(len(punch), 2)
        fr = self.g.gabung_punch([{"atMs": 0, "scale": 1.12, "mode": "smooth"}, {"atMs": 3000, "scale": 1.0}], punch)
        self.assertTrue(any(f["scale"] == 1.1 for f in fr))
        self.assertFalse(any(f["scale"] == 1.12 for f in fr))  # zoom halus yang bentrok dibuang
        self.assertEqual(self.g.pecah_shot(pot, {}), (pot, []))

    def test_flash_saat_ganti_footage_bukan_di_pecahan(self):
        ops = self._ops({"transisi": "flash", "shot": {"target_dtk": 1.2, "maks_dtk": 2.0}})
        vid = [o for o in ops if o.get("track_kind") == "video"]
        for a, b in zip(vid, vid[1:]):
            beda = a["media"] != b["media"]
            self.assertEqual("transition" in b, beda, (a["media"], b["media"]))
        self.assertTrue(any(o.get("transition") == {"type": "flash", "ms": 300} for o in vid))

    def test_audio_pilihan_musik_tanpa_vo_dan_caption(self):
        m = {"kunci": "$musik:x", "durasi": 60.0, "volume": 0.12, "sumber": "brand_kit", "lisensi_iklan": True}
        v = dict(self.v, musik=m)
        ops = self._ops({"audio_pilihan": "musik"}, v)
        kinds = {o.get("track_kind") for o in ops}
        self.assertNotIn("audio", kinds)
        self.assertNotIn("subtitle", kinds)
        self.assertIn("music", kinds)
        ops2 = self._ops({"audio_pilihan": "keduanya"}, v)
        self.assertIn({"op": "set_ducking", "on": True, "level": 0.3}, ops2)
        self.assertIn("audio", {o.get("track_kind") for o in ops2})

    def test_end_card_dan_watermark(self):
        aset = {"kunci": "$penutup:logo", "durasi_ms": 5000, "lisensi_iklan": True}
        b = dict(self.brand, aset=[aset], penutup={"aset": "$penutup:logo", "detik": 2.0},
                 preset={"p": {"penutup": {"end_card": True}}})
        b2, g = self.g.siapkan(b, {"teks": {"tagline": "CUCI · JEMUR · PAKAI"},
                                   "visual": {"watermark": {"teks": "@aysillafactoryid", "y": 0.05}}}, {"preset": "p"})
        ops = self.pr.buat_ops(self.v, b2, "u3", False, g)[0]
        total = int(round(self.v["durasi"] * 1000))
        self.assertIn(("broll", total, 2000), [(o.get("track_kind"), o.get("start_ms"), o.get("duration_ms")) for o in ops])
        teks = sorted((o["start_ms"], o["start_ms"] + o["duration_ms"]) for o in ops if o.get("track_kind") == "text")
        self.assertTrue(all(b1 <= a2 for (_, b1), (a2, _) in zip(teks, teks[1:])))  # track text tidak tumpang tindih
        self.assertTrue(any(o.get("text") == "@aysillafactoryid" for o in ops))
        self.assertTrue(any(o.get("text") == "CUCI · JEMUR · PAKAI" for o in ops))
        tanpa = self.g.siapkan(dict(self.brand, preset={"p": {"penutup": {"end_card": True}}}), {}, {"preset": "p"})[1]
        self.assertEqual([p["jenis"] for p in self.g.peringatan(self.v, tanpa)], ["penutup"])

    def test_audio_pilihan_salah_ditolak(self):
        self.assertIn("audio_pilihan", self.g.siapkan(self.brand, {}, {"audio_pilihan": "lagu"})[1]["salah"])

    def test_beatspot_preset_beat_watermark_dan_vo(self):
        import json as _json
        import tempfile
        import beatspot
        with tempfile.TemporaryDirectory() as tmp:
            j = Path(tmp)
            kit = _json.loads((Path(__file__).resolve().parents[2] / "brandkit" / "aysilla.export.json").read_text(encoding="utf-8"))
            kit["preset"] = {"aysilla-beatspot": {"jenis": "beat_spot", "beat": {"tiap_ketukan": 2, "bpm": 100}}}
            kit["visual"]["watermark"] = {"teks": "@aysillafactoryid", "y": 0.05, "lebar": 0.4}
            kit["teks"]["tagline"] = "NYAMAN SEHARIAN"
            (j / "brand_kit.json").write_text(_json.dumps(kit))
            vids = []
            for i in range(4):
                (j / f"v{i}.mp4").write_bytes(b"x")
                vids.append({"kunci": f"$sumber:f{i}", "path": str(j / f"v{i}.mp4")})
            (j / "s.wav").write_bytes(b"x")
            vids.append({"kunci": "$sumber:snd", "path": str(j / "s.wav")})
            (j / "job.json").write_text(_json.dumps({"mode": "beatspot", "job_id": "T", "brand_kit": "brand_kit.json",
                                                     "preset": "aysilla-beatspot", "audio_pilihan": "vo",
                                                     "sumber": vids, "beatspot": {}}))
            palsu = lambda footage, t: {"footage": {f: {"durasi": 12.0} for f in footage}, "shots": shots_bs()}  # noqa: E731
            self.assertEqual(beatspot.jalankan(j, analisis=palsu), 0)
            lap = _json.loads((j / "out" / "beatspot.json").read_text())
            ops = _json.loads((j / "out" / "ops.json").read_text())["ops"]
        self.assertEqual((lap["bpm"], lap["ketukan_per_potong"]), (100.0, 2))  # dari preset
        self.assertFalse(any(o.get("track_kind") == "music" for o in ops))  # audio_pilihan vo
        self.assertTrue(any(o.get("text") == "@aysillafactoryid" for o in ops))
        self.assertTrue(any(o.get("text") == "NYAMAN SEHARIAN" for o in ops))
        self.assertIn({"op": "set_brand_logo", "on": False}, ops)  # beat_spot + watermark = tanpa logo


class DataTerpisah(unittest.TestCase):
    """R20: KODE dari folder rilis, DATA dari MOTION_ENGINE_DATA. Tanpa env = perilaku lama (data = repo)."""

    BATCH = Path(__file__).resolve().parent

    def _py(self, kode: str, env_data: str | None) -> dict:
        import json as _j
        import os
        import subprocess
        env = {k: v for k, v in os.environ.items() if k != "MOTION_ENGINE_DATA"}
        if env_data:
            env["MOTION_ENGINE_DATA"] = env_data
        r = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {str(self.BATCH)!r})\n" + kode],
                           env=env, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stderr)
        return _j.loads(r.stdout.strip().splitlines()[-1])

    KODE = (
        "import json, jalur\n"
        "print(json.dumps({'root': str(jalur.ROOT), 'data': str(jalur.DATA), 'konten': str(jalur.KONTEN),\n"
        "  'main_py': str(jalur.MAIN_PY), 'rel': jalur.relatif(jalur.KONTEN / '2-dipisah' / 'b' / 'x.mp4')}))"
    )

    def test_tanpa_env_data_sama_dengan_repo(self):
        d = self._py(self.KODE, None)
        root = Path(d["root"])
        self.assertEqual(Path(d["data"]), root)
        self.assertEqual(Path(d["konten"]), root / "konten")
        self.assertTrue(Path(d["main_py"]).is_relative_to(root / ".venv"))
        self.assertEqual(d["rel"], "konten/2-dipisah/b/x.mp4")

    def test_env_data_folder_lain(self):
        import json as _j
        import os
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp).resolve()
            d = self._py(self.KODE, str(data))
            self.assertEqual(Path(d["data"]), data)
            self.assertEqual(Path(d["konten"]), data / "konten")
            self.assertNotEqual(Path(d["root"]), data)  # kode tetap dari folder repo/rilis
            self.assertTrue(Path(d["main_py"]).is_relative_to(data / ".venv"))
            self.assertEqual(d["rel"], "konten/2-dipisah/b/x.mp4")  # relatif ke DATA
            # daftar.py (CLI) membaca konten dari folder data
            (data / "konten" / "2-dipisah" / "batch-data" / "video-bisu").mkdir(parents=True)
            (data / "konten" / "2-dipisah" / "batch-data" / "video-bisu" / "a.mp4").write_bytes(b"x")
            env = {**os.environ, "MOTION_ENGINE_DATA": str(data)}
            r = subprocess.run([sys.executable, str(self.BATCH / "daftar.py")], env=env, capture_output=True, text=True,
                               encoding="utf-8")
            nama = [x["batch"] for x in _j.loads(r.stdout)["batch"]]
            self.assertEqual(nama, ["batch-data"])
            # musik bebas lisensi (public/musik) dan riwayat juga dari folder data
            m = self._py("import json, riwayat\nprint(json.dumps({'riw': str(riwayat.folder())}))", str(data))
            self.assertEqual(Path(m["riw"]), data / "konten" / "riwayat")


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


def vo_panjang():
    teks = ["Bahannya adem banget.", "Modelnya high waist.", "Warnanya ada lima.", "Jahitannya rapi sekali.",
            "Tapi ukurannya lengkap.", "Cocok buat kerja.", "Cek keranjang kuning ya."]
    ks, t = [], 0.0
    for t_ in teks:
        ks += kalimat(kata(t_, mulai=t))
        t += len(t_.split()) * 0.4 + 0.3
    for i, k in enumerate(ks):
        k["id"], k["saran_buang"], k["teknis"], k["brand_lain"] = i, None, None, None
    return {"id": "A", "kalimat": ks, "durasi": 30.0}


class RagamVO(unittest.TestCase):
    """Owner 14 Nov: varian dengan VO sama tidak boleh punya audio identik."""

    def test_susunan_beda_hook_cta_tetap(self):
        v, rng, sudah = vo_panjang(), random.Random(2), set()
        self.assertIn("cta", v["kalimat"][-1]["topik"])
        for _ in range(4):
            rv = vo.ragamkan(vo.susun(v, rng), v, rng, sudah)
            self.assertIsNotNone(rv)
            u = tuple(rv["urutan"])
            self.assertNotIn(u, sudah)
            sudah.add(u)
            self.assertEqual(u[0], 0)
            self.assertEqual(u[-1], len(v["kalimat"]) - 1)

    def test_varian_pertama_utuh(self):
        v = vo_panjang()
        rv = vo.ragamkan(vo.susun(v, random.Random(0)), v, random.Random(0), set())
        self.assertEqual(rv["urutan"], list(range(len(v["kalimat"]))))

    def test_kalimat_penyambung_tidak_dipindah(self):
        v, rng, sudah = vo_panjang(), random.Random(5), set()
        tapi = next(k["id"] for k in v["kalimat"] if k["teks"].startswith("Tapi"))
        for _ in range(4):
            rv = vo.ragamkan(vo.susun(v, rng), v, rng, sudah)
            if rv is None:
                break
            sudah.add(tuple(rv["urutan"]))
            u = rv["urutan"]
            if tapi in u:  # "Tapi ..." tetap tepat sesudah kalimat aslinya
                self.assertEqual(u[u.index(tapi) - 1], tapi - 1)

    def test_habis_kalau_kalimat_sedikit(self):
        v = vo_sintetis()
        v["kalimat"] = v["kalimat"][:2]
        rv0 = vo.susun(v, random.Random(0))
        self.assertIsNone(vo.ragamkan(rv0, v, random.Random(0), {tuple(rv0["urutan"])}))


class MiripPosisi(unittest.TestCase):
    def test_sama_posisi(self):
        import perencana
        self.assertEqual(perencana.sama_posisi({0: ("a",), 1: ("b",)}, {0: ("a",), 1: ("c",)}), 0.5)
        self.assertEqual(perencana.sama_posisi({0: ("a",)}, {1: ("a",)}), 0)
