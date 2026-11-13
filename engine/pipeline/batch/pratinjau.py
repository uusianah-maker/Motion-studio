"""Pratinjau kasar satu varian Batch Remix (540x960, tanpa caption/efek) untuk mengecek rencana.

BUKAN render final: render tetap di Motion Studio setelah rencana disetujui. Alat ini hanya merakit
klip video + VO + musik dari ops.json supaya pilihan shot, sinkron bibir, dan musik bisa ditonton.

Pakai:
  .venv\\Scripts\\python pipeline\\batch\\pratinjau.py <job_dir> varian-001 [varian-002 ...]
  --blur  terapkan juga kotak blur usulan (watermark, footer, teks bawaan) untuk dicek
Hasil: <job_dir>/out/<varian>/pratinjau.mp4 (atau pratinjau_blur.mp4)
"""

import json
import subprocess
import sys
from pathlib import Path

W, H = 540, 960


def _blur_chain(label_in: str, label_out: str, boxes: list[dict], in_s: float, i: int) -> list[str]:
    """Kotak blur (pecahan frame, waktu sumber) -> filter crop+boxblur+overlay per klip."""
    if not boxes:
        return [f"[{label_in}]null[{label_out}]"]
    parts = [f"[{label_in}]split={len(boxes) + 1}[b{i}_0]" + "".join(f"[s{i}_{j}]" for j in range(len(boxes)))]
    prev = f"b{i}_0"
    for j, b in enumerate(boxes):
        x, y = int(b["x"] * W) // 2 * 2, int(b["y"] * H) // 2 * 2
        w = min(max(8, int(b["w"] * W) // 2 * 2), W - x)
        h = min(max(8, int(b["h"] * H) // 2 * 2), H - y)
        r = max(1, min(12, w // 4 - 1, h // 4 - 1))
        t0, t1 = b["dari_ms"] / 1000 - in_s, b["sampai_ms"] / 1000 - in_s
        nxt = label_out if j == len(boxes) - 1 else f"b{i}_{j + 1}"
        parts.append(f"[s{i}_{j}]crop={w}:{h}:{x}:{y},boxblur={r}:3[k{i}_{j}]")
        parts.append(f"[{prev}][k{i}_{j}]overlay={x}:{y}:enable='between(t,{t0:.3f},{t1:.3f})'[{nxt}]")
        prev = nxt
    return parts


def rakit(job_dir: Path, vid: str, blur: bool = False) -> Path:
    media = json.loads((job_dir / "out" / "batch.json").read_text(encoding="utf-8"))["media"]
    rencana = json.loads((job_dir / "out" / vid / "rencana.json").read_text(encoding="utf-8"))
    blur_at = {round(x["start"], 3): x["blur"] for x in rencana["batch"]["blur_usulan"]} if blur else {}
    ops = json.loads((job_dir / "out" / vid / "ops.json").read_text(encoding="utf-8"))["ops"]
    clips = [o for o in ops if o["op"] == "add_clip"]
    video = sorted((o for o in clips if o["track_kind"] == "video"), key=lambda o: o["start_ms"])
    audio = [o for o in clips if o["track_kind"] in ("audio", "music")]
    au = rencana.get("audio", {})
    if au.get("musik") and not any(o["track_kind"] == "music" for o in clips):
        # Mode kompat: musik belum di ops (menunggu U3), tapi tetap diperdengarkan di pratinjau.
        media = {**media, au["musik"]: au["musik_path"]}
        total = max(o["start_ms"] + o["duration_ms"] for o in video)
        audio.append({"media": au["musik"], "start_ms": 0, "duration_ms": total, "in_ms": 0, "volume": au["musik_volume"]})
    args, fc = ["ffmpeg", "-v", "error", "-y"], []
    for i, o in enumerate(video):
        args += ["-ss", f"{o['in_ms'] / 1000:.3f}", "-t", f"{o['duration_ms'] / 1000:.3f}", "-i", media[o["media"]]]
        fc.append(f"[{i}:v]scale={W}:{H},setsar=1,fps=30,trim=duration={o['duration_ms'] / 1000:.3f},"
                  f"setpts=PTS-STARTPTS[r{i}]")
        fc += _blur_chain(f"r{i}", f"v{i}", blur_at.get(round(o["start_ms"] / 1000, 3), []), o["in_ms"] / 1000, i)
    n = len(video)
    fc.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]")
    for j, o in enumerate(audio):
        k = n + j
        args += ["-ss", f"{o['in_ms'] / 1000:.3f}", "-t", f"{o['duration_ms'] / 1000:.3f}", "-i", media[o["media"]]]
        fc.append(f"[{k}:a]aresample=48000,volume={o.get('volume', 1.0)},adelay={o['start_ms']}|{o['start_ms']}[a{j}]")
    fc.append("".join(f"[a{j}]" for j in range(len(audio))) + f"amix=inputs={len(audio)}:normalize=0,"
              "loudnorm=I=-14:TP=-1:LRA=11[a]")
    out = job_dir / "out" / vid / ("pratinjau_blur.mp4" if blur else "pratinjau.mp4")
    args += ["-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "26",
             "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", "-shortest", str(out)]
    subprocess.run(args, check=True)
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--blur"]
    if len(args) < 2:
        raise SystemExit(__doc__)
    for v in args[1:]:
        print(rakit(Path(args[0]), v, blur="--blur" in sys.argv))
