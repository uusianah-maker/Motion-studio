"""R24e Enhancement: Real-ESRGAN ncnn-vulkan (exe MIT, model BSD-3, ncnn BSD-3; GPU Vulkan) — upscale gambar/video.

  python pipeline/visual/perjelas.py <masuk> <folder_keluar> [--mode cepat|kualitas] [--skala 2|3|4] [--sisi 1920]

- Alat: <TOOLS>/realesrgan/realesrgan-ncnn-vulkan.exe (MOTION_TOOLS_DIR; override MOTION_REALESRGAN), lisensi di LICENSES/.
- Mode:
    kualitas = realesrgan-x4plus (foto/footage nyata, x4 saja, lambat)  -> bawaan GAMBAR
    cepat    = realesr-animevideov3 (x2/x3/x4, jauh lebih cepat)       -> bawaan VIDEO
- Gambar: <nama>-hd.png. Video (maks 15 dtk, §18.0): frame diproses semua, lalu <nama>-hd.mp4 (H.264 CRF 18,
  audio asli disalin). `--sisi` = sisi panjang maksimum hasil (bawaan: video 1920, gambar 4096); lebih besar diperkecil.
- Prioritas Idle (proses exe juga), kunci AI global, tile 128 (VRAM GTX 1650 4 GB), 1 thread muat/simpan.
  Perkiraan waktu diukur dari frame pertama dan dikirim sebelum lanjut.
- Hasil = USULAN: file baru di folder keluar; klip asli tidak diubah, app yang menawarkan penggantian.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import beban  # noqa: E402

beban.siapkan_env()

import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

ALAT = Path(os.environ.get("MOTION_REALESRGAN") or beban.TOOLS / "realesrgan" / "realesrgan-ncnn-vulkan.exe")
MODE = {"kualitas": ("realesrgan-x4plus", (4,)), "cepat": ("realesr-animevideov3", (2, 3, 4))}
GAMBAR = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
IDLE = 0x40
TILE = 128


def esrgan(masuk: Path, keluar: Path, model: str, skala: int) -> None:
    if not ALAT.exists():
        raise RuntimeError(f"Real-ESRGAN tidak ada: {ALAT}")
    r = subprocess.run([str(ALAT), "-i", str(masuk), "-o", str(keluar), "-n", model, "-s", str(skala), "-t", str(TILE),
                        "-j", "1:1:1", "-f", "png", "-m", str(ALAT.parent / "models")],
                       capture_output=True, text=True, errors="replace", creationflags=IDLE if os.name == "nt" else 0)
    if r.returncode != 0:
        raise RuntimeError(f"Real-ESRGAN gagal ({r.returncode}): {(r.stderr or r.stdout)[-300:]}")


def ffmpeg(args: list[str]) -> None:
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, creationflags=IDLE)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg gagal: {r.stderr[-300:]}")


def probe(p: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration",
                        "-of", "json", str(p)], capture_output=True, text=True, creationflags=IDLE)
    if r.returncode != 0:
        raise beban.Ditolak(f"file tidak terbaca: {p.name}")
    d = json.loads(r.stdout)
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        raise beban.Ditolak("tidak ada gambar di file")
    a, _, b = (v.get("avg_frame_rate") or "30/1").partition("/")
    return {"lebar": int(v["width"]), "tinggi": int(v["height"]), "fps": float(a) / float(b or 1) if float(b or 1) else 30.0,
            "durasi": float(d.get("format", {}).get("duration") or 0),
            "audio": any(s.get("codec_type") == "audio" for s in d.get("streams", []))}


def skala_akhir(w: int, h: int, skala: int, sisi: int) -> tuple[int, int]:
    W, H = w * skala, h * skala
    if max(W, H) > sisi:
        f = sisi / max(W, H)
        W, H = W * f, H * f
    return int(W) // 2 * 2, int(H) // 2 * 2


def gambar(masuk: Path, keluar: Path, model: str, skala: int, sisi: int) -> dict:
    info = probe(masuk)
    beban.perkiraan("perjelas", 20 if model == "realesrgan-x4plus" else 5)
    keluar.mkdir(parents=True, exist_ok=True)
    t = time.monotonic()
    tmp = Path(tempfile.mkdtemp(prefix="hd-", dir=keluar))
    try:
        esrgan(masuk, tmp / "x.png", model, skala)
        W, H = skala_akhir(info["lebar"], info["tinggi"], skala, sisi)
        f = keluar / f"{masuk.stem}-hd.png"
        ffmpeg(["-i", str(tmp / "x.png"), "-vf", f"scale={W}:{H}:flags=lanczos", str(f)])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"jenis": "gambar", "file": f.name, "dari": [info["lebar"], info["tinggi"]], "jadi": [W, H],
            "detik_proses": round(time.monotonic() - t, 1)}


def video(masuk: Path, keluar: Path, model: str, skala: int, sisi: int, progres=beban.progres) -> dict:
    info = probe(masuk)
    beban.cek_durasi_klip(info["durasi"])
    keluar.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="hd-", dir=keluar))
    try:
        fi, fo = tmp / "f", tmp / "o"
        fi.mkdir()
        fo.mkdir()
        ffmpeg(["-i", str(masuk), "-an", "-fps_mode", "passthrough", str(fi / "%05d.png")])
        frames = sorted(fi.glob("*.png"))
        if not frames:
            raise beban.Ditolak("video tanpa frame")
        mulai = time.monotonic()
        # Frame pertama sendiri: ukur kecepatan nyata -> perkiraan untuk app, lalu sisanya sekaligus (exe 1 kali).
        satu = tmp / "satu"
        satu.mkdir()
        shutil.copy(frames[0], satu / frames[0].name)
        esrgan(satu, fo, model, skala)
        per = time.monotonic() - mulai
        beban.perkiraan("perjelas", per * len(frames) + 15,
                        f"{len(frames)} frame x {per:.1f} dtk = perkiraan ±{max(1, round(per * len(frames) / 60))} menit")
        sisa = tmp / "sisa"
        sisa.mkdir()
        for f in frames[1:]:
            shutil.move(str(f), sisa / f.name)
        if frames[1:]:
            # stderr exe ke FILE: exe menulis banyak baris; pipe yang tidak dibaca membuatnya tertahan (±50 dtk/frame).
            log = tmp / "esrgan.log"
            with open(log, "w", encoding="utf-8", errors="replace") as fl:
                proses = subprocess.Popen([str(ALAT), "-i", str(sisa), "-o", str(fo), "-n", model, "-s", str(skala),
                                           "-t", str(TILE), "-j", "1:1:1", "-f", "png", "-m", str(ALAT.parent / "models")],
                                          stdout=subprocess.DEVNULL, stderr=fl, creationflags=IDLE if os.name == "nt" else 0)
                while proses.poll() is None:
                    jadi = len(list(fo.glob("*.png")))
                    progres("perjelas", 5 + int(85 * jadi / len(frames)), f"frame {jadi}/{len(frames)}")
                    time.sleep(2)
            if proses.returncode != 0:
                raise RuntimeError(f"Real-ESRGAN gagal ({proses.returncode}): "
                                   f"{log.read_text(encoding='utf-8', errors='replace')[-300:]}")
        W, H = skala_akhir(info["lebar"], info["tinggi"], skala, sisi)
        f = keluar / f"{masuk.stem}-hd.mp4"
        progres("encode", 92, f"menyusun video {W}x{H}")
        args = ["-framerate", f"{info['fps']:.6f}", "-i", str(fo / "%05d.png")]
        if info["audio"]:
            args += ["-i", str(masuk), "-map", "0:v", "-map", "1:a", "-c:a", "copy", "-shortest"]
        ffmpeg(args + ["-vf", f"scale={W}:{H}:flags=lanczos", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                       "-threads", str(beban.MAKS_THREAD), str(f)])
        return {"jenis": "video", "file": f.name, "dari": [info["lebar"], info["tinggi"]], "jadi": [W, H],
                "frame": len(frames), "durasi": round(info["durasi"], 3), "detik_proses": round(time.monotonic() - mulai, 1)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def jalankan(masuk: Path, keluar: Path, mode: str | None, skala: int | None, sisi: int | None) -> int:
    lap = {"schema": "perjelas/1", "status": "ditolak", "usulan": True, "masuk": masuk.name}
    try:
        if not masuk.exists():
            raise beban.Ditolak(f"file tidak ada: {masuk.name}")
        adalah_gambar = masuk.suffix.lower() in GAMBAR
        mode = mode or ("kualitas" if adalah_gambar else "cepat")
        if mode not in MODE:
            raise beban.Ditolak(f"--mode harus {' / '.join(MODE)}")
        model, boleh = MODE[mode]
        skala = skala or (4 if mode == "kualitas" else 2)
        if skala not in boleh:
            raise beban.Ditolak(f"mode {mode} hanya skala {boleh}")
        sisi = sisi or (4096 if adalah_gambar else 1920)
        if not 256 <= sisi <= 4096:
            raise beban.Ditolak("--sisi harus 256..4096")
        beban.tunggu_ram()
        with beban.kunci_ai("perjelas"):
            hasil = gambar(masuk, keluar, model, skala, sisi) if adalah_gambar else video(masuk, keluar, model, skala, sisi)
        lap.update(status="selesai", mode=mode, model=model, skala=skala, **hasil)
        kode = 0
        beban.progres("selesai", 100, hasil["file"])
    except beban.Ditolak as e:
        lap["alasan"] = str(e)
        beban.progres("ditolak", 100, str(e))
        kode = 2
    keluar.mkdir(parents=True, exist_ok=True)
    (keluar / "perjelas.json").write_text(json.dumps(lap, ensure_ascii=False, indent=2), encoding="utf-8")
    return kode


def main() -> int:
    import argparse
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="upscale gambar/video (Real-ESRGAN ncnn-vulkan)")
    ap.add_argument("masuk")
    ap.add_argument("keluar")
    ap.add_argument("--mode", choices=tuple(MODE))
    ap.add_argument("--skala", type=int)
    ap.add_argument("--sisi", type=int)
    a = ap.parse_args()
    try:
        return jalankan(Path(a.masuk).resolve(), Path(a.keluar).resolve(), a.mode, a.skala, a.sisi)
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        beban.progres("gagal", 100, str(e)[:300])
        return 1


if __name__ == "__main__":
    sys.exit(main())
