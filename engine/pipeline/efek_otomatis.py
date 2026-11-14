"""Efek & SFX otomatis untuk Generate Otomatis dan Batch Remix (venus, 14 Nov 2026).

Masalah yang diperbaiki:
- SFX Library brand tidak pernah terdengar: mesin mengambil aset PERTAMA yang tag-nya cocok, dan untuk
  "transisi"/"teks-muncul" itu bunyi klik 12–94 ms -> lebih pendek dari MIN_CLIP_MS (100 ms) -> dibuang.
- Batch Remix sama sekali belum memasang SFX maupun efek.

Aturan (sama untuk kedua mode, gaya iklan TikTok yang rapi, tidak norak):
- SFX dipilih per JENIS kejadian dengan durasi yang pas, bunyi negatif (error/glitch/scratch) tidak dipakai,
  dan dipilih BERVARIASI (urutan + seed), tidak selalu bunyi yang sama.
- Jarak antar SFX >= 2 dtk, maksimal 8 per video.
- Efek: zoom halus (punch-in) di <= 2 kalimat penting + zoom-through di <= 2 titik potong. Tidak di hook.
"""

import hashlib

SFX_JARAK_MS = 2000
SFX_MAKS = 8
MIN_SFX_MS = 100

# jenis kejadian -> tag yang cocok (urutan = prioritas) + rentang durasi yang pas (ms)
JENIS_SFX = {
    "whoosh": {"tag": ["transisi", "switch", "maximize", "minimize"], "min": 150, "max": 900},
    "pop": {"tag": ["kata-kunci", "select", "drop", "pluck", "toggle"], "min": 80, "max": 450},
    "muncul": {"tag": ["teks-muncul", "maximize", "open", "confirmation"], "min": 100, "max": 650},
}
TAG_HINDARI = {"error", "glitch", "scratch", "question", "back", "click", "tick"}
STEM_KE_JENIS = {"whoosh": "whoosh", "pop": "pop"}


def _boleh(a: dict, dilarang) -> bool:
    if a.get("lisensi_iklan") is False:
        return False
    teks = " ".join([str(a.get("nama", "")), str(a.get("kunci", "")), *map(str, a.get("tag", []))]).lower()
    return not any(str(x).lower() in teks for x in (dilarang or []) if str(x).strip())


def kandidat_sfx(aset: list[dict], jenis: str, dilarang=()) -> list[dict]:
    """Aset SFX brand yang pas untuk jenis kejadian ini, urut (prioritas tag, lalu kunci) — deterministik."""
    spec = JENIS_SFX[jenis]
    hasil = []
    for a in aset:
        if a.get("jenis") != "sfx" or not a.get("kunci") or not _boleh(a, dilarang):
            continue
        tag = set(a.get("tag", []))
        if tag & TAG_HINDARI:
            continue
        d = a.get("durasi_ms") or 0
        if not (max(spec["min"], MIN_SFX_MS) <= d <= spec["max"]):
            continue
        prio = min((spec["tag"].index(t) for t in tag if t in spec["tag"]), default=None)
        if prio is not None:
            hasil.append((prio, a["kunci"], a))
    return [a for _, _, a in sorted(hasil, key=lambda x: (x[0], x[1]))]


def pilih_sfx(aset: list[dict], jenis: str, urutan: int, seed: str = "", dilarang=()) -> dict | None:
    """Satu aset untuk kejadian ke-`urutan`: bervariasi (bukan selalu yang pertama), tetap sama untuk seed sama."""
    calon = kandidat_sfx(aset, jenis, dilarang)
    if not calon:
        return None
    awal = int(hashlib.sha1(f"{seed}|{jenis}".encode()).hexdigest()[:8], 16)
    return calon[(awal + urutan) % len(calon)]


def saring_sfx(kejadian: list[tuple[int, str]], total_ms: int) -> list[tuple[int, str]]:
    """(ms, jenis) -> yang dipakai: urut waktu, jarak >= SFX_JARAK_MS, maks SFX_MAKS, tidak di 0,3 dtk terakhir.
    Prioritas: muncul (hook) > whoosh (transisi) > pop (kata kunci)."""
    prio = {"muncul": 0, "whoosh": 1, "pop": 2}
    terpilih: list[tuple[int, str]] = []
    for t, j in sorted(kejadian, key=lambda x: (prio.get(x[1], 9), x[0])):
        if t < 0 or t > total_ms - 300:
            continue
        if all(abs(t - u) >= SFX_JARAK_MS for u, _ in terpilih):
            terpilih.append((t, j))
        if len(terpilih) >= SFX_MAKS:
            break
    return sorted(terpilih)


def efek_batch(potong_ms: list[int], kalimat: list[tuple[int, int]], hook_akhir_ms: int, total_ms: int) -> tuple[list[dict], list[int]]:
    """Rencana efek Batch Remix -> (framing untuk ops.efek_video, titik zoom-through).

    potong_ms: titik pergantian shot (ms timeline). kalimat: rentang kalimat VO (ms). Tidak ada efek di hook
    (hook sudah punya kotak kaca) dan di 1,5 dtk terakhir (CTA)."""
    aman = [c for c in sorted(set(potong_ms)) if hook_akhir_ms + 500 <= c <= total_ms - 1500]
    zt = []
    for frac in (0.35, 0.7):  # dua titik potong, tersebar
        if aman:
            c = min(aman, key=lambda x: abs(x - total_ms * frac))
            if all(abs(c - z) >= 3000 for z in zt):
                zt.append(c)
    framing = []
    calon = [(a, b) for a, b in kalimat if a >= hook_akhir_ms and b <= total_ms - 1500 and b - a >= 1200]
    pilih = []
    if calon:
        pilih.append(calon[0])  # kalimat pertama setelah hook: menarik perhatian
        tengah = min(calon, key=lambda k: abs((k[0] + k[1]) / 2 - total_ms * 0.6))
        if tengah != calon[0]:
            pilih.append(tengah)
    for a, b in sorted(pilih):
        framing.append({"atMs": a, "scale": 1.12, "mode": "smooth"})
        framing.append({"atMs": b, "scale": 1.0})
    return framing, sorted(zt)
