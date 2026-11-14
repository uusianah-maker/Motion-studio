"""Bagian bersama modul Batch Remix (yuki): path, topik, pembaca kalimat VO.

Modul inti milik venus (edit.py, autocut.py, cek_ucapan.py, brandkit.py) hanya DIIMPOR, tidak diubah.
"""

import re
import sys
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))

from autocut import merge_split_words  # noqa: E402,F401  (milik venus)
from cek_ucapan import cek_ucapan  # noqa: E402  (milik venus)
from edit import SUPERLATIF_UMUM, apply_kamus  # noqa: E402,F401  (milik venus)

from jalur import KONTEN, ROOT  # noqa: E402,F401  (absolut: tidak bergantung folder kerja)

# Topik dari kata yang diucapkan. Dipakai Shot Library (label shot) dan Matcher (label kalimat VO).
TOPIK = {
    "anti_kusut": ["kusut", "lecek", "kucek", "kucek-kucek", "remes", "remes-remes", "banting", "lipatan"],
    "bahan": ["bahan", "bahannya", "poliester", "polyester", "adem", "flowy", "jatuh", "jatoh", "ringan", "tebal",
              "nerawang", "lembut"],
    "high_waist": ["high", "waist", "pinggang", "pinggangnya", "pinggul", "perut", "karet", "fit"],
    "kaki_jenjang": ["jenjang", "kaki", "tinggi"],
    "ukuran": ["size", "ukuran", "cm", "panjang", "160", "150", "170", "bb", "tb"],
    "warna": ["warna", "warnanya", "espresso", "latte", "ivory", "grey", "black", "netral"],
    "harga": ["harga", "harganya", "ribu", "murah", "rp", "kantong", "promo"],
    "styling": ["outfit", "mix", "match", "look", "looks", "looknya", "styling", "kerja", "kantor", "ngantor",
                "kuliah", "casual", "formal", "atasan", "hangout", "ngampus", "traveling"],
    "review": ["review", "reviewnya", "ulasan", "fomo", "rating"],
    "cta": ["keranjang", "checkout", "check", "cek", "beli", "borong"],
    "nyaman": ["nyaman", "enak", "seharian"],
}

# Kalimat VO yang tidak dipakai di iklan (aturan skill konversi + PRD).
BUANG_KALIMAT = {
    "urgensi": ["habis", "kehabisan", "terbatas", "buruan", "sebelum kehabisan"],
    "live": ["live"],
    "musiman": ["lebaran", "buber", "silaturahmi", "ramadhan", "ramadan", "mudik", "thr"],
    "superlatif": ["paling"],
}


def norm(t: str) -> str:
    return re.sub(r"[^\w]+", "", t.lower())


def topik_dari(teks: str) -> list[str]:
    toks = {norm(x) for x in teks.split()}
    return sorted(k for k, keys in TOPIK.items() if toks & {norm(x) for x in keys})


def kalimat(words: list[dict]) -> list[dict]:
    """Pecah kata Whisper jadi kalimat (berakhir . ? !). Waktu dalam detik sumber."""
    words = merge_split_words(words)
    # Whisper memecah singkatan/angka: "A" ".L" ".N." -> "A.L.N.", "30" ".000" -> "30.000".
    rapat = []
    for w in words:
        if rapat and re.match(r"^\.\w", w["text"]):
            rapat[-1] = {**rapat[-1], "text": rapat[-1]["text"] + w["text"], "endMs": w["endMs"]}
        else:
            rapat.append(dict(w))
    words = rapat
    out, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.?!]$", w["text"].strip()):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    res = []
    for ws in out:
        teks = " ".join(w["text"] for w in ws).strip()
        res.append({
            "dari": ws[0]["startMs"] / 1000,
            "sampai": ws[-1]["endMs"] / 1000,
            "teks": teks,
            "kata": ws,
            "topik": topik_dari(teks),
        })
    return res


def alasan_buang(teks: str, terlarang: list[str]) -> str | None:
    low = teks.lower()
    for frasa in list(SUPERLATIF_UMUM) + list(terlarang):
        if frasa and frasa.lower() in low:
            return f"kata terlarang: {frasa}"
    toks = {norm(x) for x in teks.split()}
    for jenis, keys in BUANG_KALIMAT.items():
        if toks & {norm(k) for k in keys}:
            return jenis
    return None
