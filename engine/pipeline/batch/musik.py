"""Y4 Music Matcher (Batch Remix): daftar musik yang boleh dipakai + tempo/ketukan + pilihan per varian.

Sumber musik, urut prioritas:
  1. Aset Brand Kit (ekspor Motion Studio) jenis "musik" dengan lisensi_iklan = true.
  2. public/musik/* yang punya lisensi.txt di foldernya (aturan lama repo ini).
  3. HANYA kalau izinkan_musik_tanpa_lisensi: stem musik batch (konten/2-dipisah/<batch>/musik/).
     Varian yang memakainya ditandai bukan_iklan = true.
Tempo & ketukan dihitung dari audio (spectral flux hop 128 + autokorelasi + pencarian periode/fase sub-frame,
lihat tempo()), disimpan di cache konten/2-dipisah/<batch>/musik_analisis.json (dihitung ulang bila VERSI_ANALISIS naik).
"""

import json
import random
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np

SR = 22050
WIN = 2048
HOP_PRESISI = 128  # 5,8 ms per frame onset
SERANGAN = 0.075  # puncak flux ±75 ms sebelum serangan bunyi (kalibrasi klik)
BPM_MIN, BPM_MAKS = 70, 170
# Naik setiap cara baca tempo berubah: entri cache musik_analisis.json dengan versi lain dihitung ulang.
VERSI_ANALISIS = 2
TARGET_DB = -32.0  # rata-rata volume musik di bawah VO


def _decode(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def _flux(y: np.ndarray, hop: int) -> np.ndarray:
    """Spectral flux (jendela 2048), dihitung per blok supaya musik panjang tidak makan ratusan MB."""
    n = 1 + (len(y) - WIN) // hop if len(y) > WIN else 0
    if n < 2:
        return np.zeros(0, np.float32)
    win = np.hanning(WIN).astype(np.float32)
    fr = np.lib.stride_tricks.as_strided(y, shape=(n, WIN), strides=(y.strides[0] * hop, y.strides[0]))
    out, sebelum = [], None
    for a in range(0, n, 2048):
        lg = np.log1p(np.abs(np.fft.rfft(fr[a:a + 2048] * win, axis=1))).astype(np.float32)
        if sebelum is not None:
            lg = np.vstack([sebelum, lg])
        out.append(np.maximum(0, np.diff(lg, axis=0)).sum(axis=1))
        sebelum = lg[-1:]
    return np.concatenate(out)


def tempo(y: np.ndarray) -> tuple[float | None, list[float]]:
    """Tempo + ketukan presisi sub-frame dari audio mono SR (dipakai Batch Remix, Beat Spot, Ganti Outfit).

    Dulu: lag autokorelasi bulat di hop 512 (23 ms) -> sound referensi 119,95 BPM terbaca 123 (WAV) / 117,5 (MP4)
    dan potongan bergeser ±0,4 dtk di detik 16. Sekarang: onset hop 128, puncak autokorelasi diinterpolasi parabola,
    periode dicari ulang ±1,5 % dan fase sub-frame supaya grid mengenai onset sebanyak mungkin, plus koreksi serangan
    75 ms (dikalibrasi klik 100/120/140 BPM: fase <= 3 ms, BPM ±0,03).
    Hasil (None, []) = tidak ada ketukan: audio terlalu pendek (< ±2,5 dtk) atau autokorelasi tanpa puncak di 70-170 BPM
    (hening, nada datar). Audio tanpa irama yang jelas (ucapan, ambience) tetap mendapat tempo, sama seperti cara lama.
    """
    flux = _flux(y, HOP_PRESISI)
    if len(flux) < 400:
        return None, []
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    fps = SR / HOP_PRESISI
    f = np.fft.rfft(flux, 2 * len(flux))  # autokorelasi lewat FFT (np.correlate O(n^2) lambat untuk musik panjang)
    ac = np.fft.irfft(f * np.conj(f))[:len(flux)]
    lo, hi = int(fps * 60 / BPM_MAKS), int(fps * 60 / BPM_MIN)
    i = lo + int(np.argmax(ac[lo:hi + 1]))
    if i in (lo, hi):
        # Maksimum di tepi rentang = puncak aslinya di luar 70-170 (mis. 69,8 untuk lagu 139,7 BPM) atau tanpa
        # puncak sama sekali: pakai puncak lokal terkuat di dalam rentang; tidak ada = tanpa ketukan.
        pk = [j for j in range(lo + 1, hi) if ac[j] > ac[j - 1] and ac[j] >= ac[j + 1]]
        if not pk:
            return None, []
        i = max(pk, key=lambda j: ac[j])
    a, b, c = ac[i - 1], ac[i], ac[i + 1]
    lag = i + (0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0)
    # Periode & fase: maksimalkan energi onset (dihaluskan sedikit) tepat di titik grid.
    k = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)
    hal = np.convolve(np.maximum(flux, 0), k / k.sum(), mode="same")
    t = np.arange(len(hal))

    def nilai(per, fase):
        pos = np.arange(fase, len(hal) - 1, per)
        return float(np.interp(pos, t, hal).sum()) / max(len(pos), 1)

    terbaik = (-1.0, lag, 0.0)
    for per in np.linspace(lag * 0.985, lag * 1.015, 61):
        for fase in np.arange(0, per, 1.0):
            v = nilai(per, fase)
            if v > terbaik[0]:
                terbaik = (v, per, fase)
    _, per, fase = terbaik
    for fase2 in np.arange(fase - 1, fase + 1, 0.1):  # fase sub-frame
        if fase2 >= 0:
            v = nilai(per, fase2)
            if v > terbaik[0]:
                terbaik = (v, per, fase2)
    _, per, fase = terbaik
    bpm = 60 * fps / per
    # Puncak flux muncul ±75 ms sebelum serangan bunyi (jendela 2048 + penghalusan); dikalibrasi dengan
    # klik 100/120/140 BPM di fase 0,10 / 0,25 / 0,37 dtk: sisa selisih <= 3 ms.
    beats = [float((fase + j * per) / fps + SERANGAN) for j in range(int((len(flux) - fase) / per) + 1)]
    return float(bpm), beats  # bisa sedikit di luar 70-170 (pencarian periode ±1,5 %)


def analisis(path: Path) -> dict:
    """{durasi, db, bpm, ketukan}: bpm 2 desimal, ketukan detik (3 desimal) dari awal file; bpm None = tanpa ketukan."""
    y = _decode(path)
    dur = len(y) / SR
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-9) if len(y) else 1e-9
    mean_db = 20 * np.log10(rms)
    bpm, beats = tempo(y)
    return {"durasi": round(dur, 2), "db": round(float(mean_db), 1), "bpm": round(bpm, 2) if bpm else None,
            "ketukan": [round(b, 3) for b in beats]}


def mood(bpm: float | None) -> str:
    if not bpm:
        return "tanpa_tempo"
    return "santai" if bpm < 90 else ("sedang" if bpm < 118 else "ceria")


def library(brand_raw: dict, batch_dir: Path, izinkan_tanpa_lisensi: bool, vo_ditolak: set[str]) -> list[dict]:
    out = []
    for a in brand_raw.get("aset", []) if brand_raw.get("schema") == "brand-kit-export/1" else []:
        if a.get("jenis") == "musik" and a.get("lisensi_iklan"):
            out.append({"kunci": a["kunci"], "path": a["path"], "tag": a.get("tag", []), "lisensi_iklan": True,
                        "sumber": "brand_kit"})
    from jalur import DATA  # R20: data (public/musik) di folder MOTION_ENGINE_DATA, bawaan = repo
    pm = DATA / "public" / "musik"
    if (pm / "lisensi.txt").exists():
        for p in sorted(pm.glob("*")):
            if p.suffix.lower() in {".mp3", ".wav", ".m4a"}:
                out.append({"kunci": f"$musik:{p.stem}", "path": str(p.resolve()).replace("\\", "/"), "tag": [],
                            "lisensi_iklan": True, "sumber": "public/musik"})
    if izinkan_tanpa_lisensi:
        for p in sorted((batch_dir / "musik").glob("*.wav")):
            # Stem dari footage yang vokalnya lirik lagu (cek_ucapan menolak) = lagu populer, dilewati.
            if p.stem in vo_ditolak:
                continue
            out.append({"kunci": f"$musik:{p.stem}", "path": str(p.resolve()).replace("\\", "/"), "tag": [],
                        "lisensi_iklan": False, "sumber": "stem_batch"})
    cache_p = batch_dir / "musik_analisis.json"
    cache = json.loads(cache_p.read_text(encoding="utf-8")) if cache_p.exists() else {}
    for m in out:
        key = m["path"]
        st = Path(key).stat()
        # Versi analisis ikut tanda tangan: cache lama (tempo kasar hop 512) otomatis dihitung ulang.
        sig = f"{st.st_size}:{int(st.st_mtime)}:v{VERSI_ANALISIS}"
        if cache.get(key, {}).get("sig") != sig:
            cache[key] = {"sig": sig, **analisis(Path(key))}
        m.update({k: v for k, v in cache[key].items() if k != "sig"})
        m["mood"] = mood(m["bpm"])
        m["volume"] = round(float(np.clip(10 ** ((TARGET_DB - m["db"]) / 20), 0.02, 1.0)), 3)
    cache_p.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    # Stem yang nyaris hening (footage tanpa musik) tidak dipakai.
    return [m for m in out if m["db"] > -45 and m["bpm"]]


MOOD_TUJUAN = {"konversi": ["ceria", "sedang"], "awareness": ["ceria"], "branding": ["sedang", "santai"]}


def pilih(lib: list[dict], tujuan: str, durasi: float, rng: random.Random, dipakai: Counter) -> dict | None:
    if not lib:
        return None
    suka = MOOD_TUJUAN.get(tujuan, ["ceria", "sedang"])

    def skor(m):
        return ((2 if m["mood"] in suka else 0) + (1 if m["lisensi_iklan"] else 0) - 1.2 * dipakai[m["kunci"]]
                + (0.5 if m["durasi"] >= durasi else 0) + rng.random() * 0.5)

    m = max(lib, key=skor)
    dipakai[m["kunci"]] += 1
    return m
