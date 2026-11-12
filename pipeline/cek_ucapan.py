"""Cek apakah hasil transkrip benar-benar berisi orang bicara.

Whisper "mengarang" teks kalau videonya hanya musik: muncul "Terima kasih telah
menonton!", "Intro", "Muzik", dll. (uji 13 Nov 2026: 7 dari 16 video). Modul ini
menolak video seperti itu sebelum rencana edit dibuat, dan memberi peringatan
kalau ucapannya kebanyakan bukan bahasa Indonesia (mis. lirik lagu Inggris).

Pakai:
  .venv\\Scripts\\python pipeline\\cek_ucapan.py out\\ujiA01\\transkrip.json
"""

import json
import re
import sys
from pathlib import Path

# Kalimat yang sering dikarang Whisper pada bagian tanpa ucapan.
HALUSINASI = [
    "terima kasih telah menonton",
    "terima kasih sudah menonton",
    "terima kasih",
    "sampai jumpa",
    "jangan lupa subscribe",
    "jangan lupa like",
    "selamat menonton",
    "subtitle",
    "muzik",
    "musik",
    "intro",
    "outro",
]
MIN_KATA = 8  # kurang dari ini setelah halusinasi dibuang = tidak ada ucapan
MIN_KATA_PER_DETIK = 0.6  # orang bicara biasanya 2-3 kata/detik
INGGRIS = {
    "the", "a", "an", "is", "are", "was", "i", "you", "my", "me", "it", "this", "that", "with",
    "to", "of", "and", "in", "on", "for", "just", "like", "how", "your", "we", "be", "do",
    "don't", "can", "so", "out", "up", "what", "all", "keep", "wanna", "gonna", "here", "night",
}
MAKS_RASIO_INGGRIS = 0.35


def _norm(t: str) -> str:
    return re.sub(r"[^\w']+", "", t.lower())


def _buang_halusinasi(words):
    """Kembalikan kata yang bukan bagian dari frasa halusinasi."""
    toks = [_norm(w["text"]) for w in words]
    buang = [False] * len(words)
    for frasa in sorted(HALUSINASI, key=lambda f: -len(f.split())):
        f = frasa.split()
        for i in range(len(toks) - len(f) + 1):
            if not any(buang[i : i + len(f)]) and toks[i : i + len(f)] == f:
                for k in range(i, i + len(f)):
                    buang[k] = True
    return [w for w, b in zip(words, buang) if not b and _norm(w["text"])]


def cek_ucapan(tr: dict) -> dict:
    """Hasil: {"status": "ok"|"ditolak"|"peringatan", "alasan": str, ...angka}."""
    words = tr.get("words", [])
    durasi = max(tr.get("durationMs", 0) / 1000, 0.001)
    asli = _buang_halusinasi(words)
    kps = len(asli) / durasi
    hasil = {
        "kata_total": len(words),
        "kata_asli": len(asli),
        "kata_per_detik": round(kps, 2),
        "rasio_inggris": 0.0,
    }
    if len(asli) < MIN_KATA or kps < MIN_KATA_PER_DETIK:
        contoh = " ".join(w["text"] for w in words)[:60] or "(kosong)"
        hasil.update(
            status="ditolak",
            alasan=f"tidak ada ucapan terdeteksi ({len(asli)} kata asli dalam {durasi:.0f} dtk; "
            f"teks Whisper: \"{contoh}\"). Kemungkinan video hanya musik.",
        )
        return hasil
    inggris = sum(1 for w in asli if _norm(w["text"]) in INGGRIS)
    rasio = inggris / len(asli)
    hasil["rasio_inggris"] = round(rasio, 2)
    if rasio > MAKS_RASIO_INGGRIS:
        hasil.update(
            status="peringatan",
            alasan=f"ucapan kebanyakan bukan bahasa Indonesia ({rasio:.0%} kata Inggris umum), "
            "mungkin lirik lagu. Periksa sebelum dipakai.",
        )
        return hasil
    hasil.update(status="ok", alasan="")
    return hasil


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    for p in sys.argv[1:]:
        h = cek_ucapan(json.loads(Path(p).read_text(encoding="utf-8")))
        print(f"{p}: {h['status']} {h['alasan']}".rstrip())


if __name__ == "__main__":
    main()
