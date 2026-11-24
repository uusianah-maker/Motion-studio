"""Keluhan tim 24 Nov 2026: typo subtitle, potongan tidak ikut prompt, zoom/SFX kasar."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine  # noqa: E402
import instruksi  # noqa: E402
import sfx_rencana  # noqa: E402
from autocut import buang_sisa_tanpa_kata, mark_removals, merge_split_words, pasang_utuh  # noqa: E402
from edit import apply_kamus, plan_captions, saring_ragu, terapkan_instruksi, token_lindung  # noqa: E402
from jaga_ops import validasi_motion_studio  # noqa: E402
from ops import DORONG_RAMP_MS, ZT_SKALA, gerak_framing, susun, tulis  # noqa: E402

DATA = Path(__file__).parent / "data"


def fixture():
    """Transkrip asli job AYS-20261124-002 (keluhan tim): 'alright.', 'ugh,', 'nuts,', 'Danny,' prob 0,00; 'Rp89' '.000'."""
    return json.loads((DATA / "keluhan_ays_002_transkrip.json").read_text(encoding="utf-8"))


def bk_aysilla():
    t = json.loads((DATA / "keluhan_aysilla_bk_teks.json").read_text(encoding="utf-8"))
    return {"nama": "Aysilla Factory", "kosakata_whisper": t["kosakata_whisper"], "kamus_kata": t["kamus"]}


def kata(*teks, prob=0.9):
    out, t = [], 0
    for x in teks:
        out.append({"text": x, "startMs": t, "endMs": t + 300, "prob": prob})
        t += 320
    return out


class KamusToleran(unittest.TestCase):
    def test_sufiks_nya_ikut(self):
        w = kata("Selananya", "adem.")
        fixes = apply_kamus(w, {"Selana": "Celana"})
        self.assertEqual([x["text"] for x in w], ["Celananya", "adem."])
        self.assertEqual(fixes[0]["dari"], "Selananya")

    def test_sufiks_lah_kah_dan_huruf_kecil(self):
        w = kata("ini", "cekotlah,", "ya")
        apply_kamus(w, {"cekot": "checkout"})
        self.assertEqual(w[1]["text"], "checkoutlah,")
        w = kata("cekotkah?")
        apply_kamus(w, {"cekot": "checkout"})
        self.assertEqual(w[0]["text"], "checkoutkah?")

    def test_persis_tetap_jalan(self):
        w = kata("pakai", "luspents", "ini")
        apply_kamus(w, {"luspents": "Loose Pants"})
        self.assertEqual(w[1]["text"], "Loose Pants")

    def test_multi_kata_beda_satu_huruf(self):
        w = kata("hai", "waist", "nya", "enak")
        apply_kamus(w, {"hide waist": "high waist"})  # "hai" < 4 huruf: wajib persis -> tidak diganti
        self.assertEqual(w[0]["text"], "hai")
        w = kata("Hidee", "waist.")
        apply_kamus(w, {"hide waist": "high waist"})
        self.assertEqual(w[0]["text"], "High waist.")

    def test_multi_kata_dengan_sufiks(self):
        w = kata("kerajang", "kuningnya")
        apply_kamus(w, {"keranjang kuning": "keranjang kuning"})
        self.assertEqual(w[0]["text"], "keranjang kuningnya")
        w = kata("keranjang", "kuning")
        self.assertEqual(apply_kamus(w, {"keranjang kuning": "keranjang kuning"}), [])  # sudah benar

    def test_satu_kata_tidak_fuzzy(self):
        w = kata("lis", "lost")
        apply_kamus(w, {"lus": "loose", "los": "loose"})
        self.assertEqual([x["text"] for x in w], ["lis", "lost"])

    def test_kata_benar_tidak_dibetulkan_fuzzy(self):
        # "luce pants" -> "Loose Pants", tapi "Lucy Pants" (produk lain, ada di kosakata) beda 1 huruf: jangan diganti
        w = kata("Lucy", "Pants")
        apply_kamus(w, {"luce pants": "Loose Pants", "lusi pants": "Lucy Pants"}, ["Lucy Pants"])
        self.assertEqual([x["text"] for x in w], ["Lucy", "Pants"])

    def test_kunci_pendek_tidak_kena_sufiks(self):
        w = kata("selah")
        apply_kamus(w, {"se": "sih"})
        self.assertEqual(w[0]["text"], "selah")


class HargaTidakTerbelah(unittest.TestCase):
    def test_rp_titik_000_digabung(self):
        teks = [x["text"] for x in merge_split_words(fixture()["words"])]
        self.assertIn("Rp89.000-an", teks)
        self.assertIn("Rp89.000,", teks)
        self.assertNotIn(".000", teks)

    def test_singkatan_digabung(self):
        w = merge_split_words(kata("A", ".L", ".N.", "store"))
        self.assertEqual([x["text"] for x in w], ["A.L.N.", "store"])

    def _halaman(self, teks):
        caps = [{"text": t, "startMs": i * 300, "endMs": i * 300 + 280, "_word": i} for i, t in enumerate(teks)]
        plan_captions(caps, [{"text": t} for t in teks], [], [])
        halaman, cur = [], []
        for c in caps:
            cur.append(c["text"])
            if c["pageBreakAfter"]:
                halaman.append(cur)
                cur = []
        return halaman

    def test_halaman_tidak_memecah_angka(self):
        halaman = self._halaman(["harganya", "cuma", "Rp", "89", "ribu", "aja", "lho."])
        self.assertIn(["Rp", "89", "ribu"], halaman)

    def test_ukuran_baju_tetap_satu_kata(self):
        halaman = self._halaman(["size", "M,", "L,", "XL", "ready", "semua."])
        self.assertEqual(sum(len(h) for h in halaman), 6)


class KataRagu(unittest.TestCase):
    def setUp(self):
        bk = bk_aysilla()
        self.w = merge_split_words(fixture()["words"])
        apply_kamus(self.w, bk["kamus_kata"], bk["kosakata_whisper"])
        self.lap = saring_ragu(self.w, token_lindung(bk))
        mark_removals(self.w)
        self.by = {(x["startMs"], x["text"]): x for x in self.w}

    def test_karangan_inggris_tidak_tampil(self):
        for k in [(3000, "alright."), (5360, "ugh,"), (16360, "nuts,"), (16940, "Danny,"), (15520, "gdzieś,")]:
            x = self.by[k]
            self.assertTrue(x.get("hidden") or x["cut"], k)
        self.assertEqual(len(self.lap), 8)

    def test_karangan_terisolasi_dibuang_dari_potongan(self):
        for k in [(5360, "ugh,"), (16360, "nuts,"), (16940, "Danny,")]:  # Danny,: 5,9 dtk prob 0 (noise)
            self.assertIn("karangan Whisper", self.by[k]["cut"] or "", k)

    def test_angka_dan_kata_yakin_tetap(self):
        for k in [(23780, "Rp89.000-an"), (9840, "celana"), (35320, "Rp89.000,")]:
            self.assertFalse(self.by[k].get("hidden"), k)
            self.assertIsNone(self.by[k]["cut"], k)
        self.assertIsNone(self.by[(37300, "CO")]["cut"])  # 0.36 tapi diapit kata yakin

    def test_diapit_kata_yakin_tetap_tampil_ditandai(self):
        w = [{"text": "celana", "startMs": 0, "endMs": 300, "prob": 0.95},
             {"text": "kulot", "startMs": 320, "endMs": 600, "prob": 0.01},
             {"text": "adem", "startMs": 650, "endMs": 900, "prob": 0.9}]
        saring_ragu(w, set())
        self.assertFalse(w[1].get("hidden"))
        self.assertIn("ragu", w[1]["ragu"])
        mark_removals(w)
        self.assertIsNone(w[1]["cut"])
        self.assertTrue(w[1]["doubt"])

    def test_kosakata_brand_dilindungi(self):
        w = [{"text": "Aysilla", "startMs": 0, "endMs": 300, "prob": 0.01}]
        saring_ragu(w, token_lindung(bk_aysilla()))
        mark_removals(w)
        self.assertFalse(w[0].get("hidden"))
        self.assertIsNone(w[0]["cut"])


class SisaTanpaKata(unittest.TestCase):
    def test_sisa_pendek_tanpa_kata_dibuang_utuh_tetap(self):
        words = [{"text": "halo", "startMs": 1000, "endMs": 1400, "prob": 0.9, "cut": None}]
        segs = [{"srcStartMs": 900, "srcEndMs": 1520}, {"srcStartMs": 2000, "srcEndMs": 2300},
                {"srcStartMs": 3000, "srcEndMs": 3700}]
        out = buang_sisa_tanpa_kata(segs, words)
        self.assertEqual([s["srcStartMs"] for s in out], [900, 3000])  # 300 ms tanpa kata dibuang, 700 ms tetap
        # §26.5: rentang utuh dipasang SESUDAH langkah ini, jadi footage tanpa ucapan tetap utuh
        out = pasang_utuh(out, [[5000, 5300]], 9000)
        self.assertIn(5000, [s["srcStartMs"] for s in out])


class InstruksiTim(unittest.TestCase):
    CATATAN_ASLI = ("Gabungkan seluruh footage menjadi satu video yang rapi dan dinamis. Hapus bagian jeda, diam, "
                    "pengulangan, kesalahan bicara, dan momen yang tidak relevan. Prioritaskan klip yang berisi penjelasan "
                    "produk yang jelas.\n\nLakukan color correction ringan dengan auto white balance.")

    def test_catatan_asli_tidak_diabaikan_diam_diam(self):
        h = instruksi.baca(self.CATATAN_ASLI, 4)
        self.assertEqual(len(h["otomatis"]), 2)
        self.assertEqual(len(h["tidak_dipahami"]), 2)  # prioritas klip, color correction
        self.assertFalse(h["buang_footage"])

    def test_pola_footage(self):
        self.assertEqual(instruksi.baca("jangan pakai footage 2", 4)["buang_footage"], [2])
        self.assertEqual(instruksi.baca("Buang footage ke-1 dan 3.", 4)["buang_footage"], [1, 3])
        self.assertEqual(instruksi.baca("tanpa video kedua", 4)["buang_footage"], [2])
        self.assertEqual(instruksi.baca("skip footage terakhir", 4)["buang_footage"], [4])
        self.assertEqual(instruksi.baca("hanya pakai footage 1, 3", 4)["hanya_footage"], [1, 3])
        h = instruksi.baca("buang footage 7", 4)
        self.assertFalse(h["buang_footage"])
        self.assertIn("tidak ada", h["tidak_dipahami"][0]["alasan"])

    def test_pola_kalimat(self):
        h = instruksi.baca("buang kalimat \"coba kalian cek di keranjangnya\" dan kata 'payday'", 1)
        self.assertEqual([t for _, t, _ in h["buang_frasa"]], ["coba kalian cek di keranjangnya", "payday"])
        h = instruksi.baca("hapus kalimat yang jelek", 1)
        self.assertIn("tanda kutip", h["tidak_dipahami"][0]["alasan"])

    def test_terapkan_pada_transkrip_gabungan(self):
        fx = fixture()
        with tempfile.TemporaryDirectory() as d:
            g = Path(d) / "gabungan.json"
            g.write_text(json.dumps({"bagian": fx["bagian"]}), encoding="utf-8")
            tr = {"durationMs": fx["durationMs"], "utuh": [[0, 60601]]}
            w = merge_split_words(fx["words"])
            lap = terapkan_instruksi('Jangan pakai footage 2. Buang kata "payday". Tambah musik.', str(g), tr, w, False)
        f2 = fx["bagian"][1]
        a2, b2 = f2["mulai_ms"], f2["mulai_ms"] + f2["durasi_ms"]
        dalam = [x for x in w if a2 <= (x["startMs"] + x["endMs"]) / 2 < b2]
        self.assertTrue(dalam and all("footage 2" in x["forced"] for x in dalam))
        self.assertTrue(all(not x.get("forced") for x in w if x["endMs"] < a2))
        self.assertIn("payday", [x for x in w if x["text"] == "payday"][0]["forced"])
        self.assertEqual([x["aksi"] for x in lap["dipahami"]], ["buang_footage", "buang_kata"])
        self.assertEqual(lap["tidak_dipahami"][0]["kalimat"], "Tambah musik.")
        self.assertFalse(any(a < a2 + 100 < b for a, b in tr["utuh"]))  # utuh dikurangi rentang footage 2

    def test_semua_footage_terbuang_ditolak(self):
        w = kata("halo", "semua")
        lap = terapkan_instruksi("jangan pakai footage 1", None, {"durationMs": 5000}, w, False)
        self.assertFalse(any(x.get("forced") for x in w))
        self.assertIn("semua footage", lap["tidak_dipahami"][0]["alasan"])

    def test_engine_meneruskan_catatan_dan_brief(self):
        job = {"brand_kit": "brand_kit.json", "brief": {"catatan": "jangan pakai footage 2", "produk": "Loose Pants",
                                                       "varian": ["ivory", "latte"]}}
        cmd = engine.argumen_edit(job, Path("J"), Path("J/out/t.json"), Path("v.mp4"), Path("J/out"), {"kunci": "x"})
        self.assertEqual(cmd[cmd.index("--catatan") + 1], "jangan pakai footage 2")
        self.assertEqual(Path(cmd[cmd.index("--gabungan") + 1]), Path("J/out/gabungan.json"))
        self.assertNotIn("--gabungan", engine.argumen_edit(job, Path("J"), Path("t"), Path("v"), Path("o")))
        t = engine.argumen_transkrip(job, Path("J"), Path("v.mp4"), Path("t.json"))
        self.assertEqual(t[t.index("--produk") + 1], "Loose Pants")
        self.assertEqual(t[t.index("--varian") + 1], "ivory, latte")


BK_OPS = {"warna": {"caption": "#FFFFFF", "outline": "#000000", "aksen": "#FFCC00", "latar_gelap": "#000000"},
          "kapital": "kata_kunci", "superlatif_dilarang": [], "logo": "", "nama": "A"}


class GerakHalus(unittest.TestCase):
    FRAMING = [{"atMs": 0, "scale": 1.0, "mode": "cut"}, {"atMs": 3000, "scale": 1.0, "mode": "smooth"},
               {"atMs": 6000, "scale": 1.07, "mode": "cut"}, {"atMs": 9000, "scale": 1.07, "mode": "smooth"}]

    def test_dorong_pelan_dengan_ramp_keluar(self):
        efek, jendela = gerak_framing(self.FRAMING, [], 12000)
        self.assertEqual([(a, b, e["mode"]) for a, b, e in efek], [(6000, 12000, "cut")])
        dorong = [w for w in jendela if w[0][0] == 3000][0]
        naik, turun = dorong[1][0] - dorong[0][0], dorong[-1][0] - dorong[-2][0]
        self.assertTrue(DORONG_RAMP_MS[0] <= naik <= DORONG_RAMP_MS[1])
        self.assertTrue(DORONG_RAMP_MS[0] <= turun <= DORONG_RAMP_MS[1])
        self.assertEqual((dorong[0][1], dorong[-1][1]), (1.0, 1.0))  # titik kembali ke 1.0 tidak dibuang
        self.assertEqual((dorong[1][2], dorong[-1][2]), ("ease", "ease"))

    def test_zoom_through_naik_lalu_turun(self):
        _, jendela = gerak_framing([{"atMs": 0, "scale": 1.0, "mode": "cut"}], [5000], 12000)
        zt = jendela[0]
        self.assertEqual([p[1] for p in zt], [1.0, ZT_SKALA, 1.0])
        self.assertLess(zt[0][0], 5000)
        self.assertGreater(zt[-1][0], 5000)
        self.assertEqual(zt[-1][2], "ease")

    def test_ops_lolos_validator_motion_studio(self):
        caps, t = [], 0
        for i, w in enumerate("Males nyetrika celana? Ini Loose Pants anti kusut, cek keranjang kuning sekarang!".split()):
            caps.append({"text": w, "startMs": t, "endMs": t + 350, "pageBreakAfter": i % 3 == 2, "emphasis": False})
            t += 900
        props = {"segments": [{"startFrame": 0, "endFrame": 180}, {"startFrame": 200, "endFrame": 400}],
                 "captions": caps, "style": {"captionCenterY": 0.72},
                 "hook": {"text": "Males nyetrika celana?", "startMs": 0, "endMs": 1200},
                 "outroTagline": "Cek keranjang", "outroSeconds": 2.5, "sfx": [], "framing": self.FRAMING,
                 "zoomThroughs": [4000]}
        laporan = {"originalSec": 14.0, "originalMs": 14000, "removed": [], "kataKunci": [], "superlatifDisembunyikan": [],
                   "doubts": [], "peringatan": [], "posisiCaption": {"y": 0.72, "kandidat": []}}
        rencana, doc, qc = susun(props, laporan, BK_OPS, placement="tiktok", root=Path(__file__).resolve().parents[2])
        video = [o for o in doc["ops"] if o.get("track_kind") == "video"]
        self.assertTrue(any(o.get("keyframes") for o in video))
        sfx = [o for o in doc["ops"] if o.get("track_kind") == "sfx"]
        self.assertTrue(sfx and all(3 <= o["fade_in_ms"] <= 5 and 1 <= o["fade_out_ms"] <= 40 for o in sfx))
        self.assertIn("efek zoom_through", [a for _, _, a in sfx_rencana.kejadian(doc["ops"], 14000)])
        if shutil.which("node") is None:
            self.skipTest("node tidak ada")
        with tempfile.TemporaryDirectory() as d:
            tulis(Path(d), rencana, doc, qc)
            self.assertIsNone(validasi_motion_studio(Path(d) / "ops.json"))


if __name__ == "__main__":
    unittest.main()
