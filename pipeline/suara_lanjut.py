"""§25 mode lanjut latihan Applio: cadangan checkpoint, keputusan lanjut/baru, jeda aman. Tanpa GPU.

Aturan:
- Progres hanya dilanjutkan bila contoh + setelan sama (`sidik`) dan cadangan G/D terbukti utuh.
- Cadangan dibuat setelah Applio mencetak epoch N+1: baris epoch N dicetak SEBELUM checkpoint N ditulis,
  jadi baru pada N+1 file G/D pasti selesai ditulis.
- Checkpoint yang tidak terbaca = gagal keras. Applio sendiri diam-diam mulai dari epoch 1 kalau gagal memuat.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Callable

SETIAP_EPOCH = 10
NAMA_G = "G_2333333.pth"
NAMA_D = "D_2333333.pth"
SIMPAN_CADANGAN = 2


class CheckpointRusak(RuntimeError):
    """Progres ada tetapi tidak bisa dipercaya: jangan lanjut dan jangan hapus otomatis."""


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def sidik_latih(contoh: list[Path], batch: int, sr: int, backend: str = "applio") -> str:
    """Sidik isi contoh + setelan yang memengaruhi model. Urutan file tidak berpengaruh."""
    isi = sorted(_sha(p) for p in contoh)
    return hashlib.sha256(json.dumps([isi, batch, sr, backend]).encode("utf-8")).hexdigest()


def baca_iterasi(p: Path) -> int:
    """Epoch di dalam checkpoint. File rusak/tidak lengkap -> CheckpointRusak."""
    import torch
    c = None
    try:
        c = torch.load(str(p), map_location="cpu", weights_only=True, mmap=True)
        if not all(k in c for k in ("model", "optimizer", "iteration")):
            raise CheckpointRusak(f"{p.name}: isi checkpoint tidak lengkap")
        return int(c["iteration"])
    except CheckpointRusak:
        raise
    except Exception as e:  # noqa: BLE001
        raise CheckpointRusak(f"{p.name}: checkpoint tidak terbaca ({e})") from e
    finally:
        del c
        gc.collect()  # mmap Windows menahan file sampai dilepas


def _manifest(kerja: Path) -> Path:
    return kerja / "lanjut.json"


def baca_manifest(kerja: Path) -> dict | None:
    try:
        d = json.loads(_manifest(kerja).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise CheckpointRusak(f"lanjut.json tidak terbaca ({e})") from e
    return d if isinstance(d, dict) else None


def tulis_manifest(kerja: Path, d: dict) -> None:
    tmp = _manifest(kerja).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, _manifest(kerja))


def _cek_cadangan(kerja: Path, m: dict, muat: Callable[[Path], int]) -> int:
    c = m.get("cadangan")
    if not isinstance(c, dict):
        raise CheckpointRusak("catatan cadangan tidak lengkap")
    folder = kerja / "cadangan" / str(c.get("folder"))
    g, d = folder / "G.pth", folder / "D.pth"
    if not g.is_file() or not d.is_file():
        raise CheckpointRusak(f"file cadangan epoch {c.get('epoch')} hilang")
    if _sha(g) != c.get("sha_g") or _sha(d) != c.get("sha_d"):
        raise CheckpointRusak(f"sidik cadangan epoch {c.get('epoch')} tidak cocok")
    eg, ed = muat(g), muat(d)
    if eg != ed or eg != c.get("epoch"):
        raise CheckpointRusak(f"epoch cadangan tidak cocok (G {eg}, D {ed}, catatan {c.get('epoch')})")
    return eg


def putuskan(kerja: Path, exp: Path, sidik: str, total: int, muat: Callable[[Path], int] = baca_iterasi) -> dict:
    """{"aksi": "baru"} atau {"aksi": "lanjut", "epoch": N}. Progres yang meragukan -> CheckpointRusak."""
    if not kerja.exists():
        return {"aksi": "baru"}
    m = baca_manifest(kerja)
    ada_ckpt = bool(list(exp.glob("G_*.pth")) or list(exp.glob("D_*.pth")))
    if m is None:
        if ada_ckpt:
            raise CheckpointRusak("ada checkpoint tanpa catatan lanjut.json; pakai mulai_baru bila memang mau dari nol")
        return {"aksi": "baru"}
    if m.get("sidik") != sidik:
        if ada_ckpt or m.get("cadangan"):
            raise CheckpointRusak("contoh atau setelan berubah sejak latihan ini dimulai; progres tidak dihapus. "
                                  "Kembalikan contohnya, atau pakai mulai_baru bila memang mau dari nol")
        return {"aksi": "baru"}
    if not m.get("cadangan"):
        if ada_ckpt:
            raise CheckpointRusak("ada checkpoint yang belum tercadangkan; pakai mulai_baru bila memang mau dari nol")
        return {"aksi": "baru"}
    n = _cek_cadangan(kerja, m, muat)
    if n >= total:
        raise CheckpointRusak(f"cadangan epoch {n} sudah melewati target {total}")
    return {"aksi": "lanjut", "epoch": n}


def pulihkan(kerja: Path, exp: Path) -> int:
    """Salin cadangan terakhir ke folder Applio (atomik per file), buang G/D lain supaya tidak terpilih."""
    m = baca_manifest(kerja) or {}
    c = m["cadangan"]
    folder = kerja / "cadangan" / c["folder"]
    for pola in ("G_*.pth", "D_*.pth"):
        for p in exp.glob(pola):
            p.unlink()
    for asal, nama in ((folder / "G.pth", NAMA_G), (folder / "D.pth", NAMA_D)):
        tmp = exp / f"{nama}.tmp"
        shutil.copy2(asal, tmp)
        os.replace(tmp, exp / nama)
    return int(c["epoch"])


def _buat_cadangan(kerja: Path, exp: Path, epoch: int, muat: Callable[[Path], int]) -> dict:
    """Salin G/D ke cadangan/eNNNN dan buktikan salinannya utuh & epoch-nya benar."""
    akar = kerja / "cadangan"
    nama = f"e{epoch:04d}"
    tmp = akar / f"{nama}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    shutil.copy2(exp / NAMA_G, tmp / "G.pth")
    shutil.copy2(exp / NAMA_D, tmp / "D.pth")
    eg, ed = muat(tmp / "G.pth"), muat(tmp / "D.pth")
    if eg != epoch or ed != epoch:
        shutil.rmtree(tmp, ignore_errors=True)
        raise CheckpointRusak(f"checkpoint epoch {epoch} tidak cocok (G {eg}, D {ed})")
    sha_g, sha_d = _sha(tmp / "G.pth"), _sha(tmp / "D.pth")
    tujuan = akar / nama
    if tujuan.exists():
        shutil.rmtree(tujuan)
    os.replace(tmp, tujuan)
    return {"epoch": epoch, "folder": nama, "sha_g": sha_g, "sha_d": sha_d, "waktu": time.strftime("%Y-%m-%dT%H:%M:%S")}


def cadangkan(kerja: Path, exp: Path, epoch: int, muat: Callable[[Path], int] = baca_iterasi) -> None:
    """Cadangan baru dicatat setelah terbukti utuh; dua cadangan terakhir disimpan."""
    c = _buat_cadangan(kerja, exp, epoch, muat)
    m = baca_manifest(kerja) or {}
    m["cadangan"] = c
    tulis_manifest(kerja, m)
    akar = kerja / "cadangan"
    lama = sorted(p for p in akar.iterdir() if p.is_dir() and p.name.startswith("e") and not p.name.endswith(".tmp"))
    for p in lama[:-SIMPAN_CADANGAN]:
        shutil.rmtree(p, ignore_errors=True)


def perkiraan_blok(exp: Path) -> float | None:
    """Lama satu blok checkpoint dari waktu dua model `owner_<N>e_` terakhir yang berurutan."""
    ada = {}
    for p in exp.glob("owner_*e_*s.pth"):
        h = re.match(r"owner_(\d+)e_", p.name)
        if h:
            ada[int(h.group(1))] = p.stat().st_mtime
    urut = sorted(ada)
    for a, b in zip(reversed(urut[:-1]), reversed(urut[1:])):
        if b - a == SETIAP_EPOCH and ada[b] > ada[a]:
            return ada[b] - ada[a]
    return None


def sempat_checkpoint(sekarang: float, jeda_pada: float | None, dtk_blok: float | None) -> bool:
    """Apakah satu checkpoint lagi masih selesai sebelum jam jeda (+10% dan 2 menit untuk memuat model)."""
    if jeda_pada is None or not dtk_blok:
        return True
    return sekarang + dtk_blok * 1.1 + 120 < jeda_pada


def adopsi(kerja: Path, exp: Path, contoh: list[Path], batch: int, sr: int, total: int, epoch: int, sha: dict[str, str],
           muat: Callable[[Path], int] = baca_iterasi) -> dict:
    """Sekali jalan: daftarkan progres lama (tanpa lanjut.json) ke mode lanjut. Tidak menghapus apa pun."""
    if baca_manifest(kerja) is not None:
        raise CheckpointRusak("folder kerja sudah punya lanjut.json")
    if (kerja / "cadangan").exists():
        raise CheckpointRusak("folder cadangan sudah ada")
    g, d = exp / NAMA_G, exp / NAMA_D
    if not g.is_file() or not d.is_file():
        raise CheckpointRusak("G/D tidak ada")
    if _sha(g).lower() != sha[NAMA_G].lower() or _sha(d).lower() != sha[NAMA_D].lower():
        raise CheckpointRusak("SHA-256 G/D tidak cocok dengan cadangan terverifikasi")
    eg, ed = muat(g), muat(d)
    if eg != epoch or ed != epoch or epoch >= total:
        raise CheckpointRusak(f"epoch G/D tidak sesuai (G {eg}, D {ed}, diminta {epoch}, target {total})")
    data = sorted((kerja / "dataset").glob("*.wav"))
    if not data or sorted(_sha(p) for p in data) != sorted(_sha(p) for p in contoh):
        raise CheckpointRusak("contoh tidak sama dengan dataset latihan ini")
    c = _buat_cadangan(kerja, exp, epoch, muat)
    m = {"schema": "suara-lanjut/1", "sidik": sidik_latih(contoh, batch, sr), "total_epoch": total, "batch": batch,
         "adopsi": time.strftime("%Y-%m-%dT%H:%M:%S"), "dtk_blok": perkiraan_blok(exp), "cadangan": c}
    tulis_manifest(kerja, m)
    return m


def waktu_jeda(pukul: str | None, sekarang: float | None = None) -> float | None:
    """'06:00' -> epoch waktu kemunculan berikutnya (waktu lokal)."""
    if not pukul:
        return None
    jam, menit = (int(x) for x in pukul.split(":"))
    if not (0 <= jam <= 23 and 0 <= menit <= 59):
        raise ValueError("jeda_pukul harus HH:MM")
    t = time.time() if sekarang is None else sekarang
    lt = time.localtime(t)
    target = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, jam, menit, 0, 0, 0, -1))
    if target <= t:
        lt2 = time.localtime(t + 86400)
        target = time.mktime((lt2.tm_year, lt2.tm_mon, lt2.tm_mday, jam, menit, 0, 0, 0, -1))
    return target


class Penjaga:
    """Dipanggil tiap baris epoch Applio. True = cadangan aman sudah ada dan latihan harus dijeda sekarang."""

    def __init__(self, kerja: Path, exp: Path, total: int, mulai_dari: int = 0, jeda_pada: float | None = None,
                 muat: Callable[[Path], int] = baca_iterasi, jam: Callable[[], float] = time.time):
        self.kerja, self.exp, self.total, self.mulai_dari = kerja, exp, total, mulai_dari
        self.jeda_pada, self.muat, self.jam = jeda_pada, muat, jam
        self.pertama = True
        self.epoch_aman = mulai_dari
        self.t_terakhir = jam()

    def __call__(self, e: int) -> bool:
        if self.pertama:
            self.pertama = False
            if self.mulai_dari and e != self.mulai_dari + 1:
                raise CheckpointRusak(f"Applio tidak melanjutkan dari epoch {self.mulai_dari} (mulai di epoch {e})")
        n = e - 1
        if n <= self.mulai_dari or n % SETIAP_EPOCH or e > self.total:
            return False
        cadangkan(self.kerja, self.exp, n, self.muat)
        self.epoch_aman = n
        now = self.jam()
        durasi = now - self.t_terakhir  # lama satu blok checkpoint
        self.t_terakhir = now
        m = baca_manifest(self.kerja) or {}
        m["dtk_blok"] = round(durasi, 1)
        tulis_manifest(self.kerja, m)
        # Jeda di checkpoint terakhir yang masih sempat, bukan melewati jam yang diminta.
        return self.jeda_pada is not None and now + durasi >= self.jeda_pada


if __name__ == "__main__":
    # suara_lanjut.py adopsi <kerja> <sha256.json> <epoch> <total> <batch> <sr> <contoh.wav>...  (jalankan dengan suara-venv)
    if len(sys.argv) < 9 or sys.argv[1] != "adopsi":
        print("pakai: suara_lanjut.py adopsi <kerja> <sha256.json> <epoch> <total> <batch> <sr> <contoh.wav>...", file=sys.stderr)
        sys.exit(1)
    _kerja = Path(sys.argv[2])
    _sha_json = {x["nama"]: x["sha256"] for x in json.loads(Path(sys.argv[3]).read_text(encoding="utf-8-sig"))}
    _hasil = adopsi(_kerja, _kerja / "logs" / "owner", [Path(x) for x in sys.argv[8:]], int(sys.argv[6]), int(sys.argv[7]),
                    int(sys.argv[5]), int(sys.argv[4]), _sha_json)
    print(json.dumps({"adopsi": "ok", "epoch": _hasil["cadangan"]["epoch"], "dtk_blok": _hasil["dtk_blok"]}))
