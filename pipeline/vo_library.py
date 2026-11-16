"""§22 VO dari Library (yuki): VO dari "Suara dari Teks" (aset `vo`) jadi suara utama; subtitle dari teks yang sudah
diketahui (tanpa Whisper); footage jadi gambar. Helper bersama Generate (edit.py), Batch Remix, Beat Spot.

job.json: {"vo": {"media": "$vo:<aset>", "index": "vo_index.json", "suara_footage": "mati"|"pelan"|"asli", "subtitle": true}}
<job_dir>/vo_index.json = salinan `.motionstudio/vo/<version>.json` dari app (schema vo-index/1):
  {"schema": "vo-index/1", "job_id", "teks", "kalimat": [{"teks", "mulai", "akhir", "kata": [{"teks", "mulai", "akhir"}]}]}
  kalimat.mulai/akhir = detik di file VO; kata.mulai/akhir = detik RELATIF ke awal kalimat (voText.ts).
Tanpa dependensi (dipakai .venv dan demucs-venv).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = "vo-index/1"
MAKS_KALIMAT = 60
TOLERANSI_DTK = 0.1
SUARA_FOOTAGE = {"mati": 0.0, "pelan": 0.15, "asli": 1.0}
MIN_SEGMEN_MS = 400


class Ditolak(Exception):
    pass


def konfigurasi(job: dict) -> dict | None:
    """job.vo yang sudah dirapikan, atau None (job tanpa VO dari Library = perilaku lama)."""
    v = job.get("vo")
    if v is None:
        return None
    if not isinstance(v, dict) or not str(v.get("media") or "").startswith("$vo:"):
        raise Ditolak("vo.media harus kunci aset VO ($vo:...)")
    sf = str(v.get("suara_footage") or "mati")
    if sf not in SUARA_FOOTAGE:
        raise Ditolak(f"vo.suara_footage harus {' / '.join(SUARA_FOOTAGE)}")
    if job.get("audio_pilihan") == "musik":
        raise Ditolak('audio_pilihan "musik" (tanpa suara) bertentangan dengan VO dari Library')
    nama = str(v.get("index") or "vo_index.json")
    if "/" in nama or "\\" in nama or nama.startswith("."):
        raise Ditolak("vo.index harus nama file di dalam folder job")
    return {"media": v["media"], "index": nama, "suara_footage": sf, "volume_footage": SUARA_FOOTAGE[sf],
            "subtitle": v.get("subtitle", True) is not False}


def durasi_media(path: Path) -> float | None:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True, timeout=60)
        return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def muat_index(path: Path, durasi_dtk: float | None = None) -> dict:
    if not path.exists():
        raise Ditolak(f"index VO tidak ada: {path.name} (app menyalin .motionstudio/vo/<versi>.json)")
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise Ditolak("index VO bukan JSON yang sah") from None
    if d.get("schema") != SCHEMA:
        raise Ditolak(f"index VO harus schema {SCHEMA}")
    k = d.get("kalimat")
    if not isinstance(k, list) or not k:
        raise Ditolak("index VO tanpa kalimat")
    if len(k) > MAKS_KALIMAT:
        raise Ditolak(f"index VO lebih dari {MAKS_KALIMAT} kalimat")
    lalu = -1.0
    for i, s in enumerate(k):
        try:
            a, b = float(s["mulai"]), float(s["akhir"])
        except (KeyError, TypeError, ValueError):
            raise Ditolak(f"kalimat {i + 1}: mulai/akhir tidak sah") from None
        if not str(s.get("teks") or "").strip() or b <= a or a < lalu - 1e-6:
            raise Ditolak(f"kalimat {i + 1}: teks kosong atau waktu tidak urut")
        lalu = b
    if durasi_dtk is not None and lalu > durasi_dtk + TOLERANSI_DTK:
        raise Ditolak(f"index VO ({lalu:.2f} dtk) lebih panjang dari file VO ({durasi_dtk:.2f} dtk)")
    return d


def kata_absolut(index: dict) -> list[dict]:
    """Semua kata dengan waktu ABSOLUT di file VO (ms): {text, startMs, endMs, kalimat}. Kalimat tanpa cap waktu
    kata: kata dibagi rata sepanjang kalimat (menurut panjang huruf). Urut & tidak tumpang tindih."""
    out = []
    for ki, s in enumerate(index["kalimat"]):
        a0, b0 = float(s["mulai"]), float(s["akhir"])
        kata = [w for w in (s.get("kata") or []) if str(w.get("teks") or "").strip()]
        if kata:
            for w in kata:
                a = a0 + float(w["mulai"])
                b = min(a0 + float(w["akhir"]), b0)
                out.append({"text": str(w["teks"]).strip(), "startMs": round(a * 1000), "endMs": round(max(b, a) * 1000), "kalimat": ki})
        else:
            tok = str(s["teks"]).split()
            total = sum(len(t) for t in tok) or 1
            t = a0
            for w in tok:
                d = (b0 - a0) * len(w) / total
                out.append({"text": w, "startMs": round(t * 1000), "endMs": round((t + d) * 1000), "kalimat": ki})
                t += d
    for x, y in zip(out, out[1:]):  # rapikan: tidak tumpang tindih, durasi minimal 1 ms
        y["startMs"] = max(y["startMs"], x["startMs"] + 1)
        x["endMs"] = min(max(x["endMs"], x["startMs"] + 1), y["startMs"])
    if out:
        out[-1]["endMs"] = max(out[-1]["endMs"], out[-1]["startMs"] + 1)
    return out


def kata_transkrip(index: dict) -> list[dict]:
    """Kata berbentuk transkrip Whisper (edit.py/autocut): text, startMs, endMs, prob, cut, doubt, kalimat."""
    return [{**w, "prob": 1.0, "cut": None, "doubt": None} for w in kata_absolut(index)]


def caption_dari(kata: list[dict]) -> list[dict]:
    """Caption berbentuk keluaran autocut.run_cut (waktu hasil = waktu VO, karena VO dipakai utuh mulai 0)."""
    return [{"text": w["text"], "startMs": w["startMs"], "endMs": max(w["endMs"], w["startMs"] + 120), "timestampMs": None,
             "confidence": 1.0, "_word": i} for i, w in enumerate(kata)]


def segmen_footage(footage_ms: int, target_ms: int, fps: float, sisa_ms: int = 34) -> list[dict]:
    """Potongan footage {startFrame, endFrame} berurutan mengisi target_ms; footage lebih pendek = diulang dari awal."""
    pakai = max(0, footage_ms - sisa_ms)
    if pakai < MIN_SEGMEN_MS:
        raise Ditolak("footage terlalu pendek untuk dijadikan gambar VO")
    seg, t = [], 0
    while t < target_ms:
        d = min(pakai, target_ms - t)
        if d < MIN_SEGMEN_MS and seg:  # sisa pendek: perpanjang potongan terakhir bila footage masih ada
            last = seg[-1]
            ruang = pakai - round(last["endFrame"] * 1000 / fps)
            if ruang >= d:
                last["endFrame"] += int(round(d * fps / 1000))
                break
        seg.append({"startFrame": 0, "endFrame": int(round(d * fps / 1000))})
        t += d
    return seg


def peta_footage(segmen: list[dict], fps: float):
    """to_out: waktu footage (ms) -> waktu hasil (ms) pada kemunculan PERTAMA (untuk zoom-through di pergantian
    adegan footage). Di luar potongan = posisi akhir potongan terdekat."""
    pos, acc = [], 0.0
    for s in segmen:
        a, b = s["startFrame"] * 1000 / fps, s["endFrame"] * 1000 / fps
        pos.append((a, b, acc))
        acc += b - a

    def to_out(ms: float, prefer_next: bool = False) -> float:
        for a, b, o in pos:
            if a <= ms < b:
                return o + (ms - a)
        return acc

    return to_out


def cut_vo(index: dict, footage_ms: int, fps: float, kata: list[dict] | None = None) -> dict:
    """Pengganti autocut.run_cut untuk §22: VO utuh (tanpa potong), caption dari teks, footage mengisi durasi VO.
    `kata` = list yang SAMA dengan yang ditandai edit.py (superlatif disembunyikan), bawaan dari index."""
    kata = kata_transkrip(index) if kata is None else kata
    vo_ms = round(float(index["kalimat"][-1]["akhir"]) * 1000)
    seg = segmen_footage(footage_ms, vo_ms, fps)
    return {"words": kata, "segments": seg, "to_out": peta_footage(seg, fps), "captions": caption_dari(kata),
            "removed": [], "doubts": [], "videoMs": sum((s["endFrame"] - s["startFrame"]) * 1000 / fps for s in seg),
            "voMs": vo_ms}


def halaman(kata: list[dict], maks_kata: int = 3, jeda_ms: int = 250, maks_ms: int = 1600) -> list[list[dict]]:
    """Halaman subtitle: pecah di akhir kalimat, tanda baca, jeda, maks kata/durasi (aturan sama dengan edit.py)."""
    pages, cur = [], []
    for i, w in enumerate(kata):
        cur.append(w)
        nxt = kata[i + 1] if i + 1 < len(kata) else None
        pecah = (nxt is None or nxt.get("kalimat") != w.get("kalimat") or len(cur) >= maks_kata
                 or re.search(r"[.,!?;:]$", w["text"]) or nxt["startMs"] - w["endMs"] >= jeda_ms
                 or nxt["endMs"] - cur[0]["startMs"] > maks_ms)
        if pecah:
            pages.append(cur)
            cur = []
    return pages


def laporan(cfg: dict, index: dict) -> dict:
    return {"media": cfg["media"], "durasi": round(float(index["kalimat"][-1]["akhir"]), 3),
            "kalimat": len(index["kalimat"]), "suara_footage": cfg["suara_footage"]}


if __name__ == "__main__":  # cek cepat: python pipeline/vo_library.py <vo_index.json>
    d = muat_index(Path(sys.argv[1]))
    print(json.dumps({"kata": len(kata_absolut(d)), "halaman": len(halaman(kata_absolut(d)))}))
