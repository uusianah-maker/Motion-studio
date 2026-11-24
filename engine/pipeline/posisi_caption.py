"""Posisi caption otomatis yang tidak menutup wajah (V4d).

Uji 13 Nov 2026: posisi caption dipukul rata (bawah 0.72 / atas 0.36), sehingga di
beberapa video caption menutup wajah atau produk. Modul ini mengambil sampel frame
(1 per detik), mendeteksi wajah (MediaPipe di visual-venv bila ada, cadangan OpenCV Haar; lokal, gratis), lalu memilih pusat
vertikal caption yang paling jarang mengenai wajah, tidak masuk 15% bawah (tombol
TikTok/Reels), dan menghindari area produk kalau brief menyebutnya.

Pakai:
  .venv\\Scripts\\python pipeline\\posisi_caption.py public\\masuk\\a3.mp4 [--produk bawah]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

LEBAR, TINGGI = 270, 480  # resolusi sampel (9:16)
SETENGAH_TINGGI = 0.07  # perkiraan setengah tinggi blok caption (0..1 tinggi frame)
KANDIDAT = [0.72, 0.66, 0.60, 0.42, 0.36, 0.30]
BATAS_BAWAH = 0.85  # 15% bawah = tombol platform
MIN_KENA = 0.10  # < 10% frame dianggap salah deteksi
AREA_PRODUK = {"bawah": (0.50, 0.95), "atas": (0.20, 0.60), "penuh": (0.20, 0.95)}


def _durasi(video: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out or 0)


def sampel_frame(video: str, tiap_detik: float = 1.0, maks: int = 90):
    """Frame abu-abu LEBARxTINGGI tiap `tiap_detik`, langsung dari ffmpeg (tanpa file sementara)."""
    fps = 1.0 / tiap_detik
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video, "-vf",
         f"fps={fps},scale={LEBAR}:{TINGGI}:force_original_aspect_ratio=disable,format=gray",
         "-frames:v", str(maks), "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout
    n = len(raw) // (LEBAR * TINGGI)
    return np.frombuffer(raw[: n * LEBAR * TINGGI], dtype=np.uint8).reshape(n, TINGGI, LEBAR)


def deteksi_wajah(frames):
    """Per frame: daftar kotak wajah (y0, y1) dalam 0..1 tinggi frame."""
    import cv2

    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    hasil = []
    for f in frames:
        boxes = det.detectMultiScale(f, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
        # Wajah + sedikit ruang (dagu/rambut): perbesar 25% ke atas & bawah.
        hasil.append([(max(0.0, (y - 0.25 * h) / TINGGI), min(1.0, (y + 1.25 * h) / TINGGI)) for (x, y, w, h) in boxes])
    return hasil


def _tumpang(a0, a1, b0, b1) -> bool:
    return a0 < b1 and b0 < a1


def pilih_y(wajah_per_frame, default: float = 0.72, area_produk: str | None = None):
    """Pilih pusat caption. Hasil: (y, laporan)."""
    n = max(len(wajah_per_frame), 1)
    produk = AREA_PRODUK.get(area_produk or "")
    terbaik = None
    laporan = []
    # Posisi preset (§17.1 caption.y, mis. 0.76) ikut dicoba walau tidak ada di daftar kandidat.
    for y in sorted(set(KANDIDAT) | {round(default, 3)}, reverse=True):
        y0, y1 = y - SETENGAH_TINGGI, y + SETENGAH_TINGGI
        if y1 > BATAS_BAWAH:
            continue
        kena = sum(1 for boxes in wajah_per_frame if any(_tumpang(y0, y1, a, b) for a, b in boxes)) / n
        if kena < MIN_KENA:
            kena = 0.0  # deteksi sesekali = kemungkinan salah deteksi, abaikan
        kena_produk = 1.0 if produk and _tumpang(y0, y1, *produk) else 0.0
        skor = kena * 10 + kena_produk * 5 + abs(y - default)
        laporan.append({"y": y, "kenaWajah": round(kena, 2), "kenaProduk": kena_produk, "skor": round(skor, 2)})
        if terbaik is None or skor < terbaik[1]:
            terbaik = (y, skor)
    ada_wajah = sum(1 for b in wajah_per_frame if b) / n
    return terbaik[0], {"frameDenganWajah": round(ada_wajah, 2), "kandidat": laporan}


# R24a (venus 16 Nov): MediaPipe (visual-venv) bila tersedia — lebih akurat untuk wajah berhijab/miring/agak jauh;
# Haar tetap jadi cadangan (visual-venv tidak ada, gagal, atau terlalu lama karena antre kunci AI).
_DATA = Path(os.environ["MOTION_ENGINE_DATA"]).resolve() if os.environ.get("MOTION_ENGINE_DATA") else Path(__file__).resolve().parents[1]
_TOOLS = Path(os.environ["MOTION_TOOLS_DIR"]).resolve() if os.environ.get("MOTION_TOOLS_DIR") else _DATA.parent / "tools"
VISUAL_PY = os.environ.get("MOTION_VISUAL_PY") or str(next(
    (p for p in (_TOOLS / "visual-venv" / "Scripts" / "python.exe", _TOOLS / "visual-venv" / "bin" / "python") if p.exists()),
    _TOOLS / "visual-venv" / "Scripts" / "python.exe"))
DETEKSI = Path(__file__).resolve().parent / "visual" / "deteksi.py"
BATAS_MP_DTK = 120


def wajah_mediapipe(video: str, tiap_detik: float, maks: int = 90):
    """Kotak wajah (y0, y1) per sampel waktu k*tiap_detik dari jalur-posisi MediaPipe, atau None (pakai Haar)."""
    if os.environ.get("MOTION_POSISI_HAAR") or not Path(VISUAL_PY).exists() or not DETEKSI.exists():
        return None
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "jalur.json"
        try:
            r = subprocess.run([VISUAL_PY, str(DETEKSI), video, str(out), "--jenis", "wajah", "--hz", f"{1 / tiap_detik:.4f}"],
                               capture_output=True, timeout=BATAS_MP_DTK,
                               creationflags=0x40 if sys.platform == "win32" else 0)
        except (subprocess.TimeoutExpired, OSError):
            return None
        if r.returncode != 0 or not out.exists():
            return None
        doc = json.loads(out.read_text(encoding="utf-8"))
    n = min(maks, int(doc.get("durasi", 0) / tiap_detik) + 1)
    hasil = [[] for _ in range(max(n, 1))]
    for j in doc.get("jalur", []):
        for p in j["titik"]:
            k = round(p["t"] / tiap_detik)
            if 0 <= k < len(hasil) and abs(p["t"] - k * tiap_detik) <= tiap_detik / 2:
                # sama dengan Haar: wajah + 25% ruang ke atas & bawah (dagu/rambut/hijab)
                hasil[k].append((max(0.0, p["y"] - 0.25 * p["h"]), min(1.0, p["y"] + 1.25 * p["h"])))
    return hasil


def posisi_otomatis(video: str, default: float = 0.72, area_produk: str | None = None):
    tiap = 1.0 if _durasi(video) <= 90 else _durasi(video) / 90
    wajah = wajah_mediapipe(video, tiap)
    metode = "mediapipe"
    if wajah is None:
        wajah, metode = deteksi_wajah(sampel_frame(video, tiap_detik=tiap)), "haar"
    y, lap = pilih_y(wajah, default, area_produk)
    lap["deteksi"] = metode
    return y, lap


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--produk", choices=list(AREA_PRODUK), help="letak produk di frame (dari brief)")
    args = ap.parse_args()
    y, lap = posisi_otomatis(args.video, area_produk=args.produk)
    print(f"caption y={y}  wajah di {lap['frameDenganWajah']:.0%} frame")
    print(json.dumps(lap["kandidat"]))


if __name__ == "__main__":
    main()
