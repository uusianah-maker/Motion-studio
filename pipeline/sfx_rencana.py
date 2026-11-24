"""R29 SFX lebih banyak (owner 16 Nov: "SFX itu banyak, kenapa tidak dipakai?") — yuki.

Satu aturan untuk Generate (ops.py) dan Batch Remix (batch/perencana.py): baca timeline ms-ops/1 yang SUDAH jadi,
cari kejadian, pilih SFX dari Library brand (100 SFX Kenney ber-tag), lalu ganti semua klip track `sfx`.

Kejadian (prioritas tinggi -> rendah):
  hook    teks hook muncul                      -> "muncul" (maximize/open/drop)
  riser   sebelum hook (kalau ada ruang) atau sebelum CTA (kepadatan sedang/ramai) -> naik (maximize/scroll)
  cta     CTA / penutup muncul                  -> "ding" (confirmation/bong/glass)
  harga   kata harga/diskon/promo/gratis/%      -> "cash"/ding (glass/confirmation/bong)
  whoosh  titik potong, zoom/punch-in, transisi -> whoosh (switch/minimize/maximize/close/open)
  pop     kata yang di-highlight (kata kunci/angka) -> pop (pluck/drop/select/toggle/glass)
  halaman halaman subtitle baru (PENGISI, disebar merata) -> pop pelan

Kepadatan (preset `sfx.kepadatan`, bawaan "sedang"):
  tanpa   : tidak ada SFX
  sedikit : jarak >= 3 dtk, maks 1 per 6 dtk
  sedang  : jarak >= 1,5 dtk, maks ±1 per 3 dtk
  ramai   : jarak >= 1 dtk,  maks 1 per 2 dtk
Volume di bawah VO (VO = 1,0). Variasi: file yang sama tidak dipakai lagi dalam 3 SFX terakhir.
Sfx_dilarang Brand Kit + lisensi_iklan=false dihormati. Hybrid: hasil = klip biasa di track `sfx`, bebas
dihapus/digeser di editor; laporan per SFX (detik, jenis, alasan) masuk rencana.
"""

from __future__ import annotations

import hashlib
import re

from efek_otomatis import TAG_HINDARI, _boleh
from jaga_ops import SISA_MS  # pengaman venus: klip <= panjang file - SISA_MS

MIN_CLIP_MS = 100
KEPADATAN = {
    "tanpa": None,
    "sedikit": {"jarak": 3000, "per": 6000},
    "sedang": {"jarak": 1500, "per": 3000},
    "ramai": {"jarak": 1000, "per": 2000},
}
BAWAAN = "sedang"

# jenis kejadian -> (tag kategori Kenney urut prioritas, lalu tag mesin umum (brand lain tanpa Kenney), durasi min, maks, volume, prioritas penyaringan)
JENIS = {
    "muncul": (["maximize", "open", "drop", "teks-muncul", "transisi"], 150, 650, 0.35, 0),
    "cta": (["confirmation", "bong", "glass", "penutup", "kata-kunci"], 120, 800, 0.4, 1),
    "riser": (["maximize", "scroll", "transisi"], 350, 1100, 0.25, 3),
    "harga": (["glass", "confirmation", "bong", "kata-kunci", "penutup"], 110, 800, 0.4, 2),
    "whoosh": (["switch", "minimize", "maximize", "close", "open", "transisi"], 150, 700, 0.3, 3),
    "pop": (["pluck", "drop", "select", "toggle", "glass", "kata-kunci", "teks-muncul"], 100, 450, 0.3, 4),
    "halaman": (["pluck", "toggle", "drop", "select", "teks-muncul", "kata-kunci"], 100, 300, 0.22, 5),
}
TANPA_ASET = {"muncul": ("$sfx:whoosh", 450), "riser": ("$sfx:whoosh", 450), "whoosh": ("$sfx:whoosh", 450),
              "cta": ("$sfx:pop", 250), "harga": ("$sfx:pop", 250), "pop": ("$sfx:pop", 250), "halaman": ("$sfx:pop", 250)}
HINDARI = TAG_HINDARI | {"scratch", "back", "glitch", "error", "question"}

FADE_MASUK_MS = 4
FADE_KELUAR_MS = (15, 40)  # (bunyi utuh, bunyi terpotong)
RISER_MAJU = 900  # riser mulai 0,9 dtk sebelum hook/CTA; pasangan ini boleh lebih rapat dari jarak minimum

KATA_HARGA = re.compile(
    r"^(rp\.?|rupiah|ribu|rb|juta|jt|diskon|disc|promo|gratis|free|ongkir|harga|murah|hemat|cuma|hanya|"
    r"cashback|potongan|sale|flash|rp\.?\d[\d.,]*(rb|k|ribu|jt|juta)?|\d[\d.,]*(rb|k|ribu|jt|juta|%)|%)$")


def kepadatan_dari(preset: dict | None, nilai: str | None = None) -> str:
    k = str(nilai or ((preset or {}).get("sfx") or {}).get("kepadatan") or BAWAAN).strip().lower()
    return k if k in KEPADATAN else BAWAAN


def _bersih(t: str) -> str:
    return re.sub(r"[^\w%.-]+", "", str(t).lower()).strip(".")


def kejadian(ops: list[dict], total_ms: int, hook_ms: int | None = None, cta_ms: int | None = None,
             kepadatan: str = BAWAAN) -> list[tuple[int, str, str]]:
    """(ms, jenis, alasan) dari timeline ms-ops/1 yang sudah jadi."""
    ev: list[tuple[int, str, str]] = []
    if hook_ms is not None:
        ev.append((hook_ms + 60, "muncul", "hook muncul"))
        if hook_ms >= RISER_MAJU:
            ev.append((hook_ms - RISER_MAJU, "riser", "sebelum hook"))
    if cta_ms is not None and cta_ms < total_ms - 300:
        ev.append((cta_ms, "cta", "CTA muncul"))
        if kepadatan in ("sedang", "ramai") and cta_ms >= RISER_MAJU + 300:
            ev.append((cta_ms - RISER_MAJU, "riser", "sebelum CTA"))
    video = sorted((o for o in ops if o.get("track_kind") == "video"), key=lambda o: o["start_ms"])
    for o in video[1:]:
        tr = o.get("transition") or {}
        ev.append((max(0, o["start_ms"] - 80), "whoosh", f"transisi {tr['type']}" if tr.get("type") else "potong"))
    # Zoom-through sebagai keyframe klip video (Generate, keluhan tim 24 Nov): puncak skala >= 1.25 yang diapit
    # skala ~1 = satu kejadian (jangkar di klip tetangga tidak dihitung dua kali).
    puncak = set()
    for o in video:
        kf = o.get("keyframes") or []
        for k in range(1, len(kf) - 1):
            if kf[k].get("scale", 1) >= 1.25 and kf[k - 1].get("scale", 1) <= 1.05 and kf[k + 1].get("scale", 1) <= 1.05:
                t = o["start_ms"] + int(kf[k - 1]["at_ms"])
                if o["start_ms"] <= o["start_ms"] + int(kf[k]["at_ms"]) < o["start_ms"] + o["duration_ms"] and t not in puncak:
                    puncak.add(t)
                    ev.append((max(0, t - 60), "whoosh", "efek zoom_through"))
    for o in ops:
        if o.get("track_kind") == "effects":
            jenis = (o.get("effect") or {}).get("type", "")
            if jenis in ("zoom_through", "flash") or ((o.get("effect") or {}).get("mode") == "cut" and jenis == "zoom"):
                ev.append((max(0, o["start_ms"] - 60), "whoosh", f"efek {jenis}"))
        elif o.get("track_kind") == "subtitle":
            hl = {_bersih(w) for w in (((o.get("style") or {}).get("highlight") or {}).get("words") or [])}
            ada = False
            for w in o.get("words") or []:
                t = o["start_ms"] + int(w.get("start_ms", 0))
                b = _bersih(w.get("text", ""))
                if KATA_HARGA.match(b):
                    ev.append((max(0, t - 40), "harga", f"kata harga '{w.get('text', '')}'"))
                    ada = True
                elif b and b in hl:
                    ev.append((max(0, t - 60), "pop", f"kata kunci '{w.get('text', '')}'"))
                    ada = True
            if not ada:
                ev.append((o["start_ms"], "halaman", "subtitle baru"))
    return [(t, j, a) for t, j, a in ev if 0 <= t <= total_ms - 300]


def saring(ev: list[tuple[int, str, str]], total_ms: int, kepadatan: str = BAWAAN) -> list[tuple[int, str, str]]:
    """Batas kepadatan: jarak minimum, maks 2 SFX per jendela `per` ms, total <= durasi/`per`+1.
    Kejadian penting dulu (urut waktu); PENGISI (halaman) dipilih yang paling jauh dari SFX lain -> merata."""
    k = KEPADATAN.get(kepadatan)
    if not k or not ev:
        return []
    maks = total_ms // k["per"] + 1
    pilih: list[tuple[int, str, str]] = []

    def boleh(t: int, jenis: str = "") -> bool:
        # riser hanya dipakai bersama pasangannya (hook/CTA sudah terpilih tepat RISER_MAJU sesudahnya)
        pasangan = [u for u, j, _ in pilih if jenis == "riser" and j in ("muncul", "cta") and u - t in (RISER_MAJU, RISER_MAJU + 60)]
        if jenis == "riser" and not pasangan:
            return False
        lain = [(u, j) for u, j, _ in pilih if u not in pasangan]
        if any(abs(t - u) < k["jarak"] for u, _ in lain):
            return False
        return sum(1 for u, _ in lain if abs(t - u) < k["per"]) < 2

    # Whoosh maks separuh jatah: video dengan banyak potongan (Batch) tidak boleh berisi whoosh saja.
    maks_whoosh = max(1, (maks + 1) // 2)
    utama = sorted((e for e in ev if e[1] != "halaman"), key=lambda e: (JENIS[e[1]][4], e[0]))
    whoosh = [e for e in utama if e[1] == "whoosh"]
    if len(whoosh) > maks_whoosh:  # pilih whoosh yang tersebar merata, bukan yang paling awal
        langkah = len(whoosh) / maks_whoosh
        dipakai = {id(whoosh[int(i * langkah)]) for i in range(maks_whoosh)}
        cadangan = [e for e in whoosh if id(e) not in dipakai]
        utama = [e for e in utama if e[1] != "whoosh" or id(e) in dipakai] + cadangan
    n_whoosh = 0
    for e in utama:
        if len(pilih) >= maks:
            break
        if e[1] == "whoosh" and n_whoosh >= maks_whoosh:
            continue
        if boleh(e[0], e[1]):
            pilih.append(e)
            n_whoosh += e[1] == "whoosh"
    isi = [e for e in ev if e[1] == "halaman"]
    while isi and len(pilih) < maks:
        jauh = max(isi, key=lambda e: (min((abs(e[0] - u) for u, _, _ in pilih), default=total_ms), -e[0]))
        isi.remove(jauh)
        if boleh(jauh[0]):
            pilih.append(jauh)
    return sorted(pilih)


def kandidat(aset: list[dict], jenis: str, dilarang=()) -> list[dict]:
    tags, dmin, dmax, _, _ = JENIS[jenis]
    hasil = []
    for a in aset:
        if a.get("jenis") != "sfx" or not a.get("kunci") or not _boleh(a, dilarang):
            continue
        t = set(a.get("tag", []))
        if t & HINDARI:
            continue
        d = (a.get("durasi_ms") or 0) - SISA_MS - 1  # panjang yang boleh dipakai (jaga_durasi; +1 ms pembulatan)
        if not max(dmin - SISA_MS, MIN_CLIP_MS) <= d <= dmax:
            continue
        prio = min((tags.index(x) for x in t if x in tags), default=None)
        if prio is not None:
            hasil.append((prio, a["kunci"], a))
    # Selang-seling per kategori (switch, minimize, maximize, ...): giliran berikutnya = bunyi yang beda karakter,
    # bukan maximize-006, -007, -008 berturut-turut.
    grup: dict[int, list[dict]] = {}
    for prio, _, a in sorted(hasil, key=lambda x: (x[0], x[1])):
        grup.setdefault(prio, []).append(a)
    urut, antre = [], [grup[k] for k in sorted(grup)]
    while any(antre):
        for g in antre:
            if g:
                urut.append(g.pop(0))
    return urut


def pasang(ops: list[dict], aset: list[dict], total_ms: int, *, hook_ms: int | None = None, cta_ms: int | None = None,
           kepadatan: str = BAWAAN, dilarang=(), seed: str = "") -> tuple[list[dict], dict]:
    """Ganti SEMUA klip track `sfx` di `ops` dengan rencana R29. -> (ops baru, laporan)."""
    dasar = [o for o in ops if o.get("track_kind") != "sfx"]
    dipilih = saring(kejadian(dasar, total_ms, hook_ms, cta_ms, kepadatan), total_ms, kepadatan)
    calon = {j: kandidat(aset, j, dilarang) for j in JENIS}
    putar = {j: int(hashlib.sha1(f"{seed}|{j}".encode()).hexdigest()[:8], 16) for j in JENIS}
    terakhir: list[str] = []
    sfx_ops, detail, bawaan = [], [], set()
    for i, (t, jenis, alasan) in enumerate(dipilih):
        pil = None
        c = calon[jenis]
        for n in range(len(c)):
            a = c[(putar[jenis] + n) % len(c)]
            if a["kunci"] not in terakhir[-3:]:
                pil = a
                putar[jenis] += n + 1
                break
        if pil is None and c:
            pil = c[putar[jenis] % len(c)]
            putar[jenis] += 1
        if pil:
            kunci, dur = pil["kunci"], int(pil.get("durasi_ms") or 300) - SISA_MS - 1
        else:
            kunci, dur = TANPA_ASET[jenis]
            bawaan.add(kunci)
        nxt = dipilih[i + 1][0] if i + 1 < len(dipilih) else total_ms
        utuh = min(nxt - t, total_ms - t) >= dur
        dur = min(dur, nxt - t, total_ms - t)
        if dur < MIN_CLIP_MS:
            continue
        vol = JENIS[jenis][3]
        # Keluhan tim 24 Nov: SFX yang terpotong SFX berikutnya berhenti mendadak (klik). Fade sangat pendek:
        # masuk FADE_MASUK_MS (anti klik), keluar FADE_KELUAR_MS (lebih panjang bila bunyinya terpotong). Kontrak 12.1.
        sfx_ops.append({"op": "add_clip", "track_kind": "sfx", "media": kunci, "start_ms": int(t), "duration_ms": int(dur),
                        "volume": vol, "fade_in_ms": FADE_MASUK_MS,
                        "fade_out_ms": min(FADE_KELUAR_MS[0] if utuh else FADE_KELUAR_MS[1], int(dur) // 3)})
        detail.append({"detik": round(t / 1000, 2), "jenis": jenis, "alasan": alasan, "media": kunci})
        terakhir.append(kunci)
    lap = {"kepadatan": kepadatan, "jumlah": len(sfx_ops), "berbeda": len({d["media"] for d in detail}),
           "detail": detail, "bawaan_mesin": sorted(bawaan)}
    return dasar + sfx_ops, lap
