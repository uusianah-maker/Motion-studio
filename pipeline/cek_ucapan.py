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
    # Tambahan G1 (audit 14 Nov): lirik campur Indonesia-Inggris lolos di 32 %. Kata fungsi + kata lirik umum.
    # Sengaja tanpa kata fashion yang biasa dipakai kreator Indonesia (look, size, style, outfit, fit).
    "i'm", "im", "will", "one", "day", "know", "please", "say", "time", "now", "dont", "love", "hi", "baby",
    "boy", "girl", "oh", "yeah", "mine", "us", "our", "they", "she", "he", "her", "his", "when", "where", "why",
    "who", "never", "ever", "always", "want", "need", "feel", "heart", "tonight", "go", "come", "get", "got",
    "let", "it's", "can't", "won't", "there", "if", "but", "or", "not", "at", "by", "from", "as", "have", "has",
    "had", "been", "were", "would", "could", "should", "said", "tell", "see", "take", "give", "think", "eyes",
    "waste", "ask", "am", "cause", "ooh", "la",
}
# Kata Indonesia yang hampir pasti muncul kalau orang bicara bahasa Indonesia (lirik bahasa lain: Spanyol, Korea).
INDONESIA = {
    "aku", "kamu", "ini", "itu", "yang", "dan", "di", "ke", "ya", "nggak", "gak", "ga", "enggak", "banget", "buat",
    "dari", "ada", "bisa", "mau", "jadi", "sama", "juga", "udah", "sudah", "kalau", "kalo", "kok", "deh", "sih",
    "nih", "dong", "aja", "lagi", "pakai", "pake", "punya", "kita", "dia", "untuk", "dengan", "tapi", "karena",
    "lho", "loh", "kan", "apa", "kalian", "bahannya", "nyaman", "adem", "cek", "keranjang", "harga", "murah",
}
MIN_RASIO_INDONESIA = 0.08
MAKS_RASIO_INGGRIS = 0.35
PROB_RENDAH = 0.3
MAKS_RASIO_RAGU = 0.30
MAKS_RASIO_ANGKA = 0.30


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
    # Transkrip "sampah": banyak kata yang Whisper sendiri tidak yakin, atau isinya angka/hitungan.
    # Data 13 Nov 2026: ucapan asli <= 16% kata ragu; rekaman try-on dengan arahan dari belakang
    # kamera (DJI 0017) 40% ragu + 64% token angka ("1번, 2, 05, 05 ...").
    rendah = sum(1 for w in asli if w.get("prob", 1) < PROB_RENDAH) / len(asli)
    angka = sum(1 for w in asli if any(ch.isdigit() for ch in w["text"])) / len(asli)
    hasil.update(rasio_ragu=round(rendah, 2), rasio_angka=round(angka, 2))
    if rendah > MAKS_RASIO_RAGU or angka > MAKS_RASIO_ANGKA:
        hasil.update(
            status="ditolak",
            alasan=f"transkrip tidak meyakinkan ({rendah:.0%} kata ragu, {angka:.0%} angka). Kemungkinan bukan orang "
            "bicara ke kamera (mis. musik, hitungan, atau arahan pengambilan gambar). Cocok untuk jalur VO/Batch Remix.",
        )
        return hasil
    inggris = sum(1 for w in asli if _norm(w["text"]) in INGGRIS)
    rasio = inggris / len(asli)
    hasil["rasio_inggris"] = round(rasio, 2)
    indo = sum(1 for w in asli if _norm(w["text"]) in INDONESIA) / len(asli)
    hasil["rasio_indonesia"] = round(indo, 2)
    # jenis "lirik": Generate menolaknya kecuali job memilih "tetap lanjut" (hybrid: keputusan manual menang).
    if rasio > MAKS_RASIO_INGGRIS:
        hasil.update(
            status="peringatan", jenis="lirik",
            alasan=f"ucapan kebanyakan bukan bahasa Indonesia ({rasio:.0%} kata Inggris umum), "
            "kemungkinan lirik lagu. Periksa sebelum dipakai.",
        )
        return hasil
    if indo < MIN_RASIO_INDONESIA:
        hasil.update(
            status="peringatan", jenis="lirik",
            alasan=f"hampir tidak ada kata bahasa Indonesia ({indo:.0%}), kemungkinan lirik lagu atau bahasa lain. "
            "Periksa sebelum dipakai.",
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
