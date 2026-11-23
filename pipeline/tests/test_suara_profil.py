"""R31 §23: .venv/Scripts/python -m unittest pipeline/tests/test_suara_profil.py"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

PIPE = Path(__file__).resolve().parents[1]
SR = 16000


def ucapan(detik: float, jeda: float, musik: bool = False, seed: int = 1) -> np.ndarray:
    """'Ucapan' sintetis: semburan 0,8 dtk (nada + derau berubah) dipisah jeda panjang; opsional musik latar."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * detik)) / SR
    x = np.zeros_like(t)
    pos = 0.3
    while pos + 0.8 < detik:
        a, b = int(pos * SR), int((pos + 0.8) * SR)
        f0 = rng.uniform(110, 220)
        x[a:b] = 0.3 * np.sin(2 * np.pi * f0 * t[a:b]) * np.hanning(b - a) + 0.05 * rng.standard_normal(b - a)
        pos += 0.8 + jeda
    x += 0.0005 * rng.standard_normal(len(t))  # lantai derau ruangan sunyi
    if musik:
        x += 0.08 * (np.sin(2 * np.pi * 440 * t) + np.sin(2 * np.pi * 554 * t))
    return x.astype(np.float32)


def tulis(p: Path, x: np.ndarray) -> Path:
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return p


class SuaraProfil(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.data.mkdir()

    def jalan(self, cfg: dict, sumber: dict[str, Path]) -> tuple[int, dict]:
        j = self.tmp / "job"
        j.mkdir(exist_ok=True)
        (j / "job.json").write_text(json.dumps({"mode": "suara_profil", "suara_profil": cfg,
                                                "sumber": [{"kunci": k, "path": str(p)} for k, p in sumber.items()]}),
                                    encoding="utf-8")
        env = {**os.environ, "MOTION_ENGINE_DATA": str(self.data)}
        r = subprocess.run([sys.executable, str(PIPE / "engine.py"), "suara_profil", str(j)], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", env=env)
        lap = json.loads((j / "out" / "suara_profil.json").read_text(encoding="utf-8")) if (j / "out" / "suara_profil.json").exists() else {}
        self.last = r
        return r.returncode, lap

    def test_tambah_periksa_dedup_hapus_dan_kurang(self):
        bersih = tulis(self.tmp / "a.wav", ucapan(30, 2.0))
        bising = tulis(self.tmp / "b.wav", ucapan(20, 1.5, musik=True, seed=2))
        kode, lap = self.jalan({"tambah_contoh": ["$media:a", "$media:b"]}, {"$media:a": bersih, "$media:b": bising})
        self.assertEqual(kode, 0, self.last.stderr[-500:])
        c = {x["kunci"]: x for x in lap["contoh"]}
        self.assertTrue(c["$media:a"]["dipakai"], c["$media:a"])
        self.assertLess(c["$media:a"]["durasi_bersih"], 30 * 0.75)  # jeda 2 dtk dipendekkan ke 0,6
        self.assertGreater(c["$media:a"]["durasi_bersih"], 10)
        self.assertFalse(c["$media:b"]["dipakai"])  # musik latar
        self.assertIn("musik", c["$media:b"]["alasan"])
        self.assertEqual(lap["status"], "kurang_contoh")
        folder = self.data / "konten" / "suara" / "owner"
        self.assertEqual(len(list((folder / "contoh").glob("*.wav"))), 2)
        # file sama dikirim ulang: tidak diproses dua kali
        kode, lap = self.jalan({"tambah_contoh": ["$media:a"]}, {"$media:a": bersih})
        self.assertEqual(len(lap["contoh"]), 2)
        # latih dengan contoh kurang dari 5 menit: tetap kode 0, status kurang_contoh + alasan
        kode, lap = self.jalan({"latih": True}, {})
        self.assertEqual((kode, lap["status"]), (0, "kurang_contoh"))
        self.assertIn("minimal 5 menit", lap["alasan"])
        # hapus contoh
        kode, lap = self.jalan({"hapus_contoh": ["$media:b", "$media:tidak-ada"]}, {})
        self.assertEqual([x["kunci"] for x in lap["contoh"]], ["$media:a"])
        self.assertEqual(len(list((folder / "contoh").glob("*.wav"))), 1)

    def test_profil_terpisah_tidak_tercampur(self):
        a = tulis(self.tmp / "a.wav", ucapan(30, 2.0, seed=3))
        b = tulis(self.tmp / "b.wav", ucapan(30, 2.0, seed=4))
        kode, lap = self.jalan({"profil": "grace", "nama": "Nama Lain", "tambah_contoh": ["$media:a"]}, {"$media:a": a})
        self.assertEqual((kode, lap["profil"], lap["nama"]), (0, "grace", "Suara Grace"), self.last.stderr[-500:])
        kode, lap = self.jalan({"profil": "julia", "tambah_contoh": ["$media:b"]}, {"$media:b": b})
        self.assertEqual((kode, lap["profil"], [x["kunci"] for x in lap["contoh"]]), (0, "julia", ["$media:b"]))
        suara = self.data / "konten" / "suara"
        self.assertEqual(sorted(p.name for p in suara.iterdir()), ["grace", "julia"])  # owner tidak disentuh
        # rekaman Grace tidak boleh masuk profil lain, dan profil Niar tidak terbentuk isinya
        kode, lap = self.jalan({"profil": "niar", "tambah_contoh": ["$media:a"]}, {"$media:a": a})
        self.assertEqual(kode, 2)
        self.assertIn("grace", lap["alasan"])
        self.assertFalse((suara / "niar" / "profil.json").exists())

    def test_daftar_suara_per_profil(self):
        sys.path.insert(0, str(PIPE))
        code = (
            "import json,sys; sys.path.insert(0, sys.argv[1]); import tts; "
            "print(json.dumps([s['id'] for k in ('owner','grace','julia','niar') for s in tts.BACKEND[k].daftar()]))"
        )
        folder = self.data / "konten" / "suara" / "julia"
        folder.mkdir(parents=True)
        (folder / "profil.json").write_text(json.dumps({"profil": "julia", "nama": "Suara Julia", "versi_model": 1, "contoh": {}}), encoding="utf-8")
        niar = self.data / "konten" / "suara" / "niar"
        niar.mkdir(parents=True)
        (niar / "profil.json").write_text(json.dumps({"profil": "niar", "nama": "Suara Niar", "versi_model": 0, "contoh": {}}), encoding="utf-8")
        r = subprocess.run([sys.executable, "-c", code, str(PIPE)], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           env={**os.environ, "MOTION_ENGINE_DATA": str(self.data)})
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1]), ["julia:Suara Julia"])  # hanya profil yang siap

    def test_setelan_jeda_tidak_sah_ditolak(self):
        for cfg in ({"jeda_pukul": "25:00"}, {"jeda_pukul": "6"}, {"mulai_baru": "ya"}):
            kode, lap = self.jalan(cfg, {})
            self.assertEqual((kode, lap["status"]), (2, "ditolak"), self.last.stderr[-300:])
        kode, lap = self.jalan({"jeda_pukul": "06:00", "mulai_baru": False}, {})
        self.assertEqual(kode, 0, self.last.stderr[-300:])

    def test_status_dijeda_bertahan_di_job_berikutnya(self):
        f = self.data / "konten" / "suara" / "owner"
        f.mkdir(parents=True)
        (f / "profil.json").write_text(json.dumps({"schema": "suara-profil-data/1", "profil": "owner", "nama": "Suara owner", "contoh": {},
                                                   "versi_model": 0, "latihan_jeda": {"epoch": 120, "total_epoch": 150}}), encoding="utf-8")
        kode, lap = self.jalan({}, {})
        self.assertEqual((kode, lap["status"], lap["latihan_jeda"]["epoch"]), (0, "dijeda", 120), self.last.stderr[-300:])

    def test_ditolak(self):
        a = tulis(self.tmp / "a.wav", ucapan(5, 1.0))
        self.assertEqual(self.jalan({"profil": "talent"}, {})[0], 2)
        self.assertEqual(self.jalan({"tambah_contoh": ["$media:x"]}, {})[0], 2)
        bising = tulis(self.tmp / "m.wav", ucapan(10, 1.0, musik=True))
        kode, lap = self.jalan({"tambah_contoh": ["$media:m"], "latih": True}, {"$media:m": bising})
        self.assertEqual(kode, 2)
        self.assertIn("lolos mutu", lap["alasan"])
        self.assertTrue(a.exists())

    def test_owner_tidak_muncul_di_daftar_suara_sebelum_siap(self):
        sys.path.insert(0, str(PIPE))
        import tts
        self.assertEqual(tts.Owner().daftar(), [] if not tts.Owner()._profil() else tts.Owner().daftar())
        with self.assertRaises(tts.Ditolak):
            tts.urai_suara("talent:Budi")


if __name__ == "__main__":
    unittest.main()
