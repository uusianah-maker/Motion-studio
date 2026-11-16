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
FADE_SAMBUNG_MS = 20  # R8: anti klik di sambungan potongan video
FADE_MUSIK_MASUK_MS = 300
FADE_MUSIK_KELUAR_MS = 800
DUCKING_LEVEL = 0.3  # kontrak 12.2 (default app)


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
from efek_otomatis import STEM_KE_JENIS, pilih_sfx  # noqa: E402
import sfx_rencana  # noqa: E402  (R29)

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


def _warna(nilai, bawaan: str) -> str:
    v = str(nilai or "").strip().lower()
    return v if re.fullmatch(r"#[0-9a-f]{6}", v) else bawaan.lower()


PUNCH_IN = 1.1


def punch_in(framing, klip_video, maks_ms: float):
    """§17.1 shot.maks_dtk: shot lebih panjang dari batas dipecah dengan punch-in 110 % bergantian
    (aturan 2 laporan Hanagaki). Hanya di rentang klip yang belum punya framing sendiri."""
    out = list(framing)
    ada = sorted(f["atMs"] for f in framing)
    for o in klip_video:
        a, b = o["start_ms"], o["start_ms"] + o["duration_ms"]
        if b - a <= maks_ms or any(a <= t < b for t in ada):
            continue
        # Skala yang sedang berlaku (framing terakhir sebelum klip) dipulihkan sesudah klip.
        dasar = next((f["scale"] for f in sorted(framing, key=lambda f: -f["atMs"]) if f["atMs"] <= a), 1.0)
        n = int((b - a) // maks_ms)
        for k in range(1, n + 1):
            t = round(a + (b - a) * k / (n + 1))
            out.append({"atMs": t, "scale": round(dasar * PUNCH_IN, 3) if k % 2 else dasar, "mode": "cut"})
        if n % 2:
            out.append({"atMs": b, "scale": dasar, "mode": "cut"})
    return sorted(out, key=lambda f: f["atMs"])


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
          preset: dict | None = None, batas_durasi: list | None = None):
    """Kembalikan (rencana, ops, qc).

    Durasi TANPA BATAS secara default (keputusan owner 13 Nov 2026, sama dengan Batch Remix):
    durasi preset hanya saran. Batas aktif hanya kalau job memberi `batas_durasi: [min, maks]`."""
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
    # R8: fade suara sangat pendek di tiap sambungan potongan supaya tidak ada bunyi "klik" di jump cut.
    # Hybrid: nilainya tetap bisa diubah/dihapus per klip di Inspector (Suara).
    klip_video = [o for o in ops if o.get("track_kind") == "video"]
    for i, o in enumerate(klip_video):
        if i > 0:
            o["fade_in_ms"] = FADE_SAMBUNG_MS
        if i + 1 < len(klip_video):
            o["fade_out_ms"] = FADE_SAMBUNG_MS

    # 2. Caption: satu klip subtitle per halaman (frasa).
    y = props["style"]["captionCenterY"]
    p_cap = preset.get("caption") or {}
    gaya_caption = {"x": 0.5, "y": round(y, 3), "size": CAPTION_SIZE, "width": 0.8,
                    "color": _warna(p_cap.get("warna"), warna["caption"]),
                    "bg": None, "bold": True, "outline": True, "align": "center", "font": "caption"}
    if p_cap.get("kotak"):  # §17.1: kotak latar caption
        gaya_caption.update(bg=warna["latar_gelap"].lower(), bg_opacity=0.7, outline=False)
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
        p_hook = preset.get("hook") or {}
        # §17.1 hook.ukuran = % tinggi layar per baris; style.size = % sisi pendek (9:16 -> x 16/9).
        ukuran = round(min(12.0, float(p_hook["ukuran"]) * 16 / 9), 2) if p_hook.get("ukuran") else HOOK_SIZE
        gaya_hook = {"x": 0.5, "y": round(min(0.8, (hook.get("top") or 0.30) + 0.05), 3), "size": ukuran, "width": 0.84,
                     # U3c: kotak kaca (efek 17 glass type) = kotak putih tipis + blur di belakang teks.
                     "color": _warna(p_hook.get("warna"), "#ffffff"), "bg": "#ffffff", "bg_opacity": 0.16, "bg_blur": 12, "bold": True, "outline": True,
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
            # sisakan 1 frame: durasi_ms dibulatkan, file asli bisa 1 ms lebih pendek (Motion Studio menolak)
            penutup_ms = min(penutup_ms, pen_aset["durasi_ms"] - 34)
        if penutup_ms >= MIN_CLIP_MS:
            ops.append({"op": "add_clip", "track_kind": "broll", "media": pen_aset["kunci"], "start_ms": video_ms,
                        "duration_ms": penutup_ms, "in_ms": 0})
        else:
            penutup_ms = 0
    cta_mulai, cta_akhir = (video_ms, video_ms + penutup_ms) if penutup_ms else (max(hook_end, video_ms - CTA_MS), video_ms)
    cta_tampil = bool(cta) and cta_akhir - cta_mulai >= MIN_CLIP_MS
    if cta_tampil:
        ops.append({"op": "add_clip", "track_kind": "text", "text": cta, "start_ms": cta_mulai,
                    "duration_ms": cta_akhir - cta_mulai,
                    "style": {"x": 0.5, "y": 0.45, "size": 6.0, "width": 0.84, "color": "#ffffff", "bg": warna["latar_gelap"].lower(),
                              "bg_opacity": 0.75, "bold": True, "outline": False, "align": "center", "font": "brand"}})
    if not penutup_ms:
        menunggu.append("penutup logo/video: Brand Kit belum punya aset penutup"
                        + (f" (sekarang CTA ditampilkan di {CTA_MS / 1000:.1f} dtk terakhir)" if cta_tampil else ""))
    # Disclaimer (preset teks "disclaimer" ucok): teks kecil di bawah, di sela hook dan CTA
    # (track text tidak boleh tumpang tindih).
    if props.get("disclaimer") and cta_mulai - hook_end >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "text", "text": props["disclaimer"], "start_ms": hook_end,
                    "duration_ms": cta_mulai - hook_end,
                    "style": {"x": 0.5, "y": 0.93, "size": 2.6, "width": 0.9, "color": "#ffffff", "bg": None, "bold": False,
                              "outline": True, "align": "center", "font": "default"}})

    # 5. SFX: dipasang SESUDAH efek video (langkah 6b, R29 sfx_rencana) karena titik potong/zoom ikut jadi kejadian.
    aset_lokal = {}
    seed = str((props.get("hook") or {}).get("text", "")) if isinstance(props.get("hook"), dict) else str(props.get("hook") or "")

    # 5b. Musik latar di track `music` (U3b): hanya instrumental + boleh iklan + tidak dilarang.
    #     Tiga lajur suara berbunyi bersamaan: audio (VO/suara), music, sfx.
    total_ms = video_ms + penutup_ms
    musik, alasan_musik = pilih_musik(bk, preset)
    if musik:
        dur_m = min(total_ms, musik.get("durasi_ms") or total_ms)
        # R8: musik masuk/keluar pelan + turun otomatis saat ada orang bicara (ducking). Bisa diubah di editor.
        ops.append({"op": "add_clip", "track_kind": "music", "media": musik["kunci"], "start_ms": 0, "duration_ms": dur_m,
                    "in_ms": 0, "volume": VOLUME_MUSIK,
                    "fade_in_ms": min(FADE_MUSIK_MASUK_MS, dur_m // 4), "fade_out_ms": min(FADE_MUSIK_KELUAR_MS, dur_m // 4)})
        ops.append({"op": "set_ducking", "on": True, "level": DUCKING_LEVEL})
        if dur_m < total_ms:
            alasan_musik = f"musik {dur_m / 1000:.1f} dtk lebih pendek dari video {total_ms / 1000:.1f} dtk (berhenti sebelum akhir)"

    # 6. Efek video (U3c): digital zoom (ganti framing) + zoom-through di titik potong, satu track `effects`
    #    tanpa tumpang tindih. Zoom-through menang; rentang zoom dipotong di sekitarnya.
    framing = list(props.get("framing") or [])
    maks_shot = (preset.get("shot") or {}).get("maks_dtk")
    if maks_shot:
        framing = punch_in(framing, [o for o in ops if o.get("track_kind") == "video"], float(maks_shot) * 1000)
    for e in efek_video(framing, props.get("zoomThroughs") or [], video_ms):
        ops.append({"op": "add_clip", "track_kind": "effects", "start_ms": e[0], "duration_ms": e[1] - e[0], "effect": e[2]})

    # 6b. R29 SFX lebih banyak (yuki): kejadian dari timeline jadi (hook, potong/zoom/transisi, kata kunci, harga,
    #     CTA, halaman subtitle), kepadatan dari preset `sfx.kepadatan` (bawaan sedang), volume di bawah VO.
    hook_ms = hook.get("startMs", 0) if hook and hook.get("text") and hook_end - hook.get("startMs", 0) >= MIN_CLIP_MS else None
    ops, lap_sfx = sfx_rencana.pasang(ops, bk.get("aset", []), video_ms + penutup_ms, hook_ms=hook_ms,
                                      cta_ms=cta_mulai if cta_tampil else None,
                                      kepadatan=sfx_rencana.kepadatan_dari(preset), dilarang=bk.get("sfx_dilarang", []),
                                      seed=seed)
    for kunci in lap_sfx["bawaan_mesin"]:  # Library brand tidak punya yang pas: SFX bawaan mesin (public/sfx)
        aset_lokal[kunci] = str((root / "public" / "sfx" / f"{kunci.split(':', 1)[1]}.wav").resolve()).replace("\\", "/")

    # §17.3 watermark teks kecil sepanjang video (opsional Brand Kit).
    # Motion Studio hanya punya SATU track teks: watermark mengisi celah di antara hook/CTA/disclaimer
    # (hilang sebentar saat teks lain tampil). Watermark yang selalu tampil = logo Brand Kit (set_brand_logo).
    wm = bk.get("watermark") or {}
    if wm.get("teks"):
        gaya_wm = {"x": 0.5, "y": round(float(wm.get("y", 0.07)), 3), "size": 2.6, "width": float(wm.get("lebar", 0.3)),
                   "color": "#ffffff", "bg": None, "bold": False, "outline": False, "align": "center", "font": "brand"}
        terpakai = sorted((o["start_ms"], o["start_ms"] + o["duration_ms"]) for o in ops if o.get("track_kind") == "text")
        t0, akhir_wm = 0, video_ms + penutup_ms
        for a0, b0 in terpakai + [(akhir_wm, akhir_wm)]:
            if a0 - t0 >= MIN_CLIP_MS:
                ops.append({"op": "add_clip", "track_kind": "text", "text": str(wm["teks"])[:60], "start_ms": t0,
                            "duration_ms": a0 - t0, "style": dict(gaya_wm)})
            t0 = max(t0, b0)

    ops_doc = {"schema": "ms-ops/1", "mode": mode, "aset_lokal": [{"kunci": k, "path": v} for k, v in aset_lokal.items()], "ops": ops}

    # rencana.json (5.1)
    dur = preset.get("durasi", {})
    saran = [dur.get("min", 15), dur.get("max", 30)]
    target = list(batas_durasi) if batas_durasi else None
    akhir = round((video_ms + penutup_ms) / 1000, 2)
    peringatan = [{"level": "warn", "jenis": "ucapan", "teks": p} for p in laporan.get("peringatan", [])]
    peringatan += [{"level": bk.get("level_pelanggaran", "block"), "jenis": "kata_terlarang", "detik": x["atSec"], "teks": x["frasa"]}
                   for x in laporan.get("superlatifDisembunyikan", [])]
    if cta and not cta_tampil:
        peringatan.append({"level": "warn", "jenis": "cta",
                           "teks": "CTA tidak muat (video terlalu pendek setelah hook). Tambahkan CTA manual di editor."})
    if (preset.get("penutup") or {}).get("end_card") and not penutup_ms:
        peringatan.append({"level": "warn", "jenis": "penutup",
                           "teks": "Preset meminta end card, tapi Brand Kit belum punya aset penutup. Isi di menu Brand "
                                   "(visual penutup + tagline) atau tambahkan manual di editor."})
    if not cta:
        # G6: dulu rencana menyebut "CTA ditampilkan" padahal CTA Brand Kit kosong, tanpa peringatan.
        peringatan.append({"level": "warn", "jenis": "cta",
                           "teks": "CTA Brand Kit kosong: video ini tanpa ajakan beli. Isi CTA di menu Brand, "
                                   "atau tambahkan teks CTA manual di editor."})
    hook_lewat = str((laporan.get("cekTeksBawaan") or {}).get("catatan") or "").startswith("hook dilewati")
    if hook_lewat:
        peringatan.append({"level": "warn", "jenis": "hook",
                           "teks": "Hook dilewati karena teks bawaan video memenuhi layar di detik awal. "
                                   "Tambahkan hook manual di editor kalau perlu."})
    status = "siap"
    if target and not (target[0] <= akhir <= target[1]):
        status = "perlu_keputusan"
        peringatan.append({"level": "warn", "jenis": "durasi",
                           "teks": f"durasi {akhir} dtk di luar target {target[0]}-{target[1]} dtk; pilih bagian tengah yang dibuang"})
    rencana = {
        "schema": "engine-rencana/1",
        "status": status,
        "durasi": {"mentah": laporan["originalSec"], "akhir": akhir, "target": target, "saran": saran},
        "dibuang": [{"dari": r["fromSec"], "sampai": r["toSec"], "jenis": r["reason"], "teks": r["text"],
                     "sumber": "user" if "pilihan user" in r["reason"] else "aturan"} for r in laporan["removed"]],
        "hook": {"teks": hook["text"], "dari": hook.get("startMs", 0) / 1000, "sampai": hook_end / 1000, "sumber": "aturan"} if hook else None,
        "kata_kunci": [{"teks": k["text"], "detik": round(k["atMs"] / 1000, 2)} for k in laporan.get("kataKunci", [])],
        "efek": [{"jenis": "kotak_kaca", "dari": 0, "sampai": hook_end / 1000}] if hook else [],
        "audio": {"sfx": sum(1 for o in ops if o.get("media", "").startswith("$sfx:")),
                  "sfx_rencana": lap_sfx,
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
            {"butir": "durasi sesuai target", "lulus": not target or target[0] <= akhir <= target[1],
             "nilai": akhir if target else f"{akhir} dtk (tanpa batas; saran {saran[0]}-{saran[1]} dtk)"},
            {"butir": "hook di 3 detik pertama", "lulus": (bool(hook) and hook_end <= 3000) or hook_lewat,
             **({"nilai": "dilewati: teks bawaan video (G2)"} if hook_lewat else {})},
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
