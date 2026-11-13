"""Render + normalisasi loudness + penomoran versi (versi lama tidak ditimpa).

Pakai:
  .venv\\Scripts\\python pipeline\\render.py out\\a3\\props.json --name aysilla_th_celana
  -> public\\Output\\aysilla_th_celana_v01.mp4 (lalu _v02, _v03, ...)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

TARGET_LUFS = -14
TRUE_PEAK = -1.0


OUTPUT_DIR = Path("public/Output")


def next_version(out_dir: Path, name: str) -> Path:
    nums = [int(m.group(1)) for p in out_dir.glob(f"{name}_v*.mp4") if (m := re.search(r"_v(\d+)\.mp4$", p.name))]
    return out_dir / f"{name}_v{(max(nums) + 1 if nums else 1):02d}.mp4"


def loudness(path: Path, extra: str = "") -> dict:
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af",
         f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK}:LRA=11{extra}:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return json.loads(re.findall(r"\{[^{}]*\}", res.stderr)[-1])


def job_public_dir(props_path: Path) -> Path:
    """Folder public/ khusus job ini: hanya file yang dipakai props (hardlink, tanpa
    salinan baru). Remotion menyalin seluruh public dir tiap render, jadi tanpa ini
    semua video mentah di public/masuk ikut tersalin dan render makin lambat."""
    props = json.loads(props_path.read_text(encoding="utf-8"))
    needed = {props["videoSrc"], props.get("logoSrc", ""), props.get("musicSrc", "")}
    needed |= {s["src"] for s in props.get("sfx", [])}
    dest = props_path.parent / "_public"
    shutil.rmtree(dest, ignore_errors=True)
    for rel in filter(None, needed):
        if re.match(r"^https?://", rel):
            continue
        src, dst = Path("public") / rel, dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("props")
    ap.add_argument("--name", required=True)
    ap.add_argument("--composition", default="AdVideo")
    ap.add_argument("--draf", action="store_true", help="render cepat setengah resolusi")
    args = ap.parse_args()

    props = Path(args.props)
    out_dir = props.parent
    # Video jadi dikumpulkan di satu folder; data kerja (json) tetap di out/<nama>/.
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    final = OUTPUT_DIR / f"{args.name}_draf.mp4" if args.draf else next_version(OUTPUT_DIR, args.name)
    raw = out_dir / f"_render_{final.stem}.mp4"
    quality = "--scale=0.5 --crf 23" if args.draf else "--crf 16"

    public = job_public_dir(props)
    t0 = time.perf_counter()
    subprocess.run(
        f'npx remotion render src/index.ts {args.composition} "{raw}" --props="{props}" '
        f'--public-dir="{public}" --codec h264 {quality}',
        shell=True, check=True,
    )
    render_sec = time.perf_counter() - t0

    # Loudnorm 2 tahap: ukur dulu, lalu terapkan dengan hasil ukur (lebih akurat).
    m = loudness(raw)
    measured = (
        f":measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
        f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-c:v", "copy",
         "-af", f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK}:LRA=11{measured}",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(final)],
        check=True,
    )
    raw.unlink()
    shutil.rmtree(public, ignore_errors=True)
    after = loudness(final)
    print(json.dumps({
        "file": str(final),
        "renderSec": round(render_sec, 1),
        "loudnessBefore": float(m["input_i"]),
        "loudnessAfter": float(after["input_i"]),
        "truePeakAfter": float(after["input_tp"]),
    }, indent=2))


if __name__ == "__main__":
    main()
