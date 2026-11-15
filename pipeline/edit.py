"""Rencana edit lengkap untuk satu video talking head bergaya brand.

Pakai:
  .venv\\Scripts\\python pipeline\\edit.py out\\a3\\transkrip.json ^
      --brandkit brandkit\\aysilla.json --video masuk/a3.mp4 --out out\\a3 --placement tiktok

Langkah: koreksi kamus kata -> sensor superlatif -> auto-cut -> kata kunci
(maks 1 per layar) -> judul hook -> rencana efek (maks 3 jenis) -> SFX -> CTA.

Menulis:
  <out>/potongan.json  potongan + bagian dibuang + keraguan (untuk dicek manusia)
  <out>/props.json     input composition AdVideo
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

from autocut import FPS, merge_split_words, run_cut, strip_internal
from cek_ucapan import cek_ucapan
from brandkit import muat as muat_brand_kit
from posisi_caption import posisi_otomatis
from teks_bawaan import atur_hook, baca_kotak, wajah_di
from ops import susun as susun_ops, tulis as tulis_ops
from jaga_ops import buang_teks_kosong, cek_durasi, jaga_durasi, rapikan_kata, validasi_motion_studio

MAX_WORDS_PER_PAGE = 3
PAGE_GAP_MS = 250  # jeda antar kata yang memaksa halaman caption baru
PAGE_MAX_MS = 1600
KEYWORD_SPACING_MS = 1500  # kata kunci tidak boleh lebih rapat dari ini
HOOK_MAX_WORDS = 6
HOOK_MAX_MS = 3000
HOOK_DANGLING = {"yang", "dan", "buat", "untuk", "di", "ke", "dari", "tuh", "itu", "ini", "atau", "tapi", "karena", "sama", "dengan", "jadi", "kalau"}
HOOK_STARTERS = {"ini", "kan", "jadi", "nah", "oke", "ok", "guys", "hai", "halo", "eh", "ya"}
EFFECT_SPACING_MS = 5000
FRAMING_EVERY_MS = 3000  # ganti framing tiap ~3 detik
FRAMING_ZOOM = 1.07
SFX_SPACING_MS = 2000
SCENE_THRESHOLD = 0.3

NUMBER_WORDS = {
    "nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan",
    "sepuluh", "sebelas", "seratus", "seribu", "sejuta", "belas", "puluh", "ratus", "ribu",
    "juta", "setengah", "persen", "rupiah", "rp", "rb", "jt",
}


def norm(text: str) -> str:
    return re.sub(r"[^\w]+", "", text.lower())


def trailing_punct(text: str) -> str:
    m = re.search(r"[.,?!;:]+$", text)
    return m.group(0) if m else ""


def find_phrase(words, phrase: str):
    """Semua posisi (i, n) di mana `phrase` (boleh multi-kata) cocok dengan words[i:i+n]."""
    toks = [norm(t) for t in re.split(r"[\s-]+", phrase) if norm(t)]
    if not toks:
        return []
    hits = []
    for i in range(len(words) - len(toks) + 1):
        if [norm(words[i + k]["text"]) for k in range(len(toks))] == toks:
            hits.append((i, len(toks)))
    # Kata ulang ditulis satu token ("guling-guling") -> cocokkan juga versi gabungan.
    joined = norm(phrase)
    for i, w in enumerate(words):
        if norm(w["text"]) == joined and len(toks) > 1:
            hits.append((i, 1))
    return hits


def apply_kamus(words, kamus):
    """Ganti salah dengar Whisper. Frasa multi-kata digabung jadi satu entri."""
    fixes = []
    # Frasa terpanjang dulu supaya "keran yang uniknya" menang atas "keran".
    for wrong, right in sorted(kamus.items(), key=lambda kv: -len(kv[0].split())):
        start = 0
        while True:
            # Cari mulai setelah gantian terakhir, dan lewati yang sudah benar:
            # "distyling" -> "di-styling" ternormalisasi sama, jangan diganti berulang.
            hits = [
                h for h in find_phrase(words, wrong)
                if h[0] >= start and " ".join(w["text"] for w in words[h[0] : h[0] + h[1]]).lower().rstrip(".,?!;:") != right.lower()
            ]
            if not hits:
                break
            i, n = hits[0]
            start = i + 1
            first, last = words[i], words[i + n - 1]
            before = " ".join(w["text"] for w in words[i : i + n])
            text = right[0].upper() + right[1:] if first["text"][:1].isupper() else right
            merged = dict(first)
            merged.update(
                text=text + trailing_punct(last["text"]),
                endMs=last["endMs"],
                prob=min(w["prob"] for w in words[i : i + n]),
                fixed=True,
            )
            words[i : i + n] = [merged]
            fixes.append({"atSec": round(first["startMs"] / 1000, 2), "dari": before, "jadi": merged["text"]})
    return fixes


# Klaim superlatif / mutlak yang berisiko di iklan, berlaku untuk SEMUA brand (ditambah
# daftar brand kit). Uji 13 Nov 2026: "belum ada yang ngalahin" dan "tahta tertinggi" lolos
# karena daftar lama hanya "paling murah", "no. 1".
SUPERLATIF_UMUM = [
    "paling murah", "termurah", "paling laris", "terlaris", "paling bagus", "paling ampuh",
    "no. 1", "no 1", "nomor 1", "nomor satu", "number one", "terbaik se-indonesia", "terbaik se indonesia",
    "belum ada yang ngalahin", "nggak ada yang ngalahin", "gak ada yang ngalahin", "ga ada yang ngalahin",
    "tidak ada yang mengalahkan", "tahta tertinggi", "satu-satunya", "satu satunya",
    "dijamin 100%", "100% ampuh", "100% berhasil", "pasti berhasil", "menyembuhkan",
]


def mark_banned(words, banned):
    """Superlatif terlarang: tetap terdengar di audio, tapi tidak ditampilkan sebagai teks."""
    found = []
    for phrase in banned:
        for i, n in find_phrase(words, phrase):
            for k in range(i, i + n):
                words[k]["hidden"] = True
            found.append(
                {"atSec": round(words[i]["startMs"] / 1000, 2), "frasa": " ".join(w["text"] for w in words[i : i + n])}
            )
    return found


SIZE_RE = re.compile(r"^(x{0,3}s|m|x{0,3}l|\d?xl|allsize|jumbo)$")


def is_number(text: str) -> bool:
    """Angka, harga, persen, dan ukuran baju (S/M/L/XL...) yang diucapkan."""
    raw = text.strip().rstrip(".,?!;:")
    base = re.sub(r"-nya$", "", raw, flags=re.I)
    size = bool(SIZE_RE.match(base.lower())) and base[:1].isupper()  # "M", bukan "m"
    return bool(re.search(r"\d", text)) or norm(text) in NUMBER_WORDS or size


def plan_captions(captions, words, kata_kunci, kamus_values):
    """Tandai kata kunci (maks 1 unit per halaman, jarak >= KEYWORD_SPACING_MS) dan
    tentukan pemisah halaman supaya frasa kata kunci tidak terbelah."""
    # Unit kata kunci: (indeks caption awal, panjang, prioritas). Angka paling penting.
    by_word = {c["_word"]: ci for ci, c in enumerate(captions)}
    units = []
    for phrase in kata_kunci:
        for i, n in find_phrase(words, phrase):
            cis = [by_word.get(k) for k in range(i, i + n)]
            if None not in cis:
                units.append((cis[0], len(cis), 2))
    kamus_norm = {norm(v) for v in kamus_values}
    for ci, c in enumerate(captions):
        if is_number(c["text"]):
            units.append((ci, 1, 3))
        elif norm(c["text"]) in kamus_norm:
            units.append((ci, 1, 1))
    # Satu caption hanya ikut satu unit: yang terpanjang/prioritas tertinggi.
    units.sort(key=lambda u: (u[0], -u[2], -u[1]))
    dedup, taken = [], set()
    for u in units:
        span = set(range(u[0], u[0] + u[1]))
        if span & taken:
            continue
        taken |= span
        dedup.append(u)
    unit_at = {u[0]: u for u in dedup}

    # Halaman: maks 3 kata, pecah di tanda baca / jeda / terlalu lama; frasa utuh.
    pages, cur, ci = [], [], 0
    while ci < len(captions):
        u = unit_at.get(ci)
        block = list(range(ci, ci + (u[1] if u else 1)))
        if cur:
            prev = captions[cur[-1]]
            gap = captions[block[0]]["startMs"] - prev["endMs"]
            too_long = captions[block[-1]]["endMs"] - captions[cur[0]]["startMs"] > PAGE_MAX_MS
            if len(cur) + len(block) > MAX_WORDS_PER_PAGE or gap > PAGE_GAP_MS or too_long:
                pages.append(cur)
                cur = []
        cur.extend(block)
        ci = block[-1] + 1
        last_text = captions[block[-1]]["text"]
        # Akhir kalimat selalu memotong halaman; koma hanya kalau halaman sudah >= 2
        # kata (daftar "salto, rebahan, gelinding," tidak jadi 1 kata per layar).
        if re.search(r"[.?!]$", last_text) or (re.search(r"[,;:]$", last_text) and len(cur) >= 2):
            pages.append(cur)
            cur = []
    if cur:
        pages.append(cur)

    for c in captions:
        c["emphasis"] = False
        c["pageBreakAfter"] = False
    chosen = []
    last_ms = -10**9
    for page in pages:
        captions[page[-1]]["pageBreakAfter"] = True
        cands = [unit_at[i] for i in page if i in unit_at]
        if not cands:
            continue
        best = max(cands, key=lambda u: (u[2], u[1]))
        start = captions[best[0]]["startMs"]
        if start - last_ms < KEYWORD_SPACING_MS:
            continue
        for k in range(best[0], best[0] + best[1]):
            captions[k]["emphasis"] = True
        last_ms = start
        chosen.append({"atMs": start, "text": " ".join(captions[k]["text"] for k in range(best[0], best[0] + best[1]))})
    return chosen


HOOK_QUESTION = {"kapan", "apa", "kenapa", "gimana", "bagaimana", "siapa", "pernah", "mau", "udah", "sudah"}
HOOK_BAD_START = HOOK_DANGLING | {"yaitu", "yakni", "pun", "lagi", "juga", "nya"}


def _hook_window(sent, kata_kunci):
    """Pilih potongan 3..6 kata terbaik dari kalimat yang terlalu panjang.

    Skor: memuat kata kunci/produk (+3), berakhir di akhir kalimat (+3) atau koma (+1), mulai di awal
    kalimat atau sesudah koma (+1, +1 lagi kalau kata tanya), tiap koma di tengah (-1),
    mulai/berakhir di kata sambung (-2/-3), lebih panjang sedikit lebih baik.
    """
    toks = [norm(c["text"]) for c in sent]
    kws = [[norm(t) for t in re.split(r"[\s-]+", k) if norm(t)] for k in kata_kunci]
    best, best_score = None, None
    for n in range(3, HOOK_MAX_WORDS + 1):
        for i in range(0, len(sent) - n + 1):
            w = sent[i : i + n]
            t = toks[i : i + n]
            score = 0.1 * n
            if any(k and any(t[j : j + len(k)] == k for j in range(n - len(k) + 1)) for k in kws):
                score += 3
            if re.search(r"[.?!]$", w[-1]["text"]):
                score += 3  # akhir kalimat
            elif re.search(r"[,;:]$", w[-1]["text"]):
                score += 1
            if i == 0 or re.search(r"[,;:]$", sent[i - 1]["text"]):
                score += 1
                if t[0] in HOOK_QUESTION:
                    score += 1
            score -= sum(1 for c in w[:-1] if re.search(r"[,;:]$", c["text"]))
            if t[0] in HOOK_BAD_START:
                score -= 2
            # "ini"/"itu" wajar di akhir kalimat ("...korset ini."), tapi tidak di tengah.
            if t[-1] in HOOK_DANGLING and not re.search(r"[.?!]$", w[-1]["text"]):
                score -= 3
            if best_score is None or score > best_score + 1e-9:
                best, best_score = w, score
    return best


def plan_hook(captions, kata_kunci=()):
    """Judul hook dari kalimat pertama yang diucapkan (maks 6 kata, tidak mengarang)."""
    sent = []
    for c in captions:
        sent.append(c)
        if re.search(r"[.?!]$", c["text"]):
            break
    # Judul hilang tepat saat kalimat berikutnya mulai (caption mengambil alih).
    after = captions[len(sent)]["startMs"] if len(sent) < len(captions) else sent[-1]["endMs"] + 400
    while len(sent) > HOOK_MAX_WORDS and norm(sent[0]["text"]) in HOOK_STARTERS:
        sent = sent[1:]
    note = None
    if len(sent) > HOOK_MAX_WORDS:
        sent = _hook_window(sent, kata_kunci)
        note = "kalimat pertama lebih dari 6 kata, judul dipilih dari potongan terbaik kalimat itu"
    text = " ".join(re.sub(r"[.,;:]+$", "", c["text"]) for c in sent)
    text = text[:1].upper() + text[1:]
    end = min(HOOK_MAX_MS, after)
    return {"text": text, "startMs": 0, "endMs": round(end)}, note


KUAT_KATA = {"harga", "harganya", "rating", "diskon", "murah", "promo", "gratis", "ribu", "rb", "k", "persen"}


def _kuat(teks: str) -> bool:
    """Kalimat 'kuat' untuk hook (laporan Hanagaki): ada angka, kata harga/rating/diskon, atau tanda seru."""
    toks = {norm(t) for t in teks.split()}
    return bool(re.search(r"\d", teks) or "!" in teks or toks & KUAT_KATA)


def kalimat_kuat(captions):
    """Caption kalimat pertama yang kuat (daftar kata caption), atau None."""
    sent = []
    for c in captions:
        sent.append(c)
        if re.search(r"[.?!]$", c["text"]):
            if _kuat(" ".join(x["text"] for x in sent)):
                return sent
            sent = []
    return sent if sent and _kuat(" ".join(x["text"] for x in sent)) else None


def detect_scene_cuts(video_path: str):
    res = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-i", video_path,
            "-vf", f"select='gt(scene,{SCENE_THRESHOLD})',showinfo", "-f", "null", "-",
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return [round(float(t) * 1000) for t in re.findall(r"pts_time:([\d.]+)", res.stderr)]


def plan_effects(scene_cuts_src, cut, hook):
    """Efek: 17 glass type (hook), 09 zoom-through (pergantian shot), 05 digital zoom (framing)."""
    to_out = cut["to_out"]
    video_ms = cut["videoMs"]
    # Zoom-through hanya di pergantian shot asli, berjarak >= 5 dtk dari efek lain
    # dan tidak di 3 detik terakhir (area CTA).
    zt = []
    last = hook["endMs"]
    for t in scene_cuts_src:
        o = to_out(t)
        if o - last >= EFFECT_SPACING_MS and o < video_ms - 3000:
            zt.append(round(o))
            last = o

    # Digital zoom: framing berganti tiap ~3 dtk; di sambungan potongan, ganti
    # mendadak (menyamarkan jump cut), selain itu dorong pelan.
    joins = []
    acc = 0
    for s in cut["segments"][:-1]:
        acc += s["endFrame"] - s["startFrame"]
        joins.append(acc * 1000 / FPS)
    scene_out = [to_out(t) for t in scene_cuts_src]
    framing = [{"atMs": 0, "scale": 1.0, "mode": "cut"}]
    t = 0.0
    while True:
        nxt = t + FRAMING_EVERY_MS
        hard = [j for j in joins + scene_out if t + 1500 <= j <= nxt + 800]
        at = hard[0] if hard else nxt
        if at >= video_ms - 500:
            break
        scale = 1.0 if framing[-1]["scale"] != 1.0 else FRAMING_ZOOM
        framing.append({"atMs": round(at), "scale": scale, "mode": "cut" if hard else "smooth"})
        t = at
    return zt, framing


def plan_sfx(hook, zoom_throughs, keywords):
    events = [{"atMs": max(0, hook["startMs"] + 100), "src": "sfx/whoosh.wav", "prio": 2}]
    events += [{"atMs": z - 100, "src": "sfx/whoosh.wav", "prio": 2} for z in zoom_throughs]
    events += [{"atMs": k["atMs"] - 60, "src": "sfx/pop.wav", "prio": 1} for k in keywords]
    events.sort(key=lambda e: (-e["prio"], e["atMs"]))
    kept = []
    for e in events:
        if all(abs(e["atMs"] - k["atMs"]) >= SFX_SPACING_MS for k in kept):
            kept.append(e)
    kept.sort(key=lambda e: e["atMs"])
    return [
        {"src": e["src"], "atMs": max(0, e["atMs"]), "volume": 0.35 if "pop" in e["src"] else 0.3}
        for e in kept
    ]


FONTS = {"Montserrat", "Anton", "Oswald"}


def brand_fonts(bk) -> dict:
    """Font judul/caption + gaya kata kunci dari brand kit."""
    out = {}
    f = bk.get("font", {})
    if f.get("display") in FONTS:
        out["titleFont"] = f["display"]
    if f.get("caption") in FONTS:
        out["captionFont"] = f["caption"]
    w = bk["warna"]
    # Aksen sama dengan warna caption -> kata kunci dibedakan dengan kotak (teks gelap di kotak aksen).
    out["keywordStyle"] = bk.get("kata_kunci_gaya") or ("box" if w["aksen"].lower() == w["caption"].lower() else "color")
    if "caption_outline_px" in bk:
        out["outlinePx"] = bk["caption_outline_px"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--brandkit", required=True)
    ap.add_argument("--video", required=True, help="path relatif ke public/")
    ap.add_argument("--out", required=True)
    ap.add_argument("--placement", choices=["tiktok", "instagram", "shopee", "youtube"], default="tiktok")
    ap.add_argument("--outro-seconds", type=float, default=2.5)
    ap.add_argument("--max-seconds", type=float, default=30)
    ap.add_argument("--min-seconds", type=float, default=15)
    ap.add_argument(
        "--caption-pos",
        choices=["auto", "bawah", "atas"],
        default="auto",
        help="auto = pilih otomatis supaya tidak menutup wajah (dan produk, lihat --area-produk); "
        "bawah = sepertiga bawah; atas = area badan atas",
    )
    ap.add_argument(
        "--area-produk",
        choices=["bawah", "atas", "penuh"],
        help="letak produk di frame (dari brief), mis. bawah untuk celana/rok; caption menghindarinya",
    )
    ap.add_argument(
        "--hook-end-sec",
        type=float,
        help="paksa judul hook tampil sampai detik ini (mis. sumber sudah punya teks tertanam "
        "di awal yang perlu ditutup). Default: sampai kalimat kedua mulai, maks 3 dtk",
    )
    ap.add_argument("--preset", help="id preset di Brand Kit ekspor (durasi target, batas efek)")
    ap.add_argument("--batas-durasi", type=float, nargs=2, metavar=("MIN", "MAKS"),
                    help="aktifkan batas durasi (default tanpa batas; durasi preset hanya saran)")
    ap.add_argument("--mode-ops", choices=["kompat", "u3"], default="kompat",
                    help="kompat = hanya operasi yang sudah ada di Motion Studio; u3 = + field usulan U3")
    ap.add_argument("--buang", nargs="*", default=[], help='rentang detik sumber yang dibuang, mis. "4.9-9.2"')
    ap.add_argument("--cta-text", help="teks CTA outro dari ucapan kreator (default: CTA brand kit per placement)")
    ap.add_argument("--disclaimer-warna", action="store_true", help="tampilkan disclaimer_warna brand kit (video memperlihatkan varian warna)")
    ap.add_argument("--koreksi", nargs="*", default=[], help='ganti satu kata salah dengar: "detik:teks", mis. "19.2:Bahannya"')
    ap.add_argument("--hook-height", type=float, help="tinggi minimum panel judul hook 0..1")
    ap.add_argument("--hook-top", type=float, help="posisi atas panel judul hook 0..1 (mis. 0.41 untuk menutup teks tertanam)")
    ap.add_argument("--hook-text", help="judul hook pilihan user (semua kata harus diucapkan)")
    ap.add_argument(
        "--sembunyikan",
        type=float,
        nargs="*",
        default=[],
        help="detik (waktu sumber) kata yang tidak boleh tampil di caption, mis. salah dengar Whisper",
    )
    ap.add_argument("--abaikan-cek-ucapan", action="store_true",
                    help="tetap buat rencana walau audio terdeteksi lirik lagu (pilihan manual tim)")
    ap.add_argument("--audio", choices=["vo", "musik", "keduanya"],
                    help="pilihan audio per job (§17.2): vo = tanpa musik")
    args = ap.parse_args()

    tr = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
    bk = muat_brand_kit(args.brandkit)

    # Video tanpa ucapan (hanya musik): Whisper mengarang teks, jadi jangan buat rencana.
    ucapan = cek_ucapan(tr)
    # G1: audio lagu (lirik) ditolak; tim tetap bisa memaksa lanjut (--abaikan-cek-ucapan, hybrid).
    if ucapan.get("jenis") == "lirik" and not args.abaikan_cek_ucapan:
        ucapan = {**ucapan, "status": "ditolak",
                  "alasan": ucapan["alasan"].replace(" Periksa sebelum dipakai.", "")
                  + " Generate butuh orang bicara. Kalau yakin ini ucapan, jalankan ulang dengan \"tetap lanjut\"."}
    if ucapan["status"] == "ditolak":
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "potongan.json").write_text(
            json.dumps({"source": tr["source"], "status": "ditolak", "alasan": ucapan["alasan"], "cekUcapan": ucapan},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"DITOLAK: {ucapan['alasan']}")
        raise SystemExit(2)

    words = merge_split_words(tr["words"])
    fixes = apply_kamus(words, bk.get("kamus_kata", {}))
    banned = mark_banned(words, list(dict.fromkeys(SUPERLATIF_UMUM + bk.get("superlatif_dilarang", []))))
    # Bagian tengah yang dipilih user untuk dibuang (mis. durasi > 30 dtk).
    for rng in args.buang:
        a, b = (float(x) * 1000 for x in rng.split("-"))
        for w in words:
            if w["startMs"] >= a - 50 and w["endMs"] <= b + 150:
                w["forced"] = f"dibuang (pilihan user {rng})"
    # Koreksi salah dengar di satu posisi (bukan aturan kamus umum), mis. "19.2:Bahannya".
    for item in args.koreksi:
        sec, _, teks = item.partition(":")
        for w in words:
            if abs(w["startMs"] - float(sec) * 1000) <= 150:
                fixes.append({"atSec": round(w["startMs"] / 1000, 2), "dari": w["text"], "jadi": teks + trailing_punct(w["text"])})
                w["text"] = teks + trailing_punct(w["text"])
                break
    # Kata yang jelas salah dengar dan belum dikonfirmasi: tetap di audio, tidak tampil.
    hidden_manual = []
    for sec in args.sembunyikan:
        for w in words:
            if abs(w["startMs"] - sec * 1000) <= 150:
                w["hidden"] = True
                hidden_manual.append({"atSec": round(w["startMs"] / 1000, 2), "kata": w["text"]})
    cut = run_cut(tr, words)

    captions = [c for c in cut["captions"] if not words[c["_word"]].get("hidden")]
    # Awal kalimat (juga setelah potongan/kata tersembunyi) selalu huruf kapital.
    for i, c in enumerate(captions):
        if i == 0 or re.search(r"[.?!]$", captions[i - 1]["text"]):
            c["text"] = c["text"][:1].upper() + c["text"][1:]
    keywords = plan_captions(captions, words, bk.get("kata_kunci", []), bk.get("kamus_kata", {}).values())
    preset_awal = bk.get("preset", {}).get(args.preset, {}) if args.preset else {}
    p_hook = preset_awal.get("hook") or {}
    doubts_hook = []
    hook, hook_note = plan_hook(captions, bk.get("kata_kunci", []) + [p["nama"] for p in bk.get("produk", [])])
    if args.hook_text:
        # Judul pilihan user tetap harus dari ucapan: semua katanya wajib ada di transkrip.
        spoken = {norm(c["text"]) for c in captions}
        missing = [t for t in args.hook_text.split() if norm(t) not in spoken]
        if missing:
            raise SystemExit(f"--hook-text memuat kata yang tidak diucapkan: {missing}")
        hook["text"], hook_note = args.hook_text, None
    if p_hook.get("dari_kalimat_kuat") and not args.hook_text:
        # §17.1: hook dari kalimat terkuat (angka/harga/rating/"!"); tetap kata yang diucapkan.
        kuat = kalimat_kuat(captions)
        if kuat and not _kuat(hook["text"]):
            hk, _ = plan_hook(kuat, bk.get("kata_kunci", []) + [p["nama"] for p in bk.get("produk", [])])
            hook["text"], hook_note = hk["text"], "hook diambil dari kalimat terkuat (angka/harga/rating), preset"
        elif not kuat and not _kuat(hook["text"]):
            doubts_hook.append({"atSec": 0, "word": hook["text"],
                                "note": "preset meminta hook dari kalimat kuat, tapi tidak ada kalimat dengan angka/harga/rating"})
    if p_hook.get("y") is not None and not args.hook_top:
        hook["top"] = float(p_hook["y"])
    if args.hook_top:
        hook["top"] = args.hook_top
    if args.hook_height:
        hook["height"] = args.hook_height
    if args.hook_end_sec:
        hook["endMs"] = round(cut["to_out"](args.hook_end_sec * 1000))
    scene_cuts = detect_scene_cuts(tr["source"])
    zoom_throughs, framing = plan_effects(scene_cuts, cut, hook)
    sfx = plan_sfx(hook, zoom_throughs, keywords)

    posisi = {"mode": args.caption_pos}
    y_preset = (preset_awal.get("caption") or {}).get("y")
    if args.caption_pos == "auto":
        try:
            caption_y, lap = posisi_otomatis(tr["source"], float(y_preset) if y_preset is not None else 0.72,
                                             args.area_produk)
            posisi.update(lap)
        except Exception as e:  # noqa: BLE001 - deteksi gagal tidak boleh menghentikan rencana
            caption_y = 0.72
            posisi["gagal"] = str(e)
    else:
        caption_y = 0.72 if args.caption_pos == "bawah" else 0.36
    posisi["y"] = caption_y

    # G2: hook jangan menimpa teks bawaan video. Posisi pilihan tim (--hook-top) selalu menang.
    cek_teks = {"dicek": False}
    if hook and not args.hook_top:
        # Rentang sumber yang tampil di bawah hook (hook bisa melintasi beberapa potongan).
        rentang, sisa = [], (hook["endMs"] - hook["startMs"]) / 1000
        for sg in cut["segments"]:
            if sisa <= 0.05:
                break
            a = sg["startFrame"] / FPS
            b = min(sg["endFrame"] / FPS, a + sisa)
            rentang.append((a, b))
            sisa -= b - a
        rentang = rentang or [(0.0, 3.0)]
        try:
            kotak = baca_kotak(tr["source"], 0, 0, rentang=rentang)
            try:
                wajah = wajah_di(tr["source"], rentang)
            except Exception:  # noqa: BLE001 - wajah hanya diusahakan
                wajah = []
            hook_baru, catatan = atur_hook(hook, kotak, caption_y, wajah)
            cek_teks = {"dicek": True, "kotak": len(kotak), "wajah": len(wajah), "catatan": catatan}
            if catatan:
                doubts_hook.append({"atSec": 0, "word": hook["text"], "note": catatan})
            if hook_baru is None:
                # Hook dilewati: whoosh pembuka hook ikut dibuang (temuan review R2).
                sfx = [x for x in sfx if not (x["atMs"] <= hook["startMs"] + 100 and "whoosh" in x["src"])]
            hook = hook_baru
        except Exception as e:  # noqa: BLE001 - OCR gagal tidak boleh menghentikan rencana
            cek_teks = {"dicek": False, "gagal": str(e)[:200]}

    music_dir = Path("public/musik")
    music = sorted(p for p in music_dir.glob("*") if p.suffix.lower() in {".mp3", ".wav", ".m4a"}) if music_dir.exists() else []
    if args.audio == "vo":
        music = []

    video_sec = cut["videoMs"] / 1000
    total = video_sec + args.outro_seconds
    warna = bk["warna"]
    props = {
        "videoSrc": args.video,
        "segments": cut["segments"],
        "captions": strip_internal(captions),
        "keywords": [],
        "logoSrc": bk.get("logo", ""),
        "brandName": bk["nama"],
        "handle": bk.get("handle", ""),
        "outroTagline": args.cta_text or bk["cta"].get(args.placement) or bk["cta"].get("tiktok", ""),
        "outroSeconds": args.outro_seconds,
        "maxWordsPerPage": MAX_WORDS_PER_PAGE,
        "maxDurationSeconds": args.max_seconds,
        "style": {
            "captionColor": warna["caption"],
            "outlineColor": warna["outline"],
            "accentColor": warna["aksen"],
            "outroBg": warna["latar_gelap"],
            "captionCenterY": caption_y,
            "keywordScale": 1.4,
            "uppercaseAll": False,
            "safeRight": 0.12,
            **brand_fonts(bk),
        },
        "hook": hook,
        "framing": framing,
        "zoomThroughs": zoom_throughs,
        "sfx": sfx,
        "musicSrc": f"musik/{music[0].name}" if music else "",
        "disclaimer": bk.get("disclaimer_warna", "") if args.disclaimer_warna else "",
    }

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "props.json").write_text(json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8")

    doubts = list(cut["doubts"])
    if hook_note and hook:
        doubts.append({"atSec": 0, "word": hook["text"], "note": hook_note})
    doubts += doubts_hook
    report = {
        "source": tr["source"],
        "status": "peringatan" if ucapan["status"] == "peringatan" else "siap",
        "peringatan": [ucapan["alasan"]] if ucapan["status"] == "peringatan" else [],
        "cekUcapan": ucapan,
        "placement": args.placement,
        "originalSec": round(tr["durationMs"] / 1000, 2),
        "originalMs": tr["durationMs"],
        "editedVideoSec": round(video_sec, 2),
        "totalWithOutroSec": round(total, 2),
        "overMax": total > args.max_seconds,
        "underMin": total < args.min_seconds,
        "segments": cut["segments"],
        "removed": cut["removed"],
        "kamusFixes": fixes,
        "superlatifDisembunyikan": banned,
        "kataDisembunyikan": hidden_manual,
        "hook": hook,
        "efek": {
            "17_glass_type": f"judul hook 0-{hook['endMs']/1000:.1f}s" if hook else "hook dilewati (teks bawaan)",
            "09_zoom_through": [round(z / 1000, 2) for z in zoom_throughs],
            "05_digital_zoom": f"{len(framing)} pergantian framing",
        },
        "posisiCaption": posisi,
        "cekTeksBawaan": cek_teks,
        "kataKunci": keywords,
        "sfx": sfx,
        "musik": props["musicSrc"] or "TIDAK ADA (public/musik kosong)",
        "doubts": doubts,
        "finalText": " ".join(c["text"] for c in captions),
    }
    (out_dir / "potongan.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Keluaran kontrak mesin (KONTRAK-ENGINE v0.3): rencana.json + ops.json + qc_rencana.json.
    preset = bk.get("preset", {}).get(args.preset, {}) if args.preset else {}
    rencana, ops_doc, qc = susun_ops(props, report, bk, placement=args.placement, root=Path.cwd(),
                                     mode=args.mode_ops, preset=preset, batas_durasi=args.batas_durasi)
    # Pengaman (venus, 14 Nov): tiap klip <= panjang ASLI file sumbernya (lihat jaga_ops.py).
    lokal = {a["kunci"]: a["path"] for a in ops_doc.get("aset_lokal", [])}
    lokal["$sumber"] = str((Path.cwd() / "public" / args.video).resolve())
    aset_brand = {a["kunci"]: a.get("path") for a in bk.get("aset", []) if a.get("kunci")}
    path_of = lambda k: lokal.get(k) or aset_brand.get(k)  # noqa: E731
    catatan_durasi = jaga_durasi(ops_doc["ops"], path_of) + buang_teks_kosong(ops_doc["ops"]) + rapikan_kata(ops_doc["ops"])
    masih_lebih = cek_durasi(ops_doc["ops"], path_of)
    if catatan_durasi:
        rencana.setdefault("peringatan", []).extend({"level": "info", "jenis": "durasi_sumber", "teks": c} for c in catatan_durasi)
    if masih_lebih:
        raise SystemExit("ops tidak valid, klip melebihi sumber: " + "; ".join(masih_lebih))
    tulis_ops(out_dir, rencana, ops_doc, qc)
    # Gerbang akhir: validator ASLI Motion Studio. Gagal di sini = gagal teknis (kode 1) dengan alasan jelas,
    # bukan draf yang nanti ditolak saat diterapkan di aplikasi.
    tolak_ms = validasi_motion_studio(out_dir / "ops.json", Path(args.brandkit))
    if tolak_ms:
        raise SystemExit("ops ditolak validator Motion Studio: " + tolak_ms)

    print(f"Durasi: {report['originalSec']}s -> {report['editedVideoSec']}s (+outro = {total:.2f}s)")
    if report["overMax"]:
        print(f"(info) Lebih dari {args.max_seconds}s; durasi tanpa batas, pilih bagian tengah yang dibuang kalau perlu.")
    if report["underMin"]:
        print(f"(info) Kurang dari {args.min_seconds}s.")
    print(f"Potongan: {len(cut['segments'])} dipakai, {len(cut['removed'])} dibuang")
    for r in cut["removed"]:
        print(f"  - {r['fromSec']:>6.2f}-{r['toSec']:<6.2f} {r['reason']} {r['text']}")
    for f in fixes:
        print(f"  ~ kamus {f['atSec']}s: '{f['dari']}' -> '{f['jadi']}'")
    for b in banned:
        print(f"  !! superlatif disembunyikan {b['atSec']}s: {b['frasa']}")
    print(f"Hook: '{hook['text']}' (0-{hook['endMs']/1000:.1f}s)" if hook else "Hook: dilewati (teks bawaan video)")
    print(f"Zoom-through: {report['efek']['09_zoom_through']}  Framing: {len(framing)}x")
    print("Kata kunci: " + ", ".join(f"{k['text']}@{k['atMs']/1000:.1f}" for k in keywords))
    print(f"SFX: {len(sfx)}  Musik: {report['musik']}")
    for d in doubts:
        print(f"  ? {d['atSec']}s '{d['word']}': {d['note']}")


if __name__ == "__main__":
    main()
