"""Daftar batch Batch Remix (read-only) untuk dropdown di Motion Studio (`engine daftar_batch`).

Pakai (dari D:\\VIBECODING\\remotion):
  .venv\\Scripts\\python pipeline\\batch\\daftar.py
Stdout: satu JSON {"schema": "daftar-batch/1", "batch": [...]}, diurutkan terbaru dulu. Tidak menulis apa pun.

Per batch:
  batch          nama folder (sama untuk konten/1-upload, 2-dipisah)
  upload         jumlah video di konten/1-upload/<batch>
  footage        jumlah video bisu hasil pisah
  vo             jumlah stem vokal (calon voice over)
  musik          jumlah stem musik
  dipisah        true kalau sudah ada hasil pisah; false = baru diunggah
  dipisah_pada   waktu file hasil pisah terbaru (epoch ms) atau null
  shot_library   true kalau shots.json ada; jumlah_shot, thumb (shot yang punya thumbnail)
  siap_batch     true kalau bisa dipakai sebagai batch gambar (ada video bisu + Shot Library)
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jalur import KONTEN  # noqa: E402  (R20: folder data MOTION_ENGINE_DATA, bawaan = repo)
EXT_VIDEO = {".mp4", ".mov"}


def _hitung(d: Path, ext: set[str]) -> int:
    return sum(1 for p in d.iterdir() if p.is_file() and p.suffix.lower() in ext) if d.is_dir() else 0


def info(nama: str) -> dict:
    up = KONTEN / "1-upload" / nama
    dp = KONTEN / "2-dipisah" / nama
    footage = _hitung(dp / "video-bisu", {".mp4"})
    mt = [p.stat().st_mtime for sub in ("video-bisu", "vokal", "musik") if (dp / sub).is_dir()
          for p in (dp / sub).iterdir() if p.is_file()]
    lib_path = dp / "shots.json"
    shots = []
    if lib_path.exists():
        try:
            shots = json.loads(lib_path.read_text(encoding="utf-8")).get("shots", [])
        except (json.JSONDecodeError, OSError):
            shots = []
    return {
        "batch": nama,
        "upload": _hitung(up, EXT_VIDEO),
        "footage": footage,
        "vo": _hitung(dp / "vokal", {".wav"}),
        "musik": _hitung(dp / "musik", {".wav"}),
        "dipisah": footage > 0,
        "dipisah_pada": int(max(mt) * 1000) if mt else None,
        "shot_library": lib_path.exists(),
        "jumlah_shot": len(shots),
        "thumb": sum(1 for s in shots if s.get("thumb")),
        "siap_batch": footage > 0 and lib_path.exists(),
    }


def daftar() -> list[dict]:
    nama = set()
    for sub in ("1-upload", "2-dipisah"):
        d = KONTEN / sub
        if d.is_dir():
            nama |= {p.name for p in d.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))}
    res = [info(n) for n in nama]
    return sorted(res, key=lambda r: (r["dipisah_pada"] or 0, r["batch"]), reverse=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"schema": "daftar-batch/1", "batch": daftar()}, ensure_ascii=False))
