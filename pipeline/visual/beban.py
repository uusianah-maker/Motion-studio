"""R24 aturan beban & lisensi Visual Tools (hasil cek sukma 16 Nov, KONTRAK §18.0). Tanpa dependensi.

PC kantor = server live:
- SATU job AI berat sekaligus di seluruh mesin (kunci file global; Whisper ikut bila pemanggilnya memakai `kunci_ai`).
- Proses sendiri prioritas Idle, maks 4 thread (OMP/MKL/onnxruntime/OpenCV), maks 2 pekerja.
- Tunggu bila RAM bebas < 3 GB.
- Klip video untuk AI berat (hapus latar / perjelas) maks 15 dtk; perkiraan waktu dikirim sebelum mulai.
- Cache model di D: (U2NET_HOME, HF_HOME), bukan C:.
- Model hapus latar: hanya daftar putih berlisensi komersial. bria-rmbg (bawaan rembg, non-komersial) DILARANG.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "batch"))
from jalur import TOOLS, venv_py  # noqa: E402  (MOTION_TOOLS_DIR, bawaan <DATA>/../tools)

FOLDER_MODEL = Path(os.environ.get("MOTION_MODELS_DIR") or TOOLS / "models")
VISUAL_PY = Path(os.environ.get("MOTION_VISUAL_PY") or venv_py(TOOLS / "visual-venv"))
MAKS_THREAD = 4
MAKS_PEKERJA = 2
RAM_MIN_GB = 3.0
MAKS_KLIP_DTK = 15.0
FILE_KUNCI = Path(os.environ.get("MOTION_AI_LOCK", str(FOLDER_MODEL / "ai-berat.lock")))

# Daftar putih model hapus latar (rembg) + lisensinya. Model lain ditolak.
MODEL_LATAR = {
    "birefnet-general-lite": "MIT",
    "isnet-general-use": "Apache-2.0",
    "u2net": "Apache-2.0",
    "u2netp": "Apache-2.0",
    "u2net_human_seg": "Apache-2.0",
    "silueta": "Apache-2.0",
}
MODEL_LATAR_BAWAAN = "birefnet-general-lite"


class Ditolak(Exception):
    pass


def model_latar(nama: str | None) -> str:
    """Nama model hapus latar yang boleh. Wajib eksplisit di kode: None = bawaan kita (bukan bawaan rembg)."""
    n = (nama or MODEL_LATAR_BAWAAN).strip().lower()
    if n not in MODEL_LATAR:
        raise Ditolak(f"model hapus latar '{n}' tidak diizinkan (lisensi); pilih: {', '.join(MODEL_LATAR)}")
    return n


def siapkan_env() -> None:
    """Dipanggil PALING AWAL (sebelum import numpy/onnxruntime/cv2/mediapipe)."""
    FOLDER_MODEL.mkdir(parents=True, exist_ok=True)
    os.environ["U2NET_HOME"] = str(FOLDER_MODEL)
    os.environ["HF_HOME"] = str(FOLDER_MODEL / "hf")
    os.environ.setdefault("MEDIAPIPE_DISABLE_GPU", "1")
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "ORT_NUM_THREADS"):
        os.environ[k] = str(MAKS_THREAD)
    prioritas_idle()


def prioritas_idle() -> None:
    """Proses SENDIRI ke prioritas Idle (tidak menyentuh proses lain)."""
    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x40)
    else:
        try:
            os.nice(19)
        except OSError:
            pass


def ram_bebas_gb() -> float:
    if os.name == "nt":
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS()
        m.dwLength = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullAvailPhys / 1024 ** 3
    try:
        for baris in Path("/proc/meminfo").read_text().splitlines():
            if baris.startswith("MemAvailable:"):
                return int(baris.split()[1]) / 1024 ** 2
    except OSError:
        pass
    return 99.0


def progres(tahap: str, persen: int, pesan: str = "", **lain) -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan, **lain}, ensure_ascii=False), flush=True)


def tunggu_ram(min_gb: float = RAM_MIN_GB, maks_dtk: float = 1800, jeda: float = 10, baca=ram_bebas_gb) -> None:
    mulai = time.monotonic()
    while (b := baca()) < min_gb:
        if time.monotonic() - mulai > maks_dtk:
            raise RuntimeError(f"RAM bebas {b:.1f} GB < {min_gb} GB selama {maks_dtk:.0f} dtk")
        progres("menunggu", 0, f"RAM bebas {b:.1f} GB, menunggu minimal {min_gb:.0f} GB")
        time.sleep(jeda)


def _pid_hidup(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        kode = ctypes.c_ulong()
        k32.GetExitCodeProcess(h, ctypes.byref(kode))
        k32.CloseHandle(h)
        return kode.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


@contextmanager
def kunci_ai(nama: str, maks_tunggu: float = 3600, jeda: float = 5, file: Path | None = None):
    """Kunci global SATU job AI berat. File kunci berisi pid; kunci basi (pid mati) diambil alih."""
    f = Path(file or FILE_KUNCI)
    f.parent.mkdir(parents=True, exist_ok=True)
    mulai = time.monotonic()
    while True:
        try:
            fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, json.dumps({"pid": os.getpid(), "job": nama, "mulai": time.time()}).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                isi = json.loads(f.read_text(encoding="utf-8") or "{}")
            except (OSError, ValueError):
                isi = {}
            if not _pid_hidup(int(isi.get("pid", 0))):
                try:
                    f.unlink()
                except OSError:
                    pass
                continue
            if time.monotonic() - mulai > maks_tunggu:
                raise RuntimeError(f"job AI lain ({isi.get('job')}) masih jalan lebih dari {maks_tunggu:.0f} dtk")
            progres("antre", 0, f"menunggu job AI lain selesai ({isi.get('job', '?')})")
            time.sleep(jeda)
    try:
        yield
    finally:
        try:
            if json.loads(f.read_text(encoding="utf-8")).get("pid") == os.getpid():
                f.unlink()
        except (OSError, ValueError):
            pass


def cek_durasi_klip(durasi: float, maks: float = MAKS_KLIP_DTK) -> None:
    if durasi > maks + 1e-6:
        raise Ditolak(f"klip {durasi:.1f} dtk terlalu panjang untuk AI berat (maks {maks:.0f} dtk); potong dulu")


def perkiraan(tahap: str, detik: float, pesan: str = "") -> None:
    """Perkiraan waktu dikirim SEBELUM mulai (app menampilkan ke user)."""
    progres(tahap, 1, pesan or f"perkiraan ±{max(1, round(detik / 60))} menit", perkiraan_dtk=round(detik))


if __name__ == "__main__":  # cek cepat
    siapkan_env()
    print(json.dumps({"ram_bebas_gb": round(ram_bebas_gb(), 1), "models": str(FOLDER_MODEL)}))
    sys.exit(0)
