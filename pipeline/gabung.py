"""Gabung banyak footage Video Iklan jadi satu video (KONTRAK-ENGINE §26).

Job Generate boleh membawa lebih dari satu footage: `sumber` berisi `$sumber:<id>` sesuai URUTAN
pilihan tim (urutan daftar = urutan di video). Mesin menyamakan semuanya lalu menyambungnya jadi
`<job_dir>/out/gabungan.mp4`, dan seluruh langkah berikutnya (transkrip, potong, caption, efek)
berjalan di atas file itu seperti satu video biasa.

Penyamaan (supaya sambungan tidak patah):
- gambar: 1080x1920 (kanvas 9:16), skala menutup bingkai lalu dipotong tengah (sama dengan
  "hasil dipotong ke 9:16" untuk satu video), 30 fps, yuv420p, SAR 1;
- suara: 48 kHz stereo; footage tanpa suara diberi hening sepanjang gambarnya;
- tiap bagian dipotong tepat sepanjang GAMBAR-nya, jadi suara tidak bergeser di bagian berikutnya.

Hasil tetap draf (hybrid): klip di timeline menunjuk `$gabungan:video`, aplikasi mengimpornya
sebagai media proyek, tim bisa memotong/menggeser/menghapus seperti biasa. File asli tidak diubah.
"""

import hashlib
import json
import subprocess
from pathlib import Path

LEBAR, TINGGI, FPS, RATE = 1080, 1920, 30, 48000
KUNCI = "$gabungan:video"
MAKS_FOOTAGE = 20
NAMA = "gabungan.mp4"


class Ditolak(Exception):
    pass


def daftar_footage(job: dict) -> list[dict]:
    """Footage job sesuai urutan: `$sumber` (satu video, job lama) atau `$sumber:<id>` (banyak)."""
    return [s for s in job.get("sumber", []) if isinstance(s, dict) and s.get("path")
            and (s.get("kunci") == "$sumber" or str(s.get("kunci", "")).startswith("$sumber:"))]


def periksa(path: Path) -> dict:
    """Durasi GAMBAR + ada suara atau tidak. Ditolak kalau bukan video."""
    if not path.exists():
        raise Ditolak(f"file video tidak ditemukan: {path.name}")
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        raise Ditolak(f"{path.name} tidak bisa dibaca sebagai video")
    info = json.loads(r.stdout)
    st = info.get("streams", [])
    vs = [s for s in st if s.get("codec_type") == "video"]
    if not vs:
        raise Ditolak(f"{path.name}: tidak ada gambar video")
    dur = float(vs[0].get("duration") or info.get("format", {}).get("duration") or 0)
    # Dibulatkan ke frame utuh di FPS hasil: titik sambung (bagian[].mulai_ms) tepat di frame, tidak bergeser.
    dur = max(round(dur * FPS), 1) / FPS
    if dur <= 0.1:
        raise Ditolak(f"{path.name}: video kosong")
    return {"durasi": dur, "suara": any(s.get("codec_type") == "audio" for s in st)}


def _sidik(daftar: list[dict]) -> str:
    h = hashlib.sha256()
    for s in daftar:
        p = Path(s["path"])
        st = p.stat()
        h.update(f"{s['kunci']}|{p.resolve()}|{st.st_size}|{st.st_mtime_ns}\n".encode())
    h.update(f"{LEBAR}x{TINGGI}@{FPS}/{RATE}".encode())
    return h.hexdigest()


def perintah(paths: list[Path], info: list[dict], keluar: Path) -> list[str]:
    """Satu ffmpeg: tiap bagian disamakan lalu `concat` (urutan = urutan daftar)."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin"]
    for p in paths:
        cmd += ["-i", str(p)]
    graf, label = [], []
    for i, f in enumerate(info):
        d = f"{f['durasi']:.3f}"
        # tpad: gambar yang sedikit lebih pendek dari angka durasinya diisi frame terakhir, jadi
        # tiap bagian PASTI sepanjang `d` dan suara bagian berikutnya tidak bergeser.
        graf.append(f"[{i}:v:0]setpts=PTS-STARTPTS,fps={FPS},tpad=stop_mode=clone:stop_duration=1,trim=duration={d},"
                    f"setpts=PTS-STARTPTS,"
                    f"scale={LEBAR}:{TINGGI}:force_original_aspect_ratio=increase,crop={LEBAR}:{TINGGI},"
                    f"setsar=1,format=yuv420p[v{i}]")
        if f["suara"]:
            graf.append(f"[{i}:a:0]aresample={RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
                        f"apad,atrim=duration={d},asetpts=PTS-STARTPTS[a{i}]")
        else:
            graf.append(f"anullsrc=r={RATE}:cl=stereo,atrim=duration={d},aformat=sample_fmts=fltp[a{i}]")
        label.append(f"[v{i}][a{i}]")
    graf.append(f"{''.join(label)}concat=n={len(info)}:v=1:a=1[v][a]")
    cmd += ["-filter_complex", ";".join(graf), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-movflags", "+faststart", str(keluar)]
    return cmd


def gabung(job: dict, out: Path, log=print) -> dict | None:
    """Gabungkan footage job ke out/gabungan.mp4. None kalau footage cuma satu (perilaku lama).

    Kembalikan {"path", "kunci", "bagian": [{kunci, nama, mulai_ms, durasi_ms, suara}], "durasi"}.
    Dipakai ulang kalau isi & urutan footage sama (engine ulang / Tetap lanjut tidak menggabung lagi)."""
    daftar = daftar_footage(job)
    if len(daftar) <= 1:
        return None
    if len(daftar) > MAKS_FOOTAGE:
        raise Ditolak(f"maksimal {MAKS_FOOTAGE} footage per video iklan (dipilih {len(daftar)})")
    if any(s["kunci"] == "$sumber" for s in daftar):
        raise Ditolak("footage banyak harus berkunci $sumber:<id>, bukan $sumber")
    paths = [Path(s["path"]) for s in daftar]
    info = [periksa(p) for p in paths]
    out.mkdir(parents=True, exist_ok=True)
    keluar, catatan = out / NAMA, out / "gabungan.json"
    sidik = _sidik(daftar)
    bagian, t = [], 0
    for s, p, f in zip(daftar, paths, info):
        ms = round(f["durasi"] * 1000)
        bagian.append({"kunci": s["kunci"], "nama": p.name, "mulai_ms": t, "durasi_ms": ms, "suara": f["suara"]})
        t += ms
    hasil = {"schema": "gabungan/1", "kunci": KUNCI, "path": str(keluar.resolve()).replace("\\", "/"),
             "bagian": bagian, "durasi": round(t / 1000, 3), "kanvas": [LEBAR, TINGGI], "fps": FPS, "sidik": sidik}
    lama = json.loads(catatan.read_text(encoding="utf-8")) if catatan.exists() else None
    if lama and lama.get("sidik") == sidik and keluar.exists():
        log(f"gabungan dipakai ulang ({len(bagian)} footage)")
        return hasil
    sementara = out / f".{NAMA}.tmp.mp4"
    r = subprocess.run(perintah(paths, info, sementara), capture_output=True, text=True)
    if r.returncode != 0:
        sementara.unlink(missing_ok=True)
        raise RuntimeError(f"gabung footage gagal: {r.stderr.strip()[-300:]}")
    sementara.replace(keluar)
    catatan.write_text(json.dumps(hasil, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return hasil


def pasang_di_ops(out: Path, hasil: dict) -> int:
    """Klip video `$sumber` di ops.json -> `$gabungan:video` + aset_lokal (diimpor aplikasi sebagai media proyek)."""
    p = out / "ops.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    n = 0
    for o in doc.get("ops", []):
        if isinstance(o, dict) and o.get("media") == "$sumber":
            o["media"] = hasil["kunci"]
            n += 1
    lokal = [a for a in doc.get("aset_lokal", []) if a.get("kunci") != hasil["kunci"]]
    doc["aset_lokal"] = lokal + [{"kunci": hasil["kunci"], "path": hasil["path"]}]
    p.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    r = json.loads((out / "rencana.json").read_text(encoding="utf-8"))
    r["sumber_gabungan"] = {k: hasil[k] for k in ("kunci", "bagian", "durasi", "kanvas", "fps")}
    (out / "rencana.json").write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return n
