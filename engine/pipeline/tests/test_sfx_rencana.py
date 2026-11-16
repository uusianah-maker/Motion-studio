"""R29 SFX lebih banyak: .venv/Scripts/python -m unittest pipeline/tests/test_sfx_rencana.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sfx_rencana as S  # noqa: E402
from jaga_ops import SISA_MS  # noqa: E402


def aset_kenney():
    a = []
    for kat, durs in {"switch": [504, 620, 620], "minimize": [222, 245, 380], "maximize": [228, 387, 428],
                      "pluck": [181], "drop": [199, 202], "select": [385], "toggle": [141, 158],
                      "glass": [129, 292], "confirmation": [324, 501], "close": [327], "open": [316],
                      "scratch": [161], "error": [205], "click": [19]}.items():
        for i, d in enumerate(durs):
            a.append({"kunci": f"$sfx:kny-{kat}-{i:03d}", "jenis": "sfx", "tag": ["kenney", kat], "lisensi_iklan": True,
                      "durasi_ms": d})
    return a


def timeline(total_ms=30000, potong_tiap=2000, halaman_tiap=1000, kata=None):
    ops = [{"op": "add_clip", "track_kind": "video", "start_ms": t, "duration_ms": potong_tiap}
           for t in range(0, total_ms, potong_tiap)]
    for t in range(0, total_ms - 1000, halaman_tiap):
        w = [{"text": "kak", "start_ms": 0, "end_ms": 300}, {"text": "bagus", "start_ms": 300, "end_ms": 700}]
        ops.append({"op": "add_clip", "track_kind": "subtitle", "start_ms": t, "duration_ms": halaman_tiap, "words": w,
                    "style": {}})
    for t, teks in (kata or []):
        ops.append({"op": "add_clip", "track_kind": "subtitle", "start_ms": t, "duration_ms": 900, "style": {"highlight": {"words": [teks.lower()]}},
                    "words": [{"text": teks, "start_ms": 100, "end_ms": 500}]})
    return ops


def sfx(ops):
    return sorted((o for o in ops if o.get("track_kind") == "sfx"), key=lambda o: o["start_ms"])


class Kepadatan(unittest.TestCase):
    def test_tanpa_tidak_ada_sfx_dan_sfx_lama_dibuang(self):
        ops = timeline() + [{"op": "add_clip", "track_kind": "sfx", "media": "$sfx:x", "start_ms": 0, "duration_ms": 200}]
        baru, lap = S.pasang(ops, aset_kenney(), 30000, hook_ms=0, kepadatan="tanpa")
        self.assertEqual(sfx(baru), [])
        self.assertEqual(lap["jumlah"], 0)

    def test_batas_tiap_tingkat(self):
        hasil = {}
        for k, aturan in S.KEPADATAN.items():
            if not aturan:
                continue
            baru, _ = S.pasang(timeline(), aset_kenney(), 30000, hook_ms=0, cta_ms=27000, kepadatan=k, seed="a")
            s = sfx(baru)
            hasil[k] = len(s)
            self.assertLessEqual(len(s), 30000 // aturan["per"] + 1, k)
            for a, b in zip(s, s[1:]):
                if not (b["media"] and a["start_ms"] + S.RISER_MAJU in (b["start_ms"], b["start_ms"] - 60)):
                    self.assertGreaterEqual(b["start_ms"] - a["start_ms"], aturan["jarak"], (k, a, b))
                self.assertLessEqual(a["start_ms"] + a["duration_ms"], b["start_ms"])  # track sfx tidak tumpang tindih
        self.assertLess(hasil["sedikit"], hasil["sedang"])
        self.assertLess(hasil["sedang"], hasil["ramai"])
        self.assertGreaterEqual(hasil["sedang"], 8)  # owner: SFX harus terasa (dulu 1 per video)

    def test_bawaan_sedang_dan_dari_preset(self):
        self.assertEqual(S.kepadatan_dari({}), "sedang")
        self.assertEqual(S.kepadatan_dari({"sfx": {"kepadatan": "Ramai"}}), "ramai")
        self.assertEqual(S.kepadatan_dari({"sfx": {"kepadatan": "aneh"}}), "sedang")


class Pilihan(unittest.TestCase):
    def test_variasi_tidak_mengulang_file_berturut_turut(self):
        baru, lap = S.pasang(timeline(), aset_kenney(), 30000, hook_ms=0, seed="v")
        media = [o["media"] for o in sfx(baru)]
        for i in range(len(media)):
            self.assertNotIn(media[i], media[max(0, i - 3):i], media)
        self.assertGreaterEqual(lap["berbeda"], len(media) - 1)

    def test_bunyi_negatif_dan_terlalu_pendek_tidak_dipakai(self):
        baru, _ = S.pasang(timeline(), aset_kenney(), 30000, hook_ms=0)
        media = " ".join(o["media"] for o in sfx(baru))
        for x in ("scratch", "error", "click"):
            self.assertNotIn(x, media)
        for o in sfx(baru):
            self.assertGreaterEqual(o["duration_ms"], S.MIN_CLIP_MS)

    def test_durasi_klip_sudah_dikurangi_sisa_jaga_ops(self):
        aset = {a["kunci"]: a for a in aset_kenney()}
        baru, _ = S.pasang(timeline(potong_tiap=6000), aset_kenney(), 30000, hook_ms=0)
        for o in sfx(baru):
            self.assertLessEqual(o["duration_ms"], aset[o["media"]]["durasi_ms"] - SISA_MS)

    def test_sfx_dilarang_dan_tanpa_lisensi(self):
        aset = aset_kenney()
        aset[0]["lisensi_iklan"] = False
        baru, _ = S.pasang(timeline(), aset, 30000, hook_ms=0, dilarang=["switch"])
        self.assertFalse(any("switch" in o["media"] for o in sfx(baru)))

    def test_tanpa_library_pakai_bawaan_mesin(self):
        baru, lap = S.pasang(timeline(), [], 30000, hook_ms=0)
        self.assertTrue(sfx(baru))
        self.assertTrue(set(lap["bawaan_mesin"]) <= {"$sfx:pop", "$sfx:whoosh"})

    def test_volume_di_bawah_vo(self):
        baru, _ = S.pasang(timeline(), aset_kenney(), 30000, hook_ms=0, cta_ms=27000)
        self.assertTrue(all(0 < o["volume"] <= 0.5 for o in sfx(baru)))


class Kejadian(unittest.TestCase):
    def test_harga_kata_kunci_cta_dan_hook(self):
        ops = timeline(potong_tiap=30000, halaman_tiap=10000, kata=[(4000, "Rp99rb"), (9000, "adem"), (14000, "diskon")])
        ev = S.kejadian(ops, 30000, hook_ms=0, cta_ms=27000)
        jenis = {(j, t // 1000) for t, j, _ in ev}
        self.assertIn(("muncul", 0), jenis)
        self.assertIn(("harga", 4), jenis)
        self.assertIn(("pop", 9), jenis)
        self.assertIn(("harga", 14), jenis)
        self.assertIn(("cta", 27), jenis)
        baru, lap = S.pasang(ops, aset_kenney(), 30000, hook_ms=0, cta_ms=27000)
        dipakai = {d["jenis"] for d in lap["detail"]}
        self.assertTrue({"muncul", "harga", "pop", "cta"} <= dipakai, lap["detail"])

    def test_riser_hanya_bersama_pasangannya(self):
        ops = timeline(potong_tiap=30000, halaman_tiap=10000)
        baru, lap = S.pasang(ops, aset_kenney(), 30000, hook_ms=2000, cta_ms=27000)
        det = lap["detail"]
        for i, d in enumerate(det):
            if d["jenis"] == "riser":
                self.assertIn(det[i + 1]["jenis"], ("muncul", "cta"))
                self.assertAlmostEqual(det[i + 1]["detik"] - d["detik"], S.RISER_MAJU / 1000, delta=0.07)
        self.assertTrue(any(d["jenis"] == "riser" for d in det))

    def test_whoosh_maks_separuh_jatah(self):
        baru, lap = S.pasang(timeline(potong_tiap=1500), aset_kenney(), 30000, hook_ms=0)
        n = sum(1 for d in lap["detail"] if d["jenis"] == "whoosh")
        self.assertLessEqual(n, (30000 // 3000 + 2) // 2)
        self.assertGreater(lap["jumlah"], n)


if __name__ == "__main__":
    unittest.main()
