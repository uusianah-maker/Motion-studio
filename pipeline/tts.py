"""R24f/R34 "Suara dari Teks": voice over offline untuk `engine tts <job_dir>` (yuki).

job.json (engine-job/1) bagian "tts":
  {"tts": {"kalimat": ["Halo kak.", "Ini Loose Pants."],   # atau "teks": "satu teks"
           "suara": "windows:Andika",                       # id dari daftar suara (bawaan windows:Andika; "Andika" juga boleh)
           "kecepatan": 1.0,                                # 0,5..2,0
           "jeda_ms": 300,                                  # jeda antar kalimat di file gabungan (0..3000)
           "pelafalan": {"Aysilla": "Ai sila"},             # tambahan/override kamus pelafalan Brand Kit
           "lufs": -16}}                                    # target loudness (-30..-8)
  {"tts": {"daftar_suara": true}}                           # hanya daftar suara terpasang

Kamus pelafalan per brand: Brand Kit `teks.pelafalan` {tulisan: ucapan} (brand_kit.json job), digabung dengan
job.tts.pelafalan. Hanya mengubah yang DIUCAPKAN; teks & cap waktu kata tetap memakai tulisan asli (untuk subtitle).

Hasil (hanya di dalam <job_dir>):
  out/vo/01.wav, 02.wav, ... (per kalimat) + out/vo/gabungan.wav  — WAV 48 kHz mono, satu gain untuk semua file
  supaya gabungan = target LUFS (limiter -1 dBTP).
  out/tts.json = {"schema":"tts/1","status","suara","backend","kecepatan","jeda_ms","lufs","usulan":true,
                  "gabungan":{"file","durasi"},
                  "file":[{"no","teks","diucapkan","file","durasi","mulai","akhir",          # mulai/akhir di gabungan
                           "kata":[{"teks","mulai","akhir"}]}],                             # relatif ke file kalimat
                  "total_durasi", "alasan"?}
  Daftar suara: {"schema":"tts/1","status":"selesai","suara":[{"id","nama","bahasa","gender","backend"}]}
Backend: "windows" (OneCore, tts_windows.ps1). Backend lain (TTS neural, konversi "Suara owner" R31) cukup
didaftarkan di BACKEND dengan fungsi daftar() + ucapkan().
Kode keluar: 0 selesai, 2 ditolak, 1 gagal teknis.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SKRIP = Path(__file__).resolve().parent / "tts_windows.ps1"  # folder KODE (rilis), bukan DATA
MAKS_KALIMAT = 60
MAKS_HURUF = 1000
SR = 48000
IDLE = 0x40  # IDLE_PRIORITY_CLASS: PC kantor = server live
BAWAAN_SUARA = "windows:Andika"


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


# ---------- validasi ----------
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


def angka_dari(cfg: dict, kunci: str, bawaan: float, lo: float, hi: float, nama: str) -> float:
    try:
        v = float(cfg.get(kunci, bawaan))
    except (TypeError, ValueError):
        raise Ditolak(f"tts.{kunci} harus angka") from None
    if not lo <= v <= hi:
        raise Ditolak(f"tts.{kunci} ({nama}) harus {lo:g}..{hi:g}")
    return v


# ---------- pelafalan ----------
def _n(t: str) -> str:
    return re.sub(r"[^\w-]+", "", t.lower())


def susun_ucapan(kalimat: str, pelafalan: dict[str, str]) -> tuple[str, list[dict]]:
    """Teks yang diucapkan + grup kata: [{"kata": [token asli], "awal", "akhir"}] (posisi huruf di teks ucapan).
    Frasa terpanjang dulu (maks 4 kata), tidak peka huruf besar/tanda baca; tanda baca ujung token dipertahankan."""
    kamus = {tuple(_n(w) for w in k.split()): str(v) for k, v in (pelafalan or {}).items() if str(k).strip() and str(v).strip()}
    maks = max((len(k) for k in kamus), default=1)
    tok = kalimat.split()
    grup, i, teks, pos = [], 0, [], 0
    while i < len(tok):
        cocok = None
        for n in range(min(maks, len(tok) - i), 0, -1):
            kunci = tuple(_n(w) for w in tok[i:i + n])
            if kunci in kamus and all(kunci):
                cocok = (n, kamus[kunci])
                break
        if cocok:
            n, ucap = cocok
            ekor = re.search(r"[^\w]*$", tok[i + n - 1]).group(0)  # titik/koma/tanda seru tetap -> intonasi
            # ucapan = tulisan yang sama (beda huruf besar saja) -> tulisan asli dipakai (intonasi awal kalimat)
            seg = " ".join(tok[i:i + n]) if _n(ucap.replace(" ", "")) == "".join(kunci) else ucap + ekor
        else:
            n, seg = 1, tok[i]
        if teks:
            pos += 1
        grup.append({"kata": tok[i:i + n], "awal": pos, "akhir": pos + len(seg) - 1})
        teks.append(seg)
        pos += len(seg)
        i += n
    return " ".join(teks), grup


def waktu_kata(grup: list[dict], cue: list[dict], durasi: float) -> list[dict]:
    """Cap waktu per kata asli dari batas kata backend (mulai_ms + posisi huruf). Akhir kata = awal kata berikutnya;
    kata terakhir = akhir audio dikurangi sisa sunyi (maks 0,25 dtk). Grup frasa dibagi rata menurut panjang huruf."""
    mulai_grup: list[float | None] = []
    for g in grup:
        cs = [c["mulai_ms"] for c in cue if g["awal"] <= c["awal"] <= g["akhir"]]
        mulai_grup.append(min(cs) / 1000 if cs else None)
    # grup tanpa batas kata (mis. tanda baca saja): ikut grup sebelumnya / 0
    for i, m in enumerate(mulai_grup):
        if m is None:
            mulai_grup[i] = mulai_grup[i - 1] if i else 0.0
    ujung = max(mulai_grup[-1] + 0.15, durasi - 0.25) if mulai_grup else durasi
    out = []
    for i, g in enumerate(grup):
        a = mulai_grup[i]
        b = mulai_grup[i + 1] if i + 1 < len(grup) else ujung
        b = max(b, a)
        total = sum(len(w) for w in g["kata"]) or 1
        t = a
        for w in g["kata"]:
            d = (b - a) * len(w) / total
            out.append({"teks": w, "mulai": round(t, 3), "akhir": round(t + d, 3)})
            t += d
    return out


# ---------- backend Windows ----------
def _ps(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SKRIP), *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          creationflags=IDLE if os.name == "nt" else 0)


class Windows:
    nama = "windows"

    def daftar(self) -> list[dict]:
        if os.name != "nt":
            return []
        with tempfile.TemporaryDirectory() as d:
            lap = Path(d) / "s.json"
            r = _ps(["-Daftar", "-Laporan", str(lap)])
            if r.returncode != 0 or not lap.exists():
                raise RuntimeError(f"daftar suara Windows gagal: {(r.stderr or r.stdout)[-300:]}")
            v = json.loads(lap.read_text(encoding="utf-8-sig"))["suara"]
        v = v if isinstance(v, list) else [v]
        return [{"id": f"windows:{x['nama'].replace('Microsoft ', '')}", "nama": x["nama"], "bahasa": x["bahasa"],
                 "gender": x.get("gender"), "backend": "windows"} for x in v]

    def ucapkan(self, item: list[tuple[str, Path]], suara: str, kecepatan: float) -> list[list[dict]]:
        if os.name != "nt":
            raise Ditolak("suara Windows hanya jalan di PC Windows (PC kantor)")
        with tempfile.TemporaryDirectory() as d:
            masuk, lap = Path(d) / "masuk.json", Path(d) / "hasil.json"
            masuk.write_text(json.dumps({"suara": suara, "kecepatan": kecepatan,
                                         "item": [{"teks": t, "keluar": str(p)} for t, p in item]}, ensure_ascii=False),
                             encoding="utf-8")
            r = _ps(["-Masuk", str(masuk), "-Laporan", str(lap)])
            if r.returncode != 0 or not lap.exists():
                pesan = (r.stderr or r.stdout).strip()
                if "tidak ditemukan" in pesan:
                    raise Ditolak(f"suara '{suara}' tidak terpasang di Windows")
                raise RuntimeError(f"TTS gagal: {pesan[-300:]}")
            hasil = json.loads(lap.read_text(encoding="utf-8-sig"))["item"]
        hasil = hasil if isinstance(hasil, list) else [hasil]
        return [(h.get("kata") or []) if isinstance(h.get("kata"), list) else [h["kata"]] for h in hasil]


BACKEND = {"windows": Windows()}


def urai_suara(s: str | None) -> tuple[str, str]:
    s = str(s or BAWAAN_SUARA).strip()
    be, _, nama = s.partition(":") if ":" in s else ("windows", "", s)
    if be not in BACKEND:
        raise Ditolak(f"backend suara '{be}' belum tersedia (ada: {', '.join(BACKEND)})")
    if not nama:
        raise Ditolak("nama suara kosong")
    return be, nama


# ---------- audio ----------
def durasi_wav(p: Path) -> float:
    with wave.open(str(p), "rb") as w:
        return round(w.getnframes() / float(w.getframerate()), 3)


def ffmpeg(args: list[str]) -> str:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y", *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", creationflags=IDLE if os.name == "nt" else 0)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg gagal: {r.stderr[-300:]}")
    return r.stderr


def loudness(p: Path) -> float:
    err = ffmpeg(["-i", str(p), "-af", "loudnorm=print_format=json", "-f", "null", "-"])
    d = json.loads(err[err.rindex("{"):err.rindex("}") + 1])
    v = float(d["input_i"])
    return v if v > -70 else -70.0


def gabung(files: list[Path], jeda_ms: int, keluar: Path) -> None:
    """Satu file: kalimat + sunyi jeda_ms di antaranya (WAV 48 kHz mono 16-bit)."""
    sunyi = bytes(int(SR * jeda_ms / 1000) * 2)
    with wave.open(str(keluar), "wb") as o:
        o.setnchannels(1)
        o.setsampwidth(2)
        o.setframerate(SR)
        for i, f in enumerate(files):
            with wave.open(str(f), "rb") as w:
                o.writeframes(w.readframes(w.getnframes()))
            if i + 1 < len(files):
                o.writeframes(sunyi)


def jalankan(job_dir: Path) -> int:
    out = job_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    laporan = {"schema": "tts/1", "status": "ditolak", "usulan": True, "file": []}
    try:
        job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
        cfg = job.get("tts") or {}
        if not isinstance(cfg, dict):
            raise Ditolak("job.tts harus objek")
        if cfg.get("daftar_suara"):
            semua = [s for b in BACKEND.values() for s in b.daftar()]
            (out / "tts.json").write_text(json.dumps({"schema": "tts/1", "status": "selesai", "suara": semua},
                                                     ensure_ascii=False, indent=2), encoding="utf-8")
            progres("selesai", 100, f"{len(semua)} suara")
            return 0
        kal = kalimat_dari(cfg)
        be, nama = urai_suara(cfg.get("suara"))
        kec = angka_dari(cfg, "kecepatan", 1.0, 0.5, 2.0, "kecepatan")
        jeda = int(angka_dari(cfg, "jeda_ms", 300, 0, 3000, "jeda antar kalimat"))
        lufs = angka_dari(cfg, "lufs", -16, -30, -8, "target loudness")
        bk_path = job_dir / str(job.get("brand_kit") or "brand_kit.json")
        pel = {}
        if bk_path.exists():
            bk = json.loads(bk_path.read_text(encoding="utf-8"))
            pel = dict(((bk.get("teks") or {}).get("pelafalan")) or bk.get("pelafalan") or {})
        if not isinstance(cfg.get("pelafalan", {}), dict):
            raise Ditolak("tts.pelafalan harus objek {tulisan: ucapan}")
        pel.update(cfg.get("pelafalan") or {})
        laporan.update(suara=f"{be}:{nama}", backend=be, kecepatan=kec, jeda_ms=jeda, lufs=lufs)

        vo = out / "vo"
        vo.mkdir(exist_ok=True)
        for f in vo.glob("*.wav"):  # hasil lama job ini (ulang) diganti
            f.unlink()
        ucap = [susun_ucapan(k, pel) for k in kal]
        progres("tts", 5, f"{len(kal)} kalimat, suara {nama}")
        with tempfile.TemporaryDirectory(dir=out) as d:
            mentah = [Path(d) / f"{i:02d}.wav" for i in range(1, len(kal) + 1)]
            cues = BACKEND[be].ucapkan([(u[0], p) for u, p in zip(ucap, mentah)], nama, kec)
            progres("tts", 60, "menyamakan format & loudness")
            seragam = [Path(d) / f"s{i:02d}.wav" for i in range(1, len(kal) + 1)]
            for a, b in zip(mentah, seragam):
                ffmpeg(["-i", str(a), "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", str(b)])
            g_mentah = Path(d) / "gabungan.wav"
            gabung(seragam, jeda, g_mentah)
            gain = lufs - loudness(g_mentah)
            af = f"volume={gain:.2f}dB,alimiter=limit=0.891:level=false"  # 0.891 = -1 dBTP
            for a, i in zip(seragam, range(1, len(kal) + 1)):
                ffmpeg(["-i", str(a), "-af", af, "-ar", str(SR), "-sample_fmt", "s16", str(vo / f"{i:02d}.wav")])
            ffmpeg(["-i", str(g_mentah), "-af", af, "-ar", str(SR), "-sample_fmt", "s16", str(vo / "gabungan.wav")])
        t = 0.0
        for i, (teks, (diucap, grup), cue) in enumerate(zip(kal, ucap, cues), 1):
            p = vo / f"{i:02d}.wav"
            dur = durasi_wav(p)
            laporan["file"].append({"no": i, "teks": teks, "diucapkan": diucap, "file": f"out/vo/{p.name}",
                                    "durasi": dur, "mulai": round(t, 3), "akhir": round(t + dur, 3),
                                    "kata": waktu_kata(grup, cue, dur)})
            t += dur + jeda / 1000
        laporan["gabungan"] = {"file": "out/vo/gabungan.wav", "durasi": durasi_wav(vo / "gabungan.wav")}
        laporan["total_durasi"] = laporan["gabungan"]["durasi"]
        laporan["status"] = "selesai"
        kode = 0
        progres("selesai", 100, f"{len(kal)} kalimat, {laporan['total_durasi']} dtk")
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
