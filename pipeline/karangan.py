"""Buang karangan Whisper (halusinasi) dari transkrip per kata. Dipakai transcribe.py; keluhan owner 27 Nov."""


# Kalimat karangan Whisper yang sering muncul di bagian tanpa ucapan (dari data latih subtitle YouTube).
# Hanya dibuang kalau frasanya utuh (dibandingkan tanpa huruf besar & tanda baca).
KARANGAN = [
    "terima kasih telah menonton", "terima kasih sudah menonton", "terima kasih telah menyaksikan",
    "terima kasih sudah menyaksikan", "selamat menonton", "selamat menikmati",
    "sampai jumpa di video selanjutnya", "sampai jumpa di video berikutnya", "jangan lupa like dan subscribe",
    "jangan lupa subscribe", "subtitle oleh", "diterjemahkan oleh", "thanks for watching", "thank you for watching",
]


def _n(t: str) -> str:
    return "".join(c for c in t.lower() if c.isalnum())


def bersihkan(words: list[dict], maks_ulang: int) -> dict:
    """Buang karangan Whisper dari daftar kata (di tempat). Kembalikan ringkasan yang dibuang.

    - frasa KARANGAN utuh;
    - pengulangan beruntun frasa yang sama (1-6 kata) lebih dari `maks_ulang` kali: sisanya dibuang
      ("aku baru aja, aku baru aja, ..." x10 -> maks_ulang kali). Ulang ucap asli jarang > 2-3 kali;
    - "kata" yang hanya angka/titik berderet ("5. 5. 5. 4") lebih dari 3 berturut-turut."""
    dibuang = {"karangan": 0, "ulang": 0, "angka": 0}
    # 1. frasa karangan
    for fr in KARANGAN:
        target = fr.split()
        k = len(target)
        i = 0
        while i + k <= len(words):
            if [_n(w["text"]) for w in words[i:i + k]] == [_n(x) for x in target]:
                del words[i:i + k]
                dibuang["karangan"] += k
            else:
                i += 1
    # 2. deretan angka/titik tanpa huruf
    i = 0
    while i < len(words):
        j = i
        while j < len(words) and _n(words[j]["text"]).isdigit() or (j < len(words) and _n(words[j]["text"]) == ""):
            j += 1
        if j - i > 3:
            dibuang["angka"] += j - i
            del words[i:j]
        else:
            i = max(j, i + 1)
    # 3. pengulangan beruntun
    for n in range(6, 0, -1):
        i = 0
        while i + n <= len(words):
            blok = [_n(w["text"]) for w in words[i:i + n]]
            ulang, j = 1, i + n
            while j + n <= len(words) and [_n(w["text"]) for w in words[j:j + n]] == blok:
                ulang, j = ulang + 1, j + n
            if ulang > maks_ulang and any(blok):
                hapus_dari = i + n * maks_ulang
                dibuang["ulang"] += j - hapus_dari
                del words[hapus_dari:j]
            i += 1
    return {k: v for k, v in dibuang.items() if v}
