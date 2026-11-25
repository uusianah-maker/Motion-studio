"""R31 §23 profil suara "Suara owner": `engine suara_profil <job_dir>` (yuki).

job.json:
  {"mode": "suara_profil", "sumber": [{"kunci": "$media:m_abc", "path": "..."}],
   "suara_profil": {"profil": "owner", "nama": "Suara owner", "tambah_contoh": ["$media:m_abc"],
                    "hapus_contoh": ["$media:m_old"], "latih": false, "contoh_kalimat": ["..."]}}
Profil (satu per workspace): <DATA>/konten/suara/owner/{profil.json, contoh/*.wav, model/} — tidak pernah masuk git.
Keluaran: out/suara_profil.json (suara-profil/1). Kode: 0 selesai (termasuk kurang_contoh), 2 ditolak, 1 gagal teknis.

Langkah sekarang: ambil audio (video/audio) -> mono 40 kHz -> buang sunyi > 0,6 dtk -> periksa mutu (SNR, clipping,
musik latar) -> simpan contoh bersih. `latih: true`: >= 5 menit bersih -> Applio (RVC), 30 dtk..5 menit -> uji cepat
OpenVoice, < 30 dtk -> kurang_contoh. Mesinnya suara_mesin.py di suara-venv (kunci AI global, Idle); lalu 3 contoh hasil.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "batch"))
from jalur import DATA, TOOLS, venv_py  # noqa: E402  (R20: data di MOTION_ENGINE_DATA)

SUARA_PY = Path(os.environ.get("MOTION_SUARA_PY") or venv_py(TOOLS / "suara-venv"))

# §24: owner + tiga adik owner (keputusan owner 23 Nov 2026). Profil lain tetap ditolak.
PROFIL = {"owner": "Suara owner", "grace": "Suara Grace", "julia": "Suara Julia", "niar": "Suara Niar"}
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


def pemilik_lain(profil: str, sha: str) -> str | None:
    """§24: profil lain yang sudah memakai rekaman ini (satu rekaman = satu orang, tidak boleh tercampur)."""
    for lain in PROFIL:
        if lain == profil:
            continue
        try:
            d = json.loads((folder_profil(lain) / "profil.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if any(c.get("sha256") == sha for c in (d.get("contoh") or {}).values()):
            return lain
    return None


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


def jalan_mesin(perintah: str, isi: dict, rentang: tuple[int, int] = (0, 100)) -> dict:
    """suara_mesin.py di suara-venv (Idle), di bawah kunci AI global; persen progres dipetakan ke `rentang` pemanggil."""
    sys.path.insert(0, str(Path(__file__).resolve().parent / "visual"))
    import beban
    if not SUARA_PY.exists():
        raise RuntimeError(f"mesin suara belum terpasang ({SUARA_PY.parent.parent.name} tidak ada)")
    hasil: dict = {}
    with tempfile.TemporaryDirectory() as d, beban.kunci_ai(f"suara_{perintah}"):
        beban.tunggu_ram()
        f = Path(d) / "perintah.json"
        f.write_text(json.dumps(isi, ensure_ascii=False), encoding="utf-8")
        env = {**os.environ, "MOTION_TOOLS_DIR": str(TOOLS), "PYTHONIOENCODING": "utf-8"}
        p = subprocess.Popen([str(SUARA_PY), str(Path(__file__).resolve().parent / "suara_mesin.py"), perintah, str(f)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                             env=env, creationflags=IDLE if os.name == "nt" else 0)
        for baris in p.stdout:  # type: ignore[union-attr]
            try:
                j = json.loads(baris)
            except ValueError:
                continue
            if j.get("tahap") == "hasil":
                hasil = j.get("hasil") or {}
            elif j.get("tahap") != "gagal":
                j["persen"] = rentang[0] + round((rentang[1] - rentang[0]) * int(j.get("persen") or 0) / 100)
                print(json.dumps(j, ensure_ascii=False), flush=True)
        err = p.stderr.read()  # type: ignore[union-attr]
        if p.wait() != 0:
            raise RuntimeError(f"mesin suara ({perintah}) gagal: {err.strip()[-400:]}")
    return hasil


def latih(folder: Path, data: dict, kalimat: list[str], out: Path, jeda_pukul: str | None = None,
          mulai_baru: bool = False) -> list[dict] | None:
    """Latih profil (Applio bila >= 5 menit bersih, OpenVoice bila uji cepat), lalu buat contoh hasil.
    None = dijeda aman (§25); `data["latihan_jeda"]` berisi epoch-nya."""
    pakai = [folder / c["file"] for c in data["contoh"].values() if c["dipakai"]]
    pakai = list(dict.fromkeys(pakai))  # kunci berbeda, file sama
    total = sum(c["durasi_bersih"] for c in data["contoh"].values() if c["dipakai"])
    backend = "applio" if total >= MINIMAL_DTK else "openvoice"
    perkiraan = 5400 if backend == "applio" else 120
    progres("latih", 70, f"melatih profil suara ({backend})", perkiraan_dtk=perkiraan)
    model = folder / "model"
    info = jalan_mesin("latih", {"contoh": [str(p) for p in pakai], "model_dir": str(model), "backend": backend,
                                 "epoch": int(os.environ.get("MOTION_SUARA_EPOCH") or 150),  # env hanya untuk uji asap
                                 "jeda_pukul": jeda_pukul, "mulai_baru": mulai_baru}, (70, 95))
    if info.get("dijeda"):
        data["latihan_jeda"] = {"epoch": info["epoch"], "total_epoch": info["total_epoch"], "waktu": time.strftime("%Y-%m-%dT%H:%M:%S")}
        simpan_profil(folder, data)
        return None
    data.pop("latihan_jeda", None)
    data.update(versi_model=int(data.get("versi_model") or 0) + 1, backend=info.get("backend", backend),
                dilatih_pada=time.strftime("%Y-%m-%dT%H:%M:%S"), perlu_latih_ulang=False,
                suara_dasar=data.get("suara_dasar") or "Andika")
    simpan_profil(folder, data)
    progres("contoh", 95, "membuat contoh hasil")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import tts
    (out / "contoh").mkdir(parents=True, exist_ok=True)
    item = [(k, out / "contoh" / f"{i:02d}.wav") for i, k in enumerate(kalimat, 1)]
    tts.BACKEND[data["profil"]].ucapkan([(tts.susun_ucapan(k, {})[0], p) for k, p in item], data["nama"], 1.0, profil=data, rentang=(95, 99))
    return [{"teks": k, "file": f"out/contoh/{p.name}"} for k, p in item]


def laporan(data: dict, status: str, alasan: str | None = None, contoh_hasil=None) -> dict:
    contoh = [{"kunci": k, **{x: v[x] for x in ("durasi", "durasi_bersih", "snr_db", "musik", "clipping", "dipakai", "alasan")}}
              for k, v in data["contoh"].items()]
    total = round(sum(c["durasi_bersih"] for c in contoh if c["dipakai"]), 1)
    return {"schema": "suara-profil/1", "status": status, "profil": data["profil"], "nama": data["nama"], "contoh": contoh,
            "durasi_bersih_total": total, "target_dtk": list(TARGET_DTK), "minimal_dtk": MINIMAL_DTK,
            "minimal_uji_dtk": MINIMAL_UJI_DTK, "backend": data.get("backend"), "dilatih_pada": data.get("dilatih_pada"),
            "versi_model": data.get("versi_model", 0), "latihan_jeda": data.get("latihan_jeda"),
            "contoh_hasil": contoh_hasil or [], "alasan": alasan}


def status_dari(data: dict) -> str:
    if data.get("latihan_jeda"):
        return "dijeda"
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
        jeda_pukul = cfg.get("jeda_pukul")
        if jeda_pukul is not None and not (isinstance(jeda_pukul, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", jeda_pukul)):
            raise Ditolak("jeda_pukul harus HH:MM")
        mulai_baru = cfg.get("mulai_baru", False)
        if not isinstance(mulai_baru, bool):
            raise Ditolak("mulai_baru harus true/false")
        if profil not in PROFIL:
            raise Ditolak(f"profil '{profil}' tidak diizinkan: hanya {', '.join(PROFIL)} (keputusan owner)")
        nama = PROFIL[profil]  # nama tetap per profil, supaya id suara di daftar tidak tertukar
        sumber = {s["kunci"]: Path(s["path"]) for s in job.get("sumber", []) if s.get("kunci") and s.get("path")}
        tambah = [str(k) for k in (cfg.get("tambah_contoh") or [])]
        hapus = [str(k) for k in (cfg.get("hapus_contoh") or [])]
        hilang = [k for k in tambah if k not in sumber or not sumber[k].exists()]
        if hilang:
            raise Ditolak("contoh tidak ada di sumber: " + ", ".join(hilang[:5]))
        for k in tambah:  # sebelum ada yang berubah di profil
            lain = pemilik_lain(profil, sidik(sumber[k]))
            if lain:
                raise Ditolak(f"rekaman {k} sudah dipakai profil '{lain}': satu rekaman hanya untuk satu orang")
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
            if total >= MINIMAL_UJI_DTK:
                hasil = latih(folder, data, [str(k) for k in (cfg.get("contoh_kalimat") or KALIMAT_BAWAAN)][:3], out,
                              jeda_pukul, mulai_baru)
                if hasil is None:
                    j = data["latihan_jeda"]
                    lap = {**laporan(data, "dijeda", f"dijeda aman di epoch {j['epoch']}/{j['total_epoch']}; jalankan latih lagi untuk melanjutkan"),
                           "epoch": j["epoch"], "total_epoch": j["total_epoch"]}
                else:
                    catatan = None if data.get("backend") == "applio" else (
                        f"uji cepat OpenVoice ({total / 60:.1f} menit bersih); tambah contoh sampai minimal "
                        f"{MINIMAL_DTK // 60} menit untuk hasil utama Applio")
                    lap = laporan(data, status_dari(data), catatan, contoh_hasil=hasil)
            else:
                lap = laporan(data, "kurang_contoh",
                              f"durasi bersih {total:.0f} dtk; minimal {MINIMAL_UJI_DTK} dtk untuk uji cepat dan "
                              f"minimal {MINIMAL_DTK // 60} menit untuk hasil utama "
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
