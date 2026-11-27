"""Keluhan owner 27 Nov: subtitle Batch Remix berisi karangan Whisper."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from karangan import bersihkan  # noqa: E402


def W(teks):
    return [{"text": t, "startMs": i * 100, "endMs": i * 100 + 90, "prob": 0.9} for i, t in enumerate(teks.split())]


def T(ws):
    return " ".join(w["text"] for w in ws)


class Karangan(unittest.TestCase):
    def test_ulang_x10_jadi_2(self):
        w = W("Guys, " + "aku baru aja, " * 10 + "nemuin celana basic")
        r = bersihkan(w, 2)
        self.assertEqual(T(w), "Guys, aku baru aja, aku baru aja, nemuin celana basic")
        self.assertEqual(r, {"ulang": 24})

    def test_lets_go(self):
        w = W("orang. " + "Let's go, " * 9 + "Let's go.")
        bersihkan(w, 2)
        self.assertEqual(T(w), "orang. Let's go, Let's go,")

    def test_ulang_wajar_tetap(self):
        w = W("mau di kusut, kusut, diremes -remes -remes balik rapi")
        bersihkan(w, 2)
        self.assertEqual(T(w), "mau di kusut, kusut, diremes -remes -remes balik rapi")

    def test_talking_head_3x_tetap(self):
        w = W("jadi ini, jadi ini, jadi ini, bagus")
        bersihkan(w, 3)
        self.assertEqual(T(w), "jadi ini, jadi ini, jadi ini, bagus")

    def test_penutup_youtube(self):
        w = W("harganya 200 ribu, Terima kasih telah menonton")
        r = bersihkan(w, 2)
        self.assertEqual(T(w), "harganya 200 ribu,")
        self.assertEqual(r, {"karangan": 4})

    def test_terima_kasih_biasa_tetap(self):
        w = W("terima kasih guys sudah mampir")
        self.assertEqual(bersihkan(w, 2), {})

    def test_deret_angka(self):
        w = W("5 .5 .5 .5 .4 Visi... Aysilla Factory, yang pertama")
        bersihkan(w, 2)
        self.assertEqual(T(w), "Visi... Aysilla Factory, yang pertama")

    def test_angka_harga_tetap(self):
        w = W("tinggi 150an, harga 89 ribu, 200 ribu, 300 ribu")
        self.assertEqual(bersihkan(w, 2), {})


if __name__ == "__main__":
    unittest.main()
