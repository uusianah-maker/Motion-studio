import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from edit import plan_hook  # noqa: E402


def caps(kalimat: str):
    return [{"text": t, "startMs": i * 300, "endMs": i * 300 + 280} for i, t in enumerate(kalimat.split())]


class Hook(unittest.TestCase):
    def test_kalimat_pendek_utuh(self):
        h, note = plan_hook(caps("Males nyetrika celana? Ini solusinya."))
        self.assertEqual(h["text"], "Males nyetrika celana?")
        self.assertIsNone(note)

    def test_pilih_potongan_dengan_kata_kunci_di_akhir_kalimat(self):
        k = "Sekarang aku mau buktiin gimana hasil magic dari celana korset ini. Lihat ya."
        h, _ = plan_hook(caps(k), ["celana korset"])
        self.assertEqual(h["text"], "Hasil magic dari celana korset ini")

    def test_tidak_berhenti_di_kata_sambung(self):
        k = "Salah satu yang bikin tampilan bumper ke bulet, padet, naik, pinggang ramping, yaitu korset ini."
        h, _ = plan_hook(caps(k), ["pinggang", "korset"])
        self.assertEqual(h["text"], "Pinggang ramping yaitu korset ini")
        self.assertNotIn(h["text"].split()[-1].lower(), {"yang", "dan", "buat", "untuk"})

    def test_maks_enam_kata(self):
        k = "Jadi ini tuh celana yang paling sering aku pakai buat kerja karena adem banget dan nggak kusut."
        h, _ = plan_hook(caps(k), ["adem", "kusut"])
        self.assertLessEqual(len(h["text"].split()), 6)
        self.assertGreaterEqual(len(h["text"].split()), 3)

    def test_hook_maks_3_detik(self):
        h, _ = plan_hook(caps("Kalian pernah gak sih males banget nyetrika celana tiap pagi sebelum kerja?"))
        self.assertLessEqual(h["endMs"], 3000)


if __name__ == "__main__":
    unittest.main()
