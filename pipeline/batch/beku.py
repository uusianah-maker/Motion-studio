"""Tandai shot yang gambarnya DIAM/BEKU (venus, 14 Nov 2026).

Pemicu: KORSET varian-001 terlihat "nge-freeze" 2x — footage A_18 sendiri diam ±1,9 dtk (2,3–4,2 dtk) dan
Batch Remix memakai potongan itu. Shot Library sudah menandai `buram`, tapi belum `beku`.

- `rentang_beku(video)`: rentang diam (detik) dengan ffmpeg freezedetect (perubahan < 0,3% selama >= 0,4 dtk).
- shot ditandai `"beku": true` kalau >= 30% durasinya (atau >= 0,6 dtk) jatuh di rentang diam.
  Matcher tidak memakai shot beku (sama seperti buram).

Batch lama: .venv\\Scripts\\python pipeline\\batch\\beku.py <batch>   (menambah field `beku`, tanpa analisis ulang)
"""

import json
import re
import subprocess
import sys
from pathlib import Path

AMBANG_NOISE = 0.003
MIN_DIAM_DTK = 0.4


def rentang_beku(video: Path) -> list[tuple[float, float]]:
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(video), "-an", "-vf",
                        f"freezedetect=n={AMBANG_NOISE}:d={MIN_DIAM_DTK}", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    mulai = [float(x) for x in re.findall(r"freeze_start: ([0-9.]+)", r.stderr)]
    akhir = [float(x) for x in re.findall(r"freeze_end: ([0-9.]+)", r.stderr)]
    if len(akhir) < len(mulai):  # diam sampai akhir video
        dur = re.search(r"Duration: (\d+):(\d+):([0-9.]+)", r.stderr)
        total = int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3]) if dur else mulai[-1] + MIN_DIAM_DTK
        akhir.append(total)
    return list(zip(mulai, akhir))


def shot_beku(dari: float, sampai: float, rentang: list[tuple[float, float]]) -> bool:
    kena = sum(max(0.0, min(sampai, b) - max(dari, a)) for a, b in rentang)
    return kena >= 0.6 or kena >= 0.3 * max(sampai - dari, 1e-6)


def tandai(lib: dict, video_per_footage: dict[str, Path]) -> int:
    """Isi field `beku` di semua shot. Kembalikan jumlah shot beku."""
    cache: dict[str, list] = {}
    n = 0
    for s in lib.get("shots", []):
        fid = s["footage"]
        if fid not in cache:
            v = video_per_footage.get(fid)
            cache[fid] = rentang_beku(v) if v and Path(v).is_file() else []
        if "beku" in (s.get("koreksi") or {}):  # koreksi tim menang
            s["beku"] = bool(s["koreksi"]["beku"])
        else:
            s["beku"] = shot_beku(s["dari"], s["sampai"], cache[fid])
        n += s["beku"]
    return n


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    batch = sys.argv[1]
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from jalur import DATA, KONTEN  # R20: folder data MOTION_ENGINE_DATA, bawaan = repo
    batch_dir = KONTEN / "2-dipisah" / batch
    lib_path = batch_dir / "shots.json"
    lib = json.loads(lib_path.read_text(encoding="utf-8"))
    video = {fid: (Path(f["video"]) if Path(f["video"]).is_absolute() else DATA / f["video"])
             for fid, f in lib.get("footage", {}).items() if isinstance(f, dict) and f.get("video")}
    n = tandai(lib, video)
    lib_path.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{batch}: {n} dari {len(lib.get('shots', []))} shot ditandai beku")


if __name__ == "__main__":
    main()
