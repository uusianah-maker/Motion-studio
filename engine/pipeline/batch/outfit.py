"""Beat Spot tahap 2 "Ganti Outfit" (KONTRAK-ENGINE §29; owner 24-25 Nov 2026).

Tim mengunggah 1-5 footage model sendiri + sound template. Untuk setiap footage: video jalan 3-4 ketukan,
lalu terpotong TEPAT di ketukan ke gambar diam AI. Di gambar itu orang yang sama memakai 1 look katalog
(1 atasan + 1 bawahan 1 warna). Ditutup end card berisi foto katalog ASLI semua look.

Dua tahap, masing-masing satu job mesin. Gambar AI dibuat oleh APP di antara kedua tahap, karena API key
tidak pernah sampai ke mesin:
  siapkan  -> deteksi orang (MediaPipe, visual-venv), pilih segmen jalan + crop 9:16 yang mengikuti orang,
              render klip jalan 1080x1920, frame diam = frame TERAKHIR klip itu, usulan look otomatis,
              prompt + gambar acuan untuk API. Hasil: out/outfit.json (status "menunggu_gambar").
  rakit    -> baca hasil gambar dari folder job siapkan, QC tiap gambar, end card, ops ms-ops/1 tepat di
              ketukan. Hasil: out/ops.json + out/outfit.json (status "siap") + qc_rencana.json.
Mesin TIDAK merender video akhir. Klip jalan, gambar, dan end card dikirim sebagai aset_lokal ($outfit:*)
di folder out/outfit/ job ini.

Pakai: engine outfit <job_dir>   (jalan di Python Batch, punya OpenCV + Pillow)

job.json (mode "outfit"):
  sumber: [{kunci: "$sumber:<id>", path}]   1-5 footage + 1 sound template
  katalog: "katalog.json"   {schema: "katalog-produk/1", produk: [{id, nama, jenis: atasan|bawahan, deskripsi,
                             warna: [{id, nama, path}]}]}
  outfit: {
    tahap: "siapkan" | "rakit",
    sound: "$sumber:<id>",            sound template (ketukan dibaca dari sini)
    model_sendiri: true,              wajib: AI ganti pakaian hanya untuk model/kreator sendiri (§16, K6)
    teks_atas: str | null,            teks tetap di atas sampai end card
    judul_akhir: str | null, sub_akhir: str | null   teks end card
    look: {"<id footage>": {atasan: "<produk>/<warna>" | null, bawahan: "<produk>/<warna>" | null}}   pilihan tim
    target: {"<id footage>": "utama" | "semua"}      siapa yang diganti bajunya (bawaan: otomatis)
    seed: int,
    siapkan: "<path folder job siapkan>"              hanya tahap rakit
  }
Kode keluar: 0 siap · 2 ditolak (alasan di out/rencana.json) · 1 gagal teknis. Progres JSON-lines di stdout.
"""

from __future__ import annotations

import colorsys
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jalur import DATA, TOOLS, venv_py  # noqa: E402
import musik as musik_mod  # noqa: E402

SCHEMA = "beatspot-outfit/1"
EXT_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
FPS = 30
W, H = 1080, 1920
MAKS_FOOTAGE = 5
POLA = {"jalan": (4, 3), "diam": 4, "end": 4}  # ketukan: jalan 4 (atau 3 kalau footage pendek), diam 4, end card 4
API_W, API_H = 1024, 1536  # ukuran edit gambar API (2:3); frame 9:16 diberi bingkai kiri-kanan
PAD_W = int(round(H * API_W / API_H))  # 1280: lebar frame + bingkai pada tinggi 1920
DETEKSI_HZ = 6.0
FONT = next((p for p in ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") if Path(p).exists()), None)
FONT_B = next((p for p in ("C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf") if Path(p).exists()), None)
VISUAL_PY = Path(os.environ.get("MOTION_VISUAL_PY") or venv_py(TOOLS / "visual-venv"))


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


def tolak(out_dir: Path, alasan: str) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rencana.json").write_text(json.dumps({"schema": "engine-rencana/1", "status": "ditolak", "alasan": alasan},
                                                     ensure_ascii=False, indent=1), encoding="utf-8")
    progres("ditolak", 100, alasan)
    return 2


def tulis_json(p: Path, d) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def ffmpeg(args: list[str]) -> None:
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg gagal: {r.stderr.strip()[-400:]}")


def probe(p: Path) -> dict:
    """Ukuran tampil (sudah diputar sesuai metadata rotasi), fps, durasi."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,duration:stream_side_data=rotation:format=duration",
                        "-of", "json", str(p)], capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise Ditolak(f"{p.name}: bukan video yang bisa dibaca")
    d = json.loads(r.stdout or "{}")
    st = (d.get("streams") or [{}])[0]
    if not st.get("width"):
        raise Ditolak(f"{p.name}: tidak ada gambar video")
    w, h = int(st["width"]), int(st["height"])
    rot = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, _, den = (st.get("r_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    dur = float(st.get("duration") or d.get("format", {}).get("duration") or 0)
    return {"lebar": w, "tinggi": h, "fps": fps, "durasi": dur}


# ------------------------------------------------------------------ katalog & look

def muat_katalog(job_dir: Path, job: dict) -> dict:
    p = job_dir / (job.get("katalog") or "katalog.json")
    if not p.exists():
        raise Ditolak("katalog produk belum ada (isi Katalog Produk di Motion Studio)")
    k = json.loads(p.read_text(encoding="utf-8"))
    if k.get("schema") != "katalog-produk/1":
        raise Ditolak("katalog.json harus schema katalog-produk/1")
    item = {}
    for pr in k.get("produk") or []:
        if pr.get("jenis") not in ("atasan", "bawahan"):
            continue
        for w in pr.get("warna") or []:
            if not w.get("path") or not Path(w["path"]).exists():
                continue
            kid = f"{pr['id']}/{w['id']}"
            item[kid] = {"id": kid, "produk": pr["id"], "nama_produk": pr.get("nama") or pr["id"], "jenis": pr["jenis"],
                         "deskripsi": (pr.get("deskripsi") or "").strip(), "warna": w.get("nama") or w["id"], "path": w["path"]}
    if not item:
        raise Ditolak("katalog kosong: tambahkan produk atasan/bawahan dengan foto per warna")
    return item


def warna_rata(path: str) -> tuple[float, float, float]:
    """Warna rata-rata produk (Lab, latar terang/transparan dibuang): dasar usulan pasangan."""
    import numpy as np
    from PIL import Image
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = np.asarray(im.convert("RGBA").resize((160, 160)))
        a = rgba[..., :3].reshape(-1, 3)[rgba[..., 3].reshape(-1) > 128]
    else:
        a = np.asarray(im.convert("RGB").resize((160, 160))).reshape(-1, 3)
    a = a.astype(float)
    if len(a) == 0:
        return (50.0, 0.0, 0.0)
    lat = a[0] if len(a) else a.mean(0)
    keep = (np.abs(a - lat).sum(1) > 40) & ~((a.min(1) > 235))
    if keep.sum() > 50:
        a = a[keep]
    r, g, b = (a.mean(0) / 255.0)
    return rgb_ke_lab(r, g, b)


def rgb_ke_lab(r: float, g: float, b: float) -> tuple[float, float, float]:
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = lin(r), lin(g), lin(b)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def skor_pasangan(lab_a, lab_b) -> float:
    """Serasi = beda terang-gelap cukup jelas, bawahan cenderung netral, hindari dua warna kuat yang mirip."""
    dl = abs(lab_a[0] - lab_b[0])
    chroma_b = math.hypot(lab_b[1], lab_b[2])
    chroma_a = math.hypot(lab_a[1], lab_a[2])
    s = min(dl, 55) / 55  # kontras terang
    s += 0.35 * max(0.0, 1 - chroma_b / 40)  # bawahan netral
    if chroma_a > 18 and chroma_b > 18:
        ha, hb = math.atan2(lab_a[2], lab_a[1]), math.atan2(lab_b[2], lab_b[1])
        beda = abs((ha - hb + math.pi) % (2 * math.pi) - math.pi)
        if beda < 0.5 and dl < 15:
            s -= 0.6  # warna kuat yang hampir sama: tampak satu warna
    return s


def usul_look(fids: list[str], katalog: dict, pilihan: dict, rng: random.Random) -> dict:
    """Satu look per footage: atasan berbeda tiap footage selama stok ada, warna bawahan tidak berulang."""
    atas = [k for k in katalog.values() if k["jenis"] == "atasan"]
    bawah = [k for k in katalog.values() if k["jenis"] == "bawahan"]
    lab = {k["id"]: warna_rata(k["path"]) for k in katalog.values()}
    # Atasan: bergiliran antar produk lalu antar warna (urutan acak ber-seed) -> variasi maksimal.
    per_produk: dict[str, list] = {}
    for k in atas:
        per_produk.setdefault(k["produk"], []).append(k)
    for v in per_produk.values():
        rng.shuffle(v)
    giliran, keys = [], list(per_produk)
    rng.shuffle(keys)
    while any(per_produk.values()):
        for p in keys:
            if per_produk[p]:
                giliran.append(per_produk[p].pop())
    hasil, dipakai_atas, dipakai_bawah, dipakai_produk_bawah = {}, set(), set(), {}
    for i, fid in enumerate(fids):
        mau = pilihan.get(fid) or {}
        a = katalog.get(mau.get("atasan")) if mau.get("atasan") else None
        if a is None and "atasan" not in mau and giliran:
            sisa = [k for k in giliran if k["id"] not in dipakai_atas] or giliran
            a = sisa[0]
        b = katalog.get(mau.get("bawahan")) if mau.get("bawahan") else None
        if b is None and "bawahan" not in mau and bawah:
            calon = [k for k in bawah if k["warna"].lower() not in dipakai_bawah] or bawah
            def nilai(k):
                s = skor_pasangan(lab[a["id"]], lab[k["id"]]) if a else 0.0
                s -= 0.15 * dipakai_produk_bawah.get(k["produk"], 0)  # sebar antar produk bawahan
                return s + 0.08 * rng.random()
            b = max(calon, key=nilai)
        if a is None and b is None:
            raise Ditolak(f"footage {fid}: look kosong (pilih atasan atau bawahan)")
        if a:
            dipakai_atas.add(a["id"])
        if b:
            dipakai_bawah.add(b["warna"].lower())
            dipakai_produk_bawah[b["produk"]] = dipakai_produk_bawah.get(b["produk"], 0) + 1
        hasil[fid] = {"atasan": a, "bawahan": b, "dipilih": "tim" if mau else "otomatis"}
    return hasil


# ------------------------------------------------------------------ deteksi orang

def deteksi_orang(video: Path, tmp: Path) -> list[dict]:
    """Jalur orang (jalur-posisi/1, MediaPipe di visual-venv). Gagal / tidak terpasang -> [] (crop tengah)."""
    keluar = tmp / f"{video.stem}.deteksi.json"
    if not VISUAL_PY.exists():
        return []
    r = subprocess.run([str(VISUAL_PY), str(Path(__file__).resolve().parents[1] / "visual" / "deteksi.py"), str(video), str(keluar),
                        "--jenis", "objek", "--label", "person", "--hz", str(DETEKSI_HZ)],
                       cwd=DATA, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
    if r.returncode != 0 or not keluar.exists():
        print(f"[outfit] deteksi {video.name} gagal: {r.stderr.strip()[-300:]}", file=sys.stderr)
        return []
    d = json.loads(keluar.read_text(encoding="utf-8"))
    return [j for j in d.get("jalur") or [] if j.get("label") == "person" and j.get("titik")]


def kotak_di(jalur: dict, t: float, toleransi: float = 0.35) -> dict | None:
    """Kotak jalur pada waktu t (interpolasi linear antar sampel); None kalau jauh dari sampel."""
    ts = jalur["titik"]
    if t < ts[0]["t"] - toleransi or t > ts[-1]["t"] + toleransi:
        return None
    if t <= ts[0]["t"]:
        return ts[0]
    for a, b in zip(ts, ts[1:]):
        if a["t"] <= t <= b["t"]:
            if b["t"] - a["t"] > 2 * toleransi:
                return None
            u = (t - a["t"]) / max(b["t"] - a["t"], 1e-6)
            return {k: a[k] + (b[k] - a[k]) * u for k in ("x", "y", "w", "h", "skor")} | {"t": t}
    return ts[-1]


def skor_jalur(j: dict, durasi: float) -> float:
    """Subjek utama: lama terlihat, cukup besar, utuh (tidak terpotong tepi), bukan kepala besar di depan kamera."""
    ts = j["titik"]
    lama = min(1.0, (ts[-1]["t"] - ts[0]["t"] + 1 / DETEKSI_HZ) / max(durasi, 0.5))
    h = sum(k["h"] for k in ts) / len(ts)
    sk = sum(k["skor"] for k in ts) / len(ts)
    tepi = sum(1 for k in ts if k["x"] < 0.01 or k["x"] + k["w"] > 0.99) / len(ts)
    besar = min(h, 0.6) - 2.0 * max(0.0, h - 0.62)  # setinggi > 62 % frame = orang terlalu dekat / terpotong
    return lama * besar * sk * (1 - 0.8 * tepi)


def pilih_subjek(jalur: list[dict], durasi: float, target: str | None) -> tuple[dict | None, list[dict]]:
    if not jalur:
        return None, []
    urut = sorted(jalur, key=lambda j: -skor_jalur(j, durasi))
    utama = urut[0]
    if skor_jalur(utama, durasi) <= 0:
        return None, []
    teman = []
    if target != "utama":
        hu = sum(k["h"] for k in utama["titik"]) / len(utama["titik"])
        for j in urut[1:]:
            bareng = [(a, kotak_di(j, a["t"], 0.2)) for a in utama["titik"]]
            bareng = [(a, b) for a, b in bareng if b]
            if len(bareng) < 0.5 * len(utama["titik"]):
                continue
            ok = 0
            for a, b in bareng:
                sejajar = abs((a["y"] + a["h"]) - (b["y"] + b["h"])) < 0.08  # kaki di garis yang sama
                mirip = 0.7 <= b["h"] / max(a["h"], 1e-6) <= 1.4
                dekat = abs((a["x"] + a["w"] / 2) - (b["x"] + b["w"] / 2)) < 2.2 * max(a["w"], b["w"])
                ok += sejajar and mirip and dekat
            if ok >= 0.6 * len(bareng) and sum(k["h"] for k in j["titik"]) / len(j["titik"]) > 0.6 * hu:
                teman.append(j)
    return utama, teman


def kotak_grup(grup: list[dict], t: float) -> dict | None:
    ks = [k for k in (kotak_di(j, t) for j in grup) if k]
    if not ks or grup and kotak_di(grup[0], t) is None:
        return None
    x0 = min(k["x"] for k in ks)
    y0 = min(k["y"] for k in ks)
    x1 = max(k["x"] + k["w"] for k in ks)
    y1 = max(k["y"] + k["h"] for k in ks)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "skor": min(k["skor"] for k in ks), "n": len(ks)}


def tajam(video: Path, t: float) -> float:
    """Ketajaman frame (variansi Laplacian, frame kecil): frame diam harus tidak buram."""
    import cv2
    import numpy as np
    with tempfile.TemporaryDirectory(prefix="outfit-tajam-") as d:
        p = Path(d) / "f.png"
        try:
            ffmpeg(["-ss", f"{max(t, 0):.3f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=360:-2", str(p)])
        except RuntimeError:
            return 0.0
        g = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        return float(cv2.Laplacian(g, cv2.CV_64F).var()) if g is not None else 0.0


def rencana_jalan(video: Path, info: dict, jalur: list[dict], spb: float, target: str | None) -> dict:
    """Pilih segmen jalan (4 atau 3 ketukan) + crop 9:16 yang mengikuti orang; frame diam = akhir segmen."""
    dur = info["durasi"] - 1.0 / max(info["fps"], 1)  # frame terakhir yang aman
    ketukan = next((k for k in POLA["jalan"] if k * spb <= dur - 0.05), None)
    if ketukan is None:
        raise Ditolak(f"{video.name}: footage terlalu pendek ({info['durasi']:.1f} dtk); minimal {min(POLA['jalan']) * spb + 0.1:.1f} dtk")
    L = ketukan * spb
    utama, teman = pilih_subjek(jalur, info["durasi"], target)
    grup = [utama] + teman if utama else []
    sw, sh = info["lebar"], info["tinggi"]
    # Kandidat akhir segmen tiap 1/15 dtk: subjek terlihat, utuh, besar, skor tinggi; frame tajam di akhir.
    calon = []
    t = L
    ujung = dur - 1.0 / FPS  # sisakan 1 frame cadangan sesudah frame diam
    while t <= ujung + 1e-6:
        kg = kotak_grup(grup, t) if grup else None
        if kg:
            # Utuh = tidak menyentuh tepi frame sumber (margin 3 %); orang yang keluar frame tidak boleh jadi frame diam.
            jarak_tepi = min(kg["x"], 1 - (kg["x"] + kg["w"]), 1 - (kg["y"] + kg["h"]))
            utuh = 1.0 if jarak_tepi >= 0.06 else 0.05 if jarak_tepi < 0.005 else 0.35
            # Kotak deteksi sering lebih sempit dari badan asli: utamakan saat grup dekat tengah frame.
            tengah = max(0.3, 1 - 1.4 * abs(kg["x"] + kg["w"] / 2 - 0.5))
            hadir = sum(1 for u in [t - L + L * i / 6 for i in range(7)] if kotak_grup(grup, u)) / 7
            calon.append((kg["h"] * kg["skor"] * utuh * tengah * (0.5 + 0.5 * hadir) + 0.02 * t / dur, t))
        t += 1 / 15
    if calon:
        calon.sort(reverse=True)
        terbaik = calon[:4]
        nilai = [(s * (0.7 + 0.3 * min(1.0, tajam(video, tt) / 120)), tt) for s, tt in terbaik]
        akhir = max(nilai)[1]
    else:
        akhir = ujung
    mulai = max(0.0, akhir - L)
    # Crop: tinggi supaya grup ±45 % tinggi frame (maks 2x zoom), lebar 9:16; geser linear kalau perlu.
    sampel = [mulai + L * i / 12 for i in range(13)]
    kot = [kotak_grup(grup, u) for u in sampel] if grup else []
    kot = [(u, k) for u, k in zip(sampel, kot) if k]
    if kot:
        hmax = max(k["h"] for _, k in kot) * sh
        wmax = max(k["w"] for _, k in kot) * sw
        ch = min(sh, max(hmax / 0.45, wmax * 1.35 * 16 / 9, H / 2))
    else:
        ch = sh
    cw = ch * 9 / 16
    if cw > sw:
        cw, ch = sw, sw * 16 / 9
    cw, ch = int(cw) // 2 * 2, int(ch) // 2 * 2
    if kot:
        cx = [(k["x"] + k["w"] / 2) * sw for _, k in kot]
        kiri = min(k["x"] for _, k in kot) * sw
        kanan = max(k["x"] + k["w"] for _, k in kot) * sw
        atas = min(k["y"] for _, k in kot) * sh
        bawah = max(k["y"] + k["h"] for _, k in kot) * sh
        y0 = min(max(0.0, (atas + bawah) / 2 - 0.55 * ch), sh - ch)
        y0 = min(y0, max(0.0, atas - 0.10 * ch))  # kepala tidak terpotong
        y0 = max(y0, min(bawah + 0.04 * ch - ch, sh - ch))  # kaki masuk
        if kanan - kiri <= 0.92 * cw:  # muat diam: crop tetap (tanpa gerak kamera palsu)
            # Geser dalam rentang yang masih memuat grup, menjauhi orang lain yang besar (kepala di depan kamera).
            lain = [j for j in jalur if j not in grup]
            lo_x, hi_x = max(0.0, kanan + 0.04 * cw - cw), min(sw - cw, kiri - 0.04 * cw)
            tengah = (kiri + kanan) / 2 - cw / 2
            if lain and hi_x > lo_x:
                def tabrak(x0):
                    s = 0.0
                    for u, _ in kot:
                        for j in lain:
                            k = kotak_di(j, u, 0.2)
                            if not k or k["h"] < 0.25:
                                continue
                            a0, a1 = max(x0, k["x"] * sw), min(x0 + cw, (k["x"] + k["w"]) * sw)
                            if a1 > a0:
                                s += (a1 - a0) * k["h"]
                    return s
                xs = [lo_x + (hi_x - lo_x) * i / 20 for i in range(21)]
                # Tabrakan (lebar x tinggi orang lain, rata-rata per sampel) vs geser dari tengah: imbang.
                xa = xb = min(xs, key=lambda x0: tabrak(x0) / (cw * len(kot)) + 0.35 * abs(x0 - tengah) / cw)
            else:
                xa = xb = tengah
        else:  # geser linear mengikuti pusat grup (garis lurus kuadrat terkecil)
            us = [u - mulai for u, _ in kot]
            mu, mc = sum(us) / len(us), sum(cx) / len(cx)
            var = sum((u - mu) ** 2 for u in us) or 1e-6
            b = sum((u - mu) * (c - mc) for u, c in zip(us, cx)) / var
            xa, xb = mc + b * (0 - mu) - cw / 2, mc + b * (L - mu) - cw / 2
    else:
        xa = xb = (sw - cw) / 2
        y0 = (sh - ch) / 2
    lim = lambda v: int(round(min(max(v, 0.0), sw - cw)))  # noqa: E731
    xa, xb, y0 = lim(xa), lim(xb), int(round(min(max(y0, 0.0), sh - ch)))
    kg_akhir = kotak_grup(grup, akhir) if grup else None
    if kg_akhir:  # kotak grup di koordinat frame hasil (0-1), untuk prompt & QC
        xe = xb
        kotak = {"x": (kg_akhir["x"] * sw - xe) / cw, "y": (kg_akhir["y"] * sh - y0) / ch,
                 "w": kg_akhir["w"] * sw / cw, "h": kg_akhir["h"] * sh / ch}
        kotak = {k: round(min(max(v, 0.0), 1.0), 4) for k, v in kotak.items()}
    else:
        kotak = None
    return {"mulai": round(mulai, 3), "ketukan": ketukan, "detik": round(L, 3),
            "crop": {"w": cw, "h": ch, "x_awal": xa, "x_akhir": xb, "y": y0},
            "orang": len(grup), "kotak": kotak, "deteksi": bool(grup)}


def render_jalan(video: Path, rj: dict, frames: int, keluar: Path, frame_png: Path) -> None:
    c = rj["crop"]
    dx = c["x_akhir"] - c["x_awal"]
    T = max(rj["detik"], 1e-3)
    x = f"{c['x_awal']}" if dx == 0 else f"'{c['x_awal']}+({dx})*min(t/{T:.4f}\\,1)'"
    vf = f"crop={c['w']}:{c['h']}:{x}:{c['y']},scale={W}:{H}:flags=lanczos,fps={FPS},setsar=1"
    # +1 frame cadangan: durasi klip (ms dibulatkan) tidak pernah melebihi panjang file; frame itu tidak tampil.
    ffmpeg(["-ss", f"{rj['mulai']:.3f}", "-i", str(video), "-an", "-vf", vf, "-frames:v", str(frames + 1),
            "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-r", str(FPS), str(keluar)])
    # Frame diam = frame TERAKHIR klip (sambungan jalan -> diam mulus).
    ffmpeg(["-i", str(keluar), "-vf", f"select=eq(n\\,{frames - 1})", "-frames:v", "1", "-fps_mode", "passthrough", str(frame_png)])
    if not frame_png.exists():
        ffmpeg(["-sseof", "-0.2", "-i", str(keluar), "-update", "1", "-frames:v", "1", str(frame_png)])


def klip_diam(png: Path, frames: int, keluar: Path, zoom: bool = False) -> None:
    """Gambar diam -> klip MP4 1080x1920 30 fps (renderer Motion Studio hanya menerima gambar di track overlay).
    +1 frame cadangan seperti klip jalan. End card: zoom pelan 100 -> 104 % (gaya draf v2)."""
    n = frames + 1
    vf = f"scale={W}:{H},setsar=1"
    if zoom:
        vf = (f"scale={W * 2}:{H * 2},zoompan=z='1+0.04*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={W}x{H}:fps={FPS},setsar=1")
    ffmpeg(["-loop", "1", "-framerate", str(FPS), "-i", str(png), "-vf", vf, "-frames:v", str(n), "-c:v", "libx264", "-crf", "17",
            "-preset", "medium", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-r", str(FPS), str(keluar)])


def frame_api(frame_png: Path, keluar: Path) -> dict:
    """Frame 9:16 -> 2:3 untuk API: bingkai kiri-kanan dari tepi frame (dipantulkan + diburamkan)."""
    import cv2
    im = cv2.imread(str(frame_png))
    pad = (PAD_W - W) // 2
    besar = cv2.copyMakeBorder(im, 0, 0, pad, PAD_W - W - pad, cv2.BORDER_REFLECT)
    blur = cv2.GaussianBlur(besar, (0, 0), 18)
    blur[:, pad:pad + W] = im
    cv2.imwrite(str(keluar), cv2.resize(blur, (API_W, API_H), interpolation=cv2.INTER_AREA))
    return {"ukuran": f"{API_W}x{API_H}", "pad_kiri": pad, "lebar_pad": PAD_W}


def kalimat_target(n: int, kotak: dict | None, target: str | None) -> str:
    if n >= 2 and target != "utama":
        return (f"ALL {n} people walking together in the middle of the photo; they all wear the same new outfit"
                if n > 2 else "BOTH people walking side by side in the middle of the photo; both wear the same new outfit")
    if kotak:
        sisi = "on the left" if kotak["x"] + kotak["w"] / 2 < 0.38 else "on the right" if kotak["x"] + kotak["w"] / 2 > 0.62 else "in the middle"
        return f"ONLY the main person walking {sisi} of the photo; do not change anyone else"
    return "ONLY the main person walking in the photo; do not change anyone else"


def prompt_look(siapa: str, look: dict) -> tuple[str, list[str]]:
    bagian, acuan = [], []
    if look.get("atasan"):
        a = look["atasan"]
        acuan.append(a["path"])
        desk = f" ({a['deskripsi']})" if a["deskripsi"] else ""
        bagian.append(f"the top becomes the garment in image {len(acuan) + 1}: '{a['nama_produk']}'{desk} in {a['warna']}; "
                      f"copy its exact colour, pattern, collar, sleeves and details from image {len(acuan) + 1}")
    if look.get("bawahan"):
        b = look["bawahan"]
        acuan.append(b["path"])
        desk = f" ({b['deskripsi']})" if b["deskripsi"] else ""
        bagian.append(f"the trousers / bottom become the garment in image {len(acuan) + 1}: '{b['nama_produk']}'{desk} in {b['warna']}; "
                      f"copy its exact colour, cut, length and details from image {len(acuan) + 1}")
    ubah = "; ".join(f"({i + 1}) {s}" for i, s in enumerate(bagian))
    p = ("EDIT image 1 (a real photo). Keep EVERYTHING else identical: same people, faces, hijabs or hair, bags, shoes, "
         "hands, pose, background, lighting, camera angle, framing and size. The blurred strips on the far left and right "
         "are only padding: keep them as they are. "
         f"Change ONLY the clothes of {siapa}: {ubah}. Natural folds that follow the walking pose, realistic shadows. "
         "No text, no logo, no extra people.")
    return p, acuan


# ------------------------------------------------------------------ ketukan

def ketukan_sound(sound: Path) -> tuple[float, list[float]]:
    """Tempo + ketukan presisi sub-frame lewat pembaca bersama musik.tempo (dulu algoritma ini tinggal di sini)."""
    try:
        y = musik_mod._decode(sound)
    except subprocess.CalledProcessError:
        raise Ditolak("sound template tidak bisa dibaca")
    if len(y) < musik_mod.WIN + 400 * musik_mod.HOP_PRESISI:
        raise Ditolak("sound template terlalu pendek untuk dibaca ketukannya")
    bpm, beats = musik_mod.tempo(y)
    if bpm is None or not (musik_mod.BPM_MIN <= bpm <= musik_mod.BPM_MAKS) or len(beats) < 8:
        raise Ditolak("ketukan sound template tidak terbaca (sound terlalu pendek atau tanpa ketukan)")
    return bpm, beats


def potongan(items: list[dict], ketukan: list[float]) -> tuple[list[dict], float]:
    """Batas potong di grid ketukan (dibulatkan ke frame), urut: jalan, diam per footage, lalu end card."""
    s0 = ketukan[0]
    k = [b - s0 for b in ketukan]
    spb = (k[-1] - k[0]) / max(len(k) - 1, 1)
    def di(i):  # ketukan ke-i (diperpanjang dengan tempo rata-rata kalau sound habis)
        return k[i] if i < len(k) else k[-1] + (i - len(k) + 1) * spb
    seg, b = [], 0
    for it in items:
        for jenis, n in (("jalan", it["jalan"]["ketukan"]), ("diam", POLA["diam"])):
            seg.append({"footage": it["footage"], "jenis": jenis, "ketukan_awal": b, "ketukan_akhir": b + n})
            b += n
    seg.append({"footage": None, "jenis": "end", "ketukan_awal": b, "ketukan_akhir": b + POLA["end"]})
    for s in seg:
        f0, f1 = round(di(s["ketukan_awal"]) * FPS), round(di(s["ketukan_akhir"]) * FPS)
        s.update({"frame_awal": f0, "frame": f1 - f0, "start_ms": round(f0 * 1000 / FPS), "duration_ms": round(f1 * 1000 / FPS) - round(f0 * 1000 / FPS),
                  "ketukan_detik": round(di(s["ketukan_awal"]), 3)})
    return seg, di(seg[-1]["ketukan_akhir"])


# ------------------------------------------------------------------ tahap siapkan

def baca_job(job_dir: Path) -> tuple[dict, dict, Path]:
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    out = job_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    if job.get("mode") != "outfit":
        raise Ditolak("job.json bukan mode outfit")
    o = job.get("outfit") or {}
    if o.get("tahap") not in ("siapkan", "rakit"):
        raise Ditolak("outfit.tahap harus siapkan atau rakit")
    return job, o, out


def siapkan(job_dir: Path, deteksi=deteksi_orang) -> int:
    job, o, out = baca_job(job_dir)
    if o.get("model_sendiri") is not True:
        raise Ditolak("AI ganti pakaian hanya untuk footage model/kreator sendiri: centang \"model sendiri\" dulu")
    progres("cek_input", 2, "Ganti Outfit")
    sumber = {s["kunci"]: Path(s["path"]) for s in job.get("sumber", []) if s.get("kunci") and s.get("path")}
    sk = o.get("sound")
    if not sk or sk not in sumber:
        raise Ditolak("sound template wajib (outfit.sound harus salah satu kunci sumber)")
    footage = [(k.partition(":")[2], p) for k, p in sumber.items() if k != sk and k.startswith("$sumber:")]
    if not footage:
        raise Ditolak("tidak ada footage")
    if len(footage) > MAKS_FOOTAGE:
        raise Ditolak(f"maksimal {MAKS_FOOTAGE} footage per video (ada {len(footage)})")
    hilang = [p.name for _, p in footage if not p.exists()] + ([sumber[sk].name] if not sumber[sk].exists() else [])
    if hilang:
        raise Ditolak("file tidak ditemukan: " + ", ".join(hilang))
    katalog = muat_katalog(job_dir, job)
    rng = random.Random(o.get("seed", 1))

    progres("ketukan", 5, "membaca ketukan sound template")
    bpm, ketukan = ketukan_sound(sumber[sk])
    spb = 60.0 / bpm
    target = o.get("target") or {}
    od = out / "outfit"
    od.mkdir(exist_ok=True)
    items, peringatan = [], []
    with tempfile.TemporaryDirectory(prefix="outfit-") as tmpd:
        tmp = Path(tmpd)
        for i, (fid, p) in enumerate(footage):
            progres("orang", 10 + 60 * i // len(footage), f"mencari orang di {p.name}")
            info = probe(p)
            rj = rencana_jalan(p, info, deteksi(p, tmp), spb, target.get(fid))
            if not rj["deteksi"]:
                peringatan.append({"level": "warn", "jenis": "orang", "teks": f"{p.name}: orang tidak terdeteksi, crop di tengah"})
            items.append({"footage": fid, "nama": p.name, "sumber": {"lebar": info["lebar"], "tinggi": info["tinggi"], "fps": round(info["fps"], 3),
                                                                      "durasi": round(info["durasi"], 3)},
                          "jalan": rj})
    looks = usul_look([it["footage"] for it in items], katalog, o.get("look") or {}, rng)
    seg, total = potongan(items, ketukan)
    for i, it in enumerate(items):
        fid = it["footage"]
        progres("klip", 72 + 20 * i // len(items), f"klip jalan {it['nama']}")
        n = next(s["frame"] for s in seg if s["footage"] == fid and s["jenis"] == "jalan")
        src = dict(footage)[fid]
        klip, frame = od / f"{fid}_jalan.mp4", od / f"{fid}_frame.png"
        render_jalan(src, it["jalan"], n, klip, frame)
        api = frame_api(frame, od / f"{fid}_api.png")
        siapa = kalimat_target(it["jalan"]["orang"], it["jalan"]["kotak"], target.get(fid))
        look = looks[fid]
        prompt, acuan = prompt_look(siapa, look)
        it.update({"klip": f"outfit/{fid}_jalan.mp4", "frame": f"outfit/{fid}_frame.png",
                   "api": {"gambar": f"outfit/{fid}_api.png", **api}, "acuan_katalog": acuan, "prompt": prompt,
                   "target": target.get(fid) or ("semua" if it["jalan"]["orang"] >= 2 else "utama"),
                   "look": {k: (None if v is None else {kk: v[kk] for kk in ("id", "produk", "nama_produk", "jenis", "warna", "path")})
                            for k, v in look.items() if k in ("atasan", "bawahan")} | {"dipilih": look["dipilih"]},
                   "hasil": f"outfit/{fid}_hasil.png"})
    doc = {"schema": SCHEMA, "tahap": "siapkan", "status": "menunggu_gambar", "job_id": job.get("job_id"),
           "bpm": round(bpm, 1), "detik_per_ketukan": round(spb, 4), "sound": sk, "sound_mulai_detik": round(ketukan[0], 3),
           "ketukan": [round(b - ketukan[0], 3) for b in ketukan], "pola": {"jalan": list(POLA["jalan"]), "diam": POLA["diam"], "end": POLA["end"]},
           "potongan": seg, "durasi": round(total, 3), "teks_atas": o.get("teks_atas"), "items": items, "peringatan": peringatan}
    tulis_json(out / "outfit.json", doc)
    tulis_json(out / "rencana.json", {"schema": "engine-rencana/1", "status": "siap", "peringatan": peringatan,
                                      "durasi": {"akhir": round(total, 2)}, "outfit": {"tahap": "siapkan", "footage": len(items)}})
    progres("selesai", 100, f"{len(items)} footage siap dibuatkan gambar · {bpm:.0f} BPM · {total:.1f} dtk")
    return 0


# ------------------------------------------------------------------ QC & tahap rakit

def kembalikan_ukuran(hasil: Path, keluar: Path, pad_kiri: int, lebar_pad: int) -> tuple[int, int]:
    """Gambar API -> 1080x1920. Hasil 2:3 (OpenAI: frame + bingkai) -> skala ke tinggi 1920 lalu buang bingkai.
    Hasil 9:16 (beliapi / Nano Banana: penyedia sudah memotong bingkainya) -> cukup diubah ukurannya."""
    import cv2
    im = cv2.imread(str(hasil), cv2.IMREAD_COLOR)
    if im is None:
        raise Ditolak(f"{hasil.name}: bukan gambar")
    h0, w0 = im.shape[:2]
    if abs(w0 / h0 - W / H) < 0.03:
        cv2.imwrite(str(keluar), cv2.resize(im, (W, H), interpolation=cv2.INTER_LANCZOS4))
        return w0, h0
    lebar = int(round(w0 * H / h0))
    im = cv2.resize(im, (lebar, H), interpolation=cv2.INTER_LANCZOS4)
    kiri = int(round(pad_kiri * lebar / lebar_pad))
    im = im[:, kiri:kiri + W]
    if im.shape[1] != W:
        im = cv2.resize(im, (W, H), interpolation=cv2.INTER_LANCZOS4)
    cv2.imwrite(str(keluar), im)
    return w0, h0


def selaraskan(frame: Path, hasil: Path, kotak: dict | None) -> dict:
    """Model AI sering menggeser / memperbesar komposisi sedikit (beliapi: skala 0,97, geser 32 px), sehingga
    sambungan jalan -> diam terlihat loncat. Cocokkan latar (di luar kotak orang) ke frame asli dengan ECC
    (affine), lalu tulis ulang hasilnya di posisi frame. Gagal / tidak masuk akal -> gambar dibiarkan."""
    import cv2
    import numpy as np
    a = cv2.imread(str(frame))
    b = cv2.imread(str(hasil))
    if a is None or b is None or a.shape != b.shape:
        return {"diselaraskan": False}
    s = 4
    ga = cv2.cvtColor(cv2.resize(a, (W // s, H // s), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    gb = cv2.cvtColor(cv2.resize(b, (W // s, H // s), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    m = np.full(ga.shape, 255, np.uint8)
    if kotak:
        y0, y1 = int((kotak["y"] - 0.05) * H / s), int((kotak["y"] + kotak["h"] + 0.05) * H / s)
        x0, x1 = int((kotak["x"] - 0.08) * W / s), int((kotak["x"] + kotak["w"] + 0.08) * W / s)
        m[max(y0, 0):max(y1, 0), max(x0, 0):max(x1, 0)] = 0
    w = np.eye(2, 3, dtype=np.float32)
    try:
        cc, w = cv2.findTransformECC(ga, gb, w, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), m, 5)
    except cv2.error:
        return {"diselaraskan": False}
    skala = (float(w[0, 0]), float(w[1, 1]))
    geser = (float(w[0, 2]) * s, float(w[1, 2]) * s)
    if cc < 0.6 or not all(0.85 < k < 1.15 for k in skala) or max(abs(geser[0]), abs(geser[1])) > 200:
        return {"diselaraskan": False, "ecc": round(float(cc), 3)}
    if max(abs(skala[0] - 1), abs(skala[1] - 1)) < 0.003 and max(abs(geser[0]), abs(geser[1])) < 1.5:
        return {"diselaraskan": False, "ecc": round(float(cc), 3), "ket": "sudah pas"}
    w2 = w.copy()
    w2[:, 2] *= s
    out = cv2.warpAffine(b, w2, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    cv2.imwrite(str(hasil), out)
    return {"diselaraskan": True, "ecc": round(float(cc), 3), "skala": [round(k, 3) for k in skala], "geser_px": [round(g, 1) for g in geser]}


def qc_gambar(frame: Path, hasil: Path, kotak: dict | None, look: dict) -> dict:
    """Cek: latar & orang lain tidak berubah (di luar kotak orang), area baju memang berubah,
    warna bawahan mendekati warna katalog."""
    import cv2
    import numpy as np
    a = cv2.imread(str(frame))
    b = cv2.imread(str(hasil))
    cek = []
    ukuran_ok = a is not None and b is not None and a.shape == b.shape
    cek.append({"cek": "ukuran", "lulus": ukuran_ok, "ket": "1080x1920" if ukuran_ok else "ukuran beda"})
    if not ukuran_ok:
        return {"lulus": False, "cek": cek}
    s = 4
    ga = cv2.cvtColor(cv2.resize(a, (W // s, H // s), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(float)
    gb = cv2.cvtColor(cv2.resize(b, (W // s, H // s), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(float)
    m = np.ones_like(ga, bool)
    if kotak:
        x0, y0 = int((kotak["x"] - 0.06) * W / s), int((kotak["y"] - 0.04) * H / s)
        x1, y1 = int((kotak["x"] + kotak["w"] + 0.06) * W / s), int((kotak["y"] + kotak["h"] + 0.04) * H / s)
        m[max(y0, 0):max(y1, 0), max(x0, 0):max(x1, 0)] = False
    else:
        m[:, int(0.25 * W / s):int(0.75 * W / s)] = False
    ba, bb = cv2.GaussianBlur(ga, (0, 0), 2)[m], cv2.GaussianBlur(gb, (0, 0), 2)[m]
    korelasi = float(np.corrcoef(ba, bb)[0, 1]) if ba.size > 100 and ba.std() > 1 and bb.std() > 1 else 1.0
    selisih = float(np.abs(ba - bb).mean()) if ba.size else 0.0
    latar_ok = korelasi >= 0.80 and selisih <= 22
    cek.append({"cek": "latar_tetap", "lulus": latar_ok, "ket": f"korelasi {korelasi:.2f}, selisih {selisih:.1f}"})
    if kotak:
        x0, y0 = int(kotak["x"] * W), int((kotak["y"] + 0.15 * kotak["h"]) * H)
        x1, y1 = int((kotak["x"] + kotak["w"]) * W), int((kotak["y"] + 0.95 * kotak["h"]) * H)
        da = a[y0:y1, x0:x1].astype(float)
        db = b[y0:y1, x0:x1].astype(float)
        berubah = float(np.abs(da - db).mean()) if da.size else 0.0
        cek.append({"cek": "baju_berubah", "lulus": berubah >= 6, "ket": f"perubahan {berubah:.1f}"})
        if look.get("bawahan") and da.size:
            yb0, yb1 = int((kotak["y"] + 0.58 * kotak["h"]) * H), int((kotak["y"] + 0.90 * kotak["h"]) * H)
            xb0, xb1 = int((kotak["x"] + 0.15 * kotak["w"]) * W), int((kotak["x"] + 0.85 * kotak["w"]) * W)
            area = b[yb0:yb1, xb0:xb1].reshape(-1, 3).astype(float)
            if len(area) > 50:
                rgb = np.median(area, axis=0)[::-1] / 255.0
                lab_h = rgb_ke_lab(*rgb)
                lab_k = warna_rata(look["bawahan"]["path"])
                de = math.dist(lab_h, lab_k)
                # Bayangan/pencahayaan foto berbeda dari foto katalog: toleransi besar, hanya menangkap warna salah.
                cek.append({"cek": "warna_bawahan", "lulus": de <= 38, "ket": f"beda warna {de:.0f} (maks 38)"})
    return {"lulus": all(c["lulus"] for c in cek), "cek": cek}


def end_card(looks: list[dict], judul: str, sub: str, keluar: Path) -> None:
    """Foto katalog ASLI tiap look berjajar (atasan di atas, bawahan di bawah) + nama; bukan AI."""
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np

    def font(p, n):
        return ImageFont.truetype(p, n) if p else ImageFont.load_default()

    def bersih(path):
        src = Image.open(path)
        if src.mode in ("RGBA", "LA") or (src.mode == "P" and "transparency" in src.info):
            rgba = src.convert("RGBA")
            im = Image.new("RGB", rgba.size, (255, 255, 255))
            im.paste(rgba, mask=rgba.split()[3])
        else:
            im = src.convert("RGB")
            a = np.asarray(im).astype(int)
            pj = a[3, 3]
            if abs(int(pj[1]) - int(pj[0])) > 25 and abs(int(pj[1]) - int(pj[2])) > 15:  # latar warna polos (mis. hijau)
                kand = np.abs(a - pj).sum(axis=2) < 70
            else:  # putih / kotak-kotak transparan palsu
                kand = ((a.max(axis=2) - a.min(axis=2)) < 14) & (a.min(axis=2) > 222)
            bg = np.zeros_like(kand)
            bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1] = kand[0, :], kand[-1, :], kand[:, 0], kand[:, -1]
            for _ in range(4000):
                n = bg.copy()
                n[1:, :] |= bg[:-1, :]; n[:-1, :] |= bg[1:, :]; n[:, 1:] |= bg[:, :-1]; n[:, :-1] |= bg[:, 1:]  # noqa: E702
                n &= kand
                if (n == bg).all():
                    break
                bg = n
            a = np.asarray(im).copy()
            a[bg] = 255
            im = Image.fromarray(a.astype("uint8"))
        a = np.asarray(im).astype(int)
        m = np.abs(a - 255).sum(axis=2) > 40
        ys, xs = np.where(m)
        if len(xs):
            im = im.crop((max(xs.min() - 10, 0), max(ys.min() - 10, 0), min(xs.max() + 10, im.width), min(ys.max() + 10, im.height)))
        return im

    bg = Image.new("RGB", (W, H), (245, 240, 232))
    d = ImageDraw.Draw(bg)
    n = max(len(looks), 1)
    gap = 16
    kw = min(240, (W - 60 - gap * (n - 1)) // n)
    kh_a, kh_b = (400, 430) if any(lk.get("atasan") for lk in looks) else (0, 760)
    kartu_h = (kh_a + kh_b + 30) if kh_a else kh_b + 20
    y_kartu = 580
    for teks, f, y, warna in ((judul, font(FONT_B, 104), 330, (40, 32, 26)), (sub, font(FONT, 46), 470, (90, 78, 66))):
        if not teks:
            continue
        ukuran = f.size
        while d.textlength(teks, font=f) > W - 80 and ukuran > 24:
            ukuran -= 4
            f = font(FONT_B if f is not None and ukuran and teks == judul else FONT, ukuran)
        w = d.textlength(teks, font=f)
        d.text(((W - w) / 2, y), teks, font=f, fill=warna)
    x0 = (W - (n * kw + (n - 1) * gap)) // 2
    for i, lk in enumerate(looks):
        x = x0 + i * (kw + gap)
        kartu = Image.new("RGB", (kw, kartu_h), (255, 255, 255))
        y = 10
        for jenis, hh in (("atasan", kh_a), ("bawahan", kh_b)):
            if not hh:
                continue
            if lk.get(jenis):
                foto = bersih(lk[jenis]["path"])
                foto.thumbnail((kw - 20, hh))
                kartu.paste(foto, ((kw - foto.width) // 2, y + (hh - foto.height) // 2))
            y += hh + 10
        bg.paste(kartu, (x, y_kartu))
        baris = [f"{lk[j]['nama_produk']} {lk[j]['warna']}" for j in ("atasan", "bawahan") if lk.get(j)]
        for j, teks in enumerate(baris):
            ukuran = 28 if j == 0 else 26
            f = font(FONT_B if j == 0 else FONT, ukuran)
            while d.textlength(teks, font=f) > kw + gap - 4 and ukuran > 14:
                ukuran -= 2
                f = font(FONT_B if j == 0 else FONT, ukuran)
            tw = d.textlength(teks, font=f)
            d.text((x + (kw - tw) / 2, y_kartu + kartu_h + 22 + 38 * j), teks, font=f, fill=(60, 50, 42))
    bg.save(keluar)


TEKS_GAYA = {"x": 0.5, "y": 0.13, "size": 4.2, "width": 0.86, "color": "#ffffff", "bg": "#000000", "bg_opacity": 0.0,
             "bold": False, "outline": True, "align": "center", "font": "brand"}


def rakit(job_dir: Path) -> int:
    job, o, out = baca_job(job_dir)
    sdir = Path(o.get("siapkan") or "")
    sfile = sdir / "out" / "outfit.json"
    if not sfile.exists():
        raise Ditolak("hasil tahap siapkan tidak ditemukan (outfit.siapkan)")
    s = json.loads(sfile.read_text(encoding="utf-8"))
    if s.get("schema") != SCHEMA or s.get("tahap") != "siapkan":
        raise Ditolak("outfit.json tahap siapkan tidak valid")
    sout = sdir / "out"
    od = out / "outfit"
    od.mkdir(parents=True, exist_ok=True)
    progres("qc", 10, "memeriksa gambar AI")
    items, qc_semua, aset = [], [], []
    for i, it in enumerate(s["items"]):
        fid = it["footage"]
        mentah = sout / it["hasil"]
        if not mentah.exists():
            raise Ditolak(f"gambar AI untuk {it['nama']} belum ada")
        shutil.copy2(sout / it["klip"], od / f"{fid}_jalan.mp4")
        shutil.copy2(sout / it["frame"], od / f"{fid}_frame.png")
        akhir = od / f"{fid}_diam.png"
        asli = kembalikan_ukuran(mentah, akhir, it["api"]["pad_kiri"], it["api"]["lebar_pad"])
        sel = selaraskan(od / f"{fid}_frame.png", akhir, it["jalan"]["kotak"])
        q = qc_gambar(od / f"{fid}_frame.png", akhir, it["jalan"]["kotak"], it["look"])
        q["ukuran_api"] = f"{asli[0]}x{asli[1]}"
        q["selaras"] = sel
        qc_semua.append({"footage": fid, **q})
        items.append(it | {"qc": q, "diam": f"outfit/{fid}_diam.png"})
        n_diam = next(sg["frame"] for sg in s["potongan"] if sg["footage"] == fid and sg["jenis"] == "diam")
        klip_diam(akhir, n_diam, od / f"{fid}_diam.mp4")
        aset += [{"kunci": f"$outfit:{fid}_jalan", "path": f"out/outfit/{fid}_jalan.mp4"},
                 {"kunci": f"$outfit:{fid}_diam", "path": f"out/outfit/{fid}_diam.mp4"}]
        progres("qc", 10 + 50 * (i + 1) // len(s["items"]), f"{it['nama']}: {'lulus' if q['lulus'] else 'perlu dicek'}")
    progres("end_card", 70, "end card foto katalog asli")
    looks = [it["look"] for it in items]
    nama_atas = sorted({lk["atasan"]["nama_produk"] for lk in looks if lk.get("atasan")})
    nama_bawah = sorted({lk["bawahan"]["nama_produk"] for lk in looks if lk.get("bawahan")})
    judul = (o.get("judul_akhir") or "").strip() or "Mix & Match"
    sub = (o.get("sub_akhir") or "").strip() or " · ".join(nama_atas + nama_bawah)
    end_card(looks, judul, sub, od / "end_card.png")
    klip_diam(od / "end_card.png", s["potongan"][-1]["frame"], od / "end_card.mp4", zoom=True)
    aset.append({"kunci": "$outfit:end_card", "path": "out/outfit/end_card.mp4"})
    seg = s["potongan"]
    ops = [{"op": "set_canvas", "ratio": "9:16"}, {"op": "set_brand_logo", "on": False}, {"op": "set_loudness", "lufs": -14}]
    for sg in seg:
        media = "$outfit:end_card" if sg["jenis"] == "end" else f"$outfit:{sg['footage']}_{'jalan' if sg['jenis'] == 'jalan' else 'diam'}"
        op = {"op": "add_clip", "track_kind": "video", "media": media, "start_ms": sg["start_ms"], "duration_ms": sg["duration_ms"], "in_ms": 0}
        if sg["jenis"] == "jalan":
            op["volume"] = 0
        ops.append(op)
    end_ms = seg[-1]["start_ms"]
    total_ms = seg[-1]["start_ms"] + seg[-1]["duration_ms"]
    teks = (o.get("teks_atas") if o.get("teks_atas") is not None else s.get("teks_atas")) or ""
    if teks.strip():
        ops.append({"op": "add_clip", "track_kind": "text", "text": teks.strip()[:120], "start_ms": 0, "duration_ms": end_ms, "style": dict(TEKS_GAYA)})
    in_ms = int(round(s["sound_mulai_detik"] * 1000))
    musik_ms = total_ms
    sumber = {x["kunci"]: Path(x["path"]) for x in job.get("sumber", []) if x.get("kunci") and x.get("path")}
    peringatan_sound = []
    if s["sound"] in sumber and sumber[s["sound"]].exists():
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(sumber[s["sound"]])],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL)
        try:
            sisa = int(float(r.stdout.strip()) * 1000) - in_ms - 34  # Motion Studio menolak klip 1 ms lebih panjang dari file
        except ValueError:
            sisa = musik_ms
        if sisa < musik_ms:
            musik_ms = max(sisa, 0)
            peringatan_sound.append({"level": "warn", "jenis": "sound", "detik": round(musik_ms / 1000, 2), "teks": f"sound template habis di {musik_ms / 1000:.1f} dtk (video {total_ms / 1000:.1f} dtk): pakai sound yang lebih panjang atau kurangi footage"})
    if musik_ms >= 100:
        ops.append({"op": "add_clip", "track_kind": "music", "media": s["sound"], "start_ms": 0, "duration_ms": musik_ms, "in_ms": in_ms, "volume": 1.0})
    lulus = all(q["lulus"] for q in qc_semua)
    cek = [{"cek": f"gambar_{q['footage']}", "lulus": q["lulus"], "ket": "; ".join(c["ket"] for c in q["cek"])} for q in qc_semua]
    cek.append({"cek": "potong_di_ketukan", "lulus": True, "ket": "batas potong = ketukan sound, dibulatkan ke frame 30 fps"})
    tulis_json(out / "ops.json", {"schema": "ms-ops/1", "mode": "u3", "aset_lokal": aset, "ops": ops})
    tulis_json(out / "qc_rencana.json", {"schema": "engine-qc-rencana/1", "lulus": lulus, "cek": cek,
                                         "butir": [{"butir": c["cek"], "lulus": c["lulus"], "nilai": c["ket"]} for c in cek]})
    mulai_diam = {sg["footage"]: round(sg["start_ms"] / 1000, 2) for sg in seg if sg["jenis"] == "diam"}
    peringatan = list(s.get("peringatan") or []) + peringatan_sound + [
        {"level": "warn", "jenis": "gambar_ai", "detik": mulai_diam.get(q["footage"], 0),
         "teks": f"{q['footage']}: gambar perlu dicek ({'; '.join(c['cek'] for c in q['cek'] if not c['lulus'])})"}
        for q in qc_semua if not q["lulus"]]
    tulis_json(out / "rencana.json", {"schema": "engine-rencana/1", "status": "siap", "durasi": {"akhir": round(total_ms / 1000, 2)},
                                      "dibuang": [], "hook": None, "kata_kunci": [], "efek": [],
                                      "audio": {"sfx": 0, "musik": "sound template", "musik_bpm": s["bpm"], "alasan_tanpa_musik": None},
                                      "cta": "", "peringatan": peringatan, "ragu": [], "menunggu_u3": [],
                                      "outfit": {"tahap": "rakit", "footage": len(items), "qc_lulus": lulus}})
    tulis_json(out / "outfit.json", s | {"tahap": "rakit", "status": "siap", "job_id": job.get("job_id"), "siapkan_job": s.get("job_id"),
                                          "items": items, "qc_lulus": lulus, "end_card": "outfit/end_card.png",
                                          "judul_akhir": judul, "sub_akhir": sub, "teks_atas": teks or None})
    progres("selesai", 100, f"{len(items)} look · {total_ms / 1000:.1f} dtk · QC {'lulus' if lulus else 'ada yang perlu dicek'}")
    return 0


def jalankan(job_dir: Path, deteksi=deteksi_orang) -> int:
    job, o, out = baca_job(job_dir)
    return siapkan(job_dir, deteksi) if o["tahap"] == "siapkan" else rakit(job_dir)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    job_dir = Path(sys.argv[1])
    try:
        sys.exit(jalankan(job_dir))
    except Ditolak as e:
        sys.exit(tolak(job_dir / "out", str(e)))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
