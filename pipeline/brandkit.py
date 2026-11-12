"""Pembaca Brand Kit untuk mesin (V2).

Menerima dua bentuk:
  1. `brand-kit-export/1` dari Motion Studio (lihat Video motion/docs/BRAND_KIT_EXPORT.md),
     ditulis runner ke <job_dir>/brand_kit.json.
  2. Format lama repo ini (brandkit/<brand>.json), selama masa peralihan.

Keduanya diubah ke satu bentuk internal yang dipakai edit.py / transcribe.py.

Pakai:
  .venv\\Scripts\\python pipeline\\brandkit.py cek <brand_kit.json>
  .venv\\Scripts\\python pipeline\\brandkit.py ekspor brandkit\\aysilla.json --kode AYS > aysilla.export.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "brand-kit-export/1"
PLATFORM = ("tiktok", "instagram", "shopee", "youtube")
POJOK = ("tl", "tr", "bl", "br")
TAMPIL = ("sepanjang", "penutup", "sepanjang+penutup")
KAPITAL = ("normal", "kata_kunci", "semua")
DISCLAIMER_KAPAN = ("selalu", "varian_warna", "harga", "manual")
LEVEL = ("block", "warn")
AREA = ("wajah", "produk", "bawah_15", "atas_10", "kanan_tombol")
BAHASA = ("id", "en", "campur")
KODE_RE = re.compile(r"^[A-Z0-9]{2,5}$")
HEX_RE = re.compile(r"^#[0-9a-f]{6}$")


class BrandKitError(ValueError):
    pass


def _hex(c: str) -> str:
    return (c or "").lower()


def _gelap(warna: list[str]) -> str:
    """Warna paling gelap dari daftar (untuk latar penutup)."""
    def terang(c):
        c = c.lstrip("#")
        return sum(int(c[i : i + 2], 16) for i in (0, 2, 4))

    ok = [c for c in warna if HEX_RE.match(_hex(c))]
    return min(ok, key=terang) if ok else "#000000"


def cek_ekspor(d: dict) -> list[str]:
    """Daftar masalah (kosong = valid). Hanya memeriksa yang dipakai mesin + nilai terbatas."""
    m = []
    if d.get("schema") != SCHEMA:
        return [f"schema harus {SCHEMA}, dapat {d.get('schema')!r}"]
    for kunci in ("brand", "visual", "teks", "aturan", "aset", "preset"):
        if kunci not in d:
            m.append(f"field '{kunci}' tidak ada")
    if m:
        return m
    b, v, t, a = d["brand"], d["visual"], d["teks"], d["aturan"]
    if not b.get("nama"):
        m.append("brand.nama kosong")
    if not KODE_RE.match(b.get("kode", "")):
        m.append(f"brand.kode harus 2-5 huruf besar/angka, dapat {b.get('kode')!r}")
    if b.get("bahasa") not in BAHASA:
        m.append(f"brand.bahasa tidak dikenal: {b.get('bahasa')!r}")
    for k in b.get("handle", {}):
        if k not in PLATFORM:
            m.append(f"brand.handle platform tidak dikenal: {k}")
    for c in v.get("warna", []) + [v.get("warna_teks", ""), (v.get("outline") or {}).get("warna", "")]:
        if not HEX_RE.match(c or ""):
            m.append(f"warna bukan #rrggbb huruf kecil: {c!r}")
    logo = v.get("logo")
    if logo is not None:
        if logo.get("pojok") not in POJOK:
            m.append(f"visual.logo.pojok tidak dikenal: {logo.get('pojok')!r}")
        if logo.get("tampil") not in TAMPIL:
            m.append(f"visual.logo.tampil tidak dikenal: {logo.get('tampil')!r}")
    for k in t.get("cta", {}):
        if k not in PLATFORM:
            m.append(f"teks.cta platform tidak dikenal: {k}")
    if t.get("kapital") not in KAPITAL:
        m.append(f"teks.kapital tidak dikenal: {t.get('kapital')!r}")
    dis = t.get("disclaimer")
    if dis is not None and dis.get("kapan") not in DISCLAIMER_KAPAN:
        m.append(f"teks.disclaimer.kapan tidak dikenal: {dis.get('kapan')!r}")
    if a.get("level") not in LEVEL:
        m.append(f"aturan.level tidak dikenal: {a.get('level')!r}")
    for x in a.get("area_bebas_teks", []):
        if x not in AREA:
            m.append(f"aturan.area_bebas_teks tidak dikenal: {x}")
    # Placeholder yang dirujuk harus ada di daftar aset.
    ada = {x.get("kunci") for x in d["aset"]}
    rujukan = [v.get("font_judul"), v.get("font_caption"), (v.get("penutup") or {}).get("aset")]
    if logo:
        rujukan += [logo.get("aset"), logo.get("aset_terang")]
    for r in rujukan:
        if r and r not in ada:
            m.append(f"placeholder {r} dirujuk tapi tidak ada di aset")
    return m


def dari_ekspor(d: dict) -> dict:
    """brand-kit-export/1 -> bentuk internal mesin."""
    masalah = cek_ekspor(d)
    if masalah:
        raise BrandKitError("Brand Kit tidak valid:\n- " + "\n- ".join(masalah))
    b, v, t, a = d["brand"], d["visual"], d["teks"], d["aturan"]
    aset = {x["kunci"]: x for x in d["aset"]}
    teks_warna = _hex(v["warna_teks"])
    # warna[0] = warna utama brand = aksen kata kunci. Kalau sama dengan warna teks,
    # edit.py membedakan kata kunci dengan kotak (bukan warna).
    utama = [_hex(c) for c in v.get("warna", [])]
    cta = dict(t.get("cta", {}))
    cadangan = next(iter(cta.values()), "")
    for p in PLATFORM:
        cta.setdefault(p, cta.get("tiktok") if p == "shopee" and "tiktok" in cta else cadangan)
    handle = b.get("handle", {})
    logo = v.get("logo") or {}
    dis = t.get("disclaimer") or {}
    return {
        "_format": SCHEMA,
        "id": b.get("id", ""),
        "kode": b["kode"],
        "nama": b["nama"],
        "handle": handle.get("tiktok") or next(iter(handle.values()), ""),
        "handle_per_platform": handle,
        "logo": (aset.get(logo.get("aset")) or {}).get("path", ""),
        "logo_aturan": logo or None,
        "warna": {
            "caption": teks_warna,
            "outline": _hex((v.get("outline") or {}).get("warna", "#000000")),
            "aksen": utama[0] if utama else teks_warna,
            "latar_gelap": _gelap(v.get("warna", [])),
        },
        # Font berupa file; di jalur Motion Studio font dipasang lewat style.font "brand"/"caption".
        "font": {},
        "font_file": {"judul": (aset.get(v.get("font_judul")) or {}).get("path", ""),
                      "caption": (aset.get(v.get("font_caption")) or {}).get("path", "")},
        "caption_outline_px": (v.get("outline") or {}).get("px", 4),
        "kosakata_whisper": t.get("kosakata_whisper", []),
        "kamus_kata": t.get("kamus", {}),
        "kata_kunci": t.get("kata_kunci", []),
        "kapital": t.get("kapital", "kata_kunci"),
        "emoji": t.get("emoji", False),
        "cta": cta,
        "cta_wajib": t.get("cta_wajib", ""),
        "disclaimer": dis.get("teks", ""),
        "disclaimer_kapan": dis.get("kapan", ""),
        # edit.py lama: disclaimer_warna dipakai dengan --disclaimer-warna
        "disclaimer_warna": dis.get("teks", "") if dis.get("kapan") in ("varian_warna", "selalu") else "",
        "superlatif_dilarang": a.get("terlarang", []),
        "level_pelanggaran": a.get("level", "block"),
        "harga": a.get("harga", []),
        "klaim_boleh": a.get("klaim_boleh", []),
        "warna_dilarang": v.get("warna_dilarang", []),
        "area_bebas_teks": a.get("area_bebas_teks", []),
        "produk": b.get("produk", []),
        "preset": d.get("preset", {}),
    }


def muat(path) -> dict:
    """Baca Brand Kit dari file (format ekspor Motion Studio atau format lama)."""
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    if d.get("schema") == SCHEMA:
        return dari_ekspor(d)
    d.setdefault("preset", {})
    d["_format"] = "lama"
    return d


def ke_ekspor(lama: dict, kode: str) -> dict:
    """Format lama -> brand-kit-export/1 (tanpa path aset): data awal untuk Motion Studio."""
    w = lama.get("warna", {})
    warna = list(dict.fromkeys(_hex(c) for c in (w.get("aksen"), w.get("caption"), w.get("latar_gelap")) if c))
    handle = lama.get("handle", "")
    d = {
        "schema": SCHEMA,
        "brand": {"id": "", "nama": lama["nama"], "kode": kode, "handle": {"tiktok": handle, "instagram": handle} if handle else {},
                  "target": "", "nada": [], "bahasa": "campur", "produk": []},
        "visual": {"warna": warna, "warna_teks": _hex(w.get("caption", "#ffffff")),
                   "outline": {"warna": _hex(w.get("outline", "#000000")), "px": lama.get("caption_outline_px", 4)},
                   "warna_dilarang": lama.get("warna_dilarang", []), "font_judul": None, "font_caption": None,
                   "logo": None, "penutup": {"aset": None, "detik": 2.5}, "gaya": "", "grading": ""},
        "teks": {"cta": lama.get("cta", {}), "cta_wajib": "",
                 "disclaimer": {"teks": lama["disclaimer_warna"], "kapan": "varian_warna"} if lama.get("disclaimer_warna") else None,
                 "kosakata_whisper": lama.get("kosakata_whisper", []), "kamus": lama.get("kamus_kata", {}),
                 "kata_kunci": lama.get("kata_kunci", []), "kapital": "kata_kunci", "emoji": False},
        "aturan": {"terlarang": lama.get("superlatif_dilarang", []), "level": "block", "harga": [],
                   "klaim_boleh": lama.get("klaim_boleh", []), "visual_dilarang": [],
                   "area_bebas_teks": ["wajah", "produk", "bawah_15", "kanan_tombol"]},
        "aset": [],
        "preset": {},
    }
    masalah = cek_ekspor(d)
    if masalah:
        raise BrandKitError("Hasil ekspor tidak valid:\n- " + "\n- ".join(masalah))
    return d


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cek", help="validasi Brand Kit dan tampilkan ringkasan")
    c.add_argument("path")
    e = sub.add_parser("ekspor", help="ubah brand kit format lama ke brand-kit-export/1")
    e.add_argument("path")
    e.add_argument("--kode", required=True)
    args = ap.parse_args()
    if args.cmd == "cek":
        try:
            bk = muat(args.path)
        except BrandKitError as err:
            print(err)
            raise SystemExit(1)
        print(f"OK ({bk['_format']}): {bk['nama']} | CTA tiktok: {bk['cta'].get('tiktok', '')} | "
              f"kata kunci {len(bk.get('kata_kunci', []))} | terlarang {len(bk.get('superlatif_dilarang', []))} | "
              f"preset {len(bk.get('preset', {}))}")
    else:
        lama = json.loads(Path(args.path).read_text(encoding="utf-8"))
        print(json.dumps(ke_ekspor(lama, args.kode), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
