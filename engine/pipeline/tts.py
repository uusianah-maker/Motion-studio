"""R24f TTS voice over offline (suara Windows OneCore, mis. "Andika" id-ID) untuk `engine tts <job_dir>`.

job.json (engine-job/1) bagian "tts":
  {"tts": {"kalimat": ["Halo kak", "Celana ini adem"], "suara": "Andika", "kecepatan": 1.0}}
  ("teks": "satu teks" boleh dipakai sebagai ganti "kalimat")

Hasil (hanya di dalam <job_dir>, mesin tidak menulis ke luar):
  <job_dir>/out/vo/01.wav, 02.wav, ...
  <job_dir>/out/tts.json = {"schema":"tts/1","status":"selesai"|"ditolak","suara","kecepatan","usulan":true,
                            "file":[{"no":1,"teks","file":"out/vo/01.wav","durasi":1.84}], "alasan"?}
Hybrid: VO = usulan; app menaruhnya di track audio dan user bebas mengganti/menghapus.
Kode keluar: 0 selesai, 2 ditolak (teks kosong / suara tidak ada / bukan Windows), 1 gagal teknis.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import wave
from pathlib import Path

SKRIP = Path(__file__).resolve().parent / "tts_windows.ps1"  # folder KODE (rilis), bukan DATA
MAKS_KALIMAT = 60
MAKS_HURUF = 1000
IDLE = 0x40  # IDLE_PRIORITY_CLASS: PC kantor = server live


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


def kalimat_dari(cfg: dict) -> list[str]:
    k = cfg.get("kalimat")
    if k is None and cfg.get("teks") is not None:
        k = [cfg["teks"]]
    if not isinstance(k, list):
        raise Ditolak("tts.kalimat (daftar teks) atau tts.teks wajib diisi")
    k = [" ".join(str(x).split()) for x in k]
    k = [x for x in k if x]
    if not k:
        raise Ditolak("teks voice over kosong")
    if len(k) > MAKS_KALIMAT:
        raise Ditolak(f"maksimal {MAKS_KALIMAT} kalimat per job")
    panjang = [i + 1 for i, x in enumerate(k) if len(x) > MAKS_HURUF]
    if panjang:
        raise Ditolak(f"kalimat ke-{panjang[0]} lebih dari {MAKS_HURUF} huruf")
    return k


def kecepatan_dari(cfg: dict) -> float:
    try:
        v = float(cfg.get("kecepatan", 1.0))
    except (TypeError, ValueError):
        raise Ditolak("tts.kecepatan harus angka") from None
    if not 0.5 <= v <= 2.0:
        raise Ditolak("tts.kecepatan harus 0,5–2,0")
    return v


def durasi_wav(p: Path) -> float:
    with wave.open(str(p), "rb") as w:
        return round(w.getnframes() / float(w.getframerate()), 3)


def ucapkan(teks: str, keluar: Path, suara: str, kecepatan: float) -> None:
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SKRIP),
                        "-Teks", teks, "-Keluar", str(keluar), "-Suara", suara, "-Kecepatan", str(kecepatan)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       creationflags=IDLE if os.name == "nt" else 0)
    if r.returncode != 0 or not keluar.exists():
        pesan = (r.stderr or r.stdout).strip()
        if "tidak ditemukan" in pesan:
            raise Ditolak(f"suara '{suara}' tidak terpasang di Windows")
        raise RuntimeError(f"TTS gagal: {pesan[-300:]}")


def jalankan(job_dir: Path) -> int:
    out = job_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    laporan = {"schema": "tts/1", "status": "ditolak", "usulan": True, "file": []}
    try:
        job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
        cfg = job.get("tts") or {}
        if not isinstance(cfg, dict):
            raise Ditolak("job.tts harus objek")
        kal = kalimat_dari(cfg)
        suara = str(cfg.get("suara") or "Andika")
        kec = kecepatan_dari(cfg)
        laporan.update(suara=suara, kecepatan=kec)
        if os.name != "nt":
            raise Ditolak("TTS suara Windows hanya jalan di PC Windows (PC kantor)")
        vo = out / "vo"
        vo.mkdir(exist_ok=True)
        for f in vo.glob("*.wav"):  # hasil lama job ini (ulang) diganti
            f.unlink()
        for i, teks in enumerate(kal, 1):
            progres("tts", 5 + int(90 * (i - 1) / len(kal)), f"kalimat {i}/{len(kal)}")
            p = vo / f"{i:02d}.wav"
            ucapkan(teks, p, suara, kec)
            laporan["file"].append({"no": i, "teks": teks, "file": f"out/vo/{p.name}", "durasi": durasi_wav(p)})
        laporan["status"] = "selesai"
        laporan["total_durasi"] = round(sum(f["durasi"] for f in laporan["file"]), 3)
        kode = 0
        progres("selesai", 100, f"{len(kal)} file VO, {laporan['total_durasi']} dtk")
    except Ditolak as e:
        laporan["alasan"] = str(e)
        progres("ditolak", 100, str(e))
        kode = 2
    (out / "tts.json").write_text(json.dumps(laporan, ensure_ascii=False, indent=2), encoding="utf-8")
    return kode


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        print("pakai: tts.py <job_dir>", file=sys.stderr)
        sys.exit(1)
    try:
        sys.exit(jalankan(Path(sys.argv[1]).resolve()))
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        progres("gagal", 100, str(e)[:300])
        sys.exit(1)
