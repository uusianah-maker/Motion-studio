"""Y2 Shot Library (Batch Remix): potong tiap footage jadi shot pendek + label otomatis.

Pakai (dari D:\\VIBECODING\\remotion, Python Batch Remix punya OpenCV):
  D:\\VIBECODING\\tools\\demucs-venv\\Scripts\\python pipeline\\batch\\shotlib.py 2026-11-13_video-winning

Butuh hasil pipeline/pisah.py: konten/2-dipisah/<batch>/video-bisu/ dan vokal/.
Menulis konten/2-dipisah/<batch>/shots.json + thumb/<footage>__NN.jpg (1 frame tengah tiap shot, 270x480). Label dibuat dengan aturan (tanpa AI) dan boleh
dikoreksi tim: shot yang punya "koreksi": {...} di shots.json lama dipertahankan saat dijalankan ulang.

Label per shot:
  framing      closeup_produk (tanpa wajah) | wajah_dekat | medium | full_body
  wajah_bicara wajah kreator terlihat + ia sedang bicara -> dipakai hanya tersinkron dengan VO-nya sendiri
  teks_bawaan  ada teks tertanam (bukan watermark) -> perlu blur / dihindari
  buram        gambar blur karena gerak
  tag          topik dari ucapan kreator di detik itu (anti_kusut, bahan, high_waist, ...)
Per footage: watermark TikTok (kiri sebelum detik pindah, kanan bawah sesudahnya) + footer.
"""

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

from common import topik_dari  # noqa: E402

KONTEN = Path("konten")
MAIN_PY = Path(".venv/Scripts/python.exe")
SAMPLE_FPS = 5
MAX_SHOT = 3.0  # detik; shot panjang dipecah supaya label tetap lokal
MIN_SHOT = 0.6
WAJAH_KECIL = 0.07  # tinggi wajah < 7% frame: bibir tidak terbaca, aman dipakai lintas kreator
AW, AH = 288, 512  # resolusi analisis
THUMB_W = 270  # lebar thumbnail shot (tinggi ikut rasio sumber)

# Kotak watermark TikTok & footer (pecahan lebar/tinggi), diukur dari batch 2026-11-13.
WM_KIRI = (0.0, 0.425, 0.34, 0.55)
WM_KANAN = (0.66, 0.655, 1.0, 0.795)
FOOTER = (0.0, 0.93, 1.0, 0.985)



def box_px(box, w, h):
    x0, y0, x1, y1 = box
    return int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)


def bright_frac(gray, box):
    x0, y0, x1, y1 = box_px(box, gray.shape[1], gray.shape[0])
    return float((gray[y0:y1, x0:x1] > 235).mean())




def analyse_video(path: Path):
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, round(fps / SAMPLE_FPS))
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    rows, prev_hist, prev_mouth = [], None, None
    for i in range(0, n, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (AW, AH))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        diff = 0.0 if prev_hist is None else float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA))
        prev_hist = hist
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=7, minSize=(14, 14))
        # Wajah hanya di 60% atas frame (tangan/kain di bawah sering salah terbaca wajah).
        faces = [f for f in faces if (f[1] + f[3] / 2) / AH < 0.6]
        face = max(faces, key=lambda f: f[3]) if len(faces) else None
        # Gerak mulut: beda piksel area mulut antar sampel -> membedakan bicara vs pose diam.
        mulut, mouth = None, None
        if face is not None:
            x, y, w, h = face
            crop = gray[y + int(0.65 * h): y + int(0.95 * h), x + int(0.25 * w): x + int(0.75 * w)]
            if crop.size:
                mouth = (cv2.resize(crop, (24, 12)).astype(np.float32), x + w / 2, w)
                if prev_mouth is not None and abs(prev_mouth[1] - mouth[1]) < 0.3 * w and abs(prev_mouth[2] - w) < 0.25 * w:
                    a, b = prev_mouth[0], mouth[0]
                    mulut = float(np.abs((a - a.mean()) - (b - b.mean())).mean())
        prev_mouth = mouth
        full = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rows.append({
            "t": i / fps,
            "diff": diff,
            "face_h": float(face[3] / AH) if face is not None else 0.0,
            "face_top": float(face[1] / AH) if face is not None else None,
            "mulut": mulut,
            "wm_kiri": bright_frac(full, WM_KIRI),
            "wm_kanan": bright_frac(full, WM_KANAN),
            "footer": bright_frac(full, FOOTER),
            "tajam": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
            # Ada orang (badan utuh HOG atau wajah): untuk footage satu take, bagian tanpa orang tidak dipakai.
            "orang": bool(face is not None) or any(h > 0.3 * AH for (_, _, _, h) in
                                                  hog.detectMultiScale(gray, winStride=(8, 8), scale=1.05)[0]),
        })
    cap.release()
    return rows, n / fps


def watermark_info(rows, paksa_tiktok=False):
    """Watermark TikTok: kiri di awal, pindah ke kanan bawah. Cari detik pindahnya."""
    kiri = np.array([r["wm_kiri"] for r in rows])
    kanan = np.array([r["wm_kanan"] for r in rows])
    t = np.array([r["t"] for r in rows])
    early, late = t < 4.5, t > 6
    # Watermark pindah posisi: kotak kiri terang di awal lalu redup, kotak kanan sebaliknya.
    # Dibandingkan awal vs akhir supaya latar terang tidak terbaca sebagai watermark.
    ada = bool(early.any() and late.any()
               and kiri[early].mean() - kiri[late].mean() > 0.015
               and kanan[late].mean() - kanan[early].mean() > 0.015)
    pindah = 5.0
    if ada:
        lo_k, hi_k = kiri[late].mean(), kiri[early].mean()
        for i in range(1, len(rows)):
            if t[i] > 2 and kiri[i] < (lo_k + hi_k) / 2:
                pindah = round(float(t[i]), 1)
                break
    footer = bool(np.median([r["footer"] for r in rows]) > 0.02)
    if paksa_tiktok:  # unduhan TikTok: deteksi bisa gagal di latar terang/watermark tipis
        ada, footer = True, True
    return {
        "tiktok": ada,
        "pindah_detik": pindah,
        "kotak_awal": WM_KIRI,
        "kotak_akhir": WM_KANAN,
        "footer": footer,
        "kotak_footer": FOOTER,
    }


def ada_orang(rows):
    """Kehadiran orang per sampel, dihaluskan (mayoritas 5 sampel) supaya tidak berkedip."""
    raw = [r["orang"] for r in rows]
    return [sum(raw[max(0, i - 2): i + 3]) * 2 > len(raw[max(0, i - 2): i + 3]) for i in range(len(raw))]


def cut_shots(rows, dur, pakai_orang=False):
    cuts = [0.0] + [r["t"] for r in rows if r["diff"] > 0.35] + [dur]
    if pakai_orang:  # potong juga saat orang masuk/keluar frame (kamera diam)
        hadir = ada_orang(rows)
        cuts += [rows[i]["t"] for i in range(1, len(rows)) if hadir[i] != hadir[i - 1]]
        cuts = sorted(set(cuts))
    shots = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < MIN_SHOT and shots:
            shots[-1] = (shots[-1][0], b)
            continue
        k = max(1, int(np.ceil((b - a) / MAX_SHOT)))
        for j in range(k):
            shots.append((a + (b - a) * j / k, a + (b - a) * (j + 1) / k))
    return [(round(a, 2), round(b, 2)) for a, b in shots if b - a >= 0.3]


_OCR = None


def ocr_frame(frame) -> list[dict]:
    """Teks di frame (RapidOCR, model ONNX bawaan paket). Kotak dalam pecahan frame."""
    global _OCR
    if _OCR is None:
        from rapidocr_onnxruntime import RapidOCR
        # Batas sisi deteksi dinaikkan: footage 4K (mis. DJI 1728x3072) diperkecil ke 736 px secara default,
        # tulisan kecil di latar (VOGUE di rak) jadi terlewat.
        _OCR = RapidOCR(det_limit_side_len=1600)
    h, w = frame.shape[:2]
    res, _ = _OCR(frame, use_det=True, use_cls=False, use_rec=True)
    out = []
    for box, teks, conf in res or []:
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        if float(conf) < 0.6:
            continue
        out.append({"teks": teks, "kotak": [round(min(xs) / w, 3), round(min(ys) / h, 3),
                                            round((max(xs) - min(xs)) / w, 3), round((max(ys) - min(ys)) / h, 3)]})
    return out


def _di_kotak(k, box, pad=0.03):
    cx, cy = k[0] + k[2] / 2, k[1] + k[3] / 2
    return box[0] - pad <= cx <= box[2] + pad and box[1] - pad <= cy <= box[3] + pad


def pilah_teks(items):
    """Pisahkan watermark TikTok (logo + @akun), footer hak cipta, dan teks bawaan lain."""
    wm, footer, lain = [], [], []
    for it in items:
        t = it["teks"].strip()
        low = t.lower().replace(" ", "")
        if sum(ch.isalnum() for ch in t) < 2:
            continue  # sampah OCR
        k = it["kotak"]
        # Watermark TikTok = logo "TikTok" atau nama akun. Posisi saja tidak cukup: buku/poster di latar
        # (mis. "OCULUS" di rak footage DJI) bisa kebetulan ada di area watermark.
        mirip_akun = bool(re.fullmatch(r"@?[\w.]{4,}", t)) and ("_" in t or "." in t or t.startswith("@"))
        di_area = _di_kotak(k, WM_KIRI) or _di_kotak(k, WM_KANAN)
        if ("tik" in low and len(low) <= 8) or t.startswith("@") or (di_area and mirip_akun):
            wm.append(it)
        elif "unauthor" in low or "prohibit" in low or k[1] > 0.92:
            footer.append(it)
        else:
            lain.append(it)
    return wm, footer, lain


def _iou(a, b):
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    return inter / max(aw * ah + bw * bh - inter, 1e-9)


def _dekat(a, b, pad=0.012):
    """Dua kotak bersentuhan/tumpang tindih (dengan sedikit kelonggaran)."""
    return not (a[0] + a[2] + pad < b[0] or b[0] + b[2] + pad < a[0] or a[1] + a[3] + pad < b[1] or b[1] + b[3] + pad < a[1])


def gabung_kotak(lst: list[dict]) -> list[dict]:
    """Kotak teks yang bersentuhan digabung jadi satu (hemat jatah 8 area blur Motion Studio)."""
    out = [dict(t) for t in lst]
    berubah = True
    while berubah:
        berubah = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i]["kotak"], out[j]["kotak"]
                if _dekat(a, b):
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    out[i] = {**out[i], "teks": out[i]["teks"] + " " + out[j]["teks"],
                              "kotak": [round(x0, 3), round(y0, 3), round(x1 - x0, 3), round(y1 - y0, 3)]}
                    out.pop(j)
                    berubah = True
                    break
            if berubah:
                break
    return out


def teks_statis(per_shot: list[list[dict]], ambang: float = 0.2, min_shot: int | None = None) -> list[dict]:
    """Kotak teks yang posisinya sama di >= ambang bagian shot (kamera diam, tulisan di latar)."""
    kelompok = []  # [kotak wakil, jumlah shot]
    for lst in per_shot:
        sudah = set()
        for t in lst:
            for i, g in enumerate(kelompok):
                if i not in sudah and _dekat(g[0]["kotak"], t["kotak"], 0.0):
                    g[1] += 1
                    sudah.add(i)
                    break
            else:
                kelompok.append([t, 1])
                sudah.add(len(kelompok) - 1)
    n = max(len(per_shot), 1)
    batas = min_shot if min_shot is not None else ambang * n
    return [dict(g[0], statis=True) for g in kelompok if n >= 3 and g[1] >= batas]


def ocr_shot(cap, a, b, fps):
    items = []
    for f in (0.3, 0.75):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int((a + (b - a) * f) * fps))
        ok, frame = cap.read()
        if ok:
            items += ocr_frame(frame)
    return items


def words_in(words, a, b):
    return [w for w in words if w["startMs"] / 1000 < b and w["endMs"] / 1000 > a]


def label_shot(rows, words, a, b, teks_lain, cek_kosong=False):
    rs = [r for r in rows if a <= r["t"] < b] or [min(rows, key=lambda r: abs(r["t"] - a))]
    fh = [r["face_h"] for r in rs]
    face_ratio = float(np.mean([h > 0 for h in fh]))
    face_h = float(np.median([h for h in fh if h > 0])) if face_ratio > 0 else 0.0
    if face_ratio < 0.25:
        framing = "closeup_produk"
    elif face_h > 0.14:
        framing = "wajah_dekat"
    elif face_h < 0.07:
        framing = "full_body"
    else:
        framing = "medium"
    mv = [r["mulut"] for r in rs if r["mulut"] is not None]
    mulut = round(float(np.mean(mv)), 2) if mv else None
    ws = words_in(words, a, b)
    spoken = sum(min(w["endMs"] / 1000, b) - max(w["startMs"] / 1000, a) for w in ws)
    bicara = round(min(1.0, spoken / max(b - a, 1e-6)), 2)
    text = " ".join(w["text"] for w in ws)
    tags = topik_dari(text)
    return {
        "framing": framing,
        "wajah": {"rasio": round(face_ratio, 2), "tinggi": round(face_h, 3),
                  "atas": round(float(np.median([r["face_top"] for r in rs if r["face_top"] is not None])), 3) if face_ratio > 0 else None},
        "bicara": bicara,
        "gerak_mulut": mulut,
        # gerak_mulut hanya info: diuji 13 Nov, pose diam & bicara nilainya mirip (gerak kepala ikut terbaca).
        # Jadi aturannya konservatif: wajah cukup besar + ada ucapan = dianggap bicara.
        "wajah_bicara": bool(face_ratio >= 0.4 and face_h >= WAJAH_KECIL and bicara >= 0.4),
        "teks_bawaan": bool(teks_lain),
        "teks": [{"teks": t["teks"], "kotak": t["kotak"]} for t in teks_lain],
        "buram": bool(np.median([r["tajam"] for r in rs]) < 40),
        "kosong": bool(cek_kosong and np.mean([r.get("hadir", True) for r in rs]) < 0.5),
        "tag": tags,
        "ucapan": text,
    }


def thumb_id(sid: str) -> str:
    """Nama file thumbnail aman untuk URL: '#' di id shot diganti '__'."""
    return sid.replace("#", "__")


def tulis_thumbs(video: Path, shots: list, thumb_dir: Path) -> dict:
    """Satu JPG per shot dari frame tengahnya. File yang sudah ada tidak dibuat ulang."""
    thumb_dir.mkdir(exist_ok=True)
    cap = cv2.VideoCapture(str(video))
    hasil = {}
    for sid, a, b in shots:
        out = thumb_dir / f"{thumb_id(sid)}.jpg"
        if not out.exists():
            cap.set(cv2.CAP_PROP_POS_MSEC, (a + b) / 2 * 1000)
            ok, fr = cap.read()
            if not ok:
                continue
            h, w = fr.shape[:2]
            fr = cv2.resize(fr, (THUMB_W, int(round(h * THUMB_W / w))), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(out), fr, [cv2.IMWRITE_JPEG_QUALITY, 82])
        hasil[sid] = str(out.resolve()).replace("\\", "/")  # path absolut (kontrak §8)
    cap.release()
    return hasil


def ensure_transcript(batch_dir: Path, name: str) -> Path:
    out = batch_dir / "transkrip" / f"{name}.json"
    if not out.exists():
        out.parent.mkdir(exist_ok=True)
        vokal = batch_dir / "vokal" / f"{name}.wav"
        print(f"  transkrip {name} ...", file=sys.stderr)
        subprocess.run([str(MAIN_PY), "pipeline/transcribe.py", str(vokal), str(out), "--brandkit", "brandkit/aysilla.json"],
                       check=True, stdout=subprocess.DEVNULL)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("--tiktok", action="store_true", help="semua footage unduhan TikTok: paksa blur watermark + footer")
    ap.add_argument("--hanya", nargs="*", help="proses footage tertentu saja (nama tanpa .mp4)")
    ap.add_argument("--thumb-saja", action="store_true", help="lengkapi thumbnail shots.json yang sudah ada tanpa analisis ulang")
    args = ap.parse_args()

    batch_dir = KONTEN / "2-dipisah" / args.batch
    if args.thumb_saja:
        lib_path = batch_dir / "shots.json"
        lib = json.loads(lib_path.read_text(encoding="utf-8"))
        for name, meta in lib["footage"].items():
            mine = [s for s in lib["shots"] if s["footage"] == name]
            th = tulis_thumbs(Path(meta["video"]), [(s["id"], s["dari"], s["sampai"]) for s in mine], batch_dir / "thumb")
            for s in mine:
                s["thumb"] = th.get(s["id"])
        lib_path.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"-> {lib_path}: thumbnail {sum(1 for s in lib['shots'] if s.get('thumb'))}/{len(lib['shots'])} shot")
        return
    vids = sorted((batch_dir / "video-bisu").glob("*.mp4"), key=lambda p: (len(p.stem), p.stem))
    if args.hanya:
        vids = [v for v in vids if v.stem in args.hanya]
    lib_path = batch_dir / "shots.json"
    old = json.loads(lib_path.read_text(encoding="utf-8")) if lib_path.exists() else {"footage": {}, "shots": []}
    koreksi = {s["id"]: s["koreksi"] for s in old["shots"] if s.get("koreksi")}

    lib = {"schema": "shot-library/1", "batch": args.batch, "footage": dict(old["footage"]),
           "shots": [s for s in old["shots"] if s["footage"] not in {v.stem for v in vids}]}
    for v in vids:
        name = v.stem
        has_vokal = (batch_dir / "vokal" / f"{name}.wav").exists()
        words = []
        if has_vokal:
            tr = json.loads(ensure_transcript(batch_dir, name).read_text(encoding="utf-8"))
            words = tr["words"]
        rows, dur = analyse_video(v)
        satu_take = not any(r["diff"] > 0.35 for r in rows)
        for r, h in zip(rows, ada_orang(rows)):
            r["hadir"] = h
        shots = cut_shots(rows, dur, pakai_orang=satu_take)
        cap = cv2.VideoCapture(str(v))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        ocr_per_shot, akun, ada_logo, ada_footer = [], Counter(), False, False
        for a, b in shots:
            wm, footer, lain = pilah_teks(ocr_shot(cap, a, b, fps))
            # OCR kadang membaca "_" sebagai spasi: "@aysilla factory" -> "@aysilla_factory".
            akun.update(x["teks"].strip().replace(" ", "_") for x in wm if x["teks"].strip().startswith("@"))
            ada_logo |= bool(wm)
            ada_footer |= bool(footer)
            # Teks sama yang terbaca di 2 frame cukup dicatat sekali.
            uniq = {}
            for x in lain:
                uniq.setdefault(x["teks"].lower(), x)
            ocr_per_shot.append(list(uniq.values()))
        cap.release()
        # Tulisan latar yang diam (rak, poster) muncul di banyak shot tapi kadang tertutup model di frame contoh.
        # Kotak yang terbaca di >= 30% shot ditambahkan ke semua shot footage ini supaya blur-nya konsisten.
        # Satu take tanpa potongan adegan (kamera diam, mis. DJI try-on): tulisan yang terbaca di >= 2 shot
        # sudah pasti tulisan latar. Footage berpotongan (TikTok) pakai ambang 20% supaya caption tidak menyebar.
        statis = teks_statis(ocr_per_shot, min_shot=2 if satu_take else None)
        for k2, lst in enumerate(ocr_per_shot):
            for t in statis:
                if not any(_dekat(t["kotak"], x["kotak"], 0.0) for x in lst):
                    lst.append(t)
            ocr_per_shot[k2] = gabung_kotak(lst)
        lib["footage"][name] = {
            "video": str(v).replace("\\", "/"),
            "vokal": str(batch_dir / "vokal" / f"{name}.wav").replace("\\", "/") if has_vokal else None,
            "musik": str(batch_dir / "musik" / f"{name}.wav").replace("\\", "/") if has_vokal else None,
            "durasi": round(dur, 2),
            "jumlah_kata": len(words),
            "watermark": watermark_info(rows, args.tiktok or ada_logo),
        }
        wmi = lib["footage"][name]["watermark"]
        wmi["footer"] = wmi["footer"] or ada_footer
        # Akun di watermark = petunjuk pemilik footage (hak pakai). Bacaan OCR yang jarang = salah baca.
        wmi["akun"] = [a for a, c in akun.most_common() if c >= max(akun.values(), default=0) / 3][:2]
        thumbs = tulis_thumbs(v, [(f"{name}#{k:02d}", a, b) for k, (a, b) in enumerate(shots)], batch_dir / "thumb")
        for k, (a, b) in enumerate(shots):
            sid = f"{name}#{k:02d}"
            s = {"id": sid, "footage": name, "dari": a, "sampai": b, "thumb": thumbs.get(sid),
                 **label_shot(rows, words, a, b, ocr_per_shot[k], cek_kosong=satu_take)}
            if sid in koreksi:
                s["koreksi"] = koreksi[sid]
                s.update(koreksi[sid])
            lib["shots"].append(s)
        n_wb = sum(1 for s in lib["shots"] if s["footage"] == name and s["wajah_bicara"])
        n_tx = sum(1 for s in lib["shots"] if s["footage"] == name and s["teks_bawaan"])
        print(f"{name}: {dur:.1f}s, {len(shots)} shot, {n_wb} wajah bicara, {n_tx} teks bawaan, "
              f"watermark={wmi['tiktok']} akun={','.join(wmi['akun']) or '-'}", flush=True)
    lib["shots"].sort(key=lambda s: (len(s["footage"]), s["footage"], s["dari"]))
    lib_path.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {lib_path} ({len(lib['shots'])} shot)")


if __name__ == "__main__":
    main()
