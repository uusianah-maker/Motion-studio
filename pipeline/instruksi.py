"""Instruksi tim dari `brief.catatan` (job.json) -> aturan buang yang sudah ada di mesin.

Keluhan tim 24 Nov 2026: prompt tim tidak pernah dibaca mesin. Modul ini hanya ATURAN (tanpa AI, tanpa
jaringan). Kalimat yang dikenali dipetakan ke mekanisme buang yang sama dengan `--buang` / `koreksi.buang`;
kalimat lain TIDAK diabaikan diam-diam: dilaporkan sebagai "otomatis" (memang sudah dikerjakan mesin, mis.
buang jeda) atau "tidak_dipahami" supaya app bisa menampilkannya dan tim mengerjakannya manual di editor.

Dikenali:
  jangan pakai / buang / hapus / tanpa / skip / lewati  footage|video|klip N[, M dan K]   (juga "ke-2", "kedua", "terakhir")
  hanya / cuma / cukup  pakai  footage N[, M]
  buang / hapus / potong / jangan pakai  kalimat|kata|bagian|ucapan  "teks" ['teks2' ...]   (teks wajib dalam tanda kutip)
"""

import re

KATA_FOOTAGE = r"(?:footage|video|klip|clip|file|rekaman)"
URUTAN = {"pertama": 1, "kesatu": 1, "kedua": 2, "ketiga": 3, "keempat": 4, "kelima": 5, "keenam": 6,
          "ketujuh": 7, "kedelapan": 8, "kesembilan": 9, "kesepuluh": 10, "terakhir": -1}
_NOMOR = r"(?:ke-?\s*)?(?:\d+|" + "|".join(URUTAN) + r")"
_DAFTAR = _NOMOR + r"(?:\s*(?:,|&|dan|serta)\s*(?:" + KATA_FOOTAGE + r"\s*)?" + _NOMOR + r")*"
RE_JANGAN = re.compile(r"\b(?:jangan\s+(?:di)?(?:pakai|gunakan|masukkan|masukin|ambil|pake)|buang|hapus|tanpa|skip|lewati|"
                       r"tidak\s+usah\s+(?:pakai|pake))\s+(?:(?:bagian|semua|seluruh)\s+)?" + KATA_FOOTAGE
                       + r"\s*(" + _DAFTAR + r")", re.I)
RE_HANYA = re.compile(r"\b(?:hanya|cuma|cukup|pakai\s+hanya)\s+(?:(?:pakai|pake|gunakan|ambil)\s+)?" + KATA_FOOTAGE
                      + r"\s*(" + _DAFTAR + r")", re.I)
RE_FRASA = re.compile(r"\b(?:buang|hapus|potong|jangan\s+(?:di)?(?:pakai|pake|masukkan|tampilkan))\s+(?:semua\s+)?"
                      r"(kalimat|kata|bagian|ucapan|frasa)\b", re.I)
RE_KUTIP = re.compile(r"[\"“”]([^\"“”]+)[\"“”]|[‘’']([^‘’']+)[‘’']")
# Sudah dikerjakan mesin tanpa diminta (laporkan, jangan dianggap gagal dipahami).
RE_OTOMATIS = [
    (re.compile(r"\b(?:gabung\w*|satukan|sambung\w*)\b.*\b" + KATA_FOOTAGE, re.I),
     "footage digabung berurutan (§26)"),
    (re.compile(r"\b(?:hapus|buang|potong|hilangkan)\b.*\b(?:jeda|diam|hening|pengulangan|diulang|ulang|kesalahan|salah\s+(?:bicara|ucap)|"
                r"eee|emm|filler|pengisi)", re.I),
     "jeda, kata pengisi, dan take ulang dibuang otomatis"),
]


def _nomor(teks: str, n_footage: int) -> list[int]:
    out = []
    for m in re.finditer(r"(\d+)|(" + "|".join(URUTAN) + r")", teks, re.I):
        v = int(m.group(1)) if m.group(1) else URUTAN[m.group(2).lower()]
        out.append(n_footage if v == -1 else v)
    return list(dict.fromkeys(out))


def pecah_kalimat(teks: str) -> list[str]:
    """Pecah catatan per baris / akhir kalimat, tanpa memecah teks di dalam tanda kutip."""
    out, cur, kutip = [], [], None
    pasangan = {'"': '"', "“": "”", "'": "'", "‘": "’"}
    for i, ch in enumerate(teks):
        if kutip:
            cur.append(ch)
            if ch == kutip or (kutip == '"' and ch == "”"):
                kutip = None
            continue
        if ch in pasangan and (ch not in "'’" or i == 0 or not teks[i - 1].isalnum()):
            kutip = pasangan[ch]
            cur.append(ch)
            continue
        if ch == "\n" or (ch in ".!?;" and (i + 1 >= len(teks) or teks[i + 1].isspace())):
            if ch != "\n":
                cur.append(ch)
            s = "".join(cur).strip()
            if s:
                out.append(s)
            cur = []
            continue
        cur.append(ch)
    s = "".join(cur).strip()
    if s:
        out.append(s)
    return out


def baca(catatan: str, n_footage: int) -> dict:
    """-> {"buang_footage": [no...], "hanya_footage": [no...] | None, "buang_frasa": [(jenis, teks, kalimat)],
          "dipahami": [...], "otomatis": [...], "tidak_dipahami": [...]}. Nomor footage 1-based."""
    hasil = {"buang_footage": [], "hanya_footage": None, "buang_frasa": [], "dipahami": [], "otomatis": [],
             "tidak_dipahami": []}
    for kal in pecah_kalimat(catatan or ""):
        paham = False
        for m in RE_JANGAN.finditer(kal):
            nos = _nomor(m.group(1), n_footage)
            salah = [n for n in nos if not 1 <= n <= n_footage]
            if salah:
                hasil["tidak_dipahami"].append({"kalimat": kal, "alasan": f"footage {', '.join(map(str, salah))} tidak ada "
                                                f"(job ini punya {n_footage} footage)"})
                paham = True
                continue
            hasil["buang_footage"] += nos
            hasil["dipahami"].append({"kalimat": kal, "aksi": "buang_footage", "footage": nos})
            paham = True
        for m in RE_HANYA.finditer(kal):
            nos = _nomor(m.group(1), n_footage)
            salah = [n for n in nos if not 1 <= n <= n_footage]
            if salah or not nos:
                hasil["tidak_dipahami"].append({"kalimat": kal, "alasan": f"footage {', '.join(map(str, salah))} tidak ada "
                                                f"(job ini punya {n_footage} footage)"})
                paham = True
                continue
            hasil["hanya_footage"] = sorted(set(hasil["hanya_footage"] or []) | set(nos))
            hasil["dipahami"].append({"kalimat": kal, "aksi": "hanya_footage", "footage": nos})
            paham = True
        m = RE_FRASA.search(kal)
        if m:
            kutip = [a or b for a, b in RE_KUTIP.findall(kal[m.end():])]
            kutip = [k.strip() for k in kutip if k.strip()]
            for k in kutip:
                hasil["buang_frasa"].append((m.group(1).lower(), k, kal))
            paham = paham or bool(kutip)
        if paham:
            continue
        auto = next((c for r, c in RE_OTOMATIS if r.search(kal)), None)
        if auto:
            hasil["otomatis"].append({"kalimat": kal, "catatan": auto})
        elif m:
            hasil["tidak_dipahami"].append({"kalimat": kal, "alasan": "teks yang dibuang harus ditulis dalam tanda kutip, "
                                            "mis. buang kalimat \"...\""})
        else:
            hasil["tidak_dipahami"].append({"kalimat": kal, "alasan": "belum ada aturan mesin untuk instruksi ini; "
                                            "kerjakan manual di editor"})
    hasil["buang_footage"] = sorted(set(hasil["buang_footage"]))
    return hasil


def rentang_footage(bagian: list[dict], nos: list[int]) -> list[tuple[int, int, int]]:
    """(no, mulai_ms, akhir_ms) di timeline sumber untuk footage nomor `nos` (1-based)."""
    out = []
    for n in nos:
        if 1 <= n <= len(bagian):
            b = bagian[n - 1]
            out.append((n, int(b["mulai_ms"]), int(b["mulai_ms"]) + int(b["durasi_ms"])))
    return out
