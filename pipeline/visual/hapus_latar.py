"""R24d Background remover: BiRefNet-lite (MIT) via onnxruntime CPU, file model RESMI (ZhengPeng7 rilis v1).

  python pipeline/visual/hapus_latar.py <masuk> <folder_keluar> [--model birefnet-general-lite] [--fps 10]

- Gambar (.jpg/.png/.webp): <folder_keluar>/<nama>.png RGBA (+ <nama>-masker.png).
- Video (maks 15 dtk, §18.0): masker per frame pada `--fps` (bawaan 10; 1..30) ->
    <nama>-alpha.webm  (VP9 + alpha, yuva420p) untuk ditumpuk di editor,
    <nama>-masker.mp4  (abu-abu: putih = subjek) untuk alphamerge di render FFmpeg.
- Tanpa rembg runtime download: rembg mengunduh dari mirror (danielgatis), bukan sumber resmi, jadi inferensi
  BiRefNet ditulis langsung di sini (resize 1024, normalisasi ImageNet, sigmoid). Model lain di daftar putih
  (beban.MODEL_LATAR) belum dipasang -> ditolak sampai venus OK unduhannya.
- Lambat di CPU (±13 dtk/frame di PC kantor): perkiraan waktu diukur dari frame pertama dan dikirim sebelum lanjut.
  Kunci AI global, Idle, 4 thread, tunggu RAM >= 3 GB.
- Hasil = USULAN (hybrid): app menampilkannya sebagai layer yang bisa dimatikan; klip asli tidak diubah.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import beban  # noqa: E402

beban.siapkan_env()

import json  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

FILE_MODEL = {"birefnet-general-lite": "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"}
SHA256 = {"birefnet-general-lite": "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333"}
SISI = 1024
GAMBAR = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
IDLE = 0x40


class Model:
    def __init__(self, nama: str):
        import onnxruntime as ort
        nama = beban.model_latar(nama)
        if nama not in FILE_MODEL:
            raise beban.Ditolak(f"model '{nama}' diizinkan lisensinya tetapi belum dipasang (unduhan perlu OK venus)")
        p = beban.FOLDER_MODEL / FILE_MODEL[nama]
        if not p.exists():
            raise RuntimeError(f"file model tidak ada: {p}")
        so = ort.SessionOptions()
        so.intra_op_num_threads = beban.MAKS_THREAD
        so.inter_op_num_threads = 1
        self.s = ort.InferenceSession(str(p), so, providers=["CPUExecutionProvider"])
        self.inp = self.s.get_inputs()[0].name
        self.nama = nama

    def masker(self, rgb):
        """rgb: PIL.Image RGB -> PIL.Image L (0..255, ukuran sama)."""
        import numpy as np
        from PIL import Image
        x = np.asarray(rgb.resize((SISI, SISI), Image.BILINEAR), dtype=np.float32) / 255.0
        x = ((x - (0.485, 0.456, 0.406)) / (0.229, 0.224, 0.225)).transpose(2, 0, 1)[None].astype(np.float32)
        y = self.s.run(None, {self.inp: x})[0][0, 0]
        m = 1.0 / (1.0 + np.exp(-y))
        return Image.fromarray((m * 255).clip(0, 255).astype(np.uint8)).resize(rgb.size, Image.BILINEAR)


def sha256(p: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def probe(video: Path) -> tuple[float, float]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=avg_frame_rate:format=duration", "-of", "json", str(video)],
                       capture_output=True, text=True, creationflags=IDLE)
    if r.returncode != 0:
        raise beban.Ditolak(f"bukan video yang terbaca: {video.name}")
    d = json.loads(r.stdout)
    st = (d.get("streams") or [{}])[0]
    a, _, b = (st.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(a) / float(b or 1) if float(b or 1) else 30.0
    return float(d.get("format", {}).get("duration", 0)), fps


def ffmpeg(args: list[str]) -> None:
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, creationflags=IDLE)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg gagal: {r.stderr[-300:]}")


def gambar(m: Model, masuk: Path, keluar: Path, progres=beban.progres) -> dict:
    from PIL import Image
    beban.perkiraan("hapus_latar", 15)
    im = Image.open(masuk).convert("RGB")
    t = time.monotonic()
    mk = m.masker(im)
    o = im.copy()
    o.putalpha(mk)
    keluar.mkdir(parents=True, exist_ok=True)
    f, fm = keluar / f"{masuk.stem}.png", keluar / f"{masuk.stem}-masker.png"
    o.save(f)
    mk.save(fm)
    return {"jenis": "gambar", "file": f.name, "masker": fm.name, "lebar": im.width, "tinggi": im.height,
            "detik_proses": round(time.monotonic() - t, 1)}


def video(m: Model, masuk: Path, keluar: Path, fps: float, progres=beban.progres) -> dict:
    from PIL import Image
    durasi, fps_asli = probe(masuk)
    beban.cek_durasi_klip(durasi)
    fps = min(fps, fps_asli)
    keluar.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="latar-", dir=keluar))
    try:
        (tmp / "f").mkdir()
        (tmp / "a").mkdir()
        (tmp / "m").mkdir()
        ffmpeg(["-i", str(masuk), "-an", "-vf", f"fps={fps}", str(tmp / "f" / "%05d.png")])
        frames = sorted((tmp / "f").glob("*.png"))
        if not frames:
            raise beban.Ditolak("video tanpa frame")
        mulai = time.monotonic()
        for i, fp in enumerate(frames):
            im = Image.open(fp).convert("RGB")
            mk = m.masker(im)
            o = im.copy()
            o.putalpha(mk)
            o.save(tmp / "a" / fp.name)
            mk.save(tmp / "m" / fp.name)
            if i == 0:  # perkiraan dari frame pertama yang benar-benar diukur
                per = time.monotonic() - mulai
                beban.perkiraan("hapus_latar", per * len(frames) + 10,
                                f"{len(frames)} frame x {per:.0f} dtk = perkiraan ±{max(1, round(per * len(frames) / 60))} menit")
            progres("hapus_latar", 5 + int(85 * (i + 1) / len(frames)), f"frame {i + 1}/{len(frames)}")
        fa, fm = keluar / f"{masuk.stem}-alpha.webm", keluar / f"{masuk.stem}-masker.mp4"
        progres("encode", 92, "menyusun video alpha")
        ffmpeg(["-framerate", f"{fps}", "-i", str(tmp / "a" / "%05d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                "-b:v", "0", "-crf", "30", "-auto-alt-ref", "0", "-threads", str(beban.MAKS_THREAD), str(fa)])
        ffmpeg(["-framerate", f"{fps}", "-i", str(tmp / "m" / "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-crf", "18", "-threads", str(beban.MAKS_THREAD), str(fm)])
        return {"jenis": "video", "file": fa.name, "masker": fm.name, "fps": round(fps, 3), "frame": len(frames),
                "durasi": round(durasi, 3), "detik_proses": round(time.monotonic() - mulai, 1)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def jalankan(masuk: Path, keluar: Path, model: str | None, fps: float) -> int:
    lap = {"schema": "hapus-latar/1", "status": "ditolak", "usulan": True, "masuk": masuk.name}
    try:
        if not masuk.exists():
            raise beban.Ditolak(f"file tidak ada: {masuk.name}")
        if not 1 <= fps <= 30:
            raise beban.Ditolak("--fps harus 1..30")
        beban.model_latar(model)  # daftar putih dulu, sebelum memuat apa pun
        beban.tunggu_ram()
        with beban.kunci_ai("hapus_latar"):
            m = Model(model or beban.MODEL_LATAR_BAWAAN)
            lap.update(model=m.nama, lisensi=beban.MODEL_LATAR[m.nama])
            hasil = gambar(m, masuk, keluar) if masuk.suffix.lower() in GAMBAR else video(m, masuk, keluar, fps)
        lap.update(status="selesai", **hasil)
        kode = 0
        beban.progres("selesai", 100, hasil["file"])
    except beban.Ditolak as e:
        lap["alasan"] = str(e)
        beban.progres("ditolak", 100, str(e))
        kode = 2
    keluar.mkdir(parents=True, exist_ok=True)
    (keluar / "hapus_latar.json").write_text(json.dumps(lap, ensure_ascii=False, indent=2), encoding="utf-8")
    return kode


def main() -> int:
    import argparse
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="hapus latar gambar/video (BiRefNet-lite, CPU)")
    ap.add_argument("masuk")
    ap.add_argument("keluar")
    ap.add_argument("--model", default=beban.MODEL_LATAR_BAWAAN)
    ap.add_argument("--fps", type=float, default=10.0)
    a = ap.parse_args()
    try:
        return jalankan(Path(a.masuk).resolve(), Path(a.keluar).resolve(), a.model, a.fps)
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        beban.progres("gagal", 100, str(e)[:300])
        return 1


if __name__ == "__main__":
    sys.exit(main())
