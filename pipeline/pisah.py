"""Pisah Audio + Stem Splitter untuk satu batch di konten/.

Pakai (dari D:\\VIBECODING\\remotion):
  .venv\\Scripts\\python pipeline\\pisah.py 2026-11-13_video-winning

Membaca  konten/1-upload/<batch>/*.mp4|*.mov
Menulis  konten/2-dipisah/<batch>/video-bisu/<nama>.mp4   (tanpa suara, tanpa encode ulang)
         konten/2-dipisah/<batch>/audio-asli/<nama>.wav   (audio utuh)
         konten/2-dipisah/<batch>/vokal/<nama>.wav        (suara orang saja, Demucs)
         konten/2-dipisah/<batch>/musik/<nama>.wav        (musik/backsound saja, Demucs)
File yang sudah ada dilewati, jadi aman dijalankan ulang setelah tim menambah video.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

KONTEN = Path("konten")
DEMUCS_PY = Path(r"D:\VIBECODING\tools\demucs-venv\Scripts\python.exe")
MODEL = "htdemucs_ft"


def has_audio(path: Path) -> bool:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return bool(res.stdout.strip())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch", help="nama folder di konten/1-upload/")
    ap.add_argument("--cpu", action="store_true", help="paksa Demucs pakai CPU")
    args = ap.parse_args()

    src_dir = KONTEN / "1-upload" / args.batch
    if not src_dir.is_dir():
        sys.exit(f"Folder tidak ada: {src_dir}")
    out = KONTEN / "2-dipisah" / args.batch
    dirs = {k: out / k for k in ("video-bisu", "audio-asli", "vokal", "musik")}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    videos = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in {".mp4", ".mov"})
    todo_stem = []
    for v in videos:
        name = v.stem
        bisu = dirs["video-bisu"] / f"{name}.mp4"
        asli = dirs["audio-asli"] / f"{name}.wav"
        if not bisu.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(v), "-map", "0:v:0", "-c", "copy", "-an", str(bisu)], check=True)
        if not has_audio(v):
            print(f"  ! {v.name}: tidak ada audio, hanya video bisu")
            continue
        if not asli.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(v), "-map", "0:a:0", "-c:a", "pcm_s16le", "-ar", "44100", str(asli)], check=True)
        if not (dirs["vokal"] / f"{name}.wav").exists() or not (dirs["musik"] / f"{name}.wav").exists():
            todo_stem.append(asli)

    print(f"{len(videos)} video, {len(todo_stem)} perlu dipisah vokal/musik")
    if todo_stem:
        with tempfile.TemporaryDirectory(dir=out) as tmp:
            subprocess.run(
                [str(DEMUCS_PY), "-m", "demucs", "-n", MODEL, "--two-stems=vocals",
                 "-d", "cpu" if args.cpu else "cuda", "-o", tmp, *map(str, todo_stem)],
                check=True,
            )
            for a in todo_stem:
                stem_dir = Path(tmp) / MODEL / a.stem
                shutil.move(str(stem_dir / "vocals.wav"), dirs["vokal"] / f"{a.stem}.wav")
                shutil.move(str(stem_dir / "no_vocals.wav"), dirs["musik"] / f"{a.stem}.wav")
    print(f"Selesai -> {out}")


if __name__ == "__main__":
    main()
