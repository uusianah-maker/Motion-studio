"""CLI mesin untuk dipanggil Motion Studio (V5, KONTRAK-ENGINE v0.3 bagian 2).

  engine generate <job_dir>   Generate Otomatis: satu video -> rencana.json + ops.json + qc_rencana.json
  engine ulang    <job_dir>   susun ulang draf memakai <job_dir>/koreksi.json (tanpa transkrip ulang)
  engine batch    <job_dir>   Batch Remix (modul yuki: pipeline/batch/perencana.py)
  engine pisah    <job_dir>   Batch Remix: unggahan <job_dir>/masuk/ -> konten/, pisah audio + Shot Library
                              (pipeline/pisah.py --job); hasil di <job_dir>/out/pisah.json (schema pisah/1)
  engine transfer <job_dir>   Motion Transfer tahap 1: video referensi -> adegan + gambar + prompt (pipeline/transfer.py)
  engine beatspot <job_dir>   Beat Spot tahap 1 (modul yuki): footage orang jalan + sound -> potongan tepat di ketukan,
                              logo + end card (pipeline/batch/beatspot.py); out/beatspot.json = laporan potongan
  engine tts      <job_dir>   R24f voice over offline (suara Windows, mis. Andika): job.tts.kalimat -> out/vo/NN.wav,
                              laporan out/tts.json (schema tts/1); pipeline/tts.py (modul yuki)
  engine suara_profil <job_dir> R31 §23 profil "Suara owner": tambah/hapus contoh, periksa mutu, latih
                              (pipeline/suara_profil.py, modul yuki); out/suara_profil.json (suara-profil/1)
  engine visual   <job_dir>   R24 Visual Tools (modul yuki, visual-venv MOTION_VISUAL_PY): job.visual.alat = deteksi |
                              reframe | lacak | hapus_latar | perjelas -> out/ (pipeline/visual/jalankan.py, §18)
  engine daftar_batch         daftar batch untuk dropdown (read-only, tanpa job_dir);
                              stdout satu JSON {"schema":"daftar-batch/1","batch":[...]}
  engine cek                  cek alat (ffmpeg, Whisper, GPU, OpenCV) untuk halaman status

Jalankan dari D:\\VIBECODING\\remotion dengan Python .venv:
  .venv\\Scripts\\python pipeline\\engine.py generate PROJECTS\\<proyek>\\06_ENGINE\\<job_id>

Stdout: satu objek JSON per baris (progres). Log lain ke stderr.
Kode keluar: 0 berhasil · 2 ditolak (alasan di rencana.json) · 1 gagal teknis.
Mesin TIDAK merender dan tidak menulis apa pun di luar <job_dir>.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import vo_library  # §22 VO dari Library (yuki)

ROOT = Path(__file__).resolve().parents[1]
# R20 (rilis mesin terpisah): KODE bisa jalan dari folder rilis, DATA (konten/, public/, arsip/, .venv) tetap di
# folder data. MOTION_ENGINE_DATA = folder data; tanpa env = ROOT (perilaku lama, persis sama).
DATA = Path(os.environ["MOTION_ENGINE_DATA"]).resolve() if os.environ.get("MOTION_ENGINE_DATA") else ROOT
PY = sys.executable
JOB_SCHEMA = "engine-job/1"
# R24: Python visual-venv (MediaPipe/OpenCV-contrib/onnxruntime) terpisah dari .venv & demucs-venv.
# Alat bersama: MOTION_TOOLS_DIR, bawaan <DATA>/../tools (tanpa path absolut di kode; repo publik).
TOOLS = Path(os.environ["MOTION_TOOLS_DIR"]).resolve() if os.environ.get("MOTION_TOOLS_DIR") else DATA.parent / "tools"
VISUAL_PY = os.environ.get("MOTION_VISUAL_PY") or str(next(
    (p for p in (TOOLS / "visual-venv" / "Scripts" / "python.exe", TOOLS / "visual-venv" / "bin" / "python") if p.exists()),
    TOOLS / "visual-venv" / "Scripts" / "python.exe"))


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def skrip_absolut(cmd: list[str]) -> list[str]:
    """Argumen skrip mesin relatif ("pipeline/x.py") jadi absolut dari folder KODE, karena cwd = DATA."""
    return [str(ROOT / c) if isinstance(c, str) and c.startswith("pipeline/") and c.endswith(".py") else c for c in cmd]


def jalankan(cmd: list[str]) -> int:
    """Proses anak: stdout-nya dialihkan ke stderr supaya stdout tetap JSON progres saja."""
    log("$ " + " ".join(cmd))
    return subprocess.run(skrip_absolut(cmd), cwd=DATA, stdout=sys.stderr, stderr=sys.stderr).returncode


def teruskan(cmd: list[str]) -> int:
    """Proses anak yang menulis stdout-nya sendiri (JSON-lines progres / satu JSON hasil):
    stdout & stderr diteruskan apa adanya, kode keluar juga (0 / 2 ditolak / 1 gagal)."""
    log("$ " + " ".join(cmd))
    sys.stdout.flush()
    return subprocess.run(skrip_absolut(cmd), cwd=DATA).returncode


def baca_job(job_dir: Path) -> dict:
    p = job_dir / "job.json"
    if not p.exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    job = json.loads(p.read_text(encoding="utf-8"))
    if job.get("schema") != JOB_SCHEMA:
        raise ValueError(f"job.json schema harus {JOB_SCHEMA}")
    return job


def sumber_utama(job: dict) -> Path:
    for s in job.get("sumber", []):
        if s.get("kunci") == "$sumber":
            return Path(s["path"])
    raise ValueError("job.json: sumber dengan kunci $sumber tidak ada")


def sumber_video(job: dict, out: Path, butuh_suara: bool) -> tuple[Path, dict | None]:
    """§26: satu footage -> file itu (perilaku lama). Banyak footage (`$sumber:<id>`, urut) ->
    out/gabungan.mp4 (disamakan + disambung oleh gabung.py) beserta laporannya. gabung.Ditolak = kode 2."""
    import gabung

    daftar = gabung.daftar_footage(job)
    if len(daftar) <= 1:
        return sumber_utama(job), None
    if butuh_suara:
        info = [gabung.periksa(Path(s["path"])) for s in daftar]
        if not any(f["suara"] for f in info):
            raise gabung.Ditolak("semua footage tanpa suara; Generate Otomatis butuh orang bicara (atau pilih VO dari Library)")
    progres("gabung", 8, f"menggabung {len(daftar)} footage")
    hasil = gabung.gabung(job, out, log)
    progres("gabung", 12, f"{len(daftar)} footage -> {hasil['durasi']:.1f} dtk")
    return Path(hasil["path"]), hasil


def pasang_gabungan(out: Path, gab: dict | None) -> None:
    if gab:
        import gabung

        n = gabung.pasang_di_ops(out, gab)
        log(f"gabungan: {n} klip video -> {gab['kunci']}")


def sumber_vo(job: dict, kunci: str) -> Path | None:
    for s in job.get("sumber", []):
        if s.get("kunci") == kunci and s.get("path"):
            return Path(s["path"])
    return None


def siapkan_vo(job: dict, job_dir: Path):
    """§22: (cfg, index, path VO) bila job memakai VO dari Library, None bila tidak. vo_library.Ditolak = kode 2."""
    cfg = vo_library.konfigurasi(job)
    if cfg is None:
        return None
    path = sumber_vo(job, cfg["media"])
    if path is None or not path.exists():
        raise vo_library.Ditolak(f"file VO {cfg['media']} tidak ada di sumber job")
    idx = vo_library.muat_index(job_dir / cfg["index"], vo_library.durasi_media(path))
    return cfg, idx, path


def argumen_vo(job: dict, job_dir: Path) -> list[str]:
    vo = siapkan_vo(job, job_dir)
    if vo is None:
        return []
    cfg, _, path = vo
    return ["--vo-index", str(job_dir / cfg["index"]), "--vo-media", cfg["media"], "--vo-path", str(path),
            "--vo-volume-footage", str(cfg["volume_footage"])]


def tulis_ditolak(out: Path, alasan: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "rencana.json").write_text(
        json.dumps({"schema": "engine-rencana/1", "status": "ditolak", "alasan": alasan}, ensure_ascii=False, indent=2),
        encoding="utf-8", newline="\n")


def cek_input(video: Path, min_dtk: float = 5, butuh_suara: bool = True) -> dict:
    if not video.exists():
        raise Ditolak(f"file video tidak ditemukan: {video}")
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(video)],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise Ditolak(f"file tidak bisa dibaca sebagai video: {r.stderr.strip()[:200]}")
    info = json.loads(r.stdout)
    vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    aus = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not vs:
        raise Ditolak("tidak ada gambar video di file")
    if not aus and butuh_suara:
        raise Ditolak("video tidak punya suara; Generate Otomatis butuh orang bicara")
    w, h = vs[0].get("width", 0), vs[0].get("height", 0)
    dur = float(info.get("format", {}).get("duration", 0))
    peringatan = []
    if not h or abs(w / h - 9 / 16) > 0.02:
        peringatan.append(f"rasio {w}x{h} bukan 9:16; hasil akan dipotong ke 9:16")
    if dur < min_dtk:
        raise Ditolak(f"video terlalu pendek ({dur:.1f} dtk)")
    return {"lebar": w, "tinggi": h, "durasi": dur, "peringatan": peringatan}


def argumen_edit(job: dict, job_dir: Path, transkrip: Path, video: Path, out: Path) -> list[str]:
    brief = job.get("brief", {})
    cmd = [PY, "pipeline/edit.py", str(transkrip), "--brandkit", str(job_dir / job.get("brand_kit", "brand_kit.json")),
           "--video", str(video), "--out", str(out), "--placement", brief.get("placement", "tiktok"),
           "--mode-ops", job.get("mode_ops", "kompat")]
    if job.get("preset"):
        cmd += ["--preset", job["preset"]]
    if brief.get("area_produk"):
        cmd += ["--area-produk", brief["area_produk"]]
    if job.get("batas_durasi"):
        cmd += ["--batas-durasi", *map(str, job["batas_durasi"])]
    if job.get("abaikan_cek_ucapan"):
        cmd += ["--abaikan-cek-ucapan"]
    if job.get("audio_pilihan") in ("vo", "musik", "keduanya"):
        cmd += ["--audio", job["audio_pilihan"]]
    if job.get("vo") is not None:
        cmd += argumen_vo(job, job_dir)
    return cmd


def selesai(out: Path, cek: dict | None = None, kamus_baru=None) -> int:
    r = json.loads((out / "rencana.json").read_text(encoding="utf-8"))
    if cek and cek["peringatan"]:
        r["peringatan"] = [{"level": "warn", "jenis": "input", "teks": p} for p in cek["peringatan"]] + r["peringatan"]
    if kamus_baru:
        r["kamus_baru"] = kamus_baru
    (out / "rencana.json").write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    ops = json.loads((out / "ops.json").read_text(encoding="utf-8"))
    progres("selesai", 100, f"{r['status']} · {r['durasi']['mentah']} -> {r['durasi']['akhir']} dtk · {len(ops['ops'])} operasi")
    return 0


def generate(job_dir: Path) -> int:
    import gabung

    job = baca_job(job_dir)
    out = job_dir / "out"
    progres("cek_input", 5, f"{len(gabung.daftar_footage(job))} footage")
    try:
        vo = siapkan_vo(job, job_dir)
        video, gab = sumber_video(job, out, butuh_suara=not vo)  # §26: banyak footage -> out/gabungan.mp4
        cek = cek_input(video, min_dtk=1 if vo else 5, butuh_suara=not vo)  # §22: footage hanya gambar (diulang bila pendek)
    except (Ditolak, vo_library.Ditolak, gabung.Ditolak) as e:
        tulis_ditolak(out, str(e))
        progres("selesai", 100, f"ditolak: {e}")
        return 2
    out.mkdir(parents=True, exist_ok=True)
    transkrip = out / "transkrip.json"
    if vo:
        # §22 VO dari Library: tanpa Whisper. "Transkrip" = kata VO (waktu VO); durasi = footage (batas gambar).
        cfg, idx, _ = vo
        kata = vo_library.kata_transkrip(idx)
        transkrip.write_text(json.dumps({"source": str(video), "durationMs": round(cek["durasi"] * 1000), "words": kata,
                                         "sumber_suara": "vo_library", "vo": vo_library.laporan(cfg, idx)},
                                        ensure_ascii=False), encoding="utf-8")
        progres("transkrip", 60, f"VO dari Library: {len(kata)} kata, tanpa Whisper")
        progres("rencana", 70, "caption dari teks VO, footage jadi gambar, hook, efek")
        try:
            cmd = argumen_edit(job, job_dir, transkrip, video, out)
        except vo_library.Ditolak as e:
            tulis_ditolak(out, str(e))
            return 2
        rc = jalankan(cmd)
        if rc != 0:
            raise RuntimeError(f"rencana VO gagal (kode {rc})")
        pasang_gabungan(out, gab)
        return selesai(out, cek)
    progres("transkrip", 15, f"{cek['durasi']:.0f} dtk audio")
    t0 = time.perf_counter()
    rc = jalankan([PY, "pipeline/transcribe.py", str(video), str(transkrip),
                   "--brandkit", str(job_dir / job.get("brand_kit", "brand_kit.json"))])
    if rc != 0:
        raise RuntimeError(f"transkrip gagal (kode {rc})")
    n = len(json.loads(transkrip.read_text(encoding="utf-8"))["words"])
    progres("transkrip", 60, f"{n} kata, {time.perf_counter() - t0:.0f} dtk")
    progres("rencana", 70, "potong, caption, hook, efek")
    rc = jalankan(argumen_edit(job, job_dir, transkrip, video, out))
    if rc == 2:
        alasan = json.loads((out / "potongan.json").read_text(encoding="utf-8")).get("alasan", "ditolak")
        tulis_ditolak(out, alasan)
        progres("selesai", 100, f"ditolak: {alasan}")
        return 2
    if rc != 0:
        raise RuntimeError(f"rencana gagal (kode {rc})")
    pasang_gabungan(out, gab)
    return selesai(out, cek)


def ulang(job_dir: Path) -> int:
    """Susun ulang dengan koreksi tim (kontrak bagian 6), memakai transkrip yang sudah ada."""
    job = baca_job(job_dir)
    out = job_dir / "out"
    transkrip = out / "transkrip.json"
    if not transkrip.exists():
        raise FileNotFoundError("transkrip belum ada; jalankan generate dulu")
    p = job_dir / "koreksi.json"
    koreksi = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    progres("rencana", 30, "menerapkan koreksi")
    video, gab = sumber_video(job, out, butuh_suara=False)  # §26: gabungan dipakai ulang bila footage sama
    cmd = argumen_edit(job, job_dir, transkrip, video, out)
    kata = koreksi.get("kata", [])
    if kata:
        cmd += ["--koreksi", *[f"{k['detik']}:{k['jadi']}" for k in kata]]
    if koreksi.get("buang"):
        cmd += ["--buang", *[f"{a}-{b}" for a, b in koreksi["buang"]]]
    if koreksi.get("hook"):
        cmd += ["--hook-text", koreksi["hook"]]
    if koreksi.get("hook_top") is not None:
        # Posisi hook pilihan tim (0..1) mengunci posisi: cek teks bawaan tidak menggesernya (hybrid).
        cmd += ["--hook-top", str(float(koreksi["hook_top"]))]
    rc = jalankan(cmd)
    if rc == 2:
        alasan = json.loads((out / "potongan.json").read_text(encoding="utf-8")).get("alasan", "ditolak")
        tulis_ditolak(out, alasan)
        progres("selesai", 100, f"ditolak: {alasan}")
        return 2
    if rc != 0:
        raise RuntimeError(f"rencana ulang gagal (kode {rc})")
    tr = json.loads(transkrip.read_text(encoding="utf-8"))
    kamus_baru = {}
    for k in kata:
        if k.get("simpan_ke_kamus"):
            asal = min(tr["words"], key=lambda w: abs(w["startMs"] - k["detik"] * 1000))["text"].strip(".,?!")
            kamus_baru[asal] = k["jadi"]
    if koreksi.get("pakai"):
        log("catatan: 'pakai' (paksa pakai bagian yang dibuang mesin) belum didukung; diabaikan")
    pasang_gabungan(out, gab)
    return selesai(out, kamus_baru=kamus_baru or None)


def transfer(job_dir: Path) -> int:
    """Motion Transfer tahap 1 (R11): out/transfer.json + out/adegan/NN.jpg."""
    import transfer as mt

    job = baca_job(job_dir)
    out = job_dir / "out"
    video = sumber_utama(job)
    progres("cek_input", 5, video.name)
    try:
        cek = cek_input_gambar(video)
    except Ditolak as e:
        tulis_ditolak(out, str(e))
        progres("selesai", 100, f"ditolak: {e}")
        return 2
    brief = job.get("brief", {})
    produk = brief.get("produk")
    bk_p = job_dir / job.get("brand_kit", "brand_kit.json")
    if not produk and bk_p.exists():
        daftar = json.loads(bk_p.read_text(encoding="utf-8")).get("produk") or []
        produk = daftar[0].get("nama") if daftar and isinstance(daftar[0], dict) else None
    doc = mt.transfer(str(video), out, produk or "produk kami", brief.get("deskripsi_produk", ""), progres)
    progres("selesai", 100, f"siap · {len(doc['adegan'])} adegan · {cek['durasi']:.0f} dtk")
    return 0


def cek_input_gambar(video: Path) -> dict:
    """Seperti cek_input, tapi video referensi boleh tanpa suara dan rasio apa pun."""
    if not video.exists():
        raise Ditolak(f"file video tidak ditemukan: {video}")
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json",
                        str(video)], capture_output=True, text=True)
    if r.returncode != 0:
        raise Ditolak(f"file tidak bisa dibaca sebagai video: {r.stderr.strip()[:200]}")
    info = json.loads(r.stdout)
    if not any(s.get("codec_type") == "video" for s in info.get("streams", [])):
        raise Ditolak("tidak ada gambar video di file")
    return {"durasi": float(info.get("format", {}).get("duration", 0))}


def batch(job_dir: Path) -> int:
    progres("rencana", 5, "Batch Remix")
    # perencana.py menulis progres JSON-lines sendiri: stdout-nya harus sampai ke app.
    return teruskan([PY, "pipeline/batch/perencana.py", str(job_dir)])


def pisah(job_dir: Path) -> int:
    if not (job_dir / "job.json").exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    return teruskan([PY, "pipeline/pisah.py", "--job", str(job_dir)])


def beatspot(job_dir: Path) -> int:
    if not (job_dir / "job.json").exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    # beatspot.py menulis progres JSON-lines sendiri (termasuk progres analisis shot).
    return teruskan([PY, "pipeline/batch/beatspot.py", str(job_dir)])


def tts(job_dir: Path) -> int:
    if not (job_dir / "job.json").exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    # tts.py menulis progres JSON-lines + out/tts.json sendiri; kode 2 = ditolak.
    return teruskan([PY, "pipeline/tts.py", str(job_dir)])


def suara_profil(job_dir: Path) -> int:
    if not (job_dir / "job.json").exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    # suara_profil.py menulis progres JSON-lines + out/suara_profil.json sendiri; kode 2 = ditolak.
    return teruskan([PY, "pipeline/suara_profil.py", str(job_dir)])


def visual(job_dir: Path) -> int:
    if not (job_dir / "job.json").exists():
        raise FileNotFoundError(f"job.json tidak ada di {job_dir}")
    if not Path(VISUAL_PY).exists():
        raise FileNotFoundError(f"visual-venv tidak ada: {VISUAL_PY} (isi env MOTION_VISUAL_PY)")
    # jalankan.py menulis progres JSON-lines sendiri; kode 2 = ditolak.
    return teruskan([VISUAL_PY, "pipeline/visual/jalankan.py", str(job_dir)])


def daftar_batch() -> int:
    return teruskan([PY, "pipeline/batch/daftar.py"])


def cek_alat() -> int:
    hasil = {}
    for alat in ("ffmpeg", "ffprobe"):
        hasil[alat] = bool(shutil.which(alat))
    try:
        import faster_whisper  # noqa: F401

        hasil["whisper"] = True
    except Exception:  # noqa: BLE001
        hasil["whisper"] = False
    try:
        import ctranslate2

        hasil["gpu"] = ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        hasil["gpu"] = False
    try:
        import cv2  # noqa: F401

        hasil["opencv"] = True
    except Exception:  # noqa: BLE001
        hasil["opencv"] = False
    hasil["ok"] = all(hasil[k] for k in ("ffmpeg", "ffprobe", "whisper", "opencv"))
    print(json.dumps(hasil), flush=True)
    return 0 if hasil["ok"] else 1


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2 or sys.argv[1] not in ("generate", "ulang", "batch", "pisah", "transfer", "beatspot", "tts", "visual", "suara_profil", "daftar_batch", "cek"):
        log(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "cek":
        return cek_alat()
    if cmd == "daftar_batch":
        return daftar_batch()
    if len(sys.argv) < 3:
        log(f"pakai: engine {cmd} <job_dir>")
        return 1
    job_dir = Path(sys.argv[2]).resolve()
    try:
        return {"generate": generate, "ulang": ulang, "batch": batch, "pisah": pisah, "transfer": transfer,
                "beatspot": beatspot, "tts": tts, "visual": visual, "suara_profil": suara_profil}[cmd](job_dir)
    except Exception as e:  # noqa: BLE001 - gagal teknis: kode 1, pesan ke progres
        log(f"GAGAL: {e!r}")
        progres("gagal", 100, str(e)[:300])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
