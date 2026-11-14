"""Jalur bersama Batch Remix (tanpa dependensi): root repo, Python tiap venv, nama aman.

Windows (PC kantor) dan Linux (VPS jalur B) sama-sama didukung:
  MOTION_BATCH_PY    path Python yang punya Demucs + OpenCV (default: venv demucs di D:\\VIBECODING\\tools)
  MOTION_BATCH_VENV  folder venv itu (dipakai kalau MOTION_BATCH_PY kosong)
Python utama (Whisper, transcribe.py) = <root>/.venv.
"""

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
KONTEN = ROOT / "konten"


def venv_py(venv: Path) -> Path:
    """Python di dalam venv: Scripts/python.exe (Windows) atau bin/python (Linux/macOS)."""
    for c in (venv / "Scripts" / "python.exe", venv / "bin" / "python"):
        if c.exists():
            return c
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def batch_py() -> Path:
    if os.environ.get("MOTION_BATCH_PY"):
        return Path(os.environ["MOTION_BATCH_PY"])
    return venv_py(Path(os.environ.get("MOTION_BATCH_VENV", r"D:\VIBECODING\tools\demucs-venv")))


MAIN_PY = venv_py(ROOT / ".venv")
BATCH_PY = batch_py()


def relatif(p: Path) -> str:
    """Path relatif ke root repo dengan '/' (portabel Windows/Linux); di luar root tetap absolut."""
    p = Path(p).resolve()
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def nama_aman(stem: str, maks: int = 40) -> str:
    """Nama footage yang diterima Motion Studio (^[A-Za-z0-9_.-]{1,40}$): karakter lain jadi '_'."""
    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", stem).strip("._") or "video"
    return s[:maks].rstrip("._") or "video"
