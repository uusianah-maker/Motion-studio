"""Y4 Music Matcher (Batch Remix): daftar musik yang boleh dipakai + tempo/ketukan + pilihan per varian.

Sumber musik, urut prioritas:
  1. Aset Brand Kit (ekspor Motion Studio) jenis "musik" dengan lisensi_iklan = true.
  2. public/musik/* yang punya lisensi.txt di foldernya (aturan lama repo ini).
  3. HANYA kalau izinkan_musik_tanpa_lisensi: stem musik batch (konten/2-dipisah/<batch>/musik/).
     Varian yang memakainya ditandai bukan_iklan = true.
Tempo & ketukan dihitung dari audio (spectral flux + autokorelasi), disimpan di cache
konten/2-dipisah/<batch>/musik_analisis.json.
"""

import json
import random
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np

SR = 22050
HOP = 512
TARGET_DB = -32.0  # rata-rata volume musik di bawah VO


def _decode(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def analisis(path: Path) -> dict:
    y = _decode(path)
    dur = len(y) / SR
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-9)
    mean_db = 20 * np.log10(rms)
    n = 1 + (len(y) - 2048) // HOP if len(y) > 2048 else 0
    if n < 50:
        return {"durasi": round(dur, 2), "db": round(mean_db, 1), "bpm": None, "ketukan": []}
    win = np.hanning(2048).astype(np.float32)
    frames = np.lib.stride_tricks.as_strided(y, shape=(n, 2048), strides=(y.strides[0] * HOP, y.strides[0]))
    spec = np.abs(np.fft.rfft(frames * win, axis=1))
    flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(axis=1)
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    fps = SR / HOP
    # Tempo: autokorelasi envelope, BPM 70-170.
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    lags = np.arange(len(ac))
    lo, hi = int(fps * 60 / 170), int(fps * 60 / 70)
    lag = lo + int(np.argmax(ac[lo:hi]))
    bpm = 60 * fps / lag
    # Fase ketukan: geser yang paling banyak mengenai onset.
    best = max(range(lag), key=lambda ph: flux[ph::lag].sum())
    beats = [round((best + k * lag) / fps, 3) for k in range(int((len(flux) - best) / lag) + 1)]
    return {"durasi": round(dur, 2), "db": round(float(mean_db), 1), "bpm": round(float(bpm), 1), "ketukan": beats}


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
        sig = f"{st.st_size}:{int(st.st_mtime)}"
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
