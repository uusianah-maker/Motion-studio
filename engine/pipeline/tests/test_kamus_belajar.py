"""R30b: .venv/Scripts/python -m unittest pipeline/tests/test_kamus_belajar.py"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import kamus_belajar as K  # noqa: E402


def kor(sebelum, sesudah, proyek="p1"):
    return {"schema": "belajar/1", "jenis": "koreksi", "bagian": "kata", "op": "set_text", "project_id": proyek,
            "sebelum": sebelum, "sesudah": sesudah}


class Penggantian(unittest.TestCase):
    def test_salah_dengar_diambil(self):
        self.assertEqual(K.penggantian("mau punya cana", "mau punya celana"), [("cana", "celana")])
        self.assertEqual(K.penggantian("Icy Love Factory.", "Aysilla Factory."), [("icy love", "Aysilla")])

    def test_huruf_besar_tanda_baca_tambah_hapus_diabaikan(self):
        self.assertEqual(K.penggantian("Join Live sekarang yuk!!", "Join Live Sekarang Yuk!!"), [])
        self.assertEqual(K.penggantian("bagus banget", "bagus banget kak"), [])
        self.assertEqual(K.penggantian("ini bagus banget kak", "bagus banget"), [])

    def test_penggantian_terlalu_panjang_bukan_kamus(self):
        self.assertEqual(K.penggantian("a b c d e", "v w x y z"), [])


class Usulan(unittest.TestCase):
    def test_dua_kali_jadi_usulan_sekali_pantau(self):
        c = [kor("mau punya cana", "mau punya celana", "p1"), kor("cana nya adem", "celana nya adem", "p2"),
             kor("Icy Love Factory", "Aysilla Factory")]
        d = K.usulan(c)
        self.assertEqual([(e["salah"], e["benar"], e["jumlah"], e["proyek"]) for e in d["usulan"]], [("cana", "celana", 2, 2)])
        self.assertEqual([e["salah"] for e in d["pantau"]], ["icy love"])
        self.assertEqual(d["usulan"][0]["kosakata_baru"], ["celana"])

    def test_sudah_di_kamus_dilewati(self):
        c = [kor("cana", "celana"), kor("cana", "celana")]
        d = K.usulan(c, kamus={"Cana": "celana"}, kosakata=["celana"])
        self.assertEqual(d["usulan"], [])
        self.assertEqual(len(d["sudah_di_kamus"]), 1)

    def test_kata_pendek_atau_dibiarkan_tim_ditandai_periksa(self):
        c = [kor("ini los", "ini loose"), kor("pakai los", "pakai loose"), kor("pakai los ya", "pakai los ya kak")]
        e = K.usulan(c)["usulan"][0]
        self.assertTrue(e["periksa"])
        self.assertEqual(len(e["alasan_periksa"]), 2)

    def test_cli_dengan_brand_kit_export(self):
        with tempfile.TemporaryDirectory() as d:
            b = Path(d) / "belajar.jsonl"
            baris = [kor("cana", "celana"), kor("cana", "celana"), {"jenis": "revisi_pic", "note": "x"}]
            b.write_text("\n".join(json.dumps(x) for x in baris) + "\nrusak{\n", encoding="utf-8")
            bk = Path(d) / "bk.json"
            bk.write_text(json.dumps({"teks": {"kamus": {}, "kosakata_whisper": []}}), encoding="utf-8")
            import subprocess
            r = subprocess.run([sys.executable, str(Path(K.__file__)), str(b), "--brand-kit", str(bk)],
                               capture_output=True, text=True, encoding="utf-8")
            out = json.loads(r.stdout)
            self.assertEqual(out["schema"], "kamus-usulan/1")
            self.assertEqual(out["koreksi_kata"], 2)
            self.assertEqual(out["usulan"][0]["salah"], "cana")


if __name__ == "__main__":
    unittest.main()
