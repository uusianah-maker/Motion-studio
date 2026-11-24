import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from brandkit import BrandKitError, cek_ekspor, dari_ekspor, ke_ekspor, kosakata_brand  # noqa: E402

CONTOH = {
    "schema": "brand-kit-export/1",
    "brand": {"id": "b-1", "nama": "Aysilla Factory", "kode": "AYS",
              "handle": {"tiktok": "@aysillafactoryid", "instagram": "@aysilla.ig"},
              "target": "", "nada": [], "bahasa": "campur", "produk": []},
    "visual": {"warna": ["#ffffff", "#f2c14e", "#1a1a1a"], "warna_teks": "#ffffff",
               "outline": {"warna": "#000000", "px": 5}, "warna_dilarang": [],
               "font_judul": "$font:judul", "font_caption": None,
               "logo": {"aset": "$logo", "aset_terang": None, "pojok": "tr", "ukuran": 25, "opasitas": 1, "tampil": "sepanjang"},
               "penutup": {"aset": None, "detik": 2.5}, "gaya": "", "grading": ""},
    "teks": {"cta": {"tiktok": "Cek keranjang kuning", "instagram": "Cek link di bio"}, "cta_wajib": "",
             "disclaimer": {"teks": "Warna bisa beda", "kapan": "varian_warna"},
             "kosakata_whisper": ["Loose Pants"], "kamus": {"Luspents": "Loose Pants"},
             "kata_kunci": ["anti kusut"], "kapital": "kata_kunci", "emoji": False},
    "aturan": {"terlarang": ["paling murah"], "level": "block", "harga": [], "klaim_boleh": [],
               "visual_dilarang": [], "area_bebas_teks": ["wajah"]},
    "aset": [{"kunci": "$font:judul", "jenis": "font", "path": "D:/ws/font.ttf"},
             {"kunci": "$logo", "jenis": "logo", "path": "D:/ws/logo.png"}],
    "preset": {"aysilla-konversi": {"id": "aysilla-konversi", "durasi": {"min": 15, "target": 20, "max": 30}}},
}


class BrandKit(unittest.TestCase):
    def test_ekspor_valid_dipetakan(self):
        bk = dari_ekspor(copy.deepcopy(CONTOH))
        self.assertEqual(bk["nama"], "Aysilla Factory")
        self.assertEqual(bk["kode"], "AYS")
        self.assertEqual(bk["handle"], "@aysillafactoryid")
        self.assertEqual(bk["logo"], "D:/ws/logo.png")
        self.assertEqual(bk["warna"]["caption"], "#ffffff")
        self.assertEqual(bk["warna"]["aksen"], "#ffffff")  # warna[0] = warna utama
        self.assertEqual(bk["warna"]["latar_gelap"], "#1a1a1a")
        self.assertEqual(bk["caption_outline_px"], 5)
        self.assertEqual(bk["kamus_kata"], {"Luspents": "Loose Pants"})
        self.assertEqual(bk["superlatif_dilarang"], ["paling murah"])
        self.assertEqual(bk["disclaimer_warna"], "Warna bisa beda")
        self.assertEqual(bk["font_file"]["judul"], "D:/ws/font.ttf")
        self.assertIn("aysilla-konversi", bk["preset"])

    def test_cta_shopee_ikut_tiktok(self):
        bk = dari_ekspor(copy.deepcopy(CONTOH))
        self.assertEqual(bk["cta"]["shopee"], "Cek keranjang kuning")

    def test_kode_salah_ditolak(self):
        d = copy.deepcopy(CONTOH)
        d["brand"]["kode"] = "aysilla"
        with self.assertRaises(BrandKitError):
            dari_ekspor(d)

    def test_nilai_terbatas_salah(self):
        d = copy.deepcopy(CONTOH)
        d["visual"]["logo"]["pojok"] = "kanan"
        d["aturan"]["level"] = "keras"
        d["visual"]["warna"].append("#FFF")
        m = cek_ekspor(d)
        self.assertEqual(len(m), 3, m)

    def test_placeholder_tanpa_aset_ditolak(self):
        d = copy.deepcopy(CONTOH)
        d["aset"] = [d["aset"][0]]  # logo hilang
        self.assertTrue(any("$logo" in x for x in cek_ekspor(d)))

    def test_migrasi_aysilla_valid(self):
        lama = json.loads((ROOT / "brandkit" / "aysilla.json").read_text(encoding="utf-8"))
        d = ke_ekspor(lama, "AYS")
        self.assertEqual(cek_ekspor(d), [])
        bk = dari_ekspor(d)
        self.assertEqual(bk["kamus_kata"], lama["kamus_kata"])
        self.assertEqual(bk["kata_kunci"], lama["kata_kunci"])
        self.assertEqual(bk["cta"]["tiktok"], lama["cta"]["tiktok"])


class TestKosakataBrand(unittest.TestCase):
    """R30: nama brand selalu jadi petunjuk Whisper walau kosakata Brand Kit kosong."""

    def test_nama_brand_selalu_ikut_walau_kosakata_kosong(self):
        self.assertEqual(kosakata_brand({"nama": "Aysilla Factory"}), ["Aysilla Factory"])

    def test_urutan_dan_tanpa_duplikat(self):
        bk = {"nama": "Aysilla Factory", "kosakata_whisper": ["celana", "Celana ", "join live"],
              "kata_kunci": ["diskon"], "kamus_kata": {"cana": "celana", "icy love": "Aysilla"},
              "produk": [{"nama": "Kulot Highwaist"}, "korset"]}
        # Keluhan tim 24 Nov: kata benar kamus sebelum kosakata (dulu selalu terpotong batas 40)
        self.assertEqual(kosakata_brand(bk), ["Aysilla Factory", "celana", "Aysilla", "join live", "diskon",
                                              "Kulot Highwaist", "korset"])

    def test_brief_produk_varian_sesudah_nama_brand(self):
        bk = {"nama": "Aysilla Factory", "kosakata_whisper": ["celana"], "kamus_kata": {"lus": "loose"}}
        brief = {"produk": "Loose Pants", "varian": "ivory, hitam, most grey"}
        self.assertEqual(kosakata_brand(bk, brief), ["Aysilla Factory", "Loose Pants", "ivory", "hitam", "most grey",
                                                     "loose", "celana"])

    def test_dibatasi_token_bukan_jumlah(self):
        bk = {"nama": "A", "kosakata_whisper": [f"kata{i}" for i in range(300)]}
        hitung = lambda t: len(t.split())  # noqa: E731  1 token per kata
        self.assertEqual(len(kosakata_brand(bk, hitung=hitung, batas_token=50)), 50)
        out = kosakata_brand(bk)  # tanpa tokenizer: perkiraan boros, tetap di bawah batas
        self.assertLess(len(out), 300)

    def test_batas_token_whisper_asli(self):
        """Tokenizer model Whisper yang dipakai (cache lokal, tanpa jaringan): Brand Kit Aysilla 42 kosakata +
        kamus muat, dan prompt lengkap tetap <= 223 token (batas faster-whisper)."""
        snap = Path.home() / ".cache/huggingface/hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots"
        tj = next(snap.glob("*/tokenizer.json"), None) if snap.exists() else None
        if tj is None:
            self.skipTest("tokenizer Whisper tidak ada di cache")
        import tokenizers

        tok = tokenizers.Tokenizer.from_file(str(tj))
        hitung = lambda t: len(tok.encode(" " + t, add_special_tokens=False).ids)  # noqa: E731
        fx = json.loads((Path(__file__).parent / "data" / "keluhan_aysilla_bk_teks.json").read_text(encoding="utf-8"))
        bk = {"nama": "Aysilla Factory", "kosakata_whisper": fx["kosakata_whisper"], "kamus_kata": fx["kamus"]}
        out = kosakata_brand(bk, {"produk": "Loose Pants", "varian": "ivory, hitam, latte, most grey, espresso"}, hitung, 180)
        self.assertLessEqual(hitung(", ".join(out)), 180)
        self.assertIn("cuttingannya", out)  # kata benar kamus tidak lagi terpotong
        self.assertIn("espresso", [x.lower() for x in out])
        self.assertGreater(len(out), 40)


if __name__ == "__main__":
    unittest.main()
