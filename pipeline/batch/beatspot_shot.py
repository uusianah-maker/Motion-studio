"""R16 Beat Spot: potong footage (orang jalan di mall) jadi shot per orang/adegan + label. Butuh OpenCV.

Pakai (Python Batch Remix, dipanggil beatspot.py):
  <BATCH_PY> pipeline/batch/beatspot_shot.py <keluar.json> <id>=<video> [<id>=<video> ...]
Menulis {"schema": "beatspot-shot/1", "footage": {id: {durasi}}, "shots": [...]}. Tanpa OCR / transkrip (cepat).

Per shot: id "<id>#NN", dari, sampai, orang (porsi sampel ada orang, HOG/wajah), framing, tajam, buram, beku,
gerak (rata-rata perubahan antar sampel: orang jalan = ada gerak), skor (untuk urutan pilihan).
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from beku import rentang_beku, shot_beku  # noqa: E402
from shotlib import AH, ada_orang, cut_shots  # noqa: E402

MAX_SHOT = 4.0  # orang tampil 1-4 dtk (contoh owner); shot panjang dipecah, sisa < 1 dtk digabung


def pecah(shots: list[tuple[float, float]], maks: float = MAX_SHOT) -> list[tuple[float, float]]:
    out = []
    for a, b in shots:
        n = max(1, int(np.ceil((b - a) / maks - 1e-6)))
        step = (b - a) / n
        out += [(round(a + i * step, 3), round(a + (i + 1) * step, 3)) for i in range(n)]
    return out


def label(rows, hadir, a, b, beku_rentang):
    idx = [i for i, r in enumerate(rows) if a <= r["t"] < b] or [min(range(len(rows)), key=lambda i: abs(rows[i]["t"] - a))]
    rs = [rows[i] for i in idx]
    orang = float(np.mean([hadir[i] for i in idx]))
    fh = [r["face_h"] for r in rs if r["face_h"] > 0]
    face_h = float(np.median(fh)) if fh else 0.0
    # Orang jalan dari jauh: wajah kecil / tidak terbaca, badan utuh terbaca HOG -> full_body.
    framing = "wajah_dekat" if face_h > 0.14 else ("medium" if face_h >= 0.07 else ("full_body" if orang >= 0.5 else "tanpa_orang"))
    tajam = float(np.median([r["tajam"] for r in rs]))
    gerak = float(np.mean([r["diff"] for r in rs[1:]])) if len(rs) > 1 else 0.0
    beku = shot_beku(a, b, beku_rentang)
    buram = tajam < 40
    skor = 2.0 * orang + (1.0 if framing == "full_body" else 0.4 if framing == "medium" else 0.0) \
        + min(gerak, 0.15) * 4 - (3 if buram or beku else 0)
    return {"orang": round(orang, 2), "framing": framing, "tajam": round(tajam, 1), "buram": bool(buram),
            "beku": bool(beku), "gerak": round(gerak, 3), "skor": round(skor, 2)}


SAMPEL_FPS = 3  # cukup untuk potongan >= 1 dtk; Shot Library Batch Remix memakai 5


def analisa_cepat(video: Path, fps_sampel: float = SAMPEL_FPS) -> tuple[list[dict], float]:
    """Seperti shotlib.analyse_video tapi satu kali baca lewat ffmpeg (tanpa lompat frame per sampel, yang
    sangat lambat di video panjang/4K): t, diff histogram, face_h/face_top, tajam, orang (HOG/wajah)."""
    import subprocess

    import cv2

    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                               capture_output=True, text=True).stdout.strip() or 0)
    w, h = 288, 512
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-an", "-vf",
                             f"fps={fps_sampel},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
                             "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    rows, prev, i = [], None, 0
    while True:
        buf = proc.stdout.read(w * h * 3)
        if len(buf) < w * h * 3:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        diff = 0.0 if prev is None else float(cv2.compareHist(prev, hist, cv2.HISTCMP_BHATTACHARYYA))
        prev = hist
        faces = [f for f in cascade.detectMultiScale(gray, 1.1, 7, minSize=(14, 14)) if (f[1] + f[3] / 2) / h < 0.6]
        face = max(faces, key=lambda f: f[3]) if faces else None
        badan = hog.detectMultiScale(gray, winStride=(8, 8), scale=1.1)[0]
        rows.append({"t": round(i / fps_sampel, 3), "diff": diff, "face_h": float(face[3] / h) if face is not None else 0.0,
                     "face_top": float(face[1] / h) if face is not None else None, "mulut": None,
                     "tajam": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
                     "orang": bool(face is not None) or any(bh > 0.3 * h for (_, _, _, bh) in badan)})
        i += 1
    proc.wait()
    return rows, dur or i / fps_sampel


def analisis(fid: str, video: Path) -> tuple[dict, list[dict]]:
    rows, dur = analisa_cepat(video)
    if not rows:
        return {"durasi": round(dur, 3)}, []
    for r, h in zip(rows, ada_orang(rows)):
        r["hadir"] = h
    hadir = [r["hadir"] for r in rows]
    shots = pecah(cut_shots(rows, dur, pakai_orang=True))
    rb = rentang_beku(video)
    res = [{"id": f"{fid}#{k:02d}", "footage": fid, "dari": a, "sampai": b, **label(rows, hadir, a, b, rb)}
           for k, (a, b) in enumerate(shots) if b - a >= 0.5]
    return {"durasi": round(dur, 3), "tinggi_analisis": AH}, res


def main(argv: list[str]) -> int:
    keluar, pasangan = Path(argv[0]), argv[1:]
    doc = {"schema": "beatspot-shot/1", "footage": {}, "shots": []}
    for i, p in enumerate(pasangan):
        fid, _, path = p.partition("=")
        meta, shots = analisis(fid, Path(path))
        doc["footage"][fid] = meta
        doc["shots"] += shots
        print(json.dumps({"tahap": "shot", "persen": 10 + int(50 * (i + 1) / len(pasangan)),
                          "pesan": f"{fid}: {len(shots)} shot"}), flush=True)
    keluar.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
