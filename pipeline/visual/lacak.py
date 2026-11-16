"""R24c Motion tracking: kotak pilihan user -> jalur-posisi/1 (OpenCV CSRT / KCF, opencv-contrib di visual-venv).

  python pipeline/visual/lacak.py <video> <keluar.json> --kotak x,y,w,h [--mulai 0] [--sampai dtk] [--alat csrt|kcf] [--hz 15]

- `--kotak` = pecahan frame (kiri-atas + lebar/tinggi) pada waktu `--mulai`, digambar user di app.
- Tracker jalan di SETIAP frame (perlu kontinuitas), frame diperkecil ke sisi panjang maks 640 px (cepat, Idle);
  titik disimpan `hz` per detik. Saat tracker kehilangan objek: titik tidak ditulis (celah, app tidak menempel),
  dicoba lagi tiap frame; lebih dari 2 dtk hilang = berhenti.
- Hasil = USULAN (hybrid): app memakainya untuk teks/stiker/blur yang ikut objek; user boleh geser/hapus titik.
- CSRT (bawaan) lebih akurat; KCF lebih cepat tetapi mudah lepas saat objek berubah ukuran.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import beban  # noqa: E402

beban.siapkan_env()

import json  # noqa: E402

from jalur_posisi import SCHEMA, titik, validasi  # noqa: E402

SISI_MAKS = 640
MAKS_HILANG_DTK = 2.0


def buat_tracker(alat: str):
    import cv2
    nama = {"csrt": "TrackerCSRT", "kcf": "TrackerKCF"}[alat]
    for kandidat in (getattr(cv2, nama, None), getattr(getattr(cv2, "legacy", None), nama, None)):
        if kandidat is not None and hasattr(kandidat, "create"):
            return kandidat.create()
    f = getattr(cv2, f"{nama}_create", None)
    if f:
        return f()
    raise RuntimeError(f"OpenCV tanpa {nama} (perlu opencv-contrib di visual-venv)")


def kotak_dari(teks: str) -> tuple[float, float, float, float]:
    try:
        x, y, w, h = (float(v) for v in teks.split(","))
    except ValueError:
        raise beban.Ditolak("--kotak harus x,y,w,h (pecahan frame 0..1)") from None
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise beban.Ditolak("--kotak di luar frame")
    if w < 0.01 or h < 0.01:
        raise beban.Ditolak("--kotak terlalu kecil untuk dilacak (min 1% frame)")
    return x, y, w, h


def lacak(video: Path, kotak: tuple, mulai: float = 0.0, sampai: float | None = None, alat: str = "csrt",
          hz: float = 15.0, progres=beban.progres) -> dict:
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise beban.Ditolak(f"video tidak bisa dibuka: {video.name}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    durasi = n / fps if n else 0.0
    if mulai < 0 or (durasi and mulai >= durasi):
        raise beban.Ditolak("--mulai di luar durasi video")
    akhir = min(sampai if sampai is not None else durasi, durasi or 1e9)
    if akhir <= mulai:
        raise beban.Ditolak("--sampai harus sesudah --mulai")
    s = min(1.0, SISI_MAKS / max(W, H))
    w2, h2 = max(2, int(W * s)), max(2, int(H * s))
    beban.perkiraan("lacak", (akhir - mulai) * fps * (0.012 if alat == "csrt" else 0.004) + 2)

    i0 = int(round(mulai * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, i0)
    ok, frame = cap.read()
    if not ok:
        raise beban.Ditolak("frame awal tidak terbaca")
    kecil = cv2.resize(frame, (w2, h2), interpolation=cv2.INTER_AREA)
    x, y, w, h = kotak
    tr = buat_tracker(alat)
    tr.init(kecil, (int(x * w2), int(y * h2), max(2, int(w * w2)), max(2, int(h * h2))))
    titik2 = [titik(i0 / fps, x, y, w, h, 1.0)]
    tiap = max(1, int(round(fps / hz)))
    i, hilang_sejak, alasan = i0 + 1, None, "selesai"
    while True:
        t = i / fps
        if t > akhir + 1e-6:
            break
        ok, frame = cap.read()
        if not ok:
            break
        kecil = cv2.resize(frame, (w2, h2), interpolation=cv2.INTER_AREA)
        ok, b = tr.update(kecil)
        if ok and b[2] > 0 and b[3] > 0:
            hilang_sejak = None
            if (i - i0) % tiap == 0:
                titik2.append(titik(t, b[0] / w2, b[1] / h2, b[2] / w2, b[3] / h2, 1.0))
        else:
            hilang_sejak = hilang_sejak if hilang_sejak is not None else t
            if t - hilang_sejak > MAKS_HILANG_DTK:
                alasan = "objek hilang"
                break
        if (i - i0) % 30 == 0:
            progres("lacak", 5 + int(90 * (t - mulai) / max(1e-6, akhir - mulai)), f"{t:.1f}/{akhir:.1f} dtk")
        i += 1
    cap.release()
    return {"schema": SCHEMA, "video": None, "lebar": W, "tinggi": H, "fps": round(fps, 3), "durasi": round(durasi, 3),
            "sumber": f"lacak-{alat}", "usulan": True, "hz": hz, "berhenti": alasan,
            "jalur": [{"id": "lacak-1", "jenis": "lacak", "label": "pilihan", "titik": titik2}]}


def main() -> int:
    import argparse
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "batch"))
    from jalur import relatif
    ap = argparse.ArgumentParser(description="kotak pilihan -> jalur-posisi/1 (CSRT/KCF)")
    ap.add_argument("video")
    ap.add_argument("keluar")
    ap.add_argument("--kotak", required=True)
    ap.add_argument("--mulai", type=float, default=0.0)
    ap.add_argument("--sampai", type=float)
    ap.add_argument("--alat", default="csrt", choices=("csrt", "kcf"))
    ap.add_argument("--hz", type=float, default=15.0)
    a = ap.parse_args()
    try:
        if not 1 <= a.hz <= 60:
            raise beban.Ditolak("--hz harus 1..60")
        k = kotak_dari(a.kotak)
        beban.tunggu_ram()
        with beban.kunci_ai("lacak"):
            v = Path(a.video).resolve()
            doc = lacak(v, k, a.mulai, a.sampai, a.alat, a.hz)
            doc["video"] = relatif(v)
        salah = validasi(doc)
        if salah:
            raise RuntimeError("hasil tidak sah: " + "; ".join(salah[:3]))
        Path(a.keluar).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        beban.progres("selesai", 100, f"{len(doc['jalur'][0]['titik'])} titik ({doc['berhenti']})")
        return 0
    except beban.Ditolak as e:
        beban.progres("ditolak", 100, str(e))
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        beban.progres("gagal", 100, str(e)[:300])
        return 1


if __name__ == "__main__":
    sys.exit(main())
