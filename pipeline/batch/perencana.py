"""Y5 Perencana batch (Batch Remix): N varian unik -> batch.json + rencana.json + ops.json per varian.

Kontrak: docs/KONTRAK-ENGINE.md v0.3 (bagian 3 mode "batch", 5.1, 5.2, 5.3a, 5.4).
Mesin TIDAK merender. Motion Studio (U5) menampilkan tabel batch.json, tim mencoret/menyetujui sekali,
lalu runner merender varian berstatus "disetujui".

Pakai (dari D:\\VIBECODING\\remotion):
  .venv\\Scripts\\python pipeline\\batch\\perencana.py <job_dir>
Progres: satu JSON per baris di stdout. Kode keluar: 0 berhasil, 2 ditolak (tidak ada varian), 1 gagal teknis.

job.json (mode batch) yang dibaca:
  batch, jumlah, tujuan, seed, izinkan_musik_tanpa_lisensi, brief.produk, brief.placement, brand_kit,
  opsional: mode_ops (kompat|u3), hak_pakai_jelas (default false), akun_sendiri, shot_tiktok,
  buang_otomatis (default [] = tidak ada kalimat VO dibuang), batas_durasi (default null = tanpa batas).
"""

import json
import os
import random
import re
import subprocess
import sys
import traceback
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import KONTEN, PIPELINE, norm  # noqa: E402
import matcher  # noqa: E402
import musik as musik_mod  # noqa: E402
import vo as vo_mod  # noqa: E402
from brandkit import muat as muat_brand_kit  # noqa: E402  (milik venus)
from ops import CAPTION_SIZE, CTA_MS, HOOK_SIZE, MIN_CLIP_MS, _bersih, kata_klip  # noqa: E402  (milik venus, konvensi sama)

BATCH_PY = Path(r"D:\VIBECODING\tools\demucs-venv\Scripts\python.exe")  # punya OpenCV untuk Shot Library
# Saran durasi per tujuan: hanya informasi di rencana. Batas baru berlaku kalau job menulis batas_durasi
# (keputusan owner: batas diputuskan tim nanti, sekarang tanpa batas).
SARAN_DURASI = {"konversi": (20.0, 30.0), "awareness": (12.0, 25.0), "branding": (20.0, 45.0)}
TAHAN = 1.5  # gambar ditahan sesudah kalimat terakhir
MAKS_KATA_CAPTION = 3
MAKS_OPS = 1000
MAKS_MIRIP = 0.6  # Jaccard shot broll antar varian dengan VO sama


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


def ms(x: float) -> int:
    return int(round(x * 1000))


def frasa_caption(kalimat_list, vo_klip):
    """Caption per frasa (maks 3 kata, pecah di tanda baca) dengan waktu timeline hasil."""
    res = []
    for k, vk in zip(kalimat_list, vo_klip):
        g = vk["start"] - k["dari"]
        frasa, cur = [], []
        for w in k["kata"]:
            cur.append(w)
            if len(cur) >= MAKS_KATA_CAPTION or re.search(r"[.,?!]$", w["text"]):
                frasa.append(cur)
                cur = []
        if cur:
            frasa.append(cur)
        for f in frasa:
            res.append({"teks": " ".join(w["text"] for w in f),
                        "dari": f[0]["startMs"] / 1000 + g, "sampai": f[-1]["endMs"] / 1000 + g,
                        "kata": [{"text": w["text"], "start_ms": ms(w["startMs"] / 1000 + g),
                                  "end_ms": ms(w["endMs"] / 1000 + g)} for w in f]})
    # Rapikan supaya klip subtitle tidak tumpang tindih.
    for x, y in zip(res, res[1:]):
        if x["sampai"] > y["dari"]:
            x["sampai"] = y["dari"]
    return [r for r in res if r["sampai"] - r["dari"] >= 0.12]  # Motion Studio: klip minimal 100 ms


def sorot(teks: str, kata_kunci: list[str]) -> list[str]:
    low = teks.lower()
    out = []
    for kk in kata_kunci:
        if kk.lower() in low:
            out += [w for w in teks.split() if norm(w) in {norm(t) for t in kk.split()}]
    out += [w for w in teks.split() if re.fullmatch(r"[\d.,]+(rb|ribu|k)?", norm(w))]
    return list(dict.fromkeys(out))


MS_CORE = Path(os.environ.get("MOTION_STUDIO_CORE", "D:/VIBECODING/Video motion/packages/core/dist"))


def punya_track_music() -> bool:
    """True kalau build Motion Studio (yang juga dipakai validasi_ops.mjs) sudah menerima track `music` (U3b)."""
    try:
        teks = (MS_CORE / "storage" / "timeline.js").read_text(encoding="utf-8")
    except OSError:
        return False
    return bool(re.search(r"TRACK_ORDER\s*=\s*\[[^\]]*['\"]music['\"]", teks))


MAKS_AREA_BLUR = 8  # Motion Studio MAX_BLUR_REGIONS


def blur_valid(regions: list[dict]) -> list[dict]:
    """Rapikan area blur ke aturan validateBlur Motion Studio: di dalam bingkai, w/h >= 0.01, maks 8 area."""
    out = []
    for r in regions:
        x, y = min(max(r["x"], 0.0), 0.99), min(max(r["y"], 0.0), 0.99)
        w, h = min(r["w"], 1 - x), min(r["h"], 1 - y)
        if w < 0.01 or h < 0.01 or r["sampai_ms"] <= r["dari_ms"]:
            continue
        out.append({"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4),
                    "dari_ms": int(r["dari_ms"]), "sampai_ms": int(r["sampai_ms"]), "radius": int(min(max(r.get("radius", 20), 2), 60))})
    # Kalau lebih dari 8, utamakan area terbesar (watermark & footer), sisanya dilaporkan lewat peringatan.
    return sorted(out, key=lambda r: -r["w"] * r["h"])[:MAKS_AREA_BLUR]


def buat_ops(v: dict, brand: dict, mode: str, pakai_blur: bool) -> tuple[list[dict], list[str]]:
    """Ops sesuai kontrak 5.2 + v0.3.1, konvensi sama dengan pipeline/ops.py (venus).

    kompat: operasi/field yang sudah diterima Motion Studio: U3a (volume, set_loudness), U3b (track music,
            caption words + pop + highlight), U3c (kotak kaca hook, highlight.box), U3d (Clip.blur, waktu = ms sumber).
            Blur hanya dipasang kalau hak pakai footage jelas (kontrak 5.3).
    u3    : sama; disimpan untuk kompatibilitas job lama.
    """
    u3 = mode == "u3"
    menunggu = []
    warna = brand["warna"]
    lufs = ((brand.get("preset") or {}).get("audio") or {}).get("lufs", -14)
    ops = [{"op": "set_canvas", "ratio": "9:16"},
           {"op": "set_brand_logo", "on": bool(brand.get("logo") or brand.get("logo_aturan"))},
           {"op": "set_loudness", "lufs": lufs}]  # U3a
    for p in v["susunan"]["potongan"]:
        # volume 0 (U3a): klip video berasal dari video bisu, suara dari stem vokal di track audio.
        op = {"op": "add_clip", "track_kind": "video", "media": f"$sumber:{p['footage']}",
              "start_ms": ms(p["start"]), "duration_ms": ms(p["dur"]), "in_ms": ms(p["in"]), "volume": 0}
        if pakai_blur and p["blur"]:
            op["blur"] = blur_valid(p["blur"])  # Clip.blur U3d
        ops.append(op)
    for vk in v["susunan"]["vo_klip"]:
        ops.append({"op": "add_clip", "track_kind": "audio", "media": f"$vokal:{v['vo']}",
                    "start_ms": ms(vk["start"]), "duration_ms": ms(vk["dur"]), "in_ms": ms(vk["in"]), "volume": 1.0})
    m = v["musik"]
    # Track `music` (U3b, keputusan ucok 13 Nov): lane suara ketiga di samping `audio` (VO) dan `sfx`.
    if m and (u3 or punya_track_music()):
        t, total = 0.0, v["durasi"]
        while t < total - 0.05:  # musik pendek diulang, klip berurutan tanpa tumpang tindih
            d = min(m["durasi"], total - t)
            ops.append({"op": "add_clip", "track_kind": "music", "media": m["kunci"],
                        "start_ms": ms(t), "duration_ms": ms(d), "in_ms": 0, "volume": m["volume"]})
            t += d
    elif m:
        menunggu.append("musik latar di track `music` (menunggu U3b Motion Studio)")
    gaya_caption = {"x": 0.5, "y": 0.36, "size": CAPTION_SIZE, "width": 0.8, "color": warna["caption"].lower(),
                    "bg": None, "bold": True, "outline": True, "align": "center", "font": "caption"}
    kapital = brand.get("kapital", "kata_kunci")
    pop_ms = ((brand.get("preset") or {}).get("caption") or {}).get("pop_ms", 120)
    for c in v["caption"]:
        # U3b, bentuk sama dengan Generate Otomatis: words relatif klip (kata_klip) + pop + sorot kata kunci.
        hl = set(sorot(c["teks"], brand.get("kata_kunci", [])))
        a, b = ms(c["dari"]), ms(c["sampai"])
        page = [{"text": w["text"], "startMs": w["start_ms"], "endMs": w["end_ms"], "emphasis": w["text"] in hl}
                for w in c["kata"]]
        words = kata_klip(page, a, b - a, kapital)
        kunci = sorted({_bersih(t) for t in hl} - {""})
        style = dict(gaya_caption, anim="pop", anim_ms=pop_ms)
        if kunci:
            # Aksen sama dengan warna caption (mis. Aysilla krem): kata kunci dibedakan dengan kotak (U3c).
            style["highlight"] = {"words": kunci, "color": warna["aksen"].lower(), "scale": 1.4, "current": False,
                                  "box": warna["aksen"].lower() == warna["caption"].lower()}
        ops.append({"op": "add_clip", "track_kind": "subtitle", "text": " ".join(w["text"] for w in words),
                    "words": words, "start_ms": a, "duration_ms": b - a, "style": style})
    hook = v["hook"]
    # U3c: kotak kaca (efek 17 glass type) = kotak putih tipis + blur di belakang teks, sama dengan ops.py.
    gaya_hook = {"x": 0.5, "y": 0.2, "size": HOOK_SIZE, "width": 0.84, "color": "#ffffff", "bg": "#ffffff",
                 "bg_opacity": 0.16, "bg_blur": 12, "bold": True, "outline": True, "align": "center", "font": "brand"}
    ops.append({"op": "add_clip", "track_kind": "text", "text": hook["teks"].upper(), "start_ms": ms(hook["dari"]),
                "duration_ms": ms(hook["sampai"] - hook["dari"]), "style": gaya_hook})
    total_ms = ms(v["durasi"])
    cta_mulai = max(ms(hook["sampai"]), total_ms - CTA_MS)
    ops.append({"op": "add_clip", "track_kind": "text", "text": v["cta"], "start_ms": cta_mulai,
                "duration_ms": total_ms - cta_mulai,
                "style": {"x": 0.5, "y": 0.45, "size": 6.0, "width": 0.84, "color": "#ffffff",
                          "bg": warna["latar_gelap"].lower(), "bg_opacity": 0.75, "bold": True, "outline": False,
                          "align": "center", "font": "brand"}})
    return ops, menunggu


def qc(v: dict, ops: list[dict], target, media: dict, terlarang: list[str], durasi_sumber: dict) -> dict:
    hasil = []

    def cek(nama, lulus, ket=""):
        hasil.append({"cek": nama, "lulus": bool(lulus), "ket": ket})

    if target:
        cek("durasi", target[0] <= v["durasi"] <= target[1], f"{v['durasi']:.1f} dtk, batas {target[0]:.0f}-{target[1]:.0f}")
    else:
        cek("durasi", True, f"{v['durasi']:.1f} dtk, tanpa batas (diputuskan tim)")
    cek("hook_3_detik", v["hook"]["dari"] == 0 and v["hook"]["sampai"] <= 3.0, v["hook"]["teks"])
    teks_layar = " ".join(o.get("text", "") for o in ops).lower()
    kena = [t for t in terlarang if t and t.lower() in teks_layar]
    cek("kata_terlarang", not kena, ", ".join(kena))
    cek("jumlah_ops", len(ops) <= MAKS_OPS, str(len(ops)))
    pendek = [f"{o['track_kind']}@{o['start_ms']}" for o in ops if o["op"] == "add_clip" and o["duration_ms"] < MIN_CLIP_MS]
    # (dicek semua track: video, audio/VO, subtitle, text)
    cek("klip_min_100ms", not pendek, ", ".join(pendek))
    per_track = {}
    for o in ops:
        if o["op"] == "add_clip":
            per_track.setdefault(o["track_kind"], []).append((o["start_ms"], o["start_ms"] + o["duration_ms"]))
    tumpang = [k for k, xs in per_track.items() if any(a2 < b1 for (_, b1), (a2, _) in zip(sorted(xs), sorted(xs)[1:]))]
    cek("track_tidak_tumpang_tindih", not tumpang, ", ".join(tumpang))
    vid = sorted(per_track.get("video", []))
    celah = [round(a2 - b1) for (_, b1), (a2, _) in zip(vid, vid[1:]) if a2 - b1 > 40]
    cek("video_tanpa_celah", not celah and vid and vid[0][0] == 0, f"celah ms: {celah}" if celah else "")
    lewat = [f"{o['media']}@{o['in_ms']}" for o in ops if o.get("track_kind") in ("video", "audio")
             and o.get("media", "").partition(":")[2] in durasi_sumber
             and o["in_ms"] + o["duration_ms"] > durasi_sumber[o["media"].partition(":")[2]] * 1000]
    cek("klip_dalam_sumber", not lewat, ", ".join(lewat))
    ph = {o["media"] for o in ops if "media" in o}
    cek("placeholder_dikenal", ph <= set(media), ", ".join(sorted(ph - set(media))))
    return {"schema": "engine-qc-rencana/1", "lulus": all(h["lulus"] for h in hasil), "cek": hasil}


ROOT = PIPELINE.parent.resolve()
EKSTENSI_MEDIA = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus",
                  ".flac", ".png", ".jpg", ".webp"}


def path_media(path: str) -> str:
    """Aturan runner (kontrak §8): path absolut (realpath) di DALAM root repo, ekstensi media saja."""
    real = Path(path)
    real = (real if real.is_absolute() else ROOT / real).resolve()
    if not real.is_relative_to(ROOT):
        raise ValueError(f"media di luar root mesin: {real}")
    if real.suffix.lower() not in EKSTENSI_MEDIA:
        raise ValueError(f"ekstensi bukan media: {real}")
    if not real.is_file():
        raise ValueError(f"media tidak ada: {real}")
    return str(real).replace("\\", "/")


def jaccard(a: set, b: set) -> float:
    return len(a & b) / max(1, len(a | b))


def jalankan(job_dir: Path) -> int:
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    if job.get("mode") != "batch":
        raise SystemExit("job.json bukan mode batch")
    batch = job["batch"]
    batch_dir = KONTEN / "2-dipisah" / batch
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    tujuan = job.get("tujuan", "konversi")
    target = tuple(job["batas_durasi"]) if job.get("batas_durasi") else None
    saran_durasi = SARAN_DURASI.get(tujuan, (20.0, 30.0))
    buang_otomatis = set(job.get("buang_otomatis", []))
    brief = job.get("brief", {})
    placement = brief.get("placement", "tiktok")
    rng = random.Random(job.get("seed", 1))
    izin_tanpa = bool(job.get("izinkan_musik_tanpa_lisensi", False))
    hak_jelas = bool(job.get("hak_pakai_jelas", False))
    mode_ops = job.get("mode_ops", "kompat")

    progres("cek_input", 2, batch)
    bk_path = job_dir / job.get("brand_kit", "brand_kit.json")
    if not bk_path.exists():
        bk_path = PIPELINE.parent / "brandkit" / "aysilla.json"  # masa peralihan (format lama)
    brand = muat_brand_kit(bk_path)
    brand_raw = json.loads(bk_path.read_text(encoding="utf-8"))
    terlarang = list(dict.fromkeys(brand.get("superlatif_dilarang", [])))
    if not (batch_dir / "video-bisu").is_dir():
        raise SystemExit(f"Batch belum dipisah: jalankan pipeline/pisah.py {batch}")

    lib_path = batch_dir / "shots.json"
    if not lib_path.exists():
        progres("shot_library", 5, "membuat Shot Library (sekali per batch)")
        cmd = [str(BATCH_PY), str(PIPELINE / "batch" / "shotlib.py"), batch] + (["--tiktok"] if job.get("shot_tiktok") else [])
        subprocess.run(cmd, check=True, stdout=sys.stderr)
    lib = json.loads(lib_path.read_text(encoding="utf-8"))

    progres("rencana", 20, "memilih voice over")
    produk = brief.get("produk", "")
    produk_kata = [x for x in re.split(r"\s+", produk.lower()) if x] + ["celana"] if produk else []
    vos, vo_tolak = vo_mod.kandidat(batch_dir, lib, brand, produk_kata)
    tolak_ids = {t["id"] for t in vo_tolak}
    # Footage boleh jadi broll: semua, kecuali yang ucapannya tentang produk lain.
    produk_lain = {t["id"] for t in vo_tolak if t["alasan"].startswith("tidak menyebut produk")}
    footage_boleh = set(lib["footage"]) - produk_lain
    # Hak pakai: kalau job menyebut akun sendiri, footage ber-watermark akun lain tidak dipakai sama sekali.
    akun_sendiri = {a.lower().lstrip("@") for a in job.get("akun_sendiri", [])}
    akun_footage = {f: m["watermark"].get("akun", []) for f, m in lib["footage"].items()}
    milik_lain = set()
    if akun_sendiri:
        milik_lain = {f for f, ak in akun_footage.items() if ak and not ({a.lower().lstrip("@") for a in ak} & akun_sendiri)}
        footage_boleh -= milik_lain
        vos = [v for v in vos if v["id"] not in milik_lain]
        vo_tolak += [{"id": f, "alasan": "watermark akun lain: " + ", ".join(akun_footage[f])} for f in sorted(milik_lain)]

    progres("rencana", 30, "menganalisis musik")
    mlib = musik_mod.library(brand_raw, batch_dir, izin_tanpa, tolak_ids)

    n = int(job.get("jumlah", 10))
    varian, alasan_kurang = [], ""
    g_pakai, m_pakai, vo_pakai = Counter(), Counter(), Counter()
    percobaan = 0
    while len(varian) < n and vos and percobaan < n * 15:
        percobaan += 1
        vo_c = min(vos, key=lambda x: (vo_pakai[x["id"]], -x["skor"], rng.random()))
        rv = vo_mod.susun(vo_c, rng, (target[0] - TAHAN, target[1] - TAHAN) if target else None, buang_otomatis)
        total_vo = rv["durasi_ucapan"] + TAHAN
        if target and (total_vo < target[0] or total_vo > target[1] + 0.5):
            vos.remove(vo_c)
            vo_tolak.append({"id": vo_c["id"], "alasan": f"durasi jadi {total_vo:.1f} dtk di luar target "
                             f"{target[0]:.0f}-{target[1]:.0f} (kalimat terlalu panjang/pendek)"})
            continue
        m = musik_mod.pilih(mlib, tujuan, rv["durasi_ucapan"] + TAHAN, rng, m_pakai)
        sus = matcher.susun_shot(rv, lib, footage_boleh, rng, m["ketukan"] if m else None, Counter(g_pakai))
        # Shot tidak boleh melewati ujung file sumber.
        for p in sus["potongan"]:
            dmax = lib["footage"][p["footage"]]["durasi"]
            if p["in"] + p["dur"] > dmax:
                p["in"] = round(max(0.0, dmax - p["dur"] - 0.05), 3)
                p["blur"] = matcher._blur_watermark(lib["footage"][p["footage"]], p["in"], p["in"] + p["dur"])
        shots = {p["shot"] for p in sus["potongan"] if p["jenis"] == "broll"}
        mirip = [x for x in varian if x["vo"] == rv["vo"] and jaccard(shots, x["_shots"]) > MAKS_MIRIP]
        if mirip:
            m_pakai[m["kunci"]] -= 1 if m else 0
            if percobaan % 5 == 0:
                vo_pakai[vo_c["id"]] += 1  # VO ini sudah jenuh, beri kesempatan VO lain
            continue
        for p in sus["potongan"]:
            if p["jenis"] == "broll":
                g_pakai[p["shot"]] += 1
        vo_pakai[vo_c["id"]] += 1
        k0 = rv["kalimat"][0]
        hook_sampai = min(3.0, k0["sampai"] - k0["dari"] + 0.1)
        cta = rv["cta_terucap"]
        cta_teks = brand.get("cta", {}).get(placement) or ""
        if cta and not (placement != "tiktok" and "keranjang" in cta.lower()) and len(cta.split()) <= 7:
            cta_teks = cta.rstrip(".!")
        idx = len(varian) + 1
        v = {"id": f"varian-{idx:03d}", "vo": rv["vo"], "rv": rv, "susunan": sus, "musik": m,
             "durasi": sus["durasi"], "hook": {"teks": rv["judul"], "dari": 0.0, "sampai": round(hook_sampai, 2)},
             "cta": cta_teks, "_shots": shots}
        v["caption"] = frasa_caption(rv["kalimat"], sus["vo_klip"])
        varian.append(v)
        progres("rencana", 30 + int(60 * len(varian) / n), f"{v['id']}: VO {v['vo']}, {len(sus['potongan'])} shot")
    if len(varian) < n:
        alasan_kurang = (f"hanya {len(varian)} varian unik dari {len(vos)} VO layak; tambah footage/VO baru "
                         "untuk jumlah lebih banyak tanpa risiko konten duplikat")

    media = {}
    tabel = []
    for v in varian:
        rv, sus, m = v["rv"], v["susunan"], v["musik"]
        bukan_iklan = bool(m and not m["lisensi_iklan"])
        ops, menunggu = buat_ops(v, brand, mode_ops, hak_jelas)
        aset_lokal = {o["media"] for o in ops if o.get("media") and not o["media"].startswith("$sumber")
                      and not (m and o["media"] == m["kunci"] and m["sumber"] == "brand_kit")}
        for o in ops:
            ph = o.get("media")
            if not ph:
                continue
            kind, _, fid = ph.partition(":")
            if kind == "$sumber":
                media[ph] = path_media(lib["footage"][fid]["video"])
            elif kind == "$vokal":
                media[ph] = path_media(lib["footage"][fid]["vokal"])
            elif kind == "$musik" and m and ph == m["kunci"] and m["sumber"] != "brand_kit":
                # Musik dari Brand Kit sudah dikenal runner lewat asetnya; hanya musik milik mesin yang ditulis.
                media[ph] = path_media(m["path"])
        peringatan = []
        ada_wm = any(p["blur"] for p in sus["potongan"])
        if ada_wm and not hak_jelas:
            peringatan.append({"level": "warn", "jenis": "watermark", "teks":
                               "watermark/footer sumber belum ditutup: " + ("hak pakai footage belum jelas"
                                                                           if not hak_jelas else "Clip.blur menunggu U3")})
        teks_sinkron = [p for p in sus["potongan"] if p["jenis"] == "sinkron" and p["shot"]
                        and next(s for s in lib["shots"] if s["id"] == p["shot"])["teks_bawaan"]]
        for p in ([] if hak_jelas else teks_sinkron):  # kalau hak pakai jelas, teks bawaan sudah ikut di-blur
            peringatan.append({"level": "warn", "jenis": "teks_bawaan", "detik": p["start"],
                               "teks": f"shot sinkron {p['shot']} berisi teks bawaan"})
        akun_dipakai = sorted({a for p in sus["potongan"] for a in akun_footage.get(p["footage"], [])})
        if not hak_jelas and (len(akun_dipakai) > 1 or (akun_dipakai and not akun_sendiri)):
            peringatan.append({"level": "warn", "jenis": "hak_pakai",
                               "teks": "footage dari akun: " + ", ".join(akun_dipakai) + " (pastikan semua milik brand)"})
        # Kalimat yang kena aturan tapi TIDAK dibuang (default): dilaporkan supaya tim yang memutuskan.
        mulai_kalimat = {k["id"]: vk["start"] - k["dari"] for k, vk in zip(rv["kalimat"], sus["vo_klip"])}
        id_dari = {k["dari"]: k["id"] for k in rv["kalimat"]}
        for sb in rv["saran_buang"]:
            geser = mulai_kalimat.get(id_dari.get(sb["dari"]), 0)
            peringatan.append({"level": "block" if sb["jenis"].startswith("kata terlarang") else "warn",
                               "jenis": "saran_buang", "detik": round(sb["dari"] + geser, 2),
                               "teks": sb["teks"], "alasan": sb["jenis"]})
        if bukan_iklan:
            peringatan.append({"level": "block", "jenis": "musik_tanpa_lisensi",
                               "teks": "musik dari stem video lain (uji saja), bukan untuk iklan"})
        if not m:
            alasan_m = "tidak ada musik berlisensi di Brand Kit / public/musik"
        else:
            alasan_m = None
        ragu = [{"detik": 0, "teks": v["hook"]["teks"], "alasan": "judul dipotong di kata ke-6"}] if rv["judul_dipotong"] else []
        for k, vk in zip(rv["kalimat"], sus["vo_klip"]):
            for w in k["kata"]:
                if w.get("prob", 1) < 0.4:
                    ragu.append({"detik": round(vk["start"] + w["startMs"] / 1000 - k["dari"], 2), "teks": w["text"],
                                 "alasan": f"Whisper kurang yakin ({w['prob']:.2f})"})
        kk = [{"teks": " ".join(c_hl), "detik": round(c["dari"], 2)} for c in v["caption"]
              if (c_hl := sorot(c["teks"], brand.get("kata_kunci", [])))]
        rencana = {
            "schema": "engine-rencana/1",
            "status": "siap" if not target or v["durasi"] <= target[1] + 0.5 else "perlu_keputusan",
            "durasi": {"mentah": rv["durasi_mentah"], "akhir": v["durasi"], "target": list(target) if target else None,
                       "saran": list(saran_durasi)},
            "dibuang": rv["dibuang"],
            "hook": {**v["hook"], "sumber": "aturan"},
            "kata_kunci": kk,
            "efek": [],
            "audio": {"sfx": 0, "musik": m["kunci"] if m else None, "alasan_tanpa_musik": alasan_m,
                      "musik_bpm": m["bpm"] if m else None, "musik_volume": m["volume"] if m else None,
                      "musik_path": m["path"] if m else None},
            "cta": v["cta"],
            "peringatan": peringatan,
            "ragu": ragu,
            "menunggu_u3": menunggu,
            "batch": {
                "vo": v["vo"],
                "shot": [{k2: p[k2] for k2 in ("start", "dur", "jenis", "footage", "shot", "in", "alasan")} for p in sus["potongan"]],
                "rasio_sinkron": sus["rasio_sinkron"],
                "blur_usulan": [{"start": p["start"], "footage": p["footage"], "blur": p["blur"]} for p in sus["potongan"] if p["blur"]],
                "bukan_iklan": bukan_iklan,
            },
        }
        vdir = out_dir / v["id"]
        vdir.mkdir(exist_ok=True)
        (vdir / "rencana.json").write_text(json.dumps(rencana, ensure_ascii=False, indent=1), encoding="utf-8")
        ops_doc = {"schema": "ms-ops/1", "mode": mode_ops,
                   # v0.3.1 §8: aset milik mesin (stem vokal, musik) diimpor runner seperti placeholder lain.
                   "aset_lokal": [{"kunci": k, "path": media[k]} for k in sorted(aset_lokal)], "ops": ops}
        (vdir / "ops.json").write_text(json.dumps(ops_doc, ensure_ascii=False, indent=1), encoding="utf-8")
        q = qc(v, ops, target, {**media, **{a["kunci"]: "" for a in brand_raw.get("aset", [])}}, terlarang, {f: m["durasi"] for f, m in lib["footage"].items()})
        (vdir / "qc_rencana.json").write_text(json.dumps(q, ensure_ascii=False, indent=1), encoding="utf-8")
        tabel.append({
            "id": v["id"], "vo": v["vo"], "hook": v["hook"]["teks"],
            "shot": [p["shot"] or f"{p['footage']}@{p['in']:.1f}" for p in sus["potongan"]],
            "footage": sorted({p["footage"] for p in sus["potongan"]}),
            "musik": m["kunci"] if m else None, "durasi": v["durasi"], "cta": v["cta"],
            "status": "usul", "bukan_iklan": bukan_iklan, "qc_lulus": q["lulus"],
            "folder": f"out/{v['id']}",
        })
    batch_json = {
        "schema": "batch-remix/1", "job_id": job.get("job_id"), "batch": batch, "tujuan": tujuan,
        "jumlah_diminta": n, "jumlah_jadi": len(tabel), "alasan_kurang": alasan_kurang or None,
        "vo_ditolak": vo_tolak, "musik_tersedia": len(mlib), "media": media,
        "akun_watermark": akun_footage, "footage_milik_lain": sorted(milik_lain), "varian": tabel,
    }
    (out_dir / "batch.json").write_text(json.dumps(batch_json, ensure_ascii=False, indent=1), encoding="utf-8")
    progres("selesai", 100, f"{len(tabel)} varian" + (f" ({alasan_kurang})" if alasan_kurang else ""))
    return 0 if tabel else 2


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    try:
        sys.exit(jalankan(Path(sys.argv[1])))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
