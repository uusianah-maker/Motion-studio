"""Rencana edit -> keluaran kontrak mesin (V3, KONTRAK-ENGINE v0.3).

Mengubah hasil edit.py (props + laporan potongan) menjadi:
  rencana.json      ringkasan untuk kartu "Rencana edit" (5.1)
  ops.json          operasi timeline Motion Studio (5.2)
  qc_rencana.json   cek sebelum render (5.4)

Semua fitur Motion Studio U3a–U3d sudah dipakai (track sfx/music, volume, set_loudness,
caption per kata + pop + sorot, kotak kaca, zoom/zoom-through, disclaimer, penutup broll).
`mode` (kompat/u3) dipertahankan untuk kompatibilitas kontrak; isinya sekarang sama.
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


VOLUME_MUSIK = 0.12  # jauh di bawah suara; loudness akhir dinormalkan render (set_loudness)


def pilih_musik(bk: dict, preset: dict):
    """(aset musik, alasan). Hanya instrumental=True, lisensi_iklan=True, tidak kena sfx_dilarang.
    Kalau preset menyebut mood, utamakan musik dengan mood/tag itu."""
    calon = [a for a in bk.get("aset", []) if a.get("jenis") == "musik"]
    if not calon:
        return None, "belum ada musik di library brand"
    boleh = [a for a in calon if a.get("instrumental") is True and _boleh_iklan(a, bk.get("sfx_dilarang", []))]
    if not boleh:
        return None, f"{len(calon)} musik di library, tapi tidak ada yang instrumental + berlisensi iklan"
    mood = str((preset.get("audio") or {}).get("mood") or "").lower()
    if mood:
        cocok = [a for a in boleh if mood in str(a.get("mood", "")).lower() or mood in [t.lower() for t in a.get("tag", [])]]
        boleh = cocok or boleh
    return boleh[0], ""


ZOOM_MIN = 1.02
ZOOM_THROUGH_MS = 300  # durasi transisi zoom-through di sekitar titik potong


def efek_video(framing, zoom_throughs, video_ms):
    """Daftar (mulai, akhir, effect) untuk track `effects`, urut dan tidak tumpang tindih.

    framing: [{atMs, scale, mode}] — skala berlaku sampai framing berikutnya (skala < 1.02 = tanpa zoom).
    zoom_throughs: titik potong (ms hasil); efek ±150 ms di sekitarnya, menimpa rentang zoom."""
    zt = []
    for z in sorted(zoom_throughs):
        a, b = max(0, z - ZOOM_THROUGH_MS // 2), min(video_ms, z + ZOOM_THROUGH_MS // 2)
        if b - a >= MIN_CLIP_MS and (not zt or a >= zt[-1][1]):
            zt.append((a, b, {"type": "zoom_through", "scale": 1.4, "x": 0.5, "y": 0.5}))
    out = list(zt)
    fr = sorted(framing, key=lambda f: f["atMs"])
    for i, f in enumerate(fr):
        if f["scale"] < ZOOM_MIN:
            continue
        a, b = f["atMs"], fr[i + 1]["atMs"] if i + 1 < len(fr) else video_ms
        eff = {"type": "zoom", "scale": round(min(f["scale"], 2.5), 3), "mode": f.get("mode", "cut"), "x": 0.5, "y": 0.5}
        # potong rentang zoom di sekitar zoom-through
        potong = [(a, b)]
        for za, zb, _ in zt:
            potong = [p for x0, x1 in potong for p in ((x0, min(x1, za)), (max(x0, zb), x1)) if p[1] - p[0] >= MIN_CLIP_MS]
        out += [(x0, x1, dict(eff)) for x0, x1 in potong]
    return sorted(out, key=lambda e: e[0])


MAKS_KATA_KLIP = 30
MAKS_HURUF_KATA = 40


def _bersih(t: str) -> str:
    """Bentuk pencocokan highlight Motion Studio: huruf kecil, tanpa tanda baca."""
    return re.sub(r"[^\w-]+", "", t.lower())


def kata_klip(page, mulai: int, durasi: int, kapital: str):
    """`words` U3b: satu token per kata, waktu relatif ke awal klip, urut, tidak tumpang tindih,
    di dalam [0, durasi]. Token berspasi dipecah dan waktunya dibagi rata."""
    out = []
    for c in page:
        teks = c["text"]
        if kapital == "semua" or (kapital == "kata_kunci" and c.get("emphasis")):
            teks = teks.upper()
        toks = [t[:MAKS_HURUF_KATA] for t in teks.split()] or ["…"]
        a, b = c["startMs"] - mulai, c["endMs"] - mulai
        step = max((b - a) / len(toks), 1)
        for k, t in enumerate(toks):
            out.append({"text": t, "start_ms": round(a + k * step), "end_ms": round(a + (k + 1) * step)})
    out = out[:MAKS_KATA_KLIP]
    prev = 0
    for w in out:
        w["start_ms"] = min(max(w["start_ms"], prev), durasi)
        w["end_ms"] = min(max(w["end_ms"], w["start_ms"]), durasi)
        prev = w["end_ms"]
    return out


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


def susun(props: dict, laporan: dict, bk: dict, *, placement: str, root: Path, mode: str = "kompat",
          preset: dict | None = None):
    """Kembalikan (rencana, ops, qc)."""
    preset = preset or {}
    warna = bk["warna"]
    lufs = (preset.get("audio") or {}).get("lufs", -14)
    ops = [{"op": "set_canvas", "ratio": "9:16"}, {"op": "set_brand_logo", "on": bool(bk.get("logo") or bk.get("logo_aturan"))},
           {"op": "set_loudness", "lufs": lufs}]
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
        # U3b: kata muncul saat diucapkan (pop), kata kunci disorot. Waktu kata RELATIF ke awal klip.
        words = kata_klip(page, a, b - a, bk.get("kapital", "kata_kunci"))
        kunci = sorted({_bersih(w["text"]) for c in page if c.get("emphasis") for w in [{"text": t} for t in c["text"].split()]}
                       - {""})
        style = dict(gaya_caption, anim="pop", anim_ms=(preset.get("caption") or {}).get("pop_ms", 120))
        if kunci:
            # Aksen sama dengan warna caption (mis. Aysilla krem): kata kunci dibedakan dengan kotak (U3c).
            style["highlight"] = {"words": kunci, "color": warna["aksen"].lower(), "scale": 1.4, "current": False,
                                  "box": warna["aksen"].lower() == warna["caption"].lower()}
        ops.append({"op": "add_clip", "track_kind": "subtitle", "text": " ".join(w["text"] for w in words), "words": words,
                    "start_ms": a, "duration_ms": b - a, "style": style})

    # 3. Judul hook (track text) di awal.
    hook = props.get("hook")
    hook_end = 0
    if hook and hook.get("text"):
        hook_end = min(hook["endMs"], video_ms)
        gaya_hook = {"x": 0.5, "y": round(min(0.8, (hook.get("top") or 0.30) + 0.05), 3), "size": HOOK_SIZE, "width": 0.84,
                     # U3c: kotak kaca (efek 17 glass type) = kotak putih tipis + blur di belakang teks.
                     "color": "#ffffff", "bg": "#ffffff", "bg_opacity": 0.16, "bg_blur": 12, "bold": True, "outline": True,
                     "align": "center", "font": "brand"}
        if hook_end - hook.get("startMs", 0) >= MIN_CLIP_MS:
            ops.append({"op": "add_clip", "track_kind": "text", "text": hook["text"].upper(), "start_ms": hook.get("startMs", 0),
                        "duration_ms": hook_end - hook.get("startMs", 0), "style": gaya_hook})

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
    # Disclaimer (preset teks "disclaimer" ucok): teks kecil di bawah, di sela hook dan CTA
    # (track text tidak boleh tumpang tindih).
    if props.get("disclaimer") and cta_mulai - hook_end >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "text", "text": props["disclaimer"], "start_ms": hook_end,
                    "duration_ms": cta_mulai - hook_end,
                    "style": {"x": 0.5, "y": 0.93, "size": 2.6, "width": 0.9, "color": "#ffffff", "bg": None, "bold": False,
                              "outline": True, "align": "center", "font": "default"}})

    # 5. SFX di track `sfx` (U3a) dengan volume; dari library brand, kalau tidak ada: SFX bawaan mesin.
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
        ops.append({"op": "add_clip", "track_kind": "sfx", "media": kunci, "start_ms": s["atMs"], "duration_ms": dur,
                    "volume": s.get("volume", 1)})

    # 5b. Musik latar di track `music` (U3b): hanya instrumental + boleh iklan + tidak dilarang.
    #     Tiga lajur suara berbunyi bersamaan: audio (VO/suara), music, sfx.
    total_ms = video_ms + penutup_ms
    musik, alasan_musik = pilih_musik(bk, preset)
    if musik:
        dur_m = min(total_ms, musik.get("durasi_ms") or total_ms)
        ops.append({"op": "add_clip", "track_kind": "music", "media": musik["kunci"], "start_ms": 0, "duration_ms": dur_m,
                    "in_ms": 0, "volume": VOLUME_MUSIK})
        if dur_m < total_ms:
            alasan_musik = f"musik {dur_m / 1000:.1f} dtk lebih pendek dari video {total_ms / 1000:.1f} dtk (berhenti sebelum akhir)"

    # 6. Efek video (U3c): digital zoom (ganti framing) + zoom-through di titik potong, satu track `effects`
    #    tanpa tumpang tindih. Zoom-through menang; rentang zoom dipotong di sekitarnya.
    for e in efek_video(props.get("framing") or [], props.get("zoomThroughs") or [], video_ms):
        ops.append({"op": "add_clip", "track_kind": "effects", "start_ms": e[0], "duration_ms": e[1] - e[0], "effect": e[2]})

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
                  "musik": (musik or {}).get("nama") or (musik or {}).get("kunci"),
                  "lisensi_musik": (musik or {}).get("sumber_lisensi") or (musik or {}).get("status_lisensi"),
                  "alasan_tanpa_musik" if not musik else "catatan_musik": alasan_musik,
                  "loudness_lufs": lufs},
        "cta": cta,
        "posisi_caption": laporan.get("posisiCaption", {}).get("y"),
        "peringatan": peringatan,
        "ragu": [{"detik": d["atSec"], "teks": d["word"], "alasan": d["note"]} for d in laporan.get("doubts", [])],
        "menunggu_u3": menunggu,
    }
    rencana["efek"] += [{"jenis": o["effect"]["type"], "detik": round(o["start_ms"] / 1000, 2)} for o in ops if o.get("track_kind") == "effects"]

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
