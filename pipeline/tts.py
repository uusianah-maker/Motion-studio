"""R24f/R34 "Suara dari Teks": voice over offline untuk `engine tts <job_dir>` (yuki).

job.json (engine-job/1) bagian "tts":
  {"tts": {"kalimat": ["Halo kak.", "Ini Loose Pants."],   # atau "teks": "satu teks"
           "suara": "windows:Andika",                       # id dari daftar suara (bawaan windows:Andika; "Andika" juga boleh)
           "kecepatan": 1.0,                                # 0,5..2,0
           "jeda_ms": 300,                                  # jeda antar kalimat di file gabungan (0..3000)
           "pelafalan": {"Aysilla": "Ai sila"},             # tambahan/override kamus pelafalan Brand Kit
           "lufs": -16}}                                    # target loudness (-30..-8)
  {"tts": {"daftar_suara": true}}                           # hanya daftar suara terpasang (+ "model", "gaya")

§28 pembaca & gaya (owner 24 Nov: tim tinggal pilih):
  "model": "andika" (bawaan: TTS Windows, lalu diubah ke profil bila suara = profil) | "chatterbox" | "zonos"
           model neural meniru langsung contoh rekaman profil (suara wajib profil: owner/grace/julia/niar)
  "gaya":  natural | jualan | ramah | cerita | tegas | heboh  -> parameter model (GAYA); Andika tidak punya gaya
  "perkuat_warna": true -> hasil model neural diubah lagi oleh model Applio profil (warna suara lebih mirip)
  "audio": "$media:<id>" -> UBAH SUARA: rekaman VO siapa pun (job.sumber) diubah ke suara profil; intonasi & jeda
           ikut rekaman aslinya, jadi model/gaya tidak dipakai; kecepatan tetap berlaku. Maks 10 menit.
  Cap waktu kata model neural = PERKIRAAN (dibagi menurut panjang huruf di bagian bersuara); laporan "kata_perkiraan".

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
import shutil
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
MODEL = ("andika", "chatterbox", "zonos")
MAKS_UBAH_DTK = 600
MAKS_KALIMAT_NEURAL = 25  # job mesin dibatasi 30 menit oleh server
# §28 gaya bicara -> parameter model. Chatterbox: exaggeration (ekspresi), cfg_weight (rendah = tempo lebih santai),
# temperature (variasi). ZONOS: speaking_rate (huruf UTF-8 per detik), loudness (LUFS) sebagai kondisi model.
GAYA = {
    "natural": {"label": "Natural (ngobrol biasa)", "chatterbox": {"exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8},
                "zonos": {}, "jeda_ms": 300},
    "jualan": {"label": "Semangat jualan", "chatterbox": {"exaggeration": 0.75, "cfg_weight": 0.4, "temperature": 0.8},
               "zonos": {"speaking_rate": 17, "loudness": -14}, "jeda_ms": 200},
    "ramah": {"label": "Ramah & hangat (review)", "chatterbox": {"exaggeration": 0.6, "cfg_weight": 0.45, "temperature": 0.75},
              "zonos": {"speaking_rate": 14}, "jeda_ms": 350},
    "cerita": {"label": "Bercerita (pelan, banyak jeda)", "chatterbox": {"exaggeration": 0.55, "cfg_weight": 0.3, "temperature": 0.75},
               "zonos": {"speaking_rate": 12}, "jeda_ms": 500},
    "tegas": {"label": "Tegas & jelas (promo, harga)", "chatterbox": {"exaggeration": 0.4, "cfg_weight": 0.6, "temperature": 0.6},
              "zonos": {"speaking_rate": 15, "loudness": -14}, "jeda_ms": 250},
    "heboh": {"label": "Heboh / lebay", "chatterbox": {"exaggeration": 0.95, "cfg_weight": 0.3, "temperature": 0.9},
              "zonos": {"speaking_rate": 18, "loudness": -13}, "jeda_ms": 150},
}


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


class Owner:
    """R31 §23 + §24: TTS Windows lalu konversi ke suara satu profil (owner, grace, julia, niar).
    Muncul di daftar HANYA bila profil itu siap."""

    def __init__(self, profil: str = "owner"):
        self.nama = profil

    def _profil(self) -> dict | None:
        sys.path.insert(0, str(Path(__file__).resolve().parent / "batch"))
        from jalur import DATA
        p = DATA / "konten" / "suara" / self.nama / "profil.json"
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return d if d.get("versi_model") and not d.get("perlu_latih_ulang") else None

    def daftar(self) -> list[dict]:
        d = self._profil()
        if not d:
            return []
        nama = d.get("nama") or f"Suara {self.nama}"
        return [{"id": f"{self.nama}:{nama}", "nama": nama, "bahasa": "id-ID", "gender": None, "backend": self.nama, "siap": True}]

    def ucapkan(self, item, suara, kecepatan, profil: dict | None = None, rentang: tuple[int, int] = (10, 58)):
        """TTS Windows (suara dasar, + pelafalan) lalu dikonversi ke suara owner di suara-venv. Durasi tetap sama,
        jadi batas kata dari Windows tetap berlaku untuk subtitle."""
        d = profil or self._profil()
        if not d:
            raise Ditolak(f"Profil suara '{self.nama}' belum siap: tambah contoh suara dan latih profil dulu (§23)")
        import suara_profil as sp
        with tempfile.TemporaryDirectory() as t:
            dasar = [(teks, Path(t) / f"dasar_{i:02d}.wav") for i, (teks, _) in enumerate(item)]
            cues = Windows().ucapkan(dasar, d.get("suara_dasar") or "Andika", kecepatan)
            sp.jalan_mesin("ubah", {"model_dir": str(sp.folder_profil(self.nama) / "model"),
                                    "masuk": [str(p) for _, p in dasar], "keluar": [str(p) for _, p in item]}, rentang)
        return cues


BACKEND = {"windows": Windows(), **{p: Owner(p) for p in ("owner", "grace", "julia", "niar")}}


# ---------- §28 pembaca neural ----------
def _alat() -> tuple[Path, dict]:
    sys.path.insert(0, str(Path(__file__).resolve().parent / "batch"))
    from jalur import TOOLS, venv_py
    return TOOLS / "models" / "tts-uji", {"chatterbox": venv_py(TOOLS / "chatterbox-venv"), "zonos": venv_py(TOOLS / "zonos-venv")}


def daftar_model() -> list[dict]:
    m, py = _alat()
    bobot = {"chatterbox": m / "chatterbox-id" / "t3_cfg.safetensors", "zonos": m / "zonos3-mini-hf" / "model.safetensors"}
    return [{"id": "andika", "nama": "Andika (cepat, kaku)", "siap": os.name == "nt", "gaya": False},
            {"id": "chatterbox", "nama": "Chatterbox (ekspresif, GPU)", "siap": py["chatterbox"].exists() and bobot["chatterbox"].exists(), "gaya": True},
            {"id": "zonos", "nama": "ZONOS3-Mini (CPU)", "siap": py["zonos"].exists() and bobot["zonos"].exists(), "gaya": True}]


def contoh_ref(profil: str, keluar: Path) -> None:
    """±12 dtk rekaman asli profil (contoh dipakai pertama, mulai detik 15 bila cukup panjang) -> WAV 24 kHz mono."""
    import suara_profil as sp
    f = sp.folder_profil(profil)
    d = json.loads((f / "profil.json").read_text(encoding="utf-8"))
    pakai = [f / c["file"] for c in (d.get("contoh") or {}).values() if c.get("dipakai")] or sorted((f / "contoh").glob("*.wav"))
    pakai = [p for p in pakai if p.exists()]
    if not pakai:
        raise Ditolak(f"profil suara '{profil}' tidak punya contoh rekaman untuk ditiru model")
    durasi = durasi_media(pakai[0])
    mulai = 15.0 if durasi >= 27 else max(0.0, durasi - 12)
    ffmpeg(["-ss", f"{mulai:.2f}", "-t", "12", "-i", str(pakai[0]), "-ac", "1", "-ar", "24000", str(keluar)])


def durasi_media(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(p)],
                       capture_output=True, text=True, creationflags=IDLE if os.name == "nt" else 0)
    try:
        return float(json.loads(r.stdout or "{}").get("format", {}).get("duration") or 0)
    except ValueError:
        return 0.0


def ucapkan_neural(model: str, profil: str, gaya: str, item: list[tuple[str, Path]], perkuat: bool, tmp: Path) -> None:
    """Model neural meniru contoh profil -> (opsional) diperkuat Applio -> file di `item`. Di bawah kunci AI global."""
    import suara_profil as sp
    sys.path.insert(0, str(Path(__file__).resolve().parent / "visual"))
    import beban
    mdir, py = _alat()
    if not py[model].exists():
        raise Ditolak(f"model {model} belum terpasang di server ini")
    ref = tmp / "ref.wav"
    contoh_ref(profil, ref)
    mentah = [tmp / f"n{i:02d}.wav" for i in range(len(item))]
    perintah = tmp / "neural.json"
    perintah.write_text(json.dumps({"model": model, "model_dir": str(mdir), "ref": str(ref), "seed": 0, "gaya": GAYA[gaya][model],
                                    "item": [{"teks": t, "keluar": str(p)} for (t, _), p in zip(item, mentah)]}, ensure_ascii=False),
                        encoding="utf-8")
    akhir = 45 if perkuat else 58
    with beban.kunci_ai(f"tts_{model}"):
        beban.tunggu_ram()
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        # stderr ke file, bukan PIPE: progres tqdm model memenuhi pipa yang tidak dibaca dan prosesnya macet (uji 25 Nov)
        log_err = tmp / "neural_err.log"
        with open(log_err, "w", encoding="utf-8") as fe:
            p = subprocess.Popen([str(py[model]), str(Path(__file__).resolve().parent / "tts_neural.py"), str(perintah)],
                                 stdout=subprocess.PIPE, stderr=fe, text=True, encoding="utf-8", errors="replace",
                                 env=env, creationflags=IDLE if os.name == "nt" else 0)
            for baris in p.stdout:  # type: ignore[union-attr]
                try:
                    j = json.loads(baris)
                except ValueError:
                    continue
                if "kalimat" in j:
                    progres("tts", 5 + round((akhir - 5) * j["kalimat"] / max(1, j["dari"])),
                            f"{model}: kalimat {j['kalimat']}/{j['dari']} ({j.get('perangkat')})")
            kode = p.wait()
        if kode != 0:
            err = [x for x in log_err.read_text(encoding="utf-8", errors="replace").splitlines() if "it/s]" not in x]
            raise RuntimeError(f"model {model} gagal: {chr(10).join(err)[-400:]}")
    if perkuat:  # jalan_mesin mengambil kunci AI sendiri
        sp.jalan_mesin("ubah", {"model_dir": str(sp.folder_profil(profil) / "model"),
                                "masuk": [str(x) for x in mentah], "keluar": [str(q) for _, q in item]}, (akhir, 58))
    else:
        for a, (_, b) in zip(mentah, item):
            shutil.copy2(a, b)


def rentang_bersuara(p: Path) -> tuple[float, float]:
    """Awal & akhir bagian bersuara (blok 10 ms di atas -40 dB dari puncak) WAV 16-bit mono."""
    import array
    with wave.open(str(p), "rb") as w:
        sr, a = w.getframerate(), array.array("h", w.readframes(w.getnframes()))
    if not a:
        return 0.0, 0.0
    blok = max(1, sr // 100)
    rms = [(sum(x * x for x in a[i:i + blok]) / blok) ** 0.5 for i in range(0, len(a), blok)]
    batas = max(rms) * 0.01
    aktif = [i for i, r in enumerate(rms) if r > batas] or [0, len(rms) - 1]
    return aktif[0] * blok / sr, min(len(a), (aktif[-1] + 1) * blok) / sr


def kata_perkiraan(grup: list[dict], awal: float, akhir: float) -> list[dict]:
    kata = [w for g in grup for w in g["kata"]]
    total = sum(len(w) + 1 for w in kata) or 1
    out, t = [], awal
    for w in kata:
        d = (akhir - awal) * (len(w) + 1) / total
        out.append({"teks": w, "mulai": round(t, 3), "akhir": round(t + d, 3)})
        t += d
    return out


def sumber_audio(job: dict, kunci: str, job_dir: Path) -> Path:
    """Rekaman untuk UBAH SUARA: hanya dari job.sumber (path diisi server), bukan path bebas dari pengguna."""
    for s in job.get("sumber") or []:
        if isinstance(s, dict) and s.get("kunci") == kunci and s.get("path"):
            p = Path(s["path"])
            p = p if p.is_absolute() else job_dir / p
            if not p.exists():
                raise Ditolak("rekaman VO tidak ditemukan")
            return p
    raise Ditolak(f"rekaman {kunci} tidak ada di job.sumber")


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
            (out / "tts.json").write_text(json.dumps({"schema": "tts/1", "status": "selesai", "suara": semua, "model": daftar_model(),
                                                      "gaya": [{"id": k, "label": v["label"], "jeda_ms": v["jeda_ms"]} for k, v in GAYA.items()]},
                                                     ensure_ascii=False, indent=2), encoding="utf-8")
            progres("selesai", 100, f"{len(semua)} suara")
            return 0
        be, nama = urai_suara(cfg.get("suara"))
        kec = angka_dari(cfg, "kecepatan", 1.0, 0.5, 2.0, "kecepatan")
        if cfg.get("audio"):
            return ubah_suara(job, cfg, job_dir, out, laporan, be, nama, kec)
        kal = kalimat_dari(cfg)
        model = str(cfg.get("model") or "andika")
        if model not in MODEL:
            raise Ditolak(f"model '{model}' tidak dikenal (ada: {', '.join(MODEL)})")
        gaya = str(cfg.get("gaya") or "natural")
        if gaya not in GAYA:
            raise Ditolak(f"gaya '{gaya}' tidak dikenal (ada: {', '.join(GAYA)})")
        if model != "andika" and be == "windows":
            raise Ditolak(f"model {model} meniru rekaman asli: pilih suara profil (Ayu/Grace/Julia/Niar), bukan suara Windows")
        if model != "andika" and not BACKEND[be].daftar():
            raise Ditolak(f"Profil suara '{be}' belum siap: latih profil dulu")
        if model != "andika" and len(kal) > MAKS_KALIMAT_NEURAL:
            raise Ditolak(f"model {model} maksimal {MAKS_KALIMAT_NEURAL} kalimat per job (±4 menit proses per 30 dtk suara)")
        perkuat = bool(cfg.get("perkuat_warna", True))
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
        laporan.update(suara=f"{be}:{nama}", backend=be, kecepatan=kec, jeda_ms=jeda, lufs=lufs, model=model)
        if model != "andika":
            laporan.update(gaya=gaya, perkuat_warna=perkuat, kata_perkiraan=True)

        vo = out / "vo"
        vo.mkdir(exist_ok=True)
        for f in vo.glob("*.wav"):  # hasil lama job ini (ulang) diganti
            f.unlink()
        ucap = [susun_ucapan(k, pel) for k in kal]
        progres("tts", 5, f"{len(kal)} kalimat, suara {nama}")
        with tempfile.TemporaryDirectory(dir=out) as d:
            mentah = [Path(d) / f"{i:02d}.wav" for i in range(1, len(kal) + 1)]
            if model == "andika":
                cues = BACKEND[be].ucapkan([(u[0], p) for u, p in zip(ucap, mentah)], nama, kec)
            else:
                cues = None
                asli = [Path(d) / f"a{i:02d}.wav" for i in range(1, len(kal) + 1)]
                ucapkan_neural(model, be, gaya, [(u[0], p) for u, p in zip(ucap, asli)], perkuat, Path(d))
                for a, b in zip(asli, mentah):
                    atempo(a, b, kec) if abs(kec - 1) > 1e-3 else shutil.copy2(a, b)
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
        for i, (teks, (diucap, grup)) in enumerate(zip(kal, ucap), 1):
            p = vo / f"{i:02d}.wav"
            dur = durasi_wav(p)
            kata = waktu_kata(grup, cues[i - 1], dur) if cues is not None else kata_perkiraan(grup, *rentang_bersuara(p))
            laporan["file"].append({"no": i, "teks": teks, "diucapkan": diucap, "file": f"out/vo/{p.name}",
                                    "durasi": dur, "mulai": round(t, 3), "akhir": round(t + dur, 3), "kata": kata})
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


def atempo(a: Path, b: Path, kec: float) -> None:
    ffmpeg(["-i", str(a), "-af", f"atempo={kec:.3f}", str(b)])


def ubah_suara(job: dict, cfg: dict, job_dir: Path, out: Path, laporan: dict, be: str, nama: str, kec: float) -> int:
    """§28 UBAH SUARA: rekaman VO (suara siapa pun) -> suara profil lewat Applio. Intonasi & jeda ikut rekaman."""
    if be == "windows" or not BACKEND[be].daftar():
        raise Ditolak("ubah suara butuh profil suara yang sudah dilatih (Ayu/Grace/Julia/Niar)")
    import suara_profil as sp
    lufs = angka_dari(cfg, "lufs", -16, -30, -8, "target loudness")
    masuk = sumber_audio(job, str(cfg["audio"]), job_dir)
    dur = durasi_media(masuk)
    if dur <= 0:
        raise Ditolak("rekaman VO tidak berisi audio")
    if dur > MAKS_UBAH_DTK:
        raise Ditolak(f"rekaman VO maksimal {MAKS_UBAH_DTK // 60} menit (ini {dur / 60:.1f} menit)")
    laporan.update(suara=f"{be}:{nama}", backend=be, kecepatan=kec, lufs=lufs, model="ubah_suara", jeda_ms=0)
    vo = out / "vo"
    vo.mkdir(exist_ok=True)
    for f in vo.glob("*.wav"):
        f.unlink()
    progres("tts", 5, f"ubah rekaman {dur:.0f} dtk ke {nama}")
    with tempfile.TemporaryDirectory(dir=out) as d:
        a, b, c = Path(d) / "a.wav", Path(d) / "b.wav", Path(d) / "c.wav"
        ffmpeg(["-i", str(masuk), "-vn", "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", str(a)])
        sp.jalan_mesin("ubah", {"model_dir": str(sp.folder_profil(be) / "model"), "masuk": [str(a)], "keluar": [str(b)]}, (10, 85))
        atempo(b, c, kec) if abs(kec - 1) > 1e-3 else shutil.copy2(b, c)
        progres("tts", 90, "menyamakan format & loudness")
        s = Path(d) / "s.wav"
        ffmpeg(["-i", str(c), "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", str(s)])
        af = f"volume={lufs - loudness(s):.2f}dB,alimiter=limit=0.891:level=false"
        ffmpeg(["-i", str(s), "-af", af, "-ar", str(SR), "-sample_fmt", "s16", str(vo / "01.wav")])
    shutil.copy2(vo / "01.wav", vo / "gabungan.wav")
    dur = durasi_wav(vo / "01.wav")
    laporan["file"] = [{"no": 1, "teks": "", "diucapkan": "", "file": "out/vo/01.wav", "durasi": dur, "mulai": 0.0,
                        "akhir": dur, "kata": []}]
    laporan.update(gabungan={"file": "out/vo/gabungan.wav", "durasi": dur}, total_durasi=dur, status="selesai")
    (out / "tts.json").write_text(json.dumps(laporan, ensure_ascii=False, indent=2), encoding="utf-8")
    progres("selesai", 100, f"suara diubah ke {nama}, {dur} dtk")
    return 0


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
