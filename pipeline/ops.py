"""Rencana edit -> keluaran kontrak mesin (V3, KONTRAK-ENGINE v0.3).

Mengubah hasil edit.py (props + laporan potongan) menjadi:
  rencana.json      ringkasan untuk kartu "Rencana edit" (5.1)
  ops.json          operasi timeline Motion Studio (5.2)
  qc_rencana.json   cek sebelum render (5.4)

Mode `kompat` (default) hanya memakai operasi & field yang SUDAH ada di Motion Studio,
jadi draf bisa langsung diterapkan dan dirender FFmpeg sekarang. Efek yang menunggu U3
(caption pop per kata, sorot kata kunci, kotak kaca, zoom, penutup logo, volume SFX)
dicatat di rencana.json `menunggu_u3`. Mode `u3` menambahkan field usulan 5.3 (belum
diterima validator Motion Studio sampai U3 selesai).
"""

import json
import re
import subprocess
from pathlib import Path

FPS = 30
MIN_CLIP_MS = 100
MAX_OPS = 1000
CTA_MS = 2500
CAPTION_SIZE = 5.6  # % sisi pendek kanvas
HOOK_SIZE = 7.0


def _ms_frame(f: int) -> int:
    return round(f * 1000 / FPS)


def _durasi_file_ms(path: Path) -> int | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return round(float(out) * 1000)
    except Exception:  # noqa: BLE001
        return None


# SFX bawaan mesin -> tag kejadian di library aset brand (urutan = prioritas).
TAG_SFX = {"pop": ["kata-kunci", "teks-muncul"], "whoosh": ["transisi", "teks-muncul"]}


def _boleh_iklan(a: dict, dilarang) -> bool:
    teks = " ".join([a.get("kunci", ""), a.get("nama", "")] + a.get("tag", [])).lower()
    return bool(a.get("lisensi_iklan")) and not any(d.lower() in teks for d in dilarang)


def pilih_sfx_brand(bk: dict, stem: str):
    """Aset SFX brand untuk kejadian SFX bawaan `stem` (pop/whoosh), atau None."""
    aset = [a for a in bk.get("aset", []) if a.get("jenis") == "sfx" and _boleh_iklan(a, bk.get("sfx_dilarang", []))]
    for tag in TAG_SFX.get(stem, []):
        for a in aset:
            if tag in a.get("tag", []):
                return a
    return None


def _halaman(captions):
    """Kelompokkan caption per halaman (pageBreakAfter dari edit.py)."""
    pages, cur = [], []
    for c in captions:
        cur.append(c)
        if c.get("pageBreakAfter"):
            pages.append(cur)
            cur = []
    if cur:
        pages.append(cur)
    return pages


def _teks_halaman(page, kapital: str) -> str:
    out = []
    for c in page:
        t = c["text"]
        if kapital == "semua" or (kapital == "kata_kunci" and c.get("emphasis")):
            t = t.upper()
        out.append(t)
    return " ".join(out)


def susun(props: dict, laporan: dict, bk: dict, *, placement: str, root: Path, mode: str = "kompat",
          preset: dict | None = None):
    """Kembalikan (rencana, ops, qc)."""
    preset = preset or {}
    u3 = mode == "u3"
    warna = bk["warna"]
    ops = [{"op": "set_canvas", "ratio": "9:16"}, {"op": "set_brand_logo", "on": bool(bk.get("logo") or bk.get("logo_aturan"))}]
    menunggu = []

    # 1. Video: potongan sumber berurutan tanpa celah. Akhir potongan dibatasi panjang
    # sumber (frame dibulatkan ke atas bisa melewati akhir file; Motion Studio menolaknya).
    # Sisakan 1 frame: panjang video bisa sedikit lebih pendek dari panjang audio (Whisper).
    sumber_ms = laporan.get("originalMs", round(laporan["originalSec"] * 1000)) - 34
    t = 0
    for s in props["segments"]:
        a, b = _ms_frame(s["startFrame"]), min(_ms_frame(s["endFrame"]), sumber_ms)
        dur = b - a
        if dur < MIN_CLIP_MS:
            continue
        ops.append({"op": "add_clip", "track_kind": "video", "media": "$sumber", "start_ms": t, "duration_ms": dur, "in_ms": a})
        t += dur
    video_ms = t

    # 2. Caption: satu klip subtitle per halaman (frasa).
    y = props["style"]["captionCenterY"]
    gaya_caption = {"x": 0.5, "y": round(y, 3), "size": CAPTION_SIZE, "width": 0.8, "color": warna["caption"].lower(),
                    "bg": None, "bold": True, "outline": True, "align": "center", "font": "caption"}
    pages = _halaman(props["captions"])
    for i, page in enumerate(pages):
        a = page[0]["startMs"]
        b = page[-1]["endMs"]
        if i + 1 < len(pages):
            b = min(b, pages[i + 1][0]["startMs"])
        b = min(b, video_ms)
        if b - a < MIN_CLIP_MS:
            continue
        op = {"op": "add_clip", "track_kind": "subtitle", "text": _teks_halaman(page, bk.get("kapital", "kata_kunci")),
              "start_ms": a, "duration_ms": b - a, "style": dict(gaya_caption)}
        if u3:
            op["words"] = [{"text": c["text"], "start_ms": c["startMs"], "end_ms": c["endMs"]} for c in page]
            op["style"].update({"anim": "pop", "anim_ms": preset.get("caption", {}).get("pop_ms", 100),
                                "highlight": {"words": [c["text"] for c in page if c.get("emphasis")],
                                              "color": warna["aksen"].lower(), "scale": 1.4,
                                              "box": warna["aksen"].lower() == warna["caption"].lower()}})
        ops.append(op)
    if not u3:
        menunggu.append("caption muncul per kata dengan efek pop dan sorot kata kunci (sekarang per frasa, kata kunci KAPITAL)")

    # 3. Judul hook (track text) di awal.
    hook = props.get("hook")
    hook_end = 0
    if hook and hook.get("text"):
        hook_end = min(hook["endMs"], video_ms)
        gaya_hook = {"x": 0.5, "y": round(min(0.8, (hook.get("top") or 0.30) + 0.05), 3), "size": HOOK_SIZE, "width": 0.84,
                     "color": "#ffffff", "bg": "#000000", "bg_opacity": 0.35, "bold": True, "outline": False,
                     "align": "center", "font": "brand"}
        if u3:
            gaya_hook.update({"bg": "#ffffff", "bg_opacity": 0.16, "bg_blur": 12})
        if hook_end - hook.get("startMs", 0) >= MIN_CLIP_MS:
            ops.append({"op": "add_clip", "track_kind": "text", "text": hook["text"].upper(), "start_ms": hook.get("startMs", 0),
                        "duration_ms": hook_end - hook.get("startMs", 0), "style": gaya_hook})
        if not u3:
            menunggu.append("judul hook kotak kaca/blur (sekarang kotak gelap transparan)")

    # 4. Penutup brand (catatan U3 ucok: klip track `broll` dengan media penutup Brand Kit)
    #    sesudah video, CTA tampil di atasnya. Tanpa aset penutup: CTA di detik terakhir video.
    cta = props.get("outroTagline", "")
    pen = bk.get("penutup") or {}
    pen_aset = next((a for a in bk.get("aset", []) if pen.get("aset") and a.get("kunci") == pen["aset"]
                     and a.get("lisensi_iklan", True)), None)
    penutup_ms = 0
    if pen_aset:
        penutup_ms = round((pen.get("detik") or props.get("outroSeconds", 2.5)) * 1000)
        if pen_aset.get("durasi_ms"):
            penutup_ms = min(penutup_ms, pen_aset["durasi_ms"])
        if penutup_ms >= MIN_CLIP_MS:
            ops.append({"op": "add_clip", "track_kind": "broll", "media": pen_aset["kunci"], "start_ms": video_ms,
                        "duration_ms": penutup_ms, "in_ms": 0})
        else:
            penutup_ms = 0
    cta_mulai, cta_akhir = (video_ms, video_ms + penutup_ms) if penutup_ms else (max(hook_end, video_ms - CTA_MS), video_ms)
    if cta and cta_akhir - cta_mulai >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "text", "text": cta, "start_ms": cta_mulai,
                    "duration_ms": cta_akhir - cta_mulai,
                    "style": {"x": 0.5, "y": 0.45, "size": 6.0, "width": 0.84, "color": "#ffffff", "bg": warna["latar_gelap"].lower(),
                              "bg_opacity": 0.75, "bold": True, "outline": False, "align": "center", "font": "brand"}})
    if not penutup_ms:
        menunggu.append(f"penutup logo/video: Brand Kit belum punya aset penutup (sekarang CTA ditampilkan di {CTA_MS / 1000:.1f} dtk terakhir)")
    if props.get("disclaimer"):
        menunggu.append("teks disclaimer kecil (track text dipakai hook/CTA; perlu preset disclaimer di U3)")

    # 5. SFX: aset lokal mesin sampai library aset per brand (U2) siap.
    aset_lokal = {}
    sfx = sorted(props.get("sfx", []), key=lambda s: s["atMs"])
    for i, s in enumerate(sfx):
        brand = pilih_sfx_brand(bk, Path(s["src"]).stem)
        if brand:
            kunci, dur = brand["kunci"], brand.get("durasi_ms") or 300
        else:
            p = (root / "public" / s["src"]).resolve()
            kunci = "$sfx:" + Path(s["src"]).stem
            dur = _durasi_file_ms(p) or 300
        batas = (sfx[i + 1]["atMs"] if i + 1 < len(sfx) else s["atMs"] + dur) - s["atMs"]
        dur = min(dur, batas, max(video_ms - s["atMs"], 0))
        if dur < MIN_CLIP_MS:
            continue
        if not brand:
            aset_lokal[kunci] = str(p).replace("\\", "/")
        op = {"op": "add_clip", "track_kind": "sfx" if u3 else "audio", "media": kunci, "start_ms": s["atMs"], "duration_ms": dur}
        if u3:
            op["volume"] = s.get("volume", 1)
        ops.append(op)
    if sfx and not u3:
        menunggu.append("volume SFX & track SFX terpisah dari musik (sekarang SFX di track audio, volume penuh)")

    # 6. Efek video (zoom, zoom-through) hanya di mode u3.
    if u3:
        for f in props.get("framing") or []:
            ops.append({"op": "add_clip", "track_kind": "effects", "effect": "zoom", "scale": f["scale"], "mode": f["mode"],
                        "start_ms": f["atMs"], "duration_ms": MIN_CLIP_MS})
        for z in props.get("zoomThroughs") or []:
            ops.append({"op": "add_clip", "track_kind": "effects", "effect": "zoom_through", "start_ms": z, "duration_ms": MIN_CLIP_MS})
    elif props.get("framing") or props.get("zoomThroughs"):
        menunggu.append(f"digital zoom ({len(props.get('framing') or [])}x) & zoom-through ({len(props.get('zoomThroughs') or [])}x)")

    ops_doc = {"schema": "ms-ops/1", "mode": mode, "aset_lokal": [{"kunci": k, "path": v} for k, v in aset_lokal.items()], "ops": ops}

    # rencana.json (5.1)
    dur = preset.get("durasi", {})
    target = [dur.get("min", 15), dur.get("max", 30)]
    akhir = round((video_ms + penutup_ms) / 1000, 2)
    peringatan = [{"level": "warn", "jenis": "ucapan", "teks": p} for p in laporan.get("peringatan", [])]
    peringatan += [{"level": bk.get("level_pelanggaran", "block"), "jenis": "kata_terlarang", "detik": x["atSec"], "teks": x["frasa"]}
                   for x in laporan.get("superlatifDisembunyikan", [])]
    status = "siap"
    if not (target[0] <= akhir <= target[1]):
        status = "perlu_keputusan"
        peringatan.append({"level": "warn", "jenis": "durasi",
                           "teks": f"durasi {akhir} dtk di luar target {target[0]}-{target[1]} dtk; pilih bagian tengah yang dibuang"})
    rencana = {
        "schema": "engine-rencana/1",
        "status": status,
        "durasi": {"mentah": laporan["originalSec"], "akhir": akhir, "target": target},
        "dibuang": [{"dari": r["fromSec"], "sampai": r["toSec"], "jenis": r["reason"], "teks": r["text"],
                     "sumber": "user" if "pilihan user" in r["reason"] else "aturan"} for r in laporan["removed"]],
        "hook": {"teks": hook["text"], "dari": hook.get("startMs", 0) / 1000, "sampai": hook_end / 1000, "sumber": "aturan"} if hook else None,
        "kata_kunci": [{"teks": k["text"], "detik": round(k["atMs"] / 1000, 2)} for k in laporan.get("kataKunci", [])],
        "efek": [{"jenis": "kotak_kaca", "dari": 0, "sampai": hook_end / 1000}] if hook else [],
        "audio": {"sfx": sum(1 for o in ops if o.get("media", "").startswith("$sfx:")),
                  "musik": None, "alasan_tanpa_musik": "belum ada musik berlisensi di library brand"},
        "cta": cta,
        "posisi_caption": laporan.get("posisiCaption", {}).get("y"),
        "peringatan": peringatan,
        "ragu": [{"detik": d["atSec"], "teks": d["word"], "alasan": d["note"]} for d in laporan.get("doubts", [])],
        "menunggu_u3": menunggu,
    }
    for z in props.get("zoomThroughs") or []:
        rencana["efek"].append({"jenis": "zoom_through", "detik": round(z / 1000, 2)})

    # qc_rencana.json (5.4)
    teks_layar = " ".join(o.get("text", "") for o in ops).lower()
    terlarang = [w for w in bk.get("superlatif_dilarang", []) if w.lower() in teks_layar]
    pos = laporan.get("posisiCaption", {})
    kena_wajah = next((k["kenaWajah"] for k in pos.get("kandidat", []) if k["y"] == pos.get("y")), 0)
    jenis_efek = {e["jenis"] for e in rencana["efek"]}
    maks_efek = preset.get("efek", {}).get("maks", 3)
    qc = {
        "schema": "engine-qc-rencana/1",
        "butir": [
            {"butir": "durasi sesuai target", "lulus": target[0] <= akhir <= target[1], "nilai": akhir},
            {"butir": "hook di 3 detik pertama", "lulus": bool(hook) and hook_end <= 3000},
            {"butir": "kata terlarang tidak tampil sebagai teks", "lulus": not terlarang, "nilai": terlarang},
            {"butir": "jumlah jenis efek <= batas preset", "lulus": len(jenis_efek) <= maks_efek, "nilai": sorted(jenis_efek)},
            {"butir": "caption tidak di 15% bawah", "lulus": y + 0.07 <= 0.85, "nilai": y},
            {"butir": "caption tidak menutup wajah", "lulus": kena_wajah < 0.10, "nilai": kena_wajah},
            {"butir": "jumlah operasi <= 1000", "lulus": len(ops) <= MAX_OPS, "nilai": len(ops)},
        ],
    }
    qc["lulus"] = all(b["lulus"] for b in qc["butir"])
    return rencana, ops_doc, qc


def tulis(out_dir: Path, rencana, ops_doc, qc) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for nama, isi in (("rencana.json", rencana), ("ops.json", ops_doc), ("qc_rencana.json", qc)):
        (out_dir / nama).write_text(json.dumps(isi, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
