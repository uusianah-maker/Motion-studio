"""`engine visual <job_dir>` (R24, OK venus 16 Nov): satu pintu Visual Tools, jalan di visual-venv (MOTION_VISUAL_PY).

job.json:
  {"schema": "engine-job/1", "visual": {"alat": "deteksi" | "reframe" | "lacak" | "hapus_latar" | "perjelas",
                                        "masuk": "konten/.../a.mp4", ...parameter alat}}
  `masuk` relatif ke folder DATA (MOTION_ENGINE_DATA, R20) atau absolut.

Parameter per alat (semua opsional kecuali disebut):
  deteksi     jenis ["wajah","objek"], hz 10, label ["person"]               -> out/jalur.json (jalur-posisi/1)
  reframe     jalur (path, bawaan out/jalur.json), rasio "9:16", subjek,
              kanvas [W,H] + fit "pas"|"isi" + awal_ms (opsional: keyframe app) -> out/reframe.json (reframe/1)
  lacak       kotak [x,y,w,h] WAJIB, mulai, sampai, metode "csrt"|"kcf", hz 15  -> out/lacak.json (jalur-posisi/1)
  hapus_latar model, fps 10                                                  -> out/hapus_latar/ (hapus-latar/1)
  perjelas    mode "cepat"|"kualitas", skala, sisi                           -> out/perjelas/ (perjelas/1)
Stdout: progres JSON-lines dari alatnya. Kode keluar: 0 selesai, 2 ditolak, 1 gagal teknis.
Semua alat berat lewat kunci AI global + Idle + 4 thread + tunggu RAM (beban.py). Hasil = usulan (hybrid).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "batch"))
import beban  # noqa: E402
from jalur import DATA  # noqa: E402

ALAT = ("deteksi", "reframe", "lacak", "hapus_latar", "perjelas")


def path_masuk(v: str | None, job_dir: Path) -> Path:
    if not v:
        raise beban.Ditolak("visual.masuk wajib diisi")
    p = Path(v)
    if not p.is_absolute():
        p = DATA / p if (DATA / p).exists() or not (job_dir / p).exists() else job_dir / p
    if not p.exists():
        raise beban.Ditolak(f"file masuk tidak ada: {v}")
    return p.resolve()


def daftar(x, nama: str, n: int | None = None) -> list:
    if not isinstance(x, list) or (n is not None and len(x) != n):
        raise beban.Ditolak(f"visual.{nama} harus daftar{f' {n} angka' if n else ''}")
    return x


def perintah(job_dir: Path, cfg: dict) -> list[str]:
    alat = cfg.get("alat")
    if alat not in ALAT:
        raise beban.Ditolak(f"visual.alat harus salah satu {', '.join(ALAT)}")
    out = job_dir / "out"
    py = [sys.executable, str(HERE / f"{alat}.py")]
    if alat == "deteksi":
        cmd = py + [str(path_masuk(cfg.get("masuk"), job_dir)), str(out / "jalur.json"),
                    "--jenis", ",".join(daftar(cfg.get("jenis", ["wajah", "objek"]), "jenis")),
                    "--hz", str(float(cfg.get("hz", 10))),
                    "--label", ",".join(daftar(cfg.get("label", ["person"]), "label"))]
    elif alat == "reframe":
        j = Path(cfg.get("jalur") or out / "jalur.json")
        j = j if j.is_absolute() else job_dir / j
        if not j.exists():
            raise beban.Ditolak("reframe butuh jalur-posisi (jalankan deteksi dulu atau isi visual.jalur)")
        cmd = py + [str(j), str(out / "reframe.json"), "--rasio", str(cfg.get("rasio", "9:16"))]
        if cfg.get("subjek"):
            cmd += ["--subjek", str(cfg["subjek"])]
    elif alat == "lacak":
        k = daftar(cfg.get("kotak"), "kotak", 4)
        cmd = py + [str(path_masuk(cfg.get("masuk"), job_dir)), str(out / "lacak.json"),
                    "--kotak", ",".join(str(float(v)) for v in k), "--mulai", str(float(cfg.get("mulai", 0))),
                    "--alat", str(cfg.get("metode", "csrt")), "--hz", str(float(cfg.get("hz", 15)))]
        if cfg.get("sampai") is not None:
            cmd += ["--sampai", str(float(cfg["sampai"]))]
    elif alat == "hapus_latar":
        cmd = py + [str(path_masuk(cfg.get("masuk"), job_dir)), str(out / "hapus_latar"),
                    "--fps", str(float(cfg.get("fps", 10)))]
        if cfg.get("model"):
            cmd += ["--model", str(cfg["model"])]
    else:  # perjelas
        cmd = py + [str(path_masuk(cfg.get("masuk"), job_dir)), str(out / "perjelas")]
        for k in ("mode", "skala", "sisi"):
            if cfg.get(k) is not None:
                cmd += [f"--{k}", str(cfg[k])]
    return cmd


def keyframe_app(job_dir: Path, cfg: dict) -> None:
    """reframe + kanvas -> tambahkan keyframe siap pakai app (§18.2) ke out/reframe.json."""
    if not cfg.get("kanvas"):
        return
    import reframe as rf
    p = job_dir / "out" / "reframe.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    j = json.loads(Path(cfg.get("jalur") or job_dir / "out" / "jalur.json").read_text(encoding="utf-8"))
    kanvas = daftar(cfg["kanvas"], "kanvas", 2)
    doc["keyframe_app"] = rf.ke_keyframe_app(doc, (j["lebar"], j["tinggi"]), (int(kanvas[0]), int(kanvas[1])),
                                             fit=str(cfg.get("fit", "pas")), awal_ms=int(cfg.get("awal_ms", 0)))
    doc["kanvas"], doc["fit"] = kanvas, str(cfg.get("fit", "pas"))
    p.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def jalankan(job_dir: Path) -> int:
    (job_dir / "out").mkdir(parents=True, exist_ok=True)
    try:
        job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
        cfg = job.get("visual")
        if not isinstance(cfg, dict):
            raise beban.Ditolak("job.visual harus objek")
        cmd = perintah(job_dir, cfg)
    except beban.Ditolak as e:
        beban.progres("ditolak", 100, str(e))
        (job_dir / "out" / "visual.json").write_text(json.dumps({"schema": "visual/1", "status": "ditolak", "alasan": str(e)},
                                                                ensure_ascii=False), encoding="utf-8")
        return 2
    sys.stdout.flush()
    kode = subprocess.run(cmd, creationflags=0x40 if sys.platform == "win32" else 0).returncode
    if kode == 0 and cfg["alat"] == "reframe":
        keyframe_app(job_dir, cfg)
    return kode


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        print("pakai: jalankan.py <job_dir>", file=sys.stderr)
        sys.exit(1)
    try:
        sys.exit(jalankan(Path(sys.argv[1]).resolve()))
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        beban.progres("gagal", 100, str(e)[:300])
        sys.exit(1)
