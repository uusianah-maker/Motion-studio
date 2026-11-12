"""Satu perintah: video mentah -> iklan jadi. Transkrip -> rencana edit -> render.

Pakai (dari D:\\VIBECODING\\remotion):
  .venv\\Scripts\\python pipeline\\jalan.py C:\\Users\\distc\\Videos\\a3.mp4 --brand aysilla --produk celana

Opsi penting:
  --draf                 render cepat setengah resolusi (untuk cek/revisi)
  --placement instagram  CTA versi IG (default tiktok)
  --caption-pos auto     (default) caption otomatis menghindari wajah; --area-produk bawah untuk celana/rok
  --hook-end-sec 3.4     tahan judul hook (tutup teks tertanam di video sumber)
  --transkrip-ulang      paksa Whisper jalan lagi (default: pakai transkrip lama
                         kalau videonya tidak berubah)

Hasil: public/Output/<brand>_th_<produk>_vNN.mp4; data kerja (transkrip.json,
potongan.json untuk dicek, props.json) tetap di out/<nama>/.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def run(label: str, cmd: list[str]) -> float:
    print(f"\n== {label}")
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True, cwd=ROOT)
    return time.perf_counter() - t0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="file video mentah (di mana saja)")
    ap.add_argument("--brand", required=True, help="nama file di brandkit/, mis. aysilla")
    ap.add_argument("--produk", required=True, help="nama produk untuk nama file, mis. celana")
    ap.add_argument("--nama", help="nama folder hasil (default: nama file video)")
    ap.add_argument("--placement", choices=["tiktok", "instagram"], default="tiktok")
    ap.add_argument("--caption-pos", choices=["auto", "bawah", "atas"], default="auto")
    ap.add_argument("--area-produk", choices=["bawah", "atas", "penuh"], help="letak produk di frame; caption menghindarinya")
    ap.add_argument("--hook-end-sec", type=float)
    ap.add_argument("--sembunyikan", type=float, nargs="*", default=[], help="detik kata yang tidak ditampilkan")
    ap.add_argument("--draf", action="store_true")
    ap.add_argument("--setuju", action="store_true", help="rencana sudah disetujui: lanjut render")
    ap.add_argument("--transkrip-ulang", action="store_true")
    args = ap.parse_args()

    src = Path(args.video).resolve()
    if not src.exists():
        sys.exit(f"Video tidak ditemukan: {src}")
    # --brand aysilla -> brandkit/aysilla.json; atau path file brand_kit.json (ekspor Motion Studio).
    brandkit = Path(args.brand).resolve() if args.brand.endswith(".json") else ROOT / "brandkit" / f"{args.brand}.json"
    if not brandkit.exists():
        sys.exit(f"Brand kit tidak ditemukan: {brandkit}")
    sys.path.insert(0, str(ROOT / "pipeline"))
    from brandkit import muat

    brand_slug = muat(brandkit)["kode"].lower() if args.brand.endswith(".json") else args.brand
    nama = args.nama or re.sub(r"[^\w-]+", "_", src.stem).strip("_").lower()
    produk = re.sub(r"[^\w-]+", "_", args.produk).lower()

    # 1. Salin video ke public/masuk/ (Remotion hanya membaca dari public/).
    masuk = ROOT / "public" / "masuk" / f"{nama}{src.suffix.lower()}"
    masuk.parent.mkdir(parents=True, exist_ok=True)
    if src != masuk.resolve():
        if not masuk.exists() or masuk.stat().st_size != src.stat().st_size or masuk.stat().st_mtime < src.stat().st_mtime:
            shutil.copy2(src, masuk)
    out_dir = ROOT / "out" / nama
    out_dir.mkdir(parents=True, exist_ok=True)
    rel_video = masuk.relative_to(ROOT).as_posix()  # public/masuk/x.mp4 (untuk Whisper)

    # Salinan khusus render: keyframe tiap 15 frame, tanpa B-frame. Video unduhan
    # sering keyframe-nya jarang (a5: 10 keyframe/24 dtk), sehingga tiap worker render
    # harus mundur jauh untuk mengambil satu frame. Diukur a5, 300 frame: 55,5 -> 32,5 dtk.
    render_src = ROOT / "public" / "masuk" / "_render" / f"{nama}.mp4"
    if not render_src.exists() or render_src.stat().st_mtime < masuk.stat().st_mtime:
        render_src.parent.mkdir(parents=True, exist_ok=True)
        print("\n== Siapkan salinan render (keyframe rapat)")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(masuk), "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "12", "-g", "15", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "copy", str(render_src)],
            check=True,
        )
    public_video = render_src.relative_to(ROOT / "public").as_posix()  # masuk/_render/x.mp4

    times = {}
    # 2. Transkrip: dilewati kalau sudah ada dan lebih baru dari videonya.
    transkrip = out_dir / "transkrip.json"
    fresh = transkrip.exists() and transkrip.stat().st_mtime > masuk.stat().st_mtime
    if fresh and not args.transkrip_ulang:
        print(f"\n== Transkrip: pakai yang sudah ada ({transkrip.relative_to(ROOT)})")
        times["transkrip"] = 0.0
    else:
        times["transkrip"] = run(
            "Transkrip (Whisper)",
            [PY, "pipeline/transcribe.py", rel_video, str(transkrip.relative_to(ROOT)), "--brandkit", str(brandkit)],
        )

    # 3. Rencana edit.
    edit_cmd = [
        PY, "pipeline/edit.py", str(transkrip.relative_to(ROOT)),
        "--brandkit", str(brandkit),
        "--video", public_video,
        "--out", str(out_dir.relative_to(ROOT)),
        "--placement", args.placement,
        "--caption-pos", args.caption_pos,
    ]
    if args.area_produk:
        edit_cmd += ["--area-produk", args.area_produk]
    if args.hook_end_sec:
        edit_cmd += ["--hook-end-sec", str(args.hook_end_sec)]
    if args.sembunyikan:
        edit_cmd += ["--sembunyikan", *map(str, args.sembunyikan)]
    print("\n== Rencana edit")
    t0 = time.perf_counter()
    rc = subprocess.run(edit_cmd, cwd=ROOT).returncode
    times["rencana"] = time.perf_counter() - t0
    rep = json.loads((out_dir / "potongan.json").read_text(encoding="utf-8"))
    if rc == 2:
        print(f"\n!! DITOLAK: {rep['alasan']}")
        raise SystemExit(2)
    if rc != 0:
        raise SystemExit(rc)
    for p in rep.get("peringatan", []):
        print(f"!! PERINGATAN: {p}")

    # Render hanya setelah rencana disetujui (aturan owner 12 Nov 2026).
    if not args.setuju:
        print("\n================ RENCANA SIAP ================")
        print(f"Rencana  : {(out_dir / 'potongan.json').relative_to(ROOT)}")
        print(f"Durasi   : {rep['originalSec']}s -> {rep['totalWithOutroSec']}s (termasuk outro)")
        print(f"Hook     : {rep['hook']['text']}")
        print(f"Dibuang  : {len(rep['removed'])} bagian | kata kunci: {len(rep['kataKunci'])} | SFX: {len(rep['sfx'])}")
        print("Render DITAHAN sampai disetujui. Jalankan lagi dengan --setuju untuk merender.")
        return

    # 4. Render.
    render_cmd = [
        PY, "pipeline/render.py", str((out_dir / "props.json").relative_to(ROOT)),
        "--name", f"{brand_slug}_th_{produk}",
    ]
    if args.draf:
        render_cmd.append("--draf")
    times["render"] = run("Render" + (" DRAF" if args.draf else ""), render_cmd)

    hasil = sorted((ROOT / "public" / "Output").glob(f"{brand_slug}_th_{produk}_*.mp4"), key=lambda p: p.stat().st_mtime)[-1]
    rep = json.loads((out_dir / "potongan.json").read_text(encoding="utf-8"))
    print("\n================ SELESAI ================")
    print(f"File     : {hasil.relative_to(ROOT)}")
    print(f"Durasi   : {rep['originalSec']}s -> {rep['totalWithOutroSec']}s (termasuk outro)")
    if rep["overMax"]:
        print("!! LEBIH DARI 30 DETIK: tentukan bagian tengah yang dibuang.")
    print(f"Dibuang  : {len(rep['removed'])} bagian | kata kunci: {len(rep['kataKunci'])} | SFX: {len(rep['sfx'])}")
    print(f"Musik    : {rep['musik']}")
    if rep["doubts"]:
        print("Ragu     : " + "; ".join(f"{d['atSec']}s {d['word']}" for d in rep["doubts"]))
    print(
        "Waktu    : "
        + ", ".join(f"{k} {v:.0f}s" for k, v in times.items())
        + f" | total {sum(times.values()):.0f}s"
    )


if __name__ == "__main__":
    main()
