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
import shutil
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
        return {"aksi": "baru"}  # contoh/setelan berubah: progres lama memang tidak berlaku
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


def cadangkan(kerja: Path, exp: Path, epoch: int, muat: Callable[[Path], int] = baca_iterasi) -> None:
    """Salin G/D, buktikan salinannya utuh & epoch-nya benar, baru catat sebagai cadangan terakhir."""
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
    m = baca_manifest(kerja) or {}
    m["cadangan"] = {"epoch": epoch, "folder": nama, "sha_g": sha_g, "sha_d": sha_d, "waktu": time.strftime("%Y-%m-%dT%H:%M:%S")}
    tulis_manifest(kerja, m)
    lama = sorted(p for p in akar.iterdir() if p.is_dir() and p.name.startswith("e") and not p.name.endswith(".tmp"))
    for p in lama[:-SIMPAN_CADANGAN]:
        shutil.rmtree(p, ignore_errors=True)


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
        # Jeda di checkpoint terakhir yang masih sempat, bukan melewati jam yang diminta.
        return self.jeda_pada is not None and now + durasi >= self.jeda_pada
