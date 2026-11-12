"""Transkrip per kata pakai faster-whisper (lokal; GPU NVIDIA kalau ada, selain itu CPU).

Pakai:
  .venv\\Scripts\\python pipeline\\transcribe.py public\\uji01.mp4 data\\uji01\\transcript.json

Hasil: JSON berisi daftar kata dengan waktu mulai/selesai (ms) relatif ke awal file sumber.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np


def _add_cuda_dlls() -> None:
    """Library CUDA dari pip (nvidia-cublas-cu12, nvidia-cudnn-cu12) ada di
    site-packages/nvidia/*/bin; Windows tidak mencarinya otomatis."""
    for sp in map(Path, sys.path):
        nv = sp / "nvidia"
        if nv.is_dir():
            for b in nv.glob("*/bin"):
                os.environ["PATH"] = str(b) + os.pathsep + os.environ["PATH"]
                os.add_dll_directory(str(b))


_add_cuda_dlls()
from faster_whisper import WhisperModel  # noqa: E402

# Prompt awal mendorong Whisper ikut menulis kata pengisi (eee/emm) dan kalimat
# yang diulang, supaya auto-cut bisa membuangnya. Tanpa ini Whisper cenderung
# "merapikan" ucapan dan menyembunyikan jeda di dalam durasi kata.
INITIAL_PROMPT = "Eee, jadi... emm, ini tuh, eh bentar, ulang. Jadi ini tuh bagus banget."


def load_audio(path: str) -> np.ndarray:
    """Decode ke 16 kHz mono float32 lewat ffmpeg (PyAV versi baru tidak cocok
    dengan decoder bawaan faster-whisper)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def load_model(name: str, device: str):
    """GPU kalau bisa; kalau library CUDA belum ada atau gagal, jatuh ke CPU.

    int8_float16, bukan float16: di GTX 1650 (diukur 11 Nov 2026, a3 27 dtk)
    float16 11,3 dtk vs int8_float16 3,5 dtk; CPU int8 12,6 dtk."""
    if device in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                model = WhisperModel(name, device="cuda", compute_type="int8_float16")
                # Uji kecil: error DLL baru muncul saat model benar-benar dipakai.
                list(model.transcribe(np.zeros(16000, dtype=np.float32), language="id")[0])
                return model, "cuda"
        except Exception as e:  # noqa: BLE001
            if device == "cuda":
                raise
            print(f"(GPU tidak bisa dipakai, pakai CPU: {e})")
    return WhisperModel(name, device="cpu", compute_type="int8"), "cpu"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("out")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default="id")
    ap.add_argument("--brandkit", help="brand kit JSON; kosakata_whisper dipakai sebagai petunjuk")
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    args = ap.parse_args()

    vocab = []
    if args.brandkit:
        vocab = json.loads(Path(args.brandkit).read_text(encoding="utf-8")).get("kosakata_whisper", [])
    prompt = INITIAL_PROMPT + (" " + ", ".join(vocab) + "." if vocab else "")

    t0 = time.perf_counter()
    model, device = load_model(args.model, args.device)
    t_load = time.perf_counter() - t0

    t1 = time.perf_counter()
    segments, info = model.transcribe(
        load_audio(args.source),
        language=args.language,
        word_timestamps=True,
        initial_prompt=prompt,
        hotwords=", ".join(vocab) or None,
        condition_on_previous_text=False,
        vad_filter=False,  # jeda harus tetap terlihat di timestamp
        beam_size=5,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append(
                {
                    "text": w.word.strip(),
                    "startMs": round(w.start * 1000),
                    "endMs": round(w.end * 1000),
                    "prob": round(w.probability, 3),
                }
            )
    t_tr = time.perf_counter() - t1

    out = {
        "source": args.source.replace("\\", "/"),
        "durationMs": round(info.duration * 1000),
        "language": info.language,
        "model": args.model,
        "device": device,
        "modelLoadSec": round(t_load, 1),
        "transcribeSec": round(t_tr, 1),
        "words": words,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(words)} kata, transkrip {t_tr:.1f}s di {device} (load model {t_load:.1f}s) -> {args.out}")
    print(" ".join(w["text"] for w in words))


if __name__ == "__main__":
    main()
