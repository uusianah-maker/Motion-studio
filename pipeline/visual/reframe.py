"""R24b Auto reframe / Smart crop (pola AutoFlip Google), tanpa dependensi.

Masukan: jalur-posisi/1 (R24a/R24c). Keluaran: reframe/1 = KEYFRAME crop yang bisa diedit manual (hybrid),
BUKAN video jadi. Koordinat = pecahan frame sumber; x, y = kiri-atas jendela crop.

{
  "schema": "reframe/1", "rasio": "9:16", "lebar_crop": 0.3164, "tinggi_crop": 1.0,
  "mode": "diam" | "ikut" | "tengah",   # diam = satu posisi cukup; ikut = kamera mengikuti; tengah = tanpa subjek
  "subjek": "wajah-1" | null, "usulan": true,
  "keyframe": [{"t": 0.0, "x": 0.41, "y": 0.0}, ...]   # interpolasi linear di antara keyframe
}

Langkah (seperti AutoFlip): pilih subjek dominan -> posisi ideal per sampel -> bila semua muat di satu
jendela = diam; bila tidak: zona mati (kamera tidak goyang untuk gerak kecil) + batas kecepatan pan +
penghalusan -> disederhanakan (Ramer-Douglas-Peucker) jadi sedikit keyframe yang enak diedit.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jalur_posisi import kotak_di, subjek_utama  # noqa: E402

SCHEMA = "reframe/1"
HZ = 10.0            # sampel per detik
RUANG_KEPALA = 0.38  # pusat wajah di 38% tinggi jendela (sedikit ruang di atas kepala)
ZONA_MATI = 0.06     # pecahan frame: gerak subjek lebih kecil dari ini tidak menggerakkan kamera
MAKS_PAN = 0.30      # pecahan frame per detik
HALUS_DTK = 0.6      # jendela rata-rata bergerak
TOLERANSI = 0.004    # RDP: simpangan maks keyframe terhadap kurva halus


def ukuran_crop(lebar: int, tinggi: int, rasio: tuple[int, int]) -> tuple[float, float]:
    a = rasio[0] / rasio[1]
    if lebar / tinggi > a:          # sumber lebih lebar: potong kiri-kanan
        return tinggi * a / lebar, 1.0
    return 1.0, lebar / a / tinggi  # sumber lebih tinggi: potong atas-bawah


def _jepit(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _ikuti(ideal: list[float], dt: float, zona: float, maks_pan: float) -> list[float]:
    """Kamera dengan zona mati + batas kecepatan."""
    cam = [ideal[0]]
    for v in ideal[1:]:
        c = cam[-1]
        d = v - c
        if abs(d) > zona:
            gerak = d - zona if d > 0 else d + zona
            c += _jepit(gerak, -maks_pan * dt, maks_pan * dt)
        cam.append(c)
    return cam


def _rata(v: list[float], n: int) -> list[float]:
    if n <= 1:
        return list(v)
    h = n // 2
    return [sum(v[max(0, i - h): i + h + 1]) / len(v[max(0, i - h): i + h + 1]) for i in range(len(v))]


def _rdp(t: list[float], xs: list[float], ys: list[float], tol: float) -> list[int]:
    """Indeks titik yang dipertahankan (simpangan maks x/y terhadap garis lurus <= tol)."""
    simpan = {0, len(t) - 1}
    tumpuk = [(0, len(t) - 1)]
    while tumpuk:
        a, b = tumpuk.pop()
        maks, im = 0.0, -1
        for i in range(a + 1, b):
            r = (t[i] - t[a]) / (t[b] - t[a]) if t[b] > t[a] else 0.0
            s = max(abs(xs[i] - (xs[a] + (xs[b] - xs[a]) * r)), abs(ys[i] - (ys[a] + (ys[b] - ys[a]) * r)))
            if s > maks:
                maks, im = s, i
        if maks > tol:
            simpan.add(im)
            tumpuk += [(a, im), (im, b)]
    return sorted(simpan)


def reframe(doc: dict, rasio: tuple[int, int] = (9, 16), hz: float = HZ, zona: float = ZONA_MATI,
            maks_pan: float = MAKS_PAN, halus: float = HALUS_DTK, toleransi: float = TOLERANSI,
            subjek: str | None = None) -> dict:
    cw, ch = ukuran_crop(doc["lebar"], doc["tinggi"], rasio)
    durasi = float(doc.get("durasi") or max((p["t"] for j in doc["jalur"] for p in j["titik"]), default=0.0))
    j = next((x for x in doc["jalur"] if x["id"] == subjek), None) if subjek else subjek_utama(doc)
    dasar = {"schema": SCHEMA, "rasio": f"{rasio[0]}:{rasio[1]}", "lebar_crop": round(cw, 4),
             "tinggi_crop": round(ch, 4), "subjek": j["id"] if j else None, "usulan": True,
             "sumber_jalur": doc.get("sumber"), "video": doc.get("video")}
    tengah = {"t": 0.0, "x": round((1 - cw) / 2, 4), "y": round((1 - ch) / 2, 4)}
    if j is None or cw >= 0.9999 and ch >= 0.9999:
        return {**dasar, "mode": "tengah", "keyframe": [tengah]}

    n = max(2, int(durasi * hz) + 1)
    dt = durasi / (n - 1) if durasi > 0 else 1 / hz
    ts = [i * dt for i in range(n)]
    ix, iy, ada = [], [], 0
    lalu = None
    for t in ts:
        k = kotak_di(j, t)
        if k is not None:
            ada += 1
            cx, cy = k[0] + k[2] / 2, k[1] + k[3] / 2
            fy = RUANG_KEPALA if j["jenis"] == "wajah" else 0.5
            lalu = (_jepit(cx - cw / 2, 0, 1 - cw), _jepit(cy - fy * ch, 0, 1 - ch))
        ix.append(lalu[0] if lalu else None)
        iy.append(lalu[1] if lalu else None)
    if not ada:
        return {**dasar, "mode": "tengah", "keyframe": [tengah]}
    pertama = next(i for i, v in enumerate(ix) if v is not None)  # sebelum subjek muncul: pakai posisi pertamanya
    ix = [ix[pertama]] * pertama + ix[pertama:]
    iy = [iy[pertama]] * pertama + iy[pertama:]

    # Semua posisi ideal muat dalam zona mati -> satu crop diam (median), paling enak ditonton.
    if max(ix) - min(ix) <= 2 * zona and max(iy) - min(iy) <= 2 * zona:
        med = lambda v: sorted(v)[len(v) // 2]  # noqa: E731
        return {**dasar, "mode": "diam", "keyframe": [{"t": 0.0, "x": round(med(ix), 4), "y": round(med(iy), 4)}]}

    w = max(1, int(round(halus / dt)))
    xs = [_jepit(v, 0, 1 - cw) for v in _rata(_ikuti(ix, dt, zona, maks_pan), w)]
    ys = [_jepit(v, 0, 1 - ch) for v in _rata(_ikuti(iy, dt, zona, maks_pan), w)]
    idx = _rdp(ts, xs, ys, toleransi)
    kf = [{"t": round(ts[i], 3), "x": round(xs[i], 4), "y": round(ys[i], 4)} for i in idx]
    return {**dasar, "mode": "ikut", "keyframe": kf}


def posisi_di(rf: dict, t: float) -> tuple[float, float]:
    """Kiri-atas jendela crop pada waktu t (interpolasi linear; sebelum/sesudah = keyframe ujung)."""
    kf = rf["keyframe"]
    if t <= kf[0]["t"] or len(kf) == 1:
        return kf[0]["x"], kf[0]["y"]
    for a, b in zip(kf, kf[1:]):
        if t <= b["t"]:
            r = (t - a["t"]) / (b["t"] - a["t"]) if b["t"] > a["t"] else 1.0
            return a["x"] + (b["x"] - a["x"]) * r, a["y"] + (b["y"] - a["y"]) * r
    return kf[-1]["x"], kf[-1]["y"]


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="jalur-posisi/1 -> reframe/1 (keyframe crop, usulan)")
    ap.add_argument("jalur")
    ap.add_argument("keluar")
    ap.add_argument("--rasio", default="9:16")
    ap.add_argument("--subjek")
    a = ap.parse_args()
    r = tuple(int(x) for x in a.rasio.split(":"))
    doc = json.loads(Path(a.jalur).read_text(encoding="utf-8"))
    out = reframe(doc, rasio=r, subjek=a.subjek)
    Path(a.keluar).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"mode": out["mode"], "keyframe": len(out["keyframe"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
