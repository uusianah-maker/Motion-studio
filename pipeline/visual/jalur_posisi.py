"""R24 Visual Tools: format JALUR POSISI bersama (jalur-posisi/1), tanpa dependensi.

Dipakai oleh R24a (wajah/objek MediaPipe), R24c (pelacakan kotak pilihan user) dan R24b (reframe).
Semua koordinat = PECAHAN frame (0..1), titik kiri-atas kotak + lebar/tinggi, jadi tidak bergantung resolusi.

{
  "schema": "jalur-posisi/1",
  "video": "konten/.../a.mp4",        # relatif ke folder DATA
  "lebar": 1080, "tinggi": 1920, "fps": 30.0, "durasi": 12.4,
  "sumber": "mediapipe-wajah" | "mediapipe-objek" | "lacak-csrt" | "lacak-kcf" | "manual",
  "usulan": true,                      # hybrid: hasil AI selalu usulan, boleh diubah/dimatikan di editor
  "jalur": [
    {"id": "wajah-1", "jenis": "wajah" | "objek" | "lacak", "label": "face",
     "titik": [{"t": 0.0, "x": 0.31, "y": 0.18, "w": 0.22, "h": 0.12, "skor": 0.93}, ...]}
  ]
}
"""

from __future__ import annotations

SCHEMA = "jalur-posisi/1"
JENIS = ("wajah", "objek", "lacak")
MAKS_CELAH = 0.5  # detik: di antara dua titik yang lebih jauh dari ini = subjek hilang (tidak diinterpolasi)


def kotak(x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    """Kotak dipotong supaya tetap di dalam frame (0..1)."""
    x0, y0 = max(0.0, min(1.0, x)), max(0.0, min(1.0, y))
    x1, y1 = max(0.0, min(1.0, x + w)), max(0.0, min(1.0, y + h))
    return x0, y0, x1 - x0, y1 - y0


def titik(t: float, x: float, y: float, w: float, h: float, skor: float = 1.0) -> dict:
    x, y, w, h = kotak(x, y, w, h)
    return {"t": round(t, 3), "x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4),
            "skor": round(max(0.0, min(1.0, skor)), 3)}


def validasi(doc: dict) -> list[str]:
    """Daftar kesalahan (kosong = sah)."""
    salah = []
    if doc.get("schema") != SCHEMA:
        salah.append(f"schema harus {SCHEMA}")
    for k in ("lebar", "tinggi"):
        if not isinstance(doc.get(k), int) or doc[k] <= 0:
            salah.append(f"{k} harus bilangan bulat > 0")
    ids = set()
    for i, j in enumerate(doc.get("jalur", [])):
        jid = j.get("id")
        if not jid or jid in ids:
            salah.append(f"jalur[{i}]: id kosong/ganda")
        ids.add(jid)
        if j.get("jenis") not in JENIS:
            salah.append(f"jalur[{i}]: jenis harus salah satu {JENIS}")
        t_lalu = -1.0
        for n, p in enumerate(j.get("titik", [])):
            if p["t"] <= t_lalu:
                salah.append(f"jalur[{i}].titik[{n}]: t harus naik")
            t_lalu = p["t"]
            if not (0 <= p["x"] <= 1 and 0 <= p["y"] <= 1 and 0 < p["w"] <= 1 and 0 < p["h"] <= 1
                    and p["x"] + p["w"] <= 1.0001 and p["y"] + p["h"] <= 1.0001):
                salah.append(f"jalur[{i}].titik[{n}]: kotak di luar frame")
    return salah


def kotak_di(jalur: dict, t: float, maks_celah: float = MAKS_CELAH) -> tuple | None:
    """Kotak (x, y, w, h, skor) pada waktu t, interpolasi linear di antara dua titik terdekat.
    None bila t di luar jalur atau di dalam celah (subjek hilang)."""
    ts = jalur["titik"]
    if not ts or t < ts[0]["t"] - 1e-6 or t > ts[-1]["t"] + 1e-6:
        return None
    lo, hi = 0, len(ts) - 1
    while hi - lo > 1:  # cari pasangan [lo, hi] yang mengapit t
        m = (lo + hi) // 2
        lo, hi = (m, hi) if ts[m]["t"] <= t else (lo, m)
    a, b = ts[lo], ts[hi]
    if b["t"] - a["t"] > maks_celah:
        dekat = a if t - a["t"] <= b["t"] - t else b
        return tuple(dekat[k] for k in ("x", "y", "w", "h", "skor")) if abs(dekat["t"] - t) < 1e-6 else None
    r = 0.0 if b["t"] == a["t"] else (t - a["t"]) / (b["t"] - a["t"])
    return tuple(a[k] + (b[k] - a[k]) * r for k in ("x", "y", "w", "h", "skor"))


def bobot(jalur: dict) -> float:
    """Seberapa 'utama' sebuah jalur: luas x skor x lama tampil (pola AutoFlip: subjek dominan)."""
    ts = jalur["titik"]
    if len(ts) < 2:
        return sum(p["w"] * p["h"] * p["skor"] for p in ts) * 0.1
    tot = 0.0
    for a, b in zip(ts, ts[1:]):
        dt = min(b["t"] - a["t"], MAKS_CELAH)
        tot += dt * (a["w"] * a["h"] * a["skor"] + b["w"] * b["h"] * b["skor"]) / 2
    return tot


def subjek_utama(doc: dict, jenis: tuple[str, ...] = JENIS) -> dict | None:
    """Jalur paling dominan (wajah diutamakan dua kali lipat: iklan talking head)."""
    kand = [j for j in doc.get("jalur", []) if j.get("jenis") in jenis and j.get("titik")]
    if not kand:
        return None
    return max(kand, key=lambda j: bobot(j) * (2.0 if j["jenis"] == "wajah" else 1.0))


def gabung_deteksi(per_frame: list[tuple[float, list[tuple]]], jenis: str, label: str, prefix: str,
                   iou_min: float = 0.2, maks_celah: float = MAKS_CELAH) -> list[dict]:
    """Deteksi per frame [(t, [(x, y, w, h, skor), ...]), ...] -> jalur ber-id (pencocokan IoU serakah).
    Dipakai R24a: detektor MediaPipe memberi kotak per frame tanpa identitas."""
    jalur: list[dict] = []
    aktif: list[dict] = []
    for t, kotak2 in per_frame:
        aktif = [j for j in aktif if t - j["titik"][-1]["t"] <= maks_celah]
        bebas = list(aktif)
        for k in sorted(kotak2, key=lambda k: -k[4]):
            p = titik(t, *k)
            if p["w"] <= 0 or p["h"] <= 0:
                continue
            terbaik = max(bebas, key=lambda j: iou(j["titik"][-1], p), default=None)
            if terbaik is not None and iou(terbaik["titik"][-1], p) >= iou_min:
                terbaik["titik"].append(p)
                bebas.remove(terbaik)
            else:
                j = {"id": f"{prefix}-{len(jalur) + 1}", "jenis": jenis, "label": label, "titik": [p]}
                jalur.append(j)
                aktif.append(j)
    return jalur


def iou(a: dict, b: dict) -> float:
    x0, y0 = max(a["x"], b["x"]), max(a["y"], b["y"])
    x1, y1 = min(a["x"] + a["w"], b["x"] + b["w"]), min(a["y"] + a["h"], b["y"] + b["h"])
    i = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    u = a["w"] * a["h"] + b["w"] * b["h"] - i
    return i / u if u > 0 else 0.0
