"""Pisah Audio + Stem Splitter untuk satu batch di konten/.

Pakai (dari D:\\VIBECODING\\remotion):
  .venv\\Scripts\\python pipeline\\pisah.py 2026-11-13_video-winning      (CLI, tim di PC)
  .venv\\Scripts\\python pipeline\\pisah.py --job <job_dir>                (dari Motion Studio, `engine pisah`)

Membaca  konten/1-upload/<batch>/*.mp4|*.mov
Menulis  konten/2-dipisah/<batch>/video-bisu/<nama>.mp4   (tanpa suara, tanpa encode ulang)
         konten/2-dipisah/<batch>/audio-asli/<nama>.wav   (audio utuh)
         konten/2-dipisah/<batch>/vokal/<nama>.wav        (suara orang saja, Demucs)
         konten/2-dipisah/<batch>/musik/<nama>.wav        (musik/backsound saja, Demucs)
File yang sudah ada dilewati, jadi aman dijalankan ulang setelah tim menambah video.

Mode job (--job): job.json {"mode": "pisah", "batch", "video_saja"?, "shot_tiktok"?}.
  Sumber = file video di <job_dir>/masuk/ (diunggah app). Mesin menyalinnya ke konten/1-upload/<batch>,
  memisah, lalu membuat / melengkapi Shot Library (shots.json + thumbnail) untuk footage baru.
  Progres: satu JSON per baris di stdout {tahap, persen, pesan}. Hasil: <job_dir>/out/pisah.json.
  Kode keluar: 0 selesai, 2 ditolak, 1 gagal teknis (status + alasan di out/pisah.json, progres "ditolak"/"gagal").
  Duplikat unggahan dikenali dari sidik isi (bukan nama/ukuran). Tanpa GPU, Demucs otomatis memakai CPU.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "batch"))
from jalur import BATCH_PY as DEMUCS_PY, KONTEN, ROOT, dengan_akhiran, nama_aman, nama_unik  # noqa: E402  (Demucs + OpenCV; Windows/Linux)
MODEL = "htdemucs_ft"
EXT = {".mp4", ".mov"}
NAMA_BATCH = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def video_valid(path: Path) -> bool:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return res.returncode == 0 and bool(res.stdout.strip())


def has_audio(path: Path) -> bool:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return bool(res.stdout.strip())


def sidik(p: Path) -> str:
    """Sidik cepat isi file: ukuran + SHA-256 dari 4 MB awal dan 4 MB akhir (video besar tetap cepat)."""
    n = p.stat().st_size
    h = hashlib.sha256(str(n).encode())
    with p.open("rb") as f:
        h.update(f.read(4 << 20))
        if n > 8 << 20:
            f.seek(-(4 << 20), 2)
            h.update(f.read())
    return h.hexdigest()


_CUDA = None


def ada_cuda() -> bool:
    """GPU untuk Demucs tersedia? Dicek sekali lewat Python Demucs; tanpa GPU otomatis pakai CPU."""
    global _CUDA
    if _CUDA is None:
        r = subprocess.run([str(DEMUCS_PY), "-c", "import torch;print(torch.cuda.is_available())"],
                           capture_output=True, text=True)
        _CUDA = r.stdout.strip() == "True"
    return _CUDA


def _log(msg: str, job: bool) -> None:
    # Mode job: stdout khusus JSON-lines progres, pesan biasa ke stderr.
    print(msg, file=sys.stderr if job else sys.stdout, flush=True)


def pisah_batch(batch: str, video_saja=False, cpu=False, progres=None, job=False) -> list[dict]:
    """Pisahkan semua video di konten/1-upload/<batch>. Return [{file, video, vokal, musik}] (path absolut / None)."""
    progres = progres or (lambda *a: None)
    src_dir = KONTEN / "1-upload" / batch
    if not src_dir.is_dir():
        raise SystemExit(f"Folder tidak ada: {src_dir}")
    out = KONTEN / "2-dipisah" / batch
    dirs = {k: out / k for k in ("video-bisu", "audio-asli", "vokal", "musik")}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    sink = sys.stderr if job else None

    videos = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in EXT)
    # Unggahan lewat CLI bisa berisi spasi / nama panjang; Motion Studio hanya menerima [A-Za-z0-9_.-]{1,40}.
    # nama_unik: dua file berbeda tidak pernah jadi satu nama footage (tidak saling menimpa).
    nama = nama_unik([v.stem for v in videos])
    todo_stem = []
    for i, v in enumerate(videos):
        name = nama[v.stem]
        progres("pisah_video", 10 + int(30 * i / max(1, len(videos))), v.name)
        bisu = dirs["video-bisu"] / f"{name}.mp4"
        asli = dirs["audio-asli"] / f"{name}.wav"
        if not bisu.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(v), "-map", "0:v:0", "-c", "copy", "-an", str(bisu)],
                           check=True, stdout=sink)
        if video_saja or not has_audio(v):
            # --video-saja: audio footage tidak dipakai (mis. arahan dari belakang kamera); VO dari batch lain.
            _log(f"  ! {v.name}: {'audio tidak dipakai' if video_saja else 'tidak ada audio'}, hanya video bisu", job)
            continue
        if not asli.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(v), "-map", "0:a:0", "-c:a", "pcm_s16le", "-ar", "44100", str(asli)],
                           check=True, stdout=sink)
        if not (dirs["vokal"] / f"{name}.wav").exists() or not (dirs["musik"] / f"{name}.wav").exists():
            todo_stem.append(asli)

    _log(f"{len(videos)} video, {len(todo_stem)} perlu dipisah vokal/musik", job)
    if todo_stem:
        if not cpu and not ada_cuda():
            cpu = True
            _log("  ! GPU tidak tersedia: Demucs memakai CPU (lebih lambat)", job)
        progres("stem_splitter", 45, f"Demucs: {len(todo_stem)} audio ({'CPU' if cpu else 'GPU'})")
        tmp = tempfile.mkdtemp(dir=out, prefix="_demucs-")
        try:
            subprocess.run(
                [str(DEMUCS_PY), "-m", "demucs", "-n", MODEL, "--two-stems=vocals",
                 "-d", "cpu" if cpu else "cuda", "-o", tmp, *map(str, todo_stem)],
                check=True, stdout=sink,
            )
            for a in todo_stem:
                stem_dir = Path(tmp) / MODEL / a.stem
                shutil.move(str(stem_dir / "vocals.wav"), dirs["vokal"] / f"{a.stem}.wav")
                shutil.move(str(stem_dir / "no_vocals.wav"), dirs["musik"] / f"{a.stem}.wav")
        finally:
            # Windows kadang masih memegang folder sesaat (ENOTEMPTY); sisa folder sementara tidak boleh menggagalkan job.
            for _ in range(5):
                shutil.rmtree(tmp, ignore_errors=True)
                if not Path(tmp).exists():
                    break
                time.sleep(0.5)
    _log(f"Selesai -> {out}", job)

    def ada(p: Path):
        return str(p.resolve()).replace("\\", "/") if p.exists() else None

    return [{"file": v.name, "video": ada(dirs["video-bisu"] / f"{nama[v.stem]}.mp4"),
             "vokal": ada(dirs["vokal"] / f"{nama[v.stem]}.wav"), "musik": ada(dirs["musik"] / f"{nama[v.stem]}.wav")}
            for v in videos]


def jalankan_job(job_dir: Path) -> int:
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    def progres(tahap, persen, pesan=""):
        print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)

    def tolak(alasan: str) -> int:
        (out_dir / "pisah.json").write_text(json.dumps({"schema": "pisah/1", "status": "ditolak", "alasan": alasan},
                                                       ensure_ascii=False, indent=1), encoding="utf-8")
        progres("ditolak", 100, alasan)
        return 2

    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    if job.get("mode") != "pisah":
        return tolak("job.json bukan mode pisah")
    batch = str(job.get("batch", ""))
    if not NAMA_BATCH.match(batch) or ".." in batch:
        return tolak("nama batch hanya huruf, angka, _ . - (maks 80)")
    progres("cek_input", 2, batch)
    masuk = job_dir / "masuk"
    files = sorted(p for p in masuk.iterdir() if p.is_file() and p.suffix.lower() in EXT) if masuk.is_dir() else []
    # File rusak / bukan video tidak ikut disalin: dilaporkan per file, bukan menggagalkan job.
    file_ditolak = [{"file": f.name, "alasan": "bukan video yang bisa dibaca (rusak / format tidak dikenal)"}
                    for f in files if not video_valid(f)]
    files = [f for f in files if f.name not in {x["file"] for x in file_ditolak}]
    if file_ditolak and not files and not (KONTEN / "1-upload" / batch).is_dir():
        return tolak("semua unggahan rusak / bukan video: " + ", ".join(x["file"] for x in file_ditolak))
    upload = KONTEN / "1-upload" / batch
    if not files and not upload.is_dir():
        return tolak("tidak ada video (.mp4/.mov) di masuk/ dan batch belum ada")

    # Salin unggahan ke konten/1-upload/<batch>. Nama sama + isi beda = diberi akhiran -2, -3, ...
    upload.mkdir(parents=True, exist_ok=True)
    baru = []
    for i, f in enumerate(files):
        progres("salin", 2 + int(8 * i / max(1, len(files))), f.name)
        aman = nama_aman(f.stem)  # nama yang diterima Motion Studio (id footage/shot)
        tujuan = upload / f"{aman}{f.suffix.lower()}"
        n = 2
        sf = sidik(f)
        while tujuan.exists() and sidik(tujuan) != sf:
            tujuan = upload / f"{dengan_akhiran(aman, n)}{f.suffix.lower()}"
            n += 1
        if not tujuan.exists():
            shutil.copy2(f, tujuan)
        baru.append(tujuan.stem)

    hasil = pisah_batch(batch, bool(job.get("video_saja")), bool(job.get("cpu")), progres, job=True)

    # Shot Library untuk footage baru (sekalian di akhir pisah, supaya halaman Shot Library langsung punya data).
    progres("shot_library", 75, "membuat Shot Library + thumbnail")
    cmd = [str(DEMUCS_PY), str(ROOT / "pipeline" / "batch" / "shotlib.py"), batch]
    if job.get("shot_tiktok"):
        cmd.append("--tiktok")
    lib_path = KONTEN / "2-dipisah" / batch / "shots.json"
    if lib_path.exists():
        lama = set(json.loads(lib_path.read_text(encoding="utf-8"))["footage"])
        perlu = [s for s in dict.fromkeys(baru) if s not in lama]
        if not perlu:
            cmd = None  # semua footage sudah ada di Shot Library
        else:
            cmd += ["--hanya", *perlu]
    if cmd:
        subprocess.run(cmd, check=True, cwd=ROOT, stdout=sys.stderr)

    lib = json.loads(lib_path.read_text(encoding="utf-8")) if lib_path.exists() else {"shots": []}
    doc = {"schema": "pisah/1", "status": "selesai", "batch": batch, "dipisah_pada": int(time.time() * 1000),
           "video_saja": bool(job.get("video_saja")), "hasil": hasil, "file_ditolak": file_ditolak,
           "shot_library": str(lib_path.resolve()).replace("\\", "/") if lib_path.exists() else None,
           "jumlah_shot": len(lib["shots"])}
    (out_dir / "pisah.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    progres("selesai", 100, f"{len(hasil)} video, {doc['jumlah_shot']} shot")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch", nargs="?", help="nama folder di konten/1-upload/")
    ap.add_argument("--job", help="folder job dari Motion Studio (mode job)")
    ap.add_argument("--cpu", action="store_true", help="paksa Demucs pakai CPU")
    ap.add_argument("--video-saja", action="store_true",
                    help="hanya buat video bisu; audio tidak dipisah (audionya tidak akan dipakai)")
    args = ap.parse_args()
    if args.job:
        try:
            sys.exit(jalankan_job(Path(args.job)))
        except SystemExit:
            raise
        except Exception as e:  # gagal teknis: kode 1, runner boleh mencoba ulang
            traceback.print_exc()
            alasan = f"{type(e).__name__}: {e}"[:300]
            try:
                out = Path(args.job) / "out"
                out.mkdir(parents=True, exist_ok=True)
                (out / "pisah.json").write_text(json.dumps({"schema": "pisah/1", "status": "gagal", "alasan": alasan},
                                                           ensure_ascii=False, indent=1), encoding="utf-8")
            finally:
                print(json.dumps({"tahap": "gagal", "persen": 100, "pesan": alasan}, ensure_ascii=False), flush=True)
            sys.exit(1)
    if not args.batch:
        ap.error("butuh nama batch atau --job")
    pisah_batch(args.batch, args.video_saja, args.cpu)


if __name__ == "__main__":
    main()
