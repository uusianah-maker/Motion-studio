"""R18: preset gaya hasil belajar Hanagaki untuk Batch Remix & Beat Spot (KONTRAK-ENGINE §17, v0.4.0).

Semua field opsional dan aditif: preset/Brand Kit lama (tanpa field ini) = perilaku sebelumnya.
- §17.1 preset.<id>: caption.y/warna/outline/kotak, hook.y/ukuran/baris/warna/dari_kalimat_kuat,
  shot.target_dtk/maks_dtk (shot panjang dipecah + punch-in 110 %), transisi.ganti_orang ("flash"),
  penutup.end_card, beat.tiap_ketukan/bpm (Beat Spot).
- §17.2 job.audio_pilihan: "vo" | "musik" | "keduanya" (tidak ada = perilaku sekarang). Lisensi musik tetap.
- §17.3 Brand Kit teks.tagline, visual.watermark {teks, y, lebar, opasitas}.
"""

import math
import re

MIN_CLIP_MS = 100
FLASH_MS = 300  # flash putih 0,3 dtk saat ganti narasumber/footage (§17.1)
PUNCH = 1.1  # punch-in 110 %
AUDIO_PILIHAN = ("vo", "musik", "keduanya")
KUAT = re.compile(r"\d|\brp\b|\bribu\b|\brb\b|%|\bbintang\b|\brating\b|!", re.I)


def preset_aktif(brand: dict, job: dict) -> dict:
    """Preset job.preset dari Brand Kit ekspor (dict id -> preset). Kit lama: preset tunggal tetap dipakai."""
    pr = brand.get("preset") or {}
    if not isinstance(pr, dict):
        return {}
    if job.get("preset") and isinstance(pr.get(job["preset"]), dict):
        return pr[job["preset"]]
    if pr and all(isinstance(x, dict) for x in pr.values()) and not ({"audio", "caption", "hook", "shot"} & set(pr)):
        return {}  # kumpulan preset tanpa pilihan: tidak menebak
    return pr


def siapkan(brand: dict, brand_raw: dict, job: dict) -> tuple[dict, dict]:
    """(brand dengan preset aktif, gaya untuk buat_ops). gaya["salah"] = alasan tolak input."""
    pr = preset_aktif(brand, job)
    brand2 = {**brand, "preset": pr}
    ap = job.get("audio_pilihan")
    g = {"preset": pr, "audio_pilihan": ap, "caption": pr.get("caption") or {}, "hook": pr.get("hook") or {},
         "shot": pr.get("shot") or {}, "transisi": (pr.get("transisi") or {}).get("ganti_orang"),
         "end_card": bool((pr.get("penutup") or {}).get("end_card")), "beat": pr.get("beat") or {},
         # brandkit.py (venus) sudah mengeluarkan bk["tagline"] & bk["watermark"]; JSON mentah hanya cadangan.
         "tagline": (brand.get("tagline") or (brand_raw.get("teks") or {}).get("tagline") or "").strip() or None,
         "watermark": brand.get("watermark") or (brand_raw.get("visual") or {}).get("watermark") or None}
    if ap is not None and ap not in AUDIO_PILIHAN:
        g["salah"] = f"audio_pilihan harus salah satu dari {', '.join(AUDIO_PILIHAN)}"
    pen = brand.get("penutup") or {}
    g["penutup_aset"] = next((a for a in brand.get("aset", []) if pen.get("aset") and a.get("kunci") == pen["aset"]
                              and a.get("lisensi_iklan", True)), None)
    g["penutup_dtk"] = float(pen.get("detik") or 2.5)
    return brand2, g


def _hex(x) -> str | None:
    return x.lower() if isinstance(x, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", x) else None


def gaya_caption(c: dict, warna: dict) -> dict:
    out = {}
    if isinstance(c.get("y"), (int, float)):
        out["y"] = round(min(0.95, max(0.05, float(c["y"]))), 3)
    if _hex(c.get("warna")):
        out["color"] = _hex(c["warna"])
    if c.get("outline") is not None:
        # Motion Studio: outline = garis gelap + bayangan (boolean); warna outline preset jadi info saja.
        out["outline"] = bool(c["outline"])
    if c.get("kotak") is True:
        out.update({"bg": (warna.get("latar_gelap") or "#000000").lower(), "bg_opacity": 0.6})
    elif c.get("kotak") is False:
        out["bg"] = None
    return out


def gaya_hook(h: dict) -> dict:
    out = {}
    if isinstance(h.get("y"), (int, float)):
        out["y"] = round(min(0.9, max(0.05, float(h["y"]))), 3)
    if isinstance(h.get("ukuran"), (int, float)):
        # §17.1: % tinggi layar per baris; style.size = % sisi PENDEK canvas (9:16 -> x16/9).
        out["size"] = round(min(20.0, max(2.0, float(h["ukuran"]) * 16 / 9)), 2)
    if _hex(h.get("warna")):
        out["color"] = _hex(h["warna"])
    return out


def kalimat_kuat(rv: dict) -> dict | None:
    """Kalimat dengan angka/harga/rating/"!" (hook kuat), atau None."""
    return next((k for k in rv["kalimat"] if KUAT.search(k["teks"])), None)


def teks_hook(rv: dict, h: dict) -> str:
    from vo import judul_hook  # judul maks 6 kata, tidak berakhir kata gantung
    teks = rv["judul"]
    if h.get("dari_kalimat_kuat"):
        k = kalimat_kuat(rv)
        if k:
            teks = judul_hook(k["kata"])
    baris = h.get("baris")
    if isinstance(baris, int) and 1 <= baris <= 3:
        teks = " ".join(teks.split()[: 3 * baris])  # ±3 kata per baris
    return teks


def pecah_shot(potongan: list[dict], shot: dict) -> tuple[list[dict], list[tuple[int, int]]]:
    """§17.1 shot.maks_dtk: potongan lebih panjang dipecah ±target_dtk (min 1 dtk per pecahan); pecahan
    berselang mendapat punch-in 110 %. Kembali (potongan baru, rentang punch-in ms). Tanpa maks = apa adanya."""
    maks = shot.get("maks_dtk")
    if not isinstance(maks, (int, float)) or maks <= 0:
        return potongan, []
    target = shot.get("target_dtk") if isinstance(shot.get("target_dtk"), (int, float)) and shot["target_dtk"] > 0 else maks / 2
    out, punch = [], []
    for p in potongan:
        if p["dur"] <= maks + 1e-6:
            out.append(p)
            continue
        n = max(2, min(math.ceil(p["dur"] / target), int(p["dur"] // 1.0)))
        # Batas pecahan dihitung dalam ms bulat (dibulatkan sekali) supaya klip bersambung tanpa celah/tumpang 1 ms.
        a0, in0 = round(p["start"] * 1000), round(p["in"] * 1000)
        a1 = a0 + round(p["dur"] * 1000)  # ujung sama persis dengan klip utuh (ms(start) + ms(dur))
        batas = [a0 + round((a1 - a0) * j / n) for j in range(n)] + [a1]
        for j in range(n):
            q = dict(p, start=batas[j] / 1000, dur=(batas[j + 1] - batas[j]) / 1000,
                     **{"in": (in0 + batas[j] - a0) / 1000})
            if j:
                q["pecahan"] = True
            if j % 2 == 1:
                punch.append((batas[j], batas[j + 1]))
            out.append(q)
    return out, punch


def gabung_punch(framing: list[dict], punch: list[tuple[int, int]]) -> list[dict]:
    """Gabung framing efek_batch dengan punch-in; zoom halus yang bertabrakan dengan punch-in dibuang."""
    if not punch:
        return framing
    fr = sorted(framing, key=lambda f: f["atMs"])
    rentang = []  # (a, b, scale, mode)
    for i, f in enumerate(fr):
        if f["scale"] > 1.0 and i + 1 < len(fr):
            rentang.append((f["atMs"], fr[i + 1]["atMs"], f["scale"], f.get("mode", "cut")))
    rentang = [r for r in rentang if not any(r[0] < b and r[1] > a for a, b in punch)]
    rentang += [(a, b, PUNCH, "cut") for a, b in punch]
    out = []
    for a, b, sc, mode in sorted(rentang):
        if out and out[-1]["atMs"] == a and out[-1]["scale"] == 1.0:
            out.pop()  # rentang bersambung: tanpa "kembali ke 1.0" di tengah
        out.append({"atMs": a, "scale": sc, "mode": mode})
        out.append({"atMs": b, "scale": 1.0})
    return out


def end_card(ops: list[dict], g: dict, total_ms: int, warna: dict, m: dict | None) -> list[str]:
    """§17.1 penutup.end_card: klip broll aset penutup + tagline sesudah video; musik ikut sampai akhir."""
    if not g.get("end_card"):
        return []
    aset = g.get("penutup_aset")
    if not aset:
        return ["end card: Brand Kit belum punya aset penutup (visual.penutup)"]
    dur = int(round(g.get("penutup_dtk", 2.5) * 1000))
    if aset.get("durasi_ms"):
        dur = min(dur, int(aset["durasi_ms"]) - 34)  # sisakan 1 frame (Motion Studio menolak klip > sumber)
    if dur < MIN_CLIP_MS:
        return ["end card: aset penutup terlalu pendek"]
    ops.append({"op": "add_clip", "track_kind": "broll", "media": aset["kunci"], "start_ms": total_ms,
                "duration_ms": dur, "in_ms": 0})
    catatan = []
    if g.get("tagline"):
        ops.append({"op": "add_clip", "track_kind": "text", "text": g["tagline"], "start_ms": total_ms, "duration_ms": dur,
                    "style": {"x": 0.5, "y": 0.5, "size": 6.0, "width": 0.84, "color": "#ffffff",
                              "bg": (warna.get("latar_gelap") or "#000000").lower(), "bg_opacity": 0.6, "bold": True,
                              "outline": False, "align": "center", "font": "brand"}})
    else:
        catatan.append("end card tanpa tagline: isi Brand Kit teks.tagline")
    musik = [o for o in ops if o.get("track_kind") == "music"]
    if m and musik:
        akhir = max(musik, key=lambda o: o["start_ms"])
        maks_ms = int(m["durasi"] * 1000) - 34
        mulai = akhir["in_ms"] + akhir["duration_ms"]
        if mulai + dur > maks_ms:
            mulai = 0
        if dur <= maks_ms:
            ops.append({"op": "add_clip", "track_kind": "music", "media": akhir["media"], "start_ms": total_ms,
                        "duration_ms": dur, "in_ms": mulai, "volume": akhir.get("volume", 1.0)})
    return catatan


def watermark(ops: list[dict], wm: dict | None) -> int:
    """§17.3: teks watermark kecil sepanjang video. Track text tidak boleh tumpang tindih, jadi watermark
    mengisi sela di antara teks lain (hook, CTA, tagline). Kembali jumlah klip watermark."""
    if not isinstance(wm, dict) or not str(wm.get("teks") or "").strip():
        return 0
    akhir = max((o["start_ms"] + o["duration_ms"] for o in ops if o.get("op") == "add_clip"), default=0)
    sibuk = sorted((o["start_ms"], o["start_ms"] + o["duration_ms"]) for o in ops
                   if o.get("op") == "add_clip" and o.get("track_kind") == "text")
    sela, t = [], 0
    for a, b in sibuk:
        if a - t >= MIN_CLIP_MS:
            sela.append((t, a))
        t = max(t, b)
    if akhir - t >= MIN_CLIP_MS:
        sela.append((t, akhir))
    # Bawaan sama dengan Video iklan (ops.py venus): y 0,07, lebar 0,3, tanpa outline.
    y = wm.get("y") if isinstance(wm.get("y"), (int, float)) else 0.07
    lebar = wm.get("lebar") if isinstance(wm.get("lebar"), (int, float)) else 0.3
    for a, b in sela:
        ops.append({"op": "add_clip", "track_kind": "text", "text": str(wm["teks"]).strip()[:80], "start_ms": a,
                    "duration_ms": b - a,
                    "style": {"x": 0.5, "y": round(min(0.97, max(0.02, float(y))), 3), "size": 2.6,
                              "width": round(min(1.0, max(0.2, float(lebar))), 3), "color": "#ffffff", "bg": None,
                              "bold": False, "outline": False, "align": "center", "font": "brand"}})
    return len(sela)


def peringatan(v: dict, g: dict) -> list[dict]:
    out = []
    if (g.get("hook") or {}).get("dari_kalimat_kuat") and not kalimat_kuat(v["rv"]):
        out.append({"level": "warn", "jenis": "hook", "teks": "tidak ada kalimat kuat (angka/harga/rating/!) untuk hook; "
                    "dipakai kalimat pertama"})
    if g.get("end_card") and not g.get("penutup_aset"):
        out.append({"level": "warn", "jenis": "penutup", "teks": "end card wajib di preset, tetapi Brand Kit belum punya "
                    "aset penutup (visual.penutup)"})
    if isinstance(g.get("watermark"), dict) and g["watermark"].get("opasitas") not in (None, 1, 1.0):
        out.append({"level": "info", "jenis": "watermark", "teks": "opasitas watermark belum didukung Motion Studio; "
                    "watermark tampil penuh"})
    return out
