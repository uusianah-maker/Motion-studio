"""Cek apakah naskah / transkrip baru terlalu mirip dengan video yang sudah pernah terbit.

Aturan TikTok yang dikejar: "naskah segar untuk setiap postingan". Skrip ini hanya membandingkan
KATA-KATA (naskah), bukan gambar. Ia tidak dipakai untuk menyiasati deteksi visual; kalau hasilnya
TOLAK, perbaikannya adalah menulis dan merekam naskah baru, bukan mengedit ulang file lama.

Pakai:
  # setelah video terbit: catat naskahnya ke arsip
  .venv\\Scripts\\python pipeline\\cek_orisinal.py catat out\\a3\\transkrip.json --id a3 --catatan "celana, winning Okt"

  # sebelum rekam (naskah .txt/.md) atau sebelum render (transkrip .json): bandingkan dengan arsip
  .venv\\Scripts\\python pipeline\\cek_orisinal.py cek out\\baru\\naskah_1.txt
  .venv\\Scripts\\python pipeline\\cek_orisinal.py cek out\\baru\\transkrip.json --banding out\\lama\\transkrip.json

Exit code: 0 OK, 1 HATI-HATI, 2 TOLAK (atau error).
"""

import argparse
import json
import os
import re
import sys
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

# R20: arsip naskah terbit = data, bukan kode (MOTION_ENGINE_DATA; tanpa env = root repo seperti dulu).
ARSIP = (Path(os.environ["MOTION_ENGINE_DATA"]).resolve() if os.environ.get("MOTION_ENGINE_DATA")
         else Path(__file__).resolve().parent.parent) / "arsip" / "terbit"
BATAS_TOLAK = 0.60    # kemiripan urutan kata >= 60%: naskah dianggap sama  [SEMENTARA]
BATAS_HATI = 0.40     # 40-60%: terlalu banyak kalimat yang sama            [SEMENTARA]
FRASA_PANJANG = 8     # 8+ kata berurutan yang identik dilaporkan sebagai frasa yang dipakai ulang
PENGISI = {"eee", "ee", "emm", "em", "hmm", "eh", "ehm", "nah", "ya", "yah", "oke", "ok", "guys", "jadi", "tuh", "sih",
           "deh", "dong", "kan", "lho", "loh"}


def kata_dari_file(path: Path) -> list[str]:
    """Kata ternormalisasi dari transkrip (.json hasil transcribe.py) atau naskah teks (.txt/.md)."""
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        words = data.get("words") if isinstance(data, dict) else data
        if not isinstance(words, list):
            raise ValueError(f"{path}: tidak ada daftar 'words'")
        teks = " ".join(str(w.get("text", "")) for w in words if isinstance(w, dict))
    else:
        teks = path.read_text(encoding="utf-8")
    teks = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", teks)  # buang catatan sutradara [..] / (..) di naskah
    hasil = [w for w in re.findall(r"[0-9a-zA-ZÀ-ɏ]+", teks.lower()) if w not in PENGISI]
    return hasil


def bandingkan(a: list[str], b: list[str]) -> tuple[float, list[str]]:
    """(rasio kemiripan urutan kata 0..1, frasa identik terpanjang)."""
    if not a or not b:
        return 0.0, []
    sm = SequenceMatcher(None, a, b, autojunk=False)
    blok = max(sm.get_matching_blocks(), key=lambda m: m.size)
    return sm.ratio(), a[blok.a: blok.a + blok.size]


def putusan(rasio: float) -> str:
    return "TOLAK" if rasio >= BATAS_TOLAK else "HATI-HATI" if rasio >= BATAS_HATI else "OK"


def cmd_catat(args) -> int:
    src = Path(args.file)
    kata = kata_dari_file(src)
    if len(kata) < 5:
        print(f"error: naskah terlalu pendek ({len(kata)} kata)", file=sys.stderr)
        return 2
    ARSIP.mkdir(parents=True, exist_ok=True)
    tujuan = ARSIP / f"{re.sub(r'[^0-9A-Za-z_-]+', '_', args.id)}.json"
    if tujuan.exists() and not args.timpa:
        print(f"error: {tujuan.name} sudah ada (pakai --timpa untuk mengganti)", file=sys.stderr)
        return 2
    tujuan.write_text(json.dumps({"id": args.id, "tanggal": args.tanggal or date.today().isoformat(),
                                  "catatan": args.catatan or "", "sumber": str(src), "kata": kata},
                                 ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"dicatat: {tujuan} ({len(kata)} kata)")
    return 0


def cmd_cek(args) -> int:
    baru = kata_dari_file(Path(args.file))
    if len(baru) < 5:
        print(f"error: naskah terlalu pendek ({len(baru)} kata)", file=sys.stderr)
        return 2
    pembanding: list[tuple[str, list[str]]] = []
    if ARSIP.is_dir():
        for p in sorted(ARSIP.glob("*.json")):
            d = json.loads(p.read_text(encoding="utf-8"))
            pembanding.append((f"arsip:{d.get('id', p.stem)}", d.get("kata", [])))
    for f in args.banding or []:
        pembanding.append((f"banding:{Path(f).name}", kata_dari_file(Path(f))))
    if not pembanding:
        print("PERINGATAN: arsip kosong dan tidak ada --banding. Tidak ada yang bisa dibandingkan.")
        return 1
    hasil = sorted(((nama, *bandingkan(baru, k)) for nama, k in pembanding), key=lambda x: -x[1])
    terburuk = hasil[0][1]
    print(f"Naskah baru: {len(baru)} kata. Dibandingkan dengan {len(hasil)} naskah.")
    for nama, rasio, frasa in hasil[:args.top]:
        teks = " ".join(frasa)
        frasa_info = f" | frasa sama terpanjang ({len(frasa)} kata): \"{teks[:90]}\"" if len(frasa) >= 4 else ""
        print(f"  {putusan(rasio):9} {rasio * 100:5.1f}%  {nama}{frasa_info}")
    panjang = [f for _, _, f in hasil if len(f) >= FRASA_PANJANG]
    p = putusan(terburuk)
    print(f"PUTUSAN: {p} (kemiripan tertinggi {terburuk * 100:.0f}%; batas HATI-HATI {BATAS_HATI * 100:.0f}%, "
          f"TOLAK {BATAS_TOLAK * 100:.0f}%)")
    if panjang:
        print(f"Catatan: ada {len(panjang)} naskah yang berbagi frasa >= {FRASA_PANJANG} kata identik. "
              "Tulis ulang kalimat itu dengan kata-kata sendiri.")
    if p == "TOLAK":
        print("Perbaikan: tulis naskah baru (hook, urutan, dan kalimat berbeda), lalu rekam ulang. "
              "Jangan mengedit file lama untuk lolos.")
    return {"OK": 0, "HATI-HATI": 1, "TOLAK": 2}[p]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("catat", help="simpan naskah video yang sudah terbit ke arsip")
    c.add_argument("file")
    c.add_argument("--id", required=True)
    c.add_argument("--tanggal")
    c.add_argument("--catatan")
    c.add_argument("--timpa", action="store_true")
    k = sub.add_parser("cek", help="bandingkan naskah/transkrip baru dengan arsip")
    k.add_argument("file")
    k.add_argument("--banding", nargs="*", help="transkrip/naskah lain untuk dibandingkan (mis. video winning)")
    k.add_argument("--top", type=int, default=5)
    args = ap.parse_args()
    try:
        return cmd_catat(args) if args.cmd == "catat" else cmd_cek(args)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
