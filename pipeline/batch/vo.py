"""Batch Remix: pilih footage yang layak jadi voice over (VO) dan susun kalimatnya.

VO = stem vokal satu footage. DEFAULT: semua kalimat dipakai apa adanya (keputusan owner: batas
diputuskan tim nanti). Kalimat yang kena aturan (superlatif, urgensi, live, musiman) hanya ditandai
`saran_buang` dan dilaporkan di rencana. Membuang otomatis hanya kalau job menyalakannya:
  buang_otomatis: ["superlatif", "urgensi", ...]  -> kalimat jenis itu dibuang
  batas_durasi: [min, maks]                       -> kalimat tengah bertopik paling sedikit dibuang sampai masuk
Kalimat pertama (hook) dan kalimat CTA terakhir tidak pernah dibuang karena durasi.
Yang selalu dibuang: potongan Whisper < 0,35 dtk (klip < 100 ms ditolak Motion Studio) dan kalimat yang
menyebut brand LAIN (brand_lain.py: iklan brand ini tidak boleh menyebut toko/brand lain; bukan soal gaya).
"""

import json
import random
from pathlib import Path

import brand_lain
from common import alasan_buang, apply_kamus, cek_ucapan, kalimat, merge_split_words, norm

JEDA = 0.12  # detik jeda antar kalimat di timeline hasil
MAKS_JUDUL = 6


def kandidat(batch_dir: Path, lib: dict, brand: dict, produk_kata: list[str], deteksi=None) -> tuple[list[dict], list[dict]]:
    """Return (vo_layak, ditolak). Footage tanpa ucapan / lirik lagu / produk lain ditolak sebagai VO."""
    layak, tolak = [], []
    pk = {norm(x) for x in produk_kata}
    for fid, meta in lib["footage"].items():
        tpath = batch_dir / "transkrip" / f"{fid}.json"
        if not meta.get("vokal") or not tpath.exists():
            tolak.append({"id": fid, "alasan": "tidak ada vokal/transkrip"})
            continue
        tr = json.loads(tpath.read_text(encoding="utf-8"))
        cek = cek_ucapan(tr)
        if cek["status"] != "ok":
            tolak.append({"id": fid, "alasan": cek["alasan"]})
            continue
        teks = " ".join(w["text"] for w in tr["words"])
        if pk and not ({norm(x) for x in teks.split()} & pk):
            tolak.append({"id": fid, "alasan": "tidak menyebut produk (" + ", ".join(produk_kata) + ")"})
            continue
        words = merge_split_words(tr["words"])
        apply_kamus(words, brand.get("kamus_kata", {}))
        ks = kalimat(words)
        for i, k in enumerate(ks):
            k["id"] = i
            k["saran_buang"] = alasan_buang(k["teks"], brand.get("superlatif_dilarang", []))
            # Teknis, bukan isi: gumaman/potongan Whisper, klip < 100 ms ditolak Motion Studio.
            k["teknis"] = "terlalu_pendek" if k["sampai"] - k["dari"] < 0.35 else None
            lain = deteksi.cek(k["teks"]) if deteksi else None
            k["brand_lain"] = f"brand lain: {lain}" if lain else None
        # Whisper memecah kalimat di titik singkatan ("dari A.L." | "Store, yang ..."): cek juga pasangan
        # kalimat bersebelahan; kalau nama brand lain melintasi batas, kedua kalimat ditandai.
        for k1, k2 in zip(ks, ks[1:]) if deteksi else []:
            if k2["brand_lain"]:
                continue
            if k1["brand_lain"]:
                # "dari A.L.N." (sudah kena) | "Store dengan bahan ...": sisa nama toko ikut dibuang.
                awal = brand_lain.token(k2["teks"])[:1]
                if awal and awal[0] in brand_lain.SUFIKS:
                    k2["brand_lain"] = k1["brand_lain"]
                continue
            lain = deteksi.cek(k1["teks"] + " " + k2["teks"])
            if lain:
                k1["brand_lain"] = k2["brand_lain"] = f"brand lain: {lain}"
        boleh = [k for k in ks if not k["teknis"] and not k["brand_lain"]]
        if not boleh:
            alasan = "semua kalimat menyebut brand lain" if any(k["brand_lain"] for k in ks) else "tidak ada kalimat utuh"
            tolak.append({"id": fid, "alasan": alasan})
            continue
        layak.append({"id": fid, "kalimat": ks, "durasi": meta["durasi"],
                      "skor": len({t for k in boleh for t in k["topik"]}) + (2 if any("cta" in k["topik"] for k in boleh) else 0)})
    layak.sort(key=lambda v: -v["skor"])
    return layak, tolak


GANTUNG = {"dari", "yang", "dan", "di", "ke", "ini", "itu", "tapi", "kok", "aku", "kamu", "dengan", "untuk",
           "buat", "sama", "high", "jadi", "kalau", "karena", "udah"}


def judul_hook(kata: list[dict]) -> str:
    """Judul maks 6 kata dari kalimat pertama; berhenti di koma, tidak berakhir kata gantung."""
    toks = []
    for w in kata[:MAKS_JUDUL]:
        toks.append(w["text"])
        if w["text"].endswith(",") and len(toks) >= 3:
            break
    while len(toks) > 3 and norm(toks[-1]) in GANTUNG:
        toks.pop()
    return " ".join(toks).rstrip(".,")


def panjang(ks: list[dict]) -> float:
    return sum(k["sampai"] - k["dari"] for k in ks) + JEDA * max(0, len(ks) - 1)


def _jenis(alasan: str | None) -> str | None:
    return None if not alasan else ("superlatif" if alasan.startswith("kata terlarang") else alasan)


def susun(vo: dict, rng: random.Random, target: tuple[float, float] | None = None,
          buang_otomatis: set[str] | frozenset = frozenset()) -> dict:
    """Pilih kalimat VO untuk satu varian.

    target: (min, maks) detik ucapan, atau None = tanpa batas (default, semua kalimat dipakai).
    buang_otomatis: jenis aturan yang boleh membuang kalimat (default kosong = hanya ditandai).
    """
    def kena(k):
        return k["teknis"] or k.get("brand_lain") or (_jenis(k["saran_buang"]) in buang_otomatis and k["saran_buang"])

    boleh = [k for k in vo["kalimat"] if not kena(k)]
    dibuang = [{"dari": k["dari"], "sampai": k["sampai"], "teks": k["teks"], "jenis": kena(k), "sumber": "aturan"}
               for k in vo["kalimat"] if kena(k)]
    saran = [{"dari": k["dari"], "sampai": k["sampai"], "teks": k["teks"], "jenis": k["saran_buang"]}
             for k in boleh if k["saran_buang"]]
    pakai = list(boleh)
    ada_cta = "cta" in pakai[-1]["topik"]
    while target and panjang(pakai) > target[1] and len(pakai) > 2:
        tengah = pakai[1:-1] if ada_cta else pakai[1:]
        # Buang kalimat dengan topik paling sedikit; acak di antara yang setara supaya varian beda.
        skor_min = min(len(k["topik"]) for k in tengah)
        calon = [k for k in tengah if len(k["topik"]) <= skor_min + 1]
        k = rng.choice(calon)
        pakai.remove(k)
        dibuang.append({"dari": k["dari"], "sampai": k["sampai"], "teks": k["teks"], "jenis": "durasi", "sumber": "aturan"})
    pertama = pakai[0]
    judul = judul_hook(pertama["kata"])
    return {
        "vo": vo["id"],
        "kalimat": pakai,
        "dibuang": sorted(dibuang, key=lambda d: d["dari"]),
        "saran_buang": saran,
        "durasi_ucapan": round(panjang(pakai), 2),
        "durasi_mentah": vo["durasi"],
        "judul": judul,
        "judul_dipotong": len(pertama["kata"]) > MAKS_JUDUL,
        "cta_terucap": pakai[-1]["teks"] if "cta" in pakai[-1]["topik"] else None,
        "terlalu_pendek": bool(target) and panjang(pakai) < target[0],
    }
