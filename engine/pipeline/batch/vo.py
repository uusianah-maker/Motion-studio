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
from karangan import bersihkan

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
        # Keluhan owner 27 Nov: transkrip lama (sebelum gaya "vo") bisa berisi karangan Whisper
        # ("aku baru aja" x10, "Terima kasih telah menonton"); dibersihkan juga di sini sebagai penjaga.
        if tr.get("gaya") != "vo":
            bersihkan(tr["words"], 2)
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
    return _hasil(vo, pakai, dibuang, saran, target)


# Kata pembuka yang menyambung ke kalimat sebelumnya: kalimat ini tidak boleh dipindah ke depan
# kalimat lain (artinya jadi rusak), dan kalimat sebelumnya tidak boleh dibuang sendirian.
SAMBUNG = {"tapi", "dan", "jadi", "karena", "terus", "trus", "nah", "so", "but", "and", "makanya", "soalnya",
           "apalagi", "plus", "trs", "lalu", "pokoknya", "tuh"}


def _menyambung(k: dict) -> bool:
    awal = norm(k["teks"].split()[0]) if k["teks"].split() else ""
    return awal in SAMBUNG or k["teks"].rstrip().endswith(("...", "…"))


def ragamkan(rv: dict, vo: dict, rng: random.Random, hindari: set[tuple], target=None) -> dict | None:
    """Variasi kalimat VO antar varian (owner 14 Nov: audio tidak boleh identik antar varian).

    Varian pertama sebuah VO memakai susunan `rv` apa adanya. Varian berikutnya: 1-2 kalimat tengah
    dibuang dan/atau dua kalimat tengah yang berdiri sendiri ditukar. Hook (kalimat pertama) dan CTA tidak
    disentuh. Return None kalau tidak ada susunan baru yang belum dipakai (`hindari` = urutan id kalimat).
    """
    def kunci(ks):
        return tuple(k["id"] for k in ks)

    if kunci(rv["kalimat"]) not in hindari:
        return rv
    pakai0 = rv["kalimat"]
    ada_cta = "cta" in pakai0[-1]["topik"]
    akhir = len(pakai0) - 1 if ada_cta else len(pakai0)
    tengah_idx = list(range(1, akhir))
    if not tengah_idx:
        return None
    for _ in range(40):
        pakai = list(pakai0)
        # Buang 1-2 kalimat tengah yang tidak "ditempeli" kalimat sesudahnya.
        n_buang = rng.choice([0, 1, 1, 2]) if len(tengah_idx) >= 3 else rng.choice([0, 1])
        # Membuang kalimat penyambung itu sendiri aman; yang dijaga: kalimat SESUDAHNYA tidak menyambung.
        bisa = [i for i in tengah_idx if not (i + 1 < len(pakai0) and _menyambung(pakai0[i + 1]))]
        buang = set(rng.sample(bisa, min(n_buang, len(bisa)))) if bisa else set()
        pakai = [k for i, k in enumerate(pakai0) if i not in buang]
        # Tukar dua kalimat tengah bersebelahan yang sama-sama berdiri sendiri.
        akhir2 = len(pakai) - 1 if ada_cta else len(pakai)
        pasang = [i for i in range(1, akhir2 - 1)
                  if not _menyambung(pakai[i]) and not _menyambung(pakai[i + 1])
                  and not (i + 2 < len(pakai) and _menyambung(pakai[i + 2]))]
        if pasang and (not buang or rng.random() < 0.5):
            i = rng.choice(pasang)
            pakai[i], pakai[i + 1] = pakai[i + 1], pakai[i]
        if kunci(pakai) in hindari or len(pakai) < 2:
            continue
        dibuang = list(rv["dibuang"]) + [{"dari": pakai0[i]["dari"], "sampai": pakai0[i]["sampai"],
                                          "teks": pakai0[i]["teks"], "jenis": "variasi", "sumber": "variasi"}
                                         for i in sorted(buang)]
        return _hasil(vo, pakai, dibuang, rv["saran_buang"], target)
    return None


def _hasil(vo: dict, pakai: list[dict], dibuang: list[dict], saran: list[dict], target) -> dict:
    pertama = pakai[0]
    judul = judul_hook(pertama["kata"])
    return {
        "vo": vo["id"],
        "kalimat": pakai,
        "urutan": [k["id"] for k in pakai],
        "dibuang": sorted(dibuang, key=lambda d: d["dari"]),
        "saran_buang": saran,
        "durasi_ucapan": round(panjang(pakai), 2),
        "durasi_mentah": vo["durasi"],
        "judul": judul,
        "judul_dipotong": len(pertama["kata"]) > MAKS_JUDUL,
        "cta_terucap": pakai[-1]["teks"] if "cta" in pakai[-1]["topik"] else None,
        "terlalu_pendek": bool(target) and panjang(pakai) < target[0],
    }
