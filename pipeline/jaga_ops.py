"""Pengaman ops sebelum ditulis ke ops.json (Generate Otomatis dan Batch Remix).

Motion Studio menolak klip yang 1 ms pun melebihi panjang file sumbernya ("Klip melebihi panjang
video sumber"). Kalau satu varian batch berisi klip seperti itu, Simpan keputusan gagal untuk SEMUA
varian (KORSET 14 Nov 2026: musik 26240 ms vs file 26237 ms). Maka setiap klip media dicocokkan
dengan panjang ASLI filenya (ffprobe), bukan angka hasil hitung/metadata:

- klip yang kelebihan dipendekkan sampai 1 frame di bawah akhir file;
- klip yang sisanya < MIN_CLIP_MS dibuang;
- setiap perubahan dicatat (dikembalikan sebagai daftar catatan untuk rencana/peringatan).

`cek_durasi` dipakai sebagai gerbang akhir: harus kosong setelah `jaga_durasi`.
"""

import functools
import subprocess
from pathlib import Path
from typing import Callable

SISA_MS = 34  # 1 frame @ 30 fps: aman dari pembulatan durasi file
MIN_CLIP_MS = 100


@functools.lru_cache(maxsize=1024)
def durasi_file_ms(path: str) -> int | None:
    """Panjang file (ms, dibulatkan ke bawah) menurut ffprobe; None kalau tidak terbaca."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return int(float(out) * 1000)
    except Exception:  # noqa: BLE001
        return None


def _batas(o: dict, path_of: Callable[[str], str | None]) -> int | None:
    """Durasi maksimum klip ini (ms) dari file sumbernya, atau None kalau tidak diketahui."""
    if o.get("op") != "add_clip" or not isinstance(o.get("media"), str):
        return None
    path = path_of(o["media"])
    if not path or not Path(path).is_file():
        return None
    d = durasi_file_ms(str(Path(path).resolve()))
    if d is None:
        return None
    return d - SISA_MS - int(o.get("in_ms") or 0)


def jaga_durasi(ops: list[dict], path_of: Callable[[str], str | None]) -> list[str]:
    """Rapikan `ops` di tempat. Kembalikan catatan perubahan (kosong = tidak ada yang diubah)."""
    catatan, sisa = [], []
    for o in ops:
        maks = _batas(o, path_of)
        if maks is not None and o["duration_ms"] > maks:
            if maks < MIN_CLIP_MS:
                catatan.append(f"klip {o['media']} di {o.get('start_ms', 0) / 1000:.1f} dtk dibuang: sumbernya habis")
                continue
            catatan.append(f"klip {o['media']} di {o.get('start_ms', 0) / 1000:.1f} dtk dipendekkan "
                           f"{o['duration_ms'] - maks} ms agar tidak melebihi sumber")
            o["duration_ms"] = maks
        sisa.append(o)
    ops[:] = sisa
    return catatan


def cek_durasi(ops: list[dict], path_of: Callable[[str], str | None]) -> list[str]:
    """Gerbang akhir: daftar klip yang masih melebihi sumbernya (harus kosong)."""
    return [f"{o['media']} di {o.get('start_ms', 0) / 1000:.1f} dtk melebihi sumber"
            for o in ops if (m := _batas(o, path_of)) is not None and o["duration_ms"] > m + SISA_MS]


def buang_teks_kosong(ops: list[dict]) -> list[str]:
    """Klip teks/subtitle tanpa isi (mis. CTA saat Brand Kit belum punya CTA) ditolak validator Motion
    Studio ("Teks wajib 1-500 karakter"). Dibuang di tempat; kembalikan catatan untuk peringatan rencana."""
    catatan, sisa = [], []
    for o in ops:
        if o.get("op") == "add_clip" and o.get("track_kind") in ("text", "subtitle") and not str(o.get("text") or "").strip():
            catatan.append(f"teks kosong di {o.get('start_ms', 0) / 1000:.1f} dtk dibuang (CTA Brand Kit belum diisi?)")
            continue
        if o.get("op") == "add_clip" and o.get("track_kind") in ("text", "subtitle") and len(str(o["text"])) > 500:
            o["text"] = str(o["text"])[:500]
            catatan.append(f"teks di {o.get('start_ms', 0) / 1000:.1f} dtk dipotong ke 500 karakter")
        sisa.append(o)
    ops[:] = sisa
    return catatan


def validasi_motion_studio(ops_json: Path, brand_kit_json: Path | None = None) -> str | None:
    """Gerbang akhir: uji ops.json dengan validator ASLI Motion Studio (validasi_ops.mjs: validateOps +
    applyOps). Kembalikan pesan tolak, atau None kalau lulus / validator tidak tersedia di mesin ini."""
    skrip = Path(__file__).resolve().parent / "validasi_ops.mjs"
    cmd = ["node", str(skrip), str(ops_json)] + (["--brand-kit", str(brand_kit_json)] if brand_kit_json else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except Exception:  # noqa: BLE001 - node tidak ada: gerbang dilewati, pengaman di atas tetap berlaku
        return None
    if r.returncode == 0:
        return None
    teks = (r.stderr or "") + (r.stdout or "")
    if "ERR_MODULE_NOT_FOUND" in teks or "Cannot find module" in teks:
        return None  # build Motion Studio tidak ada di mesin ini
    for baris in teks.splitlines():
        if "Error:" in baris:
            return baris.split("Error:", 1)[1].strip()[:200]
    return "ops ditolak validator Motion Studio"


def rapikan_kata(ops: list[dict]) -> list[str]:
    """Waktu per kata caption (`words`, relatif ke awal klip) harus urut, tidak tumpang tindih, dan di
    dalam klip. Pembulatan / kalimat yang dipotong bisa melanggarnya (KORSET varian-003: "paling" di luar
    0–520 ms) dan validator Motion Studio menolak seluruh varian. Dirapikan di tempat."""
    catatan = []
    for o in ops:
        words = o.get("words")
        if o.get("op") != "add_clip" or not isinstance(words, list) or not words:
            continue
        dur, t, baru, ubah = int(o["duration_ms"]), 0, [], False
        for w in words:
            a, b = int(w.get("start_ms", 0)), int(w.get("end_ms", 0))
            a2 = max(a, t)
            if a2 >= dur:  # kata mulai di/luar akhir klip: dibuang (bukan dijepit, itu menumpuk)
                ubah = True
                continue
            b2 = min(max(b, a2 + 1), dur)
            if (a2, b2) != (a, b):
                ubah = True
            baru.append({**w, "start_ms": a2, "end_ms": b2})
            t = b2
        if ubah:
            o["words"] = baru
            catatan.append(f"waktu kata caption di {o.get('start_ms', 0) / 1000:.1f} dtk dirapikan")
    return catatan
