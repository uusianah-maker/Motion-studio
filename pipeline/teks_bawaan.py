"""G2: hook Generate tidak boleh menimpa teks bawaan video sumber (keputusan owner 14 Nov malam).

Mesin membaca teks di layar pada rentang hook (OCR RapidOCR yang sama dengan Shot Library Batch Remix),
lalu memilih posisi hook yang kosong. Kalau tidak ada tempat kosong, hook dilewati dan rencana
memberi peringatan. Hybrid: posisi hook pilihan tim (--hook-top) selalu menang, dan hook tetap bisa
digeser atau dihapus di editor.

OCR butuh Python Batch Remix (OpenCV + RapidOCR), jadi bagian baca teks dijalankan sebagai proses anak:
  <BATCH_PY> pipeline/teks_bawaan.py <video> <dari_detik> <sampai_detik>
  -> stdout {"kotak": [[x, y, w, h], ...]}  (pecahan frame; watermark TikTok & footer tidak dihitung)
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Posisi atas panel hook yang dicoba, urut dari yang paling disukai (bawaan 0.30).
KANDIDAT_TOP = [0.30, 0.18, 0.10, 0.48, 0.56]
TINGGI_HOOK = 0.12  # perkiraan tinggi panel hook 2 baris (HOOK_SIZE 7 % + kotak kaca)
JARAK = 0.015
BATAS_BAWAH = 0.85  # tombol TikTok/Reels
TEKS_KECIL = 0.025  # teks latar kecil (judul buku, poster) tidak dihindari, sama dengan Shot Library


def wajah_di(video: str, rentang: list) -> list:
    """Rentang vertikal wajah (y0, y1) di rentang hook (waktu sumber). OpenCV Haar dari posisi_caption."""
    from posisi_caption import deteksi_wajah, sampel_frame

    akhir = max(b for _, b in rentang)
    frames = sampel_frame(video, 0.5, maks=int(akhir * 2) + 1)
    pilih = [f for i, f in enumerate(frames) if any(a - 0.25 <= i / 2 <= b for a, b in rentang)]
    return [r for per in deteksi_wajah(pilih) for r in per]


def teks_penting(kotak: list) -> list:
    """Teks yang harus dihindari: tinggi >= 2,5 % frame, atau lebar >= 20 % (label tipis panjang, mis.
    "Fitted Dress x With Corset Pants" setinggi 1,6 %). Judul buku/poster kecil di latar tidak dihitung."""
    return [k for k in kotak if k[3] >= TEKS_KECIL or k[2] >= 0.20]


def _bentrok(top: float, rentang: list, caption_y: float | None) -> bool:
    """rentang = [(y0, y1), ...] vertikal yang tidak boleh ditimpa panel hook."""
    a, b = top - JARAK, top + TINGGI_HOOK + JARAK
    if b > BATAS_BAWAH:
        return True
    if caption_y is not None and a < caption_y + 0.07 and b > caption_y - 0.07:
        return True
    return any(y0 < b and y1 > a for y0, y1 in rentang)


def pilih_top(kotak: list, caption_y: float | None = None, wajah: list | None = None) -> tuple[float | None, bool]:
    """(posisi atas hook, menghindari wajah juga?). Teks bawaan wajib dihindari; wajah diusahakan.
    None = tidak ada tempat tanpa menimpa teks."""
    teks = [(k[1], k[1] + k[3]) for k in teks_penting(kotak)]
    wajah = list(wajah or [])
    for rentang, juga_wajah in ((teks + wajah, True), (teks, False)):
        for top in KANDIDAT_TOP:
            if not _bentrok(top, rentang, caption_y):
                return top, juga_wajah and bool(wajah)
    return None, False


def atur_hook(hook: dict, kotak: list, caption_y: float | None,
              wajah: list | None = None) -> tuple[dict | None, str | None]:
    """Kembalikan (hook baru atau None kalau dilewati, catatan untuk rencana)."""
    if not teks_penting(kotak) and not wajah:
        return hook, None
    top, hindari_wajah = pilih_top(kotak, caption_y, wajah)
    if top is None:
        return None, ("hook dilewati: teks bawaan video memenuhi layar di detik awal; "
                      "tambahkan hook manual di editor kalau tetap perlu")
    bawaan = hook.get("top") or 0.30
    if abs(top - bawaan) < 1e-9:
        return hook, None
    alasan = "teks bawaan video" + (" dan wajah" if hindari_wajah else "") if teks_penting(kotak) else "wajah"
    return {**hook, "top": top}, f"hook digeser ke posisi {top:.2f} supaya tidak menimpa {alasan}"


def baca_kotak(video: str, dari: float, sampai: float, python: str | None = None, timeout: int = 120,
               rentang: list | None = None) -> list:
    """Kotak teks bawaan di rentang [dari, sampai] detik waktu sumber (proses anak Python Batch Remix).
    `rentang` = beberapa [dari, sampai] (hook melintasi beberapa potongan); menggantikan dari/sampai."""
    if python is None:
        # jalur.py dimuat dari path file supaya sys.path proses utama tidak diubah (nama modul batch bentrok).
        import importlib.util

        spec = importlib.util.spec_from_file_location("_jalur_batch", HERE / "batch" / "jalur.py")
        jalur = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(jalur)
        python = str(jalur.BATCH_PY)
    args = [f"{x:.2f}" for ab in (rentang or [(dari, sampai)]) for x in ab]
    r = subprocess.run([python, str(Path(__file__).resolve()), video, *args],
                       capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "OCR gagal").strip()[-300:])
    return json.loads(r.stdout.strip().splitlines()[-1])["kotak"]


def _frame(video: str, detik: float):
    import numpy as np

    w, h = 540, 960
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{detik:.2f}", "-i", video, "-frames:v", "1",
                          "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, check=True).stdout
    if len(raw) < w * h * 3:
        return None
    return np.frombuffer(raw[: w * h * 3], dtype=np.uint8).reshape(h, w, 3)


def _main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    video = sys.argv[1]
    angka = [float(x) for x in sys.argv[2:]]
    rentang = list(zip(angka[::2], angka[1::2]))
    sys.path.insert(0, str(HERE / "batch"))
    from shotlib import ocr_frame, pilah_teks  # noqa: E402  (modul yuki, hanya diimpor)

    total = sum(b - a for a, b in rentang) or 1
    titik = []
    for a, b in rentang:  # 3-6 sampel, dibagi sebanding panjang tiap rentang (minimal 1 per rentang)
        n = max(1, round(4 * (b - a) / total))
        titik += [a + (b - a) * (i + 0.5) / n for i in range(n)]
    kotak = []
    for t in titik:
        f = _frame(video, t)
        if f is None:
            continue
        _, _, lain = pilah_teks(ocr_frame(f))
        kotak += [it["kotak"] for it in lain]
    print(json.dumps({"kotak": kotak}))


if __name__ == "__main__":
    _main()
