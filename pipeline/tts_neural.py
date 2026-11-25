"""§28 pembaca neural untuk Suara dari Teks (yuki). Jalan di venv modelnya sendiri, dipanggil tts.py:

  chatterbox-venv/python tts_neural.py <perintah.json>   (Chatterbox + bobot Indonesia, GPU bila muat, jatuh ke CPU)
  zonos-venv/python      tts_neural.py <perintah.json>   (ZONOS3-Mini, CPU fp32)

perintah.json = {"model": "chatterbox"|"zonos", "model_dir": <TOOLS>/models/tts-uji, "ref": wav contoh suara (±12 dtk),
                 "seed": 0, "gaya": {...parameter model...}, "item": [{"teks", "keluar"}]}
Keluaran: satu WAV per item (sample rate asli model) + baris progres JSON {"kalimat": i, "dari": n, "perangkat"}.
Model tidak pernah diunduh di sini (HF_HUB_OFFLINE); bobot dipasang terpisah (unduh_bobot_tts.py, SHA256 dicek)."""
import json
import os
import shutil
import sys
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402


GPU_MIN_KOSONG = int(3.3 * 2**30)  # bobot fp32 + aktivasi (uji 24 Nov: ±3,0 GB terpakai)


def kabar(**k):
    print(json.dumps(k, ensure_ascii=False), flush=True)


def chatterbox(cfg: dict) -> None:
    from chatterbox.tts import ChatterboxTTS
    m = Path(cfg["model_dir"])
    gab = m / "chatterbox-id-gabung"  # bobot dasar + t3 Indonesia dalam satu folder (from_local)
    gab.mkdir(exist_ok=True)
    for f, asal in [("ve.safetensors", "chatterbox-dasar"), ("s3gen.safetensors", "chatterbox-dasar"),
                    ("tokenizer.json", "chatterbox-dasar"), ("conds.pt", "chatterbox-dasar"),
                    ("t3_cfg.safetensors", "chatterbox-id")]:
        if not (gab / f).exists():
            shutil.copy2(m / asal / f, gab / f)
    g = cfg.get("gaya") or {}
    # GPU 4 GB (GTX 1650) juga dipakai desktop: bila memori kosong kurang, Windows memindah-mindah memori GPU dan
    # Chatterbox macet (uji 25 Nov: 20 menit untuk 1 kalimat). Pakai GPU hanya bila cukup lega, selain itu CPU.
    dev = "cpu"
    if torch.cuda.is_available() and os.environ.get("MOTION_TTS_PERANGKAT", "").lower() != "cpu":
        kosong, _ = torch.cuda.mem_get_info()
        dev = "cuda" if kosong >= GPU_MIN_KOSONG else "cpu"
        kabar(gpu_kosong_mb=round(kosong / 2**20), perangkat=dev)
    try:
        model = ChatterboxTTS.from_local(gab, dev)
    except torch.cuda.OutOfMemoryError:  # GPU dipakai latihan / job lain
        torch.cuda.empty_cache()
        dev, model = "cpu", ChatterboxTTS.from_local(gab, "cpu")
    n = len(cfg["item"])
    for i, it in enumerate(cfg["item"]):
        torch.manual_seed(int(cfg.get("seed", 0)) + i)
        arg = dict(audio_prompt_path=cfg["ref"], exaggeration=float(g.get("exaggeration", 0.5)),
                   cfg_weight=float(g.get("cfg_weight", 0.5)), temperature=float(g.get("temperature", 0.8)))
        try:
            w = model.generate(it["teks"], **arg)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            dev, model = "cpu", ChatterboxTTS.from_local(gab, "cpu")
            w = model.generate(it["teks"], **arg)
        sf.write(it["keluar"], w.squeeze(0).cpu().numpy().astype(np.float32), model.sr)
        kabar(kalimat=i + 1, dari=n, perangkat=dev)


def zonos(cfg: dict) -> None:
    from transformers import AutoModel
    model = AutoModel.from_pretrained(str(Path(cfg["model_dir"]) / "zonos3-mini-hf"), trust_remote_code=True,
                                      local_files_only=True, dtype=torch.float32).to("cpu").eval()
    y, sr = sf.read(cfg["ref"], dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    emb = model.embed_speaker(torch.from_numpy(y), sr)
    g = cfg.get("gaya") or {}
    kondisi = {k: g[k] for k in ("speaking_rate", "loudness") if g.get(k) is not None}
    n = len(cfg["item"])
    for i, it in enumerate(cfg["item"]):
        with torch.inference_mode():
            out = model.generate(it["teks"], speaker_embedding=emb, language="id", seed=int(cfg.get("seed", 0)) + i,
                                 condition_values=kondisi or None,
                                 **({"temperature": float(g["temperature"])} if g.get("temperature") else {}))
        sf.write(it["keluar"], out.waveform.float().cpu().numpy().reshape(-1), out.sampling_rate)
        kabar(kalimat=i + 1, dari=n, perangkat="cpu")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    torch.set_num_threads(min(4, os.cpu_count() or 4))  # PC kantor = server live: maks 4 thread
    c = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    {"chatterbox": chatterbox, "zonos": zonos}[c["model"]](c)
