"""R31 §23 profil suara "Suara owner": `engine suara_profil <job_dir>` (yuki).

job.json:
  {"mode": "suara_profil", "sumber": [{"kunci": "$media:m_abc", "path": "..."}],
   "suara_profil": {"profil": "owner", "nama": "Suara owner", "tambah_contoh": ["$media:m_abc"],
                    "hapus_contoh": ["$media:m_old"], "latih": false, "contoh_kalimat": ["..."]}}
Profil (satu per workspace): <DATA>/konten/suara/owner/{profil.json, contoh/*.wav, model/} — tidak pernah masuk git.
Keluaran: out/suara_profil.json (suara-profil/1). Kode: 0 selesai (termasuk kurang_contoh), 2 ditolak, 1 gagal teknis.

Langkah sekarang: ambil audio (video/audio) -> mono 40 kHz -> buang sunyi > 0,6 dtk -> periksa mutu (SNR, clipping,
musik latar) -> simpan contoh bersih. Latih (Applio/OpenVoice, suara-venv) dipasang terpisah: selama belum ada,
`latih: true` dengan contoh cukup = gagal teknis "mesin latih belum terpasang" (contoh tetap tersimpan).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "batch"))
from jalur import DATA  # noqa: E402  (R20: data di MOTION_ENGINE_DATA)

PROFIL = ("owner",)  # satu profil; profil lain perlu keputusan owner
SR = 40000
FRAME = 0.03
SUNYI_MAKS = 0.6      # jeda > 0,6 dtk dipendekkan
PAD = 0.15
TARGET_DTK = (600, 900)
MINIMAL_DTK = 300     # latih Applio
MINIMAL_UJI_DTK = 30  # uji cepat OpenVoice
SNR_MIN = 15.0
IDLE = 0x40
KALIMAT_BAWAAN = ["Halo kak, selamat datang di toko kami.",
                  "Celana ini bahannya adem dan tidak gampang kusut.",
                  "Yuk langsung checkout di keranjang kuning sekarang!"]


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "", **lain) -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan, **lain}, ensure_ascii=False), flush=True)


def folder_profil(profil: str) -> Path:
    return DATA / "konten" / "suara" / profil


def sidik(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def baca_audio(p: Path) -> np.ndarray:
    """Audio file video/audio apa pun -> float32 mono SR (ffmpeg, prioritas Idle)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, creationflags=IDLE if os.name == "nt" else 0)
    if r.returncode != 0 or not r.stdout:
        raise Ditolak(f"audio tidak terbaca dari {p.name}")
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def tulis_wav(p: Path, x: np.ndarray) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def analisis(x: np.ndarray) -> dict:
    """Bagian ucapan (energi di atas lantai derau), SNR, clipping, dugaan musik latar di sela ucapan."""
    n = int(SR * FRAME)
    m = len(x) // n
    if m < 10:
        return {"ucapan": np.zeros(0, bool), "snr_db": 0.0, "clipping": False, "musik": False, "n": n}
    fr = x[: m * n].reshape(m, n)
    db = 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12)
    lantai, puncak = np.percentile(db, 10), np.percentile(db, 95)
    ambang = lantai + max(6.0, 0.35 * (puncak - lantai))
    ucap = db > ambang
    # Rapikan: isi lubang pendek (< 0,2 dtk) di tengah ucapan.
    k = max(1, int(0.2 / FRAME))
    for i in range(1, m - 1):
        if not ucap[i] and ucap[max(0, i - k):i].any() and ucap[i + 1:i + 1 + k].any():
            ucap[i] = True
    snr = float(np.mean(db[ucap]) - np.mean(db[~ucap])) if ucap.any() and (~ucap).any() else 0.0
    clipping = float(np.mean(np.abs(x) > 0.99)) > 0.001
    # Musik latar: sela ucapan tetap "berisi" (jauh di atas lantai) dan bernada (spectral flatness rendah).
    musik = False
    jeda = fr[~ucap]
    if len(jeda) >= 20:
        keras = db[~ucap] > -45  # sela ucapan masih berbunyi (ruangan sunyi ±-60 dBFS); lantai relatif ikut naik bila musik terus
        if keras.mean() > 0.4:
            spek = np.abs(np.fft.rfft(jeda[keras] * np.hanning(n), axis=1)) + 1e-9
            flat = np.exp(np.mean(np.log(spek), axis=1)) / np.mean(spek, axis=1)
            musik = bool(np.median(flat) < 0.2)
    return {"ucapan": ucap, "snr_db": round(snr, 1), "clipping": clipping, "musik": musik, "n": n}


def bersihkan(x: np.ndarray, a: dict) -> np.ndarray:
    """Hanya bagian ucapan (+pad); jeda di antaranya maks SUNYI_MAKS dtk."""
    ucap, n = a["ucapan"], a["n"]
    if not ucap.any():
        return np.zeros(0, np.float32)
    seg, i, m = [], 0, len(ucap)
    while i < m:
        if ucap[i]:
            j = i
            while j < m and ucap[j]:
                j += 1
            seg.append((max(0, i * n - int(PAD * SR)), min(len(x), j * n + int(PAD * SR))))
            i = j
        else:
            i += 1
    out, akhir = [], None
    for s0, s1 in seg:
        if akhir is not None and s0 > akhir:
            jeda = min(s0 - akhir, int(SUNYI_MAKS * SR))
            out.append(np.zeros(jeda, np.float32))
        s0 = max(s0, akhir or 0)
        if s1 > s0:
            out.append(x[s0:s1])
            akhir = s1
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def muat_profil(folder: Path, profil: str, nama: str) -> dict:
    p = folder / "profil.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"schema": "suara-profil-data/1", "profil": profil, "nama": nama, "contoh": {}, "versi_model": 0,
            "dilatih_pada": None, "backend": None, "perlu_latih_ulang": False}


def simpan_profil(folder: Path, d: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "profil.json.tmp"
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, folder / "profil.json")


def latih(folder: Path, data: dict, kalimat: list[str]) -> list[dict]:
    """Pelatihan Applio/OpenVoice (suara-venv). Belum terpasang -> gagal teknis yang jelas."""
    raise RuntimeError("mesin latih suara belum terpasang (suara-venv Applio/OpenVoice sedang disiapkan); "
                       "contoh suara sudah tersimpan dan diperiksa")


def laporan(data: dict, status: str, alasan: str | None = None, contoh_hasil=None) -> dict:
    contoh = [{"kunci": k, **{x: v[x] for x in ("durasi", "durasi_bersih", "snr_db", "musik", "clipping", "dipakai", "alasan")}}
              for k, v in data["contoh"].items()]
    total = round(sum(c["durasi_bersih"] for c in contoh if c["dipakai"]), 1)
    return {"schema": "suara-profil/1", "status": status, "profil": data["profil"], "nama": data["nama"], "contoh": contoh,
            "durasi_bersih_total": total, "target_dtk": list(TARGET_DTK), "minimal_dtk": MINIMAL_DTK,
            "minimal_uji_dtk": MINIMAL_UJI_DTK, "backend": data.get("backend"), "dilatih_pada": data.get("dilatih_pada"),
            "versi_model": data.get("versi_model", 0), "contoh_hasil": contoh_hasil or [], "alasan": alasan}


def status_dari(data: dict) -> str:
    if data.get("versi_model") and not data.get("perlu_latih_ulang"):
        return "siap"
    if data.get("versi_model") and data.get("perlu_latih_ulang"):
        return "perlu_latih_ulang"
    return "kurang_contoh"


def jalankan(job_dir: Path) -> int:
    out = job_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    data = None
    try:
        job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
        cfg = job.get("suara_profil")
        if not isinstance(cfg, dict):
            raise Ditolak("job.suara_profil harus objek")
        profil = str(cfg.get("profil") or "owner")
        if profil not in PROFIL:
            raise Ditolak(f"profil '{profil}' tidak diizinkan: hanya satu profil 'owner' (keputusan owner)")
        nama = str(cfg.get("nama") or "Suara owner")[:60]
        sumber = {s["kunci"]: Path(s["path"]) for s in job.get("sumber", []) if s.get("kunci") and s.get("path")}
        tambah = [str(k) for k in (cfg.get("tambah_contoh") or [])]
        hapus = [str(k) for k in (cfg.get("hapus_contoh") or [])]
        hilang = [k for k in tambah if k not in sumber or not sumber[k].exists()]
        if hilang:
            raise Ditolak("contoh tidak ada di sumber: " + ", ".join(hilang[:5]))
        folder = folder_profil(profil)
        data = muat_profil(folder, profil, nama)
        data["nama"] = nama
        for k in hapus:
            c = data["contoh"].pop(k, None)
            if c:
                (folder / c["file"]).unlink(missing_ok=True)
                if data.get("versi_model"):
                    data["perlu_latih_ulang"] = True
        sidik_ada = {c["sha256"] for c in data["contoh"].values()}
        for i, k in enumerate(tambah):
            progres("ambil_audio", 5 + int(60 * i / max(1, len(tambah))), f"contoh {i + 1}/{len(tambah)}")
            sha = sidik(sumber[k])
            if sha in sidik_ada and k in data["contoh"]:
                continue
            if sha in sidik_ada:  # file sama dengan kunci lain: catat kunci baru, isi sama
                lama = next(c for c in data["contoh"].values() if c["sha256"] == sha)
                data["contoh"][k] = dict(lama)
                continue
            x = baca_audio(sumber[k])
            progres("periksa", 5 + int(60 * (i + 0.5) / max(1, len(tambah))), f"contoh {i + 1}: bersihkan & periksa")
            a = analisis(x)
            bersih = bersihkan(x, a)
            alasan = None
            if len(bersih) < SR:
                alasan = "hampir tidak ada ucapan terdeteksi"
            elif a["musik"]:
                alasan = "ada musik latar; rekam ulang tanpa musik"
            elif a["snr_db"] < SNR_MIN:
                alasan = f"terlalu bising (SNR {a['snr_db']:.0f} dB < {SNR_MIN:.0f}); rekam di ruangan sunyi"
            nama_f = f"contoh/{sha[:16]}.wav"
            if len(bersih):
                tulis_wav(folder / nama_f, bersih)
            data["contoh"][k] = {"sha256": sha, "file": nama_f, "durasi": round(len(x) / SR, 1),
                                 "durasi_bersih": round(len(bersih) / SR, 1), "snr_db": a["snr_db"], "musik": a["musik"],
                                 "clipping": a["clipping"], "dipakai": alasan is None, "alasan": alasan,
                                 "ditambah": time.strftime("%Y-%m-%dT%H:%M:%S")}
            sidik_ada.add(sha)
            if data.get("versi_model"):
                data["perlu_latih_ulang"] = True
        simpan_profil(folder, data)
        total = sum(c["durasi_bersih"] for c in data["contoh"].values() if c["dipakai"])
        if cfg.get("latih"):
            if not any(c["dipakai"] for c in data["contoh"].values()):
                raise Ditolak("tidak ada contoh yang lolos mutu untuk dilatih")
            if total >= MINIMAL_DTK:
                progres("latih", 70, "melatih profil suara", perkiraan_dtk=5400)
                hasil = latih(folder, data, [str(k) for k in (cfg.get("contoh_kalimat") or KALIMAT_BAWAAN)][:3])
                lap = laporan(data, status_dari(data), contoh_hasil=hasil)
            else:
                lap = laporan(data, "kurang_contoh",
                              f"durasi bersih {total / 60:.1f} menit; minimal {MINIMAL_DTK // 60} menit untuk dilatih "
                              f"(target {TARGET_DTK[0] // 60}-{TARGET_DTK[1] // 60} menit)")
        else:
            lap = laporan(data, status_dari(data))
        (out / "suara_profil.json").write_text(json.dumps(lap, ensure_ascii=False, indent=2), encoding="utf-8")
        progres("selesai", 100, f"{lap['status']}: {total / 60:.1f} menit bersih")
        return 0
    except Ditolak as e:
        lap = laporan(data, "ditolak", str(e)) if data else {"schema": "suara-profil/1", "status": "ditolak", "alasan": str(e)}
        (out / "suara_profil.json").write_text(json.dumps(lap, ensure_ascii=False, indent=2), encoding="utf-8")
        progres("ditolak", 100, str(e))
        return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        print("pakai: suara_profil.py <job_dir>", file=sys.stderr)
        sys.exit(1)
    try:
        sys.exit(jalankan(Path(sys.argv[1]).resolve()))
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        progres("gagal", 100, str(e)[:300])
        sys.exit(1)
