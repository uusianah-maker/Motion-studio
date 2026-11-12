"""Auto-cut: buang jeda, kata pengisi (eee/emm), dan take yang diulang.

Pakai:
  .venv\\Scripts\\python pipeline\\autocut.py data\\uji01\\transcript.json ^
      --video uji01.mp4 --keywords brands\\contoh\\keywords.json --out data\\uji01

Menulis:
  <out>/cuts.json   daftar potongan + alasan, untuk dicek manusia
  <out>/props.json  input untuk composition AdVideo (npx remotion render ... --props)
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

FPS = 30
MAX_GAP_MS = 300  # jeda lebih panjang dari ini dibuang
PAD_BEFORE_MS = 80  # ruang napas sebelum kata pertama tiap potongan
PAD_AFTER_MS = 120  # ruang napas setelah kata terakhir tiap potongan
TAIL_MS = 400  # ekor setelah kata terakhir video (CTA jangan kepotong)
LOW_PROB = 0.5  # kata dengan keyakinan Whisper di bawah ini ditandai ragu
SILENCE_DB = -35  # di bawah volume ini dianggap diam (suara rata-rata uji01: -29 dB)
MIN_SEG_MS = 250  # potongan lebih pendek dari ini dibuang (bikin kedip)

# "m" tunggal TIDAK termasuk: itu ukuran baju ("size M"). "mm"/"hmm" tetap pengisi.
FILLER_RE = re.compile(r"^(e+|e+m+|e+h+m+|hm+|mm+|u+m+|u+h+|a+h+m+)$")
RETAKE_CUES = {"ulang", "ulangi"}


def merge_split_words(words):
    """Whisper memecah kata ulang: "bener" + "-bener" -> "bener-bener"."""
    out = []
    for w in words:
        if out and w["text"].startswith("-"):
            prev = out[-1]
            prev["text"] += w["text"]
            prev["endMs"] = w["endMs"]
            prev["prob"] = min(prev["prob"], w["prob"])
        else:
            out.append(dict(w))
    return out


def norm(text: str) -> str:
    return re.sub(r"[^\w]+", "", text.lower())


def ends_sentence(text: str) -> bool:
    return bool(re.search(r"[.?!]$", text.strip()))


def mark_removals(words):
    """Isi words[i]['cut'] = alasan (atau None kalau dipakai)."""
    for w in words:
        # "forced": potongan yang dipilih user (edit.py --buang), selalu dibuang.
        w["cut"] = w.get("forced")
        w["doubt"] = None

    n = len(words)

    # 1. Kata pengisi.
    for w in words:
        if FILLER_RE.match(norm(w["text"])):
            w["cut"] = "pengisi"

    # 2. Isyarat take ulang ("eh bentar, ulang"): buang dari awal kalimat yang
    #    gagal sampai isyaratnya.
    for k, w in enumerate(words):
        if norm(w["text"]) not in RETAKE_CUES:
            continue
        start = k
        while start > 0:
            prev = words[start - 1]
            if ends_sentence(prev["text"]) or words[start]["startMs"] - prev["endMs"] > 700:
                break
            start -= 1
        for j in range(start, k + 1):
            words[j]["cut"] = "take ulang (isyarat)"
        words[k]["doubt"] = "take ulang: cek awal kalimat yang dibuang sudah pas"

    # 3. Kalimat diulang tanpa isyarat: 3 kata berurutan yang muncul lagi tak
    #    lama kemudian -> buang versi pertama (pakai take terakhir).
    kept = [i for i in range(n) if words[i]["cut"] is None]
    for a in range(len(kept) - 2):
        i = kept[a]
        if words[i]["cut"]:
            continue
        gram = [norm(words[kept[a + t]]["text"]) for t in range(3)]
        if sum(len(g) for g in gram) < 8:
            continue
        for b in range(a + 3, min(a + 30, len(kept) - 2)):
            j = kept[b]
            if words[j]["startMs"] - words[i]["startMs"] > 12000:
                break
            if [norm(words[kept[b + t]]["text"]) for t in range(3)] == gram:
                for x in kept[a:b]:
                    if words[x]["cut"] is None:
                        words[x]["cut"] = "take ulang (kalimat diulang)"
                words[j]["doubt"] = (
                    f"kalimat diulang: versi pertama ({words[i]['startMs']/1000:.2f}s) dibuang"
                )
                break

    # 4. Tanda ragu: kata yang Whisper sendiri tidak yakin.
    for w in words:
        if w["cut"] is None and w["prob"] < LOW_PROB and not w["doubt"]:
            w["doubt"] = f"Whisper kurang yakin ({w['prob']:.2f})"


def build_segments(words, duration_ms):
    """Gabungkan kata yang dipakai jadi potongan sumber [startMs, endMs)."""
    segs = []
    prev_kept = None
    for idx, w in enumerate(words):
        if w["cut"]:
            continue
        removed_between = prev_kept is not None and any(
            words[x]["cut"] for x in range(prev_kept + 1, idx)
        )
        gap = None if prev_kept is None else w["startMs"] - words[prev_kept]["endMs"]
        if prev_kept is None or removed_between or gap > MAX_GAP_MS:
            segs.append({"first": idx, "last": idx})
        else:
            segs[-1]["last"] = idx
        prev_kept = idx

    out = []
    for s_i, s in enumerate(segs):
        first, last = words[s["first"]], words[s["last"]]
        # Jangan sampai padding memakan kata yang dibuang di sebelahnya.
        lo = words[s["first"] - 1]["endMs"] if s["first"] > 0 else 0
        hi = words[s["last"] + 1]["startMs"] if s["last"] + 1 < len(words) else duration_ms
        is_last = s_i == len(segs) - 1
        start = max(lo, first["startMs"] - PAD_BEFORE_MS)
        end = min(hi, last["endMs"] + (TAIL_MS if is_last else PAD_AFTER_MS))
        out.append({"srcStartMs": start, "srcEndMs": end, "first": s["first"], "last": s["last"]})
    return out


def detect_silences(video_path: str, noise_db: float, min_ms: int):
    """Jeda dari volume audio (Whisper suka melebarkan kata sampai menutupi jeda)."""
    res = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-i", video_path,
            "-af", f"silencedetect=noise={noise_db}dB:d={min_ms / 1000}",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out = []
    for m in re.finditer(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", res.stderr):
        end = float(m.group(1)) * 1000
        out.append((round(end - float(m.group(2)) * 1000), round(end)))
    return out


def subtract_silences(segs, silences):
    """Potong bagian diam di dalam potongan, sisakan padding di kedua sisi."""
    result = [dict(s) for s in segs]
    for s_start, s_end in silences:
        cut_from, cut_to = s_start + PAD_AFTER_MS, s_end - PAD_BEFORE_MS
        if cut_to - cut_from <= 0:
            continue
        nxt = []
        for seg in result:
            a, b = seg["srcStartMs"], seg["srcEndMs"]
            if cut_to <= a or cut_from >= b:
                nxt.append(seg)
                continue
            if cut_from - a >= MIN_SEG_MS:
                nxt.append({"srcStartMs": a, "srcEndMs": cut_from, "why": "jeda (audio)"})
            if b - cut_to >= MIN_SEG_MS:
                nxt.append({"srcStartMs": cut_to, "srcEndMs": b, "why": "jeda (audio)"})
        result = nxt
    return result


def run_cut(tr, words=None):
    """Jalankan auto-cut. Kembalikan potongan, peta waktu, caption, dan laporan.

    `words` boleh diberikan kalau teks sudah dikoreksi (kamus brand)."""
    words = merge_split_words(tr["words"]) if words is None else words
    mark_removals(words)
    segs = build_segments(words, tr["durationMs"])
    silences = detect_silences(tr["source"], SILENCE_DB, MAX_GAP_MS)
    segs = subtract_silences(segs, [s for s in silences if s[1] - s[0] > MAX_GAP_MS])

    # Snap ke frame (30 fps). Potongan yang bersentuhan digabung.
    segments = []
    for s in segs:
        sf = int(s["srcStartMs"] * FPS // 1000)
        ef = -(-s["srcEndMs"] * FPS // 1000)  # ceil
        if segments and sf <= segments[-1]["endFrame"]:
            segments[-1]["endFrame"] = max(segments[-1]["endFrame"], ef)
        else:
            segments.append({"startFrame": sf, "endFrame": ef})

    seg_out = []
    acc = 0
    for s in segments:
        seg_out.append(acc)
        acc += s["endFrame"] - s["startFrame"]
    out_frame = acc

    def to_out(ms: float, prefer_next: bool = True) -> float:
        """Waktu sumber (ms) -> waktu hasil edit (ms)."""
        for k, s in enumerate(segments):
            a, b = s["startFrame"] * 1000 / FPS, s["endFrame"] * 1000 / FPS
            if a <= ms < b:
                return seg_out[k] * 1000 / FPS + (ms - a)
            if ms < a:  # jatuh di bagian yang dibuang
                if prefer_next or k == 0:
                    return seg_out[k] * 1000 / FPS
                return seg_out[k] * 1000 / FPS - 1
        return out_frame * 1000 / FPS

    captions = []
    for i, w in enumerate(words):
        if w["cut"]:
            continue
        start = to_out(w["startMs"], prefer_next=True)
        end = max(to_out(w["endMs"], prefer_next=False), start + 120)
        captions.append(
            {
                "text": w["text"],
                "startMs": round(start),
                "endMs": round(end),
                "timestampMs": None,
                "confidence": w["prob"],
                "_word": i,
            }
        )

    removed = []
    cursor = 0
    for s in segments:
        s_ms = s["startFrame"] * 1000 / FPS
        if s_ms - cursor > 0:
            gone = [w for w in words if w["startMs"] >= cursor and w["endMs"] <= s_ms + 40]
            reasons = sorted({w["cut"] for w in gone if w["cut"]}) or ["jeda"]
            removed.append(
                {
                    "fromSec": round(cursor / 1000, 2),
                    "toSec": round(s_ms / 1000, 2),
                    "reason": ", ".join(reasons),
                    "text": " ".join(w["text"] for w in gone if w["cut"]),
                }
            )
        cursor = s["endFrame"] * 1000 / FPS
    if tr["durationMs"] - cursor > 0:
        removed.append(
            {
                "fromSec": round(cursor / 1000, 2),
                "toSec": round(tr["durationMs"] / 1000, 2),
                "reason": "hening di akhir",
                "text": "",
            }
        )

    doubts = [
        {"atSec": round(w["startMs"] / 1000, 2), "word": w["text"], "note": w["doubt"]}
        for w in words
        if w["doubt"]
    ]
    return {
        "words": words,
        "segments": segments,
        "to_out": to_out,
        "captions": captions,
        "removed": removed,
        "doubts": doubts,
        "videoMs": out_frame * 1000 / FPS,
    }


def strip_internal(captions):
    return [{k: v for k, v in c.items() if not k.startswith("_")} for c in captions]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--video", required=True, help="path relatif ke public/")
    ap.add_argument("--keywords", required=True)
    ap.add_argument("--logo", default="logo.svg")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-seconds", type=float, default=30)
    ap.add_argument("--outro-seconds", type=float, default=2.5)
    args = ap.parse_args()

    tr = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
    res = run_cut(tr)
    video_sec = res["videoMs"] / 1000
    total_sec = video_sec + args.outro_seconds
    keywords = json.loads(Path(args.keywords).read_text(encoding="utf-8"))["keywords"]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "source": tr["source"],
        "originalSec": round(tr["durationMs"] / 1000, 2),
        "editedVideoSec": round(video_sec, 2),
        "totalWithOutroSec": round(total_sec, 2),
        "overMax": total_sec > args.max_seconds,
        "keptSegments": len(res["segments"]),
        "removed": res["removed"],
        "doubts": res["doubts"],
        "transcript": " ".join(w["text"] for w in res["words"]),
        "finalText": " ".join(c["text"] for c in res["captions"]),
    }
    (out_dir / "cuts.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    props = {
        "videoSrc": args.video,
        "segments": res["segments"],
        "captions": strip_internal(res["captions"]),
        "keywords": keywords,
        "logoSrc": args.logo,
        "outroTagline": "",
        "outroSeconds": args.outro_seconds,
        "maxWordsPerPage": 3,
        "maxDurationSeconds": args.max_seconds,
    }
    (out_dir / "props.json").write_text(json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Durasi: {report['originalSec']}s -> {report['editedVideoSec']}s (+outro = {total_sec:.2f}s)")
    print(f"Potongan dipakai: {len(res['segments'])}, bagian dibuang: {len(res['removed'])}")
    for r in res["removed"]:
        print(f"  - {r['fromSec']:>6.2f}-{r['toSec']:<6.2f} {r['reason']}: {r['text']}")
    if report["overMax"]:
        print(f"!! Masih lebih dari {args.max_seconds}s. Tidak dipotong otomatis, cek manual.")
    for d in res["doubts"]:
        print(f"  ? {d['atSec']}s '{d['word']}': {d['note']}")


if __name__ == "__main__":
    main()
