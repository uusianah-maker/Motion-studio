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

from karangan import bersihkan  # noqa: E402

# Prompt awal mendorong Whisper ikut menulis kata pengisi (eee/emm) dan kalimat
# yang diulang, supaya auto-cut bisa membuangnya. Tanpa ini Whisper cenderung
# "merapikan" ucapan dan menyembunyikan jeda di dalam durasi kata.
INITIAL_PROMPT = "Eee, jadi... emm, ini tuh, eh bentar, ulang. Jadi ini tuh bagus banget."

# Keluhan owner 27 Nov (typo subtitle Batch Remix makin banyak): di stem VOKAL hasil pisah (musik dibuang,
# banyak jeda kosong) prompt "ulang" + hotwords membuat Whisper mengarang: "5. 5. 5. 5. 4 Visi", "aku baru
# aja" x10, "Terima kasih telah menonton", sampai membacakan daftar kosakata di bagian lagu. Uji 7 footage
# asli 2026-11-27_footage: VAD + tanpa prompt "ulang" + kosakata hanya di prompt (tanpa hotwords) menghapus
# semua karangan itu dan memperbaiki "rekomensi" -> "rekomendasi", "katingannya" -> "cuttingannya".
GAYA_VO = dict(vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=300),
               hallucination_silence_threshold=1.5)

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


def hitung_token(model):
    """Penghitung token dengan tokenizer model yang dipakai (sama seperti faster-whisper: " " + teks)."""
    tok = getattr(model, "hf_tokenizer", None)
    if tok is None:
        return None
    return lambda teks: len(tok.encode(" " + teks, add_special_tokens=False).ids)


def petunjuk(bk: dict, brief: dict, hitung=None) -> list[str]:
    """Kosakata untuk hotwords DAN initial_prompt. Batas = yang lebih ketat: prompt juga memuat INITIAL_PROMPT,
    dan faster-whisper membuang token AWAL prompt yang kepanjangan (contoh kata pengisi ikut hilang)."""
    from brandkit import BATAS_TOKEN, kosakata_brand, perkiraan_token

    n = (hitung or perkiraan_token)(INITIAL_PROMPT)
    return kosakata_brand(bk, brief, hitung, BATAS_TOKEN - n - 2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("out")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default="id")
    ap.add_argument("--brandkit", help="brand kit JSON; kosakata_whisper dipakai sebagai petunjuk")
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    ap.add_argument("--produk", help="produk dari brief job (petunjuk Whisper, prioritas sesudah nama brand)")
    ap.add_argument("--varian", help="varian dari brief job, dipisah koma")
    ap.add_argument("--gaya", choices=["bicara", "vo"], default="bicara",
                    help="bicara = rekaman talking head (kata pengisi & ulang ucap ikut ditulis untuk auto-cut); "
                         "vo = stem vokal hasil pisah Batch Remix (VAD, tanpa prompt ulang, tanpa hotwords)")
    args = ap.parse_args()

    t0 = time.perf_counter()
    model, device = load_model(args.model, args.device)
    t_load = time.perf_counter() - t0

    vocab = []
    if args.brandkit:
        from brandkit import muat

        vocab = petunjuk(muat(args.brandkit), {"produk": args.produk, "varian": args.varian}, hitung_token(model))
    if args.gaya == "vo":
        # Waktu kata tetap relatif ke awal file: faster-whisper memetakan balik potongan VAD.
        opsi = dict(initial_prompt=", ".join(vocab) + "." if vocab else None, hotwords=None, **GAYA_VO)
    else:
        opsi = dict(initial_prompt=INITIAL_PROMPT + (" " + ", ".join(vocab) + "." if vocab else ""),
                    hotwords=", ".join(vocab) or None,
                    vad_filter=False)  # jeda harus tetap terlihat di timestamp

    t1 = time.perf_counter()
    segments, info = model.transcribe(
        load_audio(args.source),
        language=args.language,
        word_timestamps=True,
        condition_on_previous_text=False,
        beam_size=5,
        **opsi,
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
    # Ulang ucap asli (talking head) dibiarkan sampai 3x untuk auto-cut; stem VO maks 2x.
    dibuang = bersihkan(words, 2 if args.gaya == "vo" else 3)

    out = {
        "source": args.source.replace("\\", "/"),
        "durationMs": round(info.duration * 1000),
        "language": info.language,
        "model": args.model,
        "device": device,
        "modelLoadSec": round(t_load, 1),
        "transcribeSec": round(t_tr, 1),
        "gaya": args.gaya,
        **({"dibuang_karangan": dibuang} if dibuang else {}),
        "words": words,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(words)} kata, transkrip {t_tr:.1f}s di {device} (load model {t_load:.1f}s) -> {args.out}")
    print(" ".join(w["text"] for w in words))


if __name__ == "__main__":
    main()
