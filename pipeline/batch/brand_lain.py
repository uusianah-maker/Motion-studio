"""Deteksi kalimat VO yang menyebut brand LAIN (bukan brand job). Tanpa nama brand di kode.

Sumber nama brand lain (data, bukan kode):
  1. brandkit/*.json di repo mesin selain brand job: "nama", "handle", dan brand-kit-export "brand.nama/handle".
  2. Akun watermark footage di Shot Library (mis. @toko_lain.id) yang bukan akun brand job / akun_sendiri.
Plus satu pola umum: "<kata> store/shop/olshop/..." yang kata depannya bukan brand job dan bukan kata umum
(Whisper sering salah eja nama toko: "ILN Store", "A .L .N. Store", "Island Store").

Kalimat yang kena tidak dipakai di varian (vo.susun) dan QC memeriksa lagi teks akhir (jaring kedua).
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# Kata generik di nama/handle (bukan inti nama brand).
GENERIK = {"store", "shop", "official", "id", "co", "olshop", "toko", "the", "factory", "store_id", "indonesia", "ind"}
# Kata sesudah nama toko yang menandai "ini nama toko".
SUFIKS = {"store", "shop", "olshop", "boutique", "butik", "outlet"}
# Kata depan yang membuat "<kata> store" bukan nama brand (lokasi / marketplace / kata umum).
UMUM_DEPAN = {"di", "ke", "dari", "online", "offline", "official", "ini", "itu", "the", "our", "my", "toko", "flagship",
              "mall", "fisik", "marketplace", "yang", "dan", "atau", "app", "play", "google", "apple", "tiktok",
              "shopee", "tokopedia", "lazada", "blibli", "bukalapak", "instagram", "ig", "online", "nya", "kita",
              "kami", "aku", "kamu", "brand", "brandnya", "nama", "namanya", "langsung", "cek",
              # kategori/kata sifat: "fashion store", "outfit shop murah" = deskripsi, bukan nama toko
              "fashion", "outfit", "baju", "pakaian", "busana", "hijab", "jilbab", "muslim", "muslimah", "gamis",
              "celana", "sepatu", "sandal", "tas", "aksesoris", "kosmetik", "skincare", "makeup", "beauty",
              "grosir", "reseller", "distro", "butik", "boutique", "local", "lokal", "brandlokal", "kids", "anak",
              "pria", "wanita", "cewek", "cowok", "men", "women", "best", "terbaik", "favorit", "langganan",
              "murah", "second", "preloved", "thrift", "vintage", "kain", "tekstil", "konveksi", "olshop", "e"}


def lev(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def token(teks: str) -> list[str]:
    """Huruf kecil + gabungkan huruf tunggal berurutan ("A .L .N." -> "aln")."""
    toks = re.findall(r"[a-z0-9]+", teks.lower())
    out, run = [], []
    for t in toks + [""]:
        if len(t) == 1 and t.isalpha():
            run.append(t)
            continue
        if run:
            out.append("".join(run))
            run = []
        if t:
            out.append(t)
    return out


def inti(nama: str) -> list[str]:
    """Inti nama brand: tanpa @, tanpa kata generik/angka. '@aln_store.id' -> ['aln']."""
    toks = [t for t in re.split(r"[^a-z0-9]+|\d+", nama.lower().lstrip("@")) if t]
    core = [t for t in toks if t not in GENERIK]
    return core or toks


def mirip(a: str, b: str) -> bool:
    if a == b:
        return True
    n = min(len(a), len(b))
    return (n >= 4 and lev(a, b) <= 1) or (n >= 6 and lev(a, b) <= 2)


def _nama_dari_kit(d: dict) -> list[str]:
    out = []
    b = d.get("brand") if isinstance(d.get("brand"), dict) else d
    if isinstance(b.get("nama"), str):
        out.append(b["nama"])
    h = b.get("handle") or d.get("handle")
    if isinstance(h, dict):
        out += [x for x in h.values() if isinstance(x, str)]
    elif isinstance(h, str):
        out.append(h)
    return [x for x in out if x.strip()]


class Pendeteksi:
    def __init__(self, sendiri: list[str], lain: list[str]):
        self.sendiri = [c for n in sendiri for c in [inti(n)] if c]
        self.sendiri_tok = {t for c in self.sendiri for t in c} | {"".join(c) for c in self.sendiri}
        lain_inti = {}
        for n in lain:
            c = inti(n)
            if c and not self._milik_sendiri(c):
                lain_inti.setdefault(tuple(c), n)
        self.lain = lain_inti

    def _milik_sendiri(self, core) -> bool:
        joined = "".join(core)
        return any(mirip(t, s) for t in list(core) + [joined] for s in self.sendiri_tok)

    def cek(self, teks: str) -> str | None:
        """Nama brand lain yang disebut di teks, atau None."""
        toks = token(teks)
        for core, asli in self.lain.items():
            n = len(core)
            for i in range(len(toks) - n + 1):
                if all(mirip(toks[i + k], core[k]) for k in range(n)):
                    return asli.lstrip("@")
            joined = "".join(core)
            if n > 1 and any(mirip(t, joined) for t in toks):
                return asli.lstrip("@")
        for i, t in enumerate(toks[1:], 1):
            d = toks[i - 1]
            if t in SUFIKS and d not in UMUM_DEPAN and not d.isdigit() and len(d) >= 2 \
                    and not any(mirip(d, s) for s in self.sendiri_tok):
                return f"{d} {t}"
        return None


def dari_job(brand_raw: dict, brand: dict, akun_sendiri: list[str], akun_watermark: list[str],
             brandkit_dir: Path | None = None) -> Pendeteksi:
    """Brand job = brand_kit job (+ akun_sendiri). Brand lain = brandkit/*.json lain + akun watermark lain."""
    sendiri = _nama_dari_kit(brand_raw) + _nama_dari_kit(brand) + list(akun_sendiri)
    lain = []
    kode_sendiri = ((brand_raw.get("brand") or {}).get("kode") or "").lower()
    for p in sorted((brandkit_dir or ROOT / "brandkit").glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        kode = ((d.get("brand") or {}).get("kode") or "").lower() if isinstance(d.get("brand"), dict) else ""
        nama = _nama_dari_kit(d)
        if (kode and kode == kode_sendiri) or any(n.lower() == s.lower() for n in nama for s in sendiri):
            continue
        lain += nama
    lain += list(akun_watermark)
    return Pendeteksi(sendiri, lain)
