"""Motion Transfer tahap 1 (R11): video referensi -> adegan + gambar terbaik tiap adegan + prompt siap salin.

Motion Transfer = pola kerja Jika (dinamai owner 15 Nov 2026):
  1. cari video referensi yang konsepnya mau ditiru;
  2. ambil gambar adegannya, ganti produk dengan produk sendiri lewat AI gambar;
  3. gerakkan gambar itu lewat AI video supaya mirip referensi.
Modul ini mengerjakan langkah 1 secara otomatis dan menyiapkan langkah 2-3 sebagai teks prompt yang bisa
disalin tim ke alat AI pilihan mereka (hybrid, tanpa biaya API). Pemanggilan API AI menyusul setelah owner
memilih akun dan batas biaya.

  engine transfer <job_dir>
    job.json: {"schema": "engine-job/1", "mode": "transfer", "sumber": [{"kunci": "$sumber", "path": ...}],
               "brief": {"produk": "nama produk (opsional, default produk pertama Brand Kit)"}}
    -> <job_dir>/out/transfer.json (schema engine-transfer/1) + out/adegan/NN.jpg
"""

import json
import subprocess
from pathlib import Path

import numpy as np

AMBANG_ADEGAN = 0.30  # ffmpeg scene score; lebih rendah dari Generate supaya gerakan kamera ikut terpisah
MIN_ADEGAN = 0.8  # detik; adegan lebih pendek digabung ke sebelumnya
MAKS_ADEGAN = 4.0  # detik; adegan panjang dipecah supaya gerakannya bisa ditiru per bagian
LEBAR_GAMBAR = 1080


def durasi(video: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out or 0)


def titik_ganti(video: str) -> list[float]:
    import re

    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", video, "-vf", f"select='gt(scene,{AMBANG_ADEGAN})',showinfo",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return [float(t) for t in re.findall(r"pts_time:([\d.]+)", r.stderr)]


def bagi_adegan(titik: list[float], total: float) -> list[tuple[float, float]]:
    batas = [0.0] + sorted(t for t in titik if 0 < t < total) + [total]
    kasar = []
    for a, b in zip(batas, batas[1:]):
        if kasar and b - a < MIN_ADEGAN:
            kasar[-1] = (kasar[-1][0], b)
        else:
            kasar.append((a, b))
    if len(kasar) > 1 and kasar[0][1] - kasar[0][0] < MIN_ADEGAN:
        kasar[1] = (kasar[0][0], kasar[1][1])
        kasar.pop(0)
    hasil = []
    for a, b in kasar:
        k = max(1, int(np.ceil((b - a) / MAKS_ADEGAN)))
        hasil += [(a + (b - a) * j / k, a + (b - a) * (j + 1) / k) for j in range(k)]
    return [(round(a, 2), round(b, 2)) for a, b in hasil]


def _ketajaman(video: str, detik: float) -> float:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{detik:.2f}", "-i", video, "-frames:v", "1",
                          "-vf", "scale=270:480,format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    if len(raw) < 270 * 480:
        return -1.0
    g = np.frombuffer(raw[: 270 * 480], dtype=np.uint8).reshape(480, 270).astype(np.float32)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return float(lap.var())


def gambar_terbaik(video: str, a: float, b: float, keluar: Path) -> float:
    """Simpan frame paling tajam dari 3 calon di tengah adegan; kembalikan detiknya."""
    calon = [a + (b - a) * f for f in (0.3, 0.5, 0.7)]
    detik = max(calon, key=lambda t: _ketajaman(video, t))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{detik:.2f}", "-i", video, "-frames:v", "1",
                    "-vf", f"scale={LEBAR_GAMBAR}:-2", "-q:v", "2", str(keluar)], check=True)
    return round(detik, 2)


def prompt_gambar(produk: str, deskripsi: str = "") -> str:
    tambahan = f" Produk: {deskripsi}." if deskripsi else ""
    return (f"Ganti produk yang dipakai/dipegang di gambar ini dengan {produk} (foto produk terlampir).{tambahan} "
            "Pertahankan pose, komposisi, latar, cahaya, sudut kamera, dan ekspresi orangnya persis sama. "
            "Jangan tambahkan teks, logo, atau watermark. Rasio 9:16.")


def prompt_gerak(a: float, b: float, nomor: int, total: int) -> str:
    return (f"Gerakkan gambar ini selama {b - a:.1f} detik meniru gerakan adegan {nomor}/{total} video referensi "
            "(gerakan kamera dan gerakan orang sama dengan referensi). Produk harus tetap sama persis bentuk, "
            "warna, dan motifnya. Tanpa teks.")


def transfer(video: str, out: Path, produk: str, deskripsi: str = "", progres=lambda *a: None) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    (out / "adegan").mkdir(exist_ok=True)
    total = durasi(video)
    progres("adegan", 20, f"{total:.0f} dtk")
    adegan = bagi_adegan(titik_ganti(video), total)
    hasil = []
    for i, (a, b) in enumerate(adegan, 1):
        nama = f"adegan/{i:02d}.jpg"
        detik = gambar_terbaik(video, a, b, out / nama)
        hasil.append({"no": i, "dari": a, "sampai": b, "durasi": round(b - a, 2), "detik_gambar": detik,
                      "gambar": nama, "prompt_gambar": prompt_gambar(produk, deskripsi),
                      "prompt_gerak": prompt_gerak(a, b, i, len(adegan)), "sumber": "aturan"})
        progres("gambar", 20 + int(75 * i / len(adegan)), f"adegan {i}/{len(adegan)}")
    doc = {"schema": "engine-transfer/1", "status": "siap", "referensi": Path(video).name, "durasi": round(total, 2),
           "produk": produk, "adegan": hasil,
           "catatan": "Tahap 2-3 masih manual: salin prompt ke alat AI gambar/video bersama foto produk. "
                      "Tim boleh menghapus, menggabung, atau mengganti adegan sebelum dipakai."}
    (out / "transfer.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return doc
