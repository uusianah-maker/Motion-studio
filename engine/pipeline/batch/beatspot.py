"""R16 Beat Spot tahap 1 (video awareness, nama dari owner 15 Nov 2026).

Kreator merekam orang yang jalan di mall memakai produk brand. Mesin memotong footage per orang/adegan,
menyusun potongan supaya tiap pergantian jatuh TEPAT di ketukan sound, lalu memasang logo brand (Brand Kit)
dan end card (aset penutup Brand Kit + tagline). Tanpa AI ganti pakaian (tahap 2 ditahan, menunggu owner).
Mesin TIDAK merender. Hybrid: laporan potongan + kandidat di out/beatspot.json; tim bisa memilih urutan
shot (beatspot.urutan_shot), mengecualikan shot, dan menggeser potongan di editor.

Pakai: engine beatspot <job_dir>   (atau: .venv\\Scripts\\python pipeline\\batch\\beatspot.py <job_dir>)

job.json (mode "beatspot"):
  sumber: [{kunci: "$sumber:<id>", path}]   footage video (+ 1 file sound milik tim, video atau audio)
  brand_kit: "brand_kit.json"
  beatspot: {
    sound: "$sumber:<id>" | null    file sound tim (bukan musik berlisensi). null = tanpa sound: pakai bpm
    bpm: number | null              wajib kalau sound null (default 120 + peringatan); sound tren dipasang tim di TikTok
    ketukan_per_potong: "auto"|1|2|4  default auto: tiap orang tampil ±1-2,5 dtk sesuai tempo
    durasi: [min, maks]             default [15, 20] detik, termasuk end card
    tagline: string | null          teks end card (default: Brand Kit teks.tagline kalau ada)
    urutan_shot: [id shot]          pilihan & urutan tim (hybrid); sisanya diisi otomatis
    kecualikan_shot: [id shot]
    sumber_orang: {"<id footage>" | "<id shot>": "kreator" | "umum"}  default "umum" (diisi tim). Untuk tahap 2:
                  AI ganti pakaian nanti hanya memproses shot "kreator" (kreator/model sendiri yang setuju).
                  Keputusan owner PC-R7 (opsi A): orang umum dipakai hanya kalau memang memakai produk kita, tanpa blur.
    seed: int
  }
Output: out/rencana.json, out/ops.json (ms-ops/1), out/qc_rencana.json, out/beatspot.json (beatspot/1).
Progres JSON-lines di stdout. Kode keluar: 0 siap · 2 ditolak (alasan di rencana.json) · 1 gagal teknis.
"""

import json
import random
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import PIPELINE  # noqa: E402,F401  (memasang path modul venus)
from jalur import BATCH_PY, DATA  # noqa: E402  (R20: proses analisis jalan di folder data)
import musik as musik_mod  # noqa: E402
from brandkit import muat as muat_brand_kit  # noqa: E402  (milik venus)
from ops import MIN_CLIP_MS  # noqa: E402  (milik venus)
import gaya as gaya_mod  # noqa: E402  (R18 §17: preset beat, tagline, watermark, audio_pilihan)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vo_library  # noqa: E402  (§22 VO dari Library)
from jaga_ops import SISA_MS  # noqa: E402
from ops import CAPTION_SIZE, kata_klip  # noqa: E402  (konvensi caption Generate/Batch)

EXT_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
DURASI_DEFAULT = (15.0, 20.0)
PENUTUP_DEFAULT = 2.5
LAMA_IDEAL = 1.8  # detik per orang yang dituju mode auto (contoh owner: 1-4 dtk)
LAMA_MIN, LAMA_MAKS = 0.9, 4.0
FRAME = 1 / 30


class Ditolak(Exception):
    pass


def progres(tahap: str, persen: int, pesan: str = "") -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan}, ensure_ascii=False), flush=True)


def ms(x: float) -> int:
    return int(round(x * 1000))


# ------------------------------------------------------------------ ketukan

def ketukan_bpm(bpm: float, durasi: float, mulai: float = 0.0) -> list[float]:
    step = 60.0 / bpm
    return [round(mulai + i * step, 3) for i in range(int((durasi - mulai) / step) + 1)]


def langkah(bpm: float, mode) -> int:
    """Berapa ketukan per potongan. auto: 1/2/4 yang paling dekat LAMA_IDEAL dan masih 0,9-4 dtk."""
    beat = 60.0 / bpm
    if mode in (1, 2, 4):
        return int(mode)
    calon = [k for k in (1, 2, 4) if LAMA_MIN <= k * beat <= LAMA_MAKS] or [1, 2, 4]
    return min(calon, key=lambda k: abs(k * beat - LAMA_IDEAL))


def titik_potong(ketukan: list[float], k: int, video_maks: float) -> list[float]:
    """Titik potong (detik timeline, 0 = ketukan pertama) tiap k ketukan; berhenti di batas video.
    Kembali [0, t1, ..., t_akhir] dengan t_akhir <= video_maks."""
    if not ketukan:
        return []
    s0 = ketukan[0]
    pts = [round(b - s0, 3) for b in ketukan[::k]]
    pts = [t for t in pts if t <= video_maks + 1e-6]
    return pts if len(pts) >= 2 else []


# ------------------------------------------------------------------ susun

def kandidat_layak(shots: list[dict], kecuali: set[str]) -> tuple[list[dict], list[dict]]:
    """Shot yang boleh dipakai: ada orang, tidak buram/beku, bukan wajah dekat orang lewat."""
    ok, buang = [], []
    for s in shots:
        alasan = ("dikecualikan tim" if s["id"] in kecuali else "buram" if s["buram"] else "beku" if s["beku"]
                  else "tanpa orang" if s["orang"] < 0.5 else "wajah dekat (orang lewat)" if s["framing"] == "wajah_dekat"
                  else None)
        (buang if alasan else ok).append(s if not alasan else {"id": s["id"], "alasan": alasan})
    return ok, buang


def susun(potong: list[float], shots: list[dict], durasi_footage: dict, rng: random.Random,
          urutan: list[str] | None = None) -> tuple[list[dict], list[str]]:
    """Isi tiap selang [potong[i], potong[i+1]] dengan satu shot. Footage berganti tiap potongan kalau bisa
    (orang berbeda), shot tidak dipakai dua kali. Kembali (potongan, catatan)."""
    by_id = {s["id"]: s for s in shots}
    dipakai, out, catatan = set(), [], []
    antre = [i for i in (urutan or []) if i in by_id]
    for i in (urutan or []):
        if i not in by_id:
            catatan.append(f"urutan_shot {i} tidak dipakai (tidak ada / tidak layak)")
    for no, (a, b) in enumerate(zip(potong, potong[1:]), 1):
        dur = b - a
        pilih, alasan = None, ""
        while antre and pilih is None:
            s = by_id[antre.pop(0)]
            if s["id"] not in dipakai:
                pilih, alasan = s, "urutan tim"
        if pilih is None:
            terakhir = out[-1]["footage"] if out else None
            calon = [s for s in shots if s["id"] not in dipakai and s["sampai"] - s["dari"] >= dur - 1e-3]
            beda = [s for s in calon if s["footage"] != terakhir] or calon
            if beda:
                n_footage = {}
                for p in out:
                    n_footage[p["footage"]] = n_footage.get(p["footage"], 0) + 1
                pilih = max(beda, key=lambda s: s["skor"] - 0.6 * n_footage.get(s["footage"], 0) + 0.3 * rng.random())
                alasan = "otomatis: " + ("orang jalan, badan utuh" if pilih["framing"] == "full_body" else pilih["framing"])
        if pilih is None:
            # Cadangan: shot terpendek yang tersisa, diperpanjang ke gambar sesudahnya di file yang sama.
            sisa = [s for s in shots if s["id"] not in dipakai
                    and s["dari"] + dur <= durasi_footage.get(s["footage"], 0) - FRAME]
            if not sisa:
                catatan.append(f"stok shot habis di potongan {no}: video diakhiri lebih awal")
                break
            pilih, alasan = max(sisa, key=lambda s: s["skor"]), "cadangan: shot terlalu pendek, disambung"
        panjang = pilih["sampai"] - pilih["dari"]
        masuk = pilih["dari"] + max(0.0, (panjang - dur) / 2)  # bagian tengah: orang paling utuh di frame
        masuk = min(masuk, durasi_footage.get(pilih["footage"], masuk + dur) - dur - FRAME)
        dipakai.add(pilih["id"])
        out.append({"no": no, "mulai": round(a, 3), "durasi": round(dur, 3), "shot": pilih["id"],
                    "footage": pilih["footage"], "in": round(max(0.0, masuk), 3), "skor": pilih["skor"], "alasan": alasan})
    return out, catatan


# ------------------------------------------------------------------ ops

def durasi_file_ms(path) -> int | None:
    """Panjang video/audio (ms) lewat ffprobe; None untuk gambar diam / file tidak terbaca.
    Penutup pilihan job (R28) di brand_kit.json tidak membawa durasi_ms, jadi dibaca dari filenya."""
    if not path or not Path(path).exists():
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name",
                        "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL)
    try:
        d = json.loads(r.stdout or "{}")
        jenis = {(st.get("codec_type"), st.get("codec_name")) for st in d.get("streams") or []}
        if jenis and all(t == "video" and c in ("png", "mjpeg", "webp", "bmp", "gif") for t, c in jenis):
            return None  # gambar: panjang bebas
        return int(float(d["format"]["duration"]) * 1000)
    except (KeyError, ValueError, TypeError):
        return None


def buat_ops(potongan, sound, video_akhir, total, brand, tagline, watermark=None, logo=True) -> tuple[list[dict], list[str], float]:
    """Kembali (ops, menunggu, durasi_penutup)."""
    warna = brand.get("warna", {})
    lufs = ((brand.get("preset") or {}).get("audio") or {}).get("lufs", -14)
    ops = [{"op": "set_canvas", "ratio": "9:16"},
           {"op": "set_brand_logo", "on": bool(logo and (brand.get("logo") or brand.get("logo_aturan")))},
           {"op": "set_loudness", "lufs": lufs}]
    menunggu = []
    for p in potongan:
        ops.append({"op": "add_clip", "track_kind": "video", "media": f"$sumber:{p['footage']}",
                    "start_ms": ms(p["mulai"]), "duration_ms": ms(p["durasi"]), "in_ms": ms(p["in"]), "volume": 0})
    v_ms = ms(video_akhir)
    pen = brand.get("penutup") or {}
    pen_aset = next((a for a in brand.get("aset", []) if pen.get("aset") and a.get("kunci") == pen["aset"]
                     and a.get("lisensi_iklan", True)), None)
    pen_ms = ms(total) - v_ms
    pen_file_ms = int(pen_aset["durasi_ms"]) if pen_aset and pen_aset.get("durasi_ms") else durasi_file_ms(pen_aset.get("path")) if pen_aset else None
    if pen_file_ms:  # end card video lebih pendek dari jatah end card: klip tidak boleh melebihi file (Motion Studio menolak)
        pen_ms = min(pen_ms, pen_file_ms - 34)
    if pen_aset and pen_ms >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "broll", "media": pen_aset["kunci"], "start_ms": v_ms,
                    "duration_ms": pen_ms, "in_ms": 0})
        teks_mulai, teks_akhir = v_ms, v_ms + pen_ms
    else:
        # Tanpa aset penutup: tagline tampil di atas potongan terakhir (2 dtk terakhir video).
        pen_ms = 0
        teks_mulai, teks_akhir = max(0, v_ms - 2000), v_ms
        menunggu.append("end card: Brand Kit belum punya aset penutup; tagline tampil di atas potongan terakhir")
    if tagline and teks_akhir - teks_mulai >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "text", "text": tagline, "start_ms": teks_mulai,
                    "duration_ms": teks_akhir - teks_mulai,
                    "style": {"x": 0.5, "y": 0.5, "size": 6.0, "width": 0.84, "color": "#ffffff",
                              "bg": (warna.get("latar_gelap") or "#000000").lower(), "bg_opacity": 0.6, "bold": True,
                              "outline": False, "align": "center", "font": "brand"}})
    elif not tagline:
        menunggu.append("tagline end card kosong: isi beatspot.tagline atau Brand Kit teks.tagline")
    total_ms = v_ms + pen_ms
    if sound:
        dur = min(total_ms, ms(sound["sisa"]) - 34)
        if dur >= MIN_CLIP_MS:
            ops.append({"op": "add_clip", "track_kind": "music", "media": sound["kunci"], "start_ms": 0,
                        "duration_ms": dur, "in_ms": ms(sound["mulai"]), "volume": 1.0})
    else:
        menunggu.append("tanpa sound: pasang sound tren di TikTok (potongan sudah mengikuti ketukan BPM pilihan tim)")
    gaya_mod.watermark(ops, watermark)  # §17.3: teks kecil sepanjang video, di sela teks lain
    return ops, menunggu, pen_ms / 1000


def qc(potongan, ketukan_tl, ops, target, total) -> dict:
    hasil = []

    def cek(nama, lulus, ket=""):
        hasil.append({"cek": nama, "lulus": bool(lulus), "ket": ket})

    cek("durasi", target[0] - 0.5 <= total <= target[1] + 0.05, f"{total:.1f} dtk, target {target[0]:.0f}-{target[1]:.0f}")
    meleset = [p["no"] for p in potongan if min((abs(p["mulai"] - b) for b in ketukan_tl), default=9) > FRAME]
    cek("potong_di_ketukan", not meleset, f"meleset di potongan {meleset}" if meleset else f"{len(potongan)} potongan")
    lama = [p["no"] for p in potongan if not (LAMA_MIN - 0.05 <= p["durasi"] <= LAMA_MAKS + 0.05)]
    cek("lama_per_orang_1_4_dtk", not lama, f"di luar 1-4 dtk: {lama}" if lama else "")
    ganda = len({p["shot"] for p in potongan}) != len(potongan)
    cek("shot_tidak_berulang", not ganda)
    beruntun = [p["no"] for a, p in zip(potongan, potongan[1:]) if a["footage"] == p["footage"]]
    cek("orang_berganti", len(beruntun) <= len(potongan) // 4, f"footage sama berturut di {beruntun}" if beruntun else "")
    vid = sorted((o["start_ms"], o["start_ms"] + o["duration_ms"]) for o in ops if o.get("track_kind") == "video")
    celah = [b1 for (_, b1), (a2, _) in zip(vid, vid[1:]) if abs(a2 - b1) > 1]
    cek("video_tanpa_celah", vid and vid[0][0] == 0 and not celah)
    cek("klip_min_100ms", all(o.get("duration_ms", MIN_CLIP_MS) >= MIN_CLIP_MS for o in ops if o["op"] == "add_clip"))
    return {"schema": "engine-qc-rencana/1", "lulus": all(h["lulus"] for h in hasil), "cek": hasil}


# ------------------------------------------------------------------ jalankan

def tolak(out_dir: Path, alasan: str) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rencana.json").write_text(json.dumps({"schema": "engine-rencana/1", "status": "ditolak", "alasan": alasan},
                                                     ensure_ascii=False, indent=1), encoding="utf-8")
    progres("ditolak", 100, alasan)
    return 2


def analisis_shot(footage: dict[str, Path], tmp: Path) -> dict:
    keluar = tmp / "shots.json"
    cmd = [str(BATCH_PY), str(Path(__file__).resolve().parent / "beatspot_shot.py"), str(keluar)] + \
          [f"{fid}={p}" for fid, p in footage.items()]
    r = subprocess.Popen(cmd, cwd=DATA, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, encoding="utf-8")
    for line in r.stdout:  # progres per footage diteruskan langsung (JSON-lines), log lain ke stderr
        (print(line.rstrip(), flush=True) if line.startswith("{") else print(line.rstrip(), file=sys.stderr))
    if r.wait() != 0:
        raise RuntimeError(f"analisis shot gagal (kode {r.returncode})")
    return json.loads(keluar.read_text(encoding="utf-8"))


def pasang_vo(ops: list[dict], cfg: dict, idx: dict, video_ms: int, brand: dict, g: dict, ada_sound: bool) -> None:
    """§22: VO utuh di track `audio` mulai 0; subtitle dari teks VO (tanpa Whisper); sound turun saat VO bicara."""
    vo_ms = round(float(idx["kalimat"][-1]["akhir"]) * 1000)
    dur = min(vo_ms - SISA_MS - 1, video_ms)
    if dur >= MIN_CLIP_MS:
        ops.append({"op": "add_clip", "track_kind": "audio", "media": cfg["media"], "start_ms": 0, "duration_ms": dur,
                    "in_ms": 0, "volume": 1.0})
    if ada_sound:
        ops.append({"op": "set_ducking", "on": True, "level": 0.3})
    if not cfg["subtitle"]:
        return
    warna = brand.get("warna", {})
    gaya = {"x": 0.5, "y": 0.72, "size": CAPTION_SIZE, "width": 0.8, "color": (warna.get("caption") or "#ffffff").lower(),
            "bg": None, "bold": True, "outline": True, "align": "center", "font": "caption", "anim": "pop", "anim_ms": 120}
    gaya.update(gaya_mod.gaya_caption(g.get("caption") or {}, warna) if warna else {})
    maks_kata = int(((g.get("caption") or {}).get("maks_kata")) or 3)
    pages = vo_library.halaman(vo_library.kata_absolut(idx), maks_kata=maks_kata)
    for i, page in enumerate(pages):
        a = page[0]["startMs"]
        b = min(page[-1]["endMs"], pages[i + 1][0]["startMs"] if i + 1 < len(pages) else video_ms, video_ms)
        if b - a < MIN_CLIP_MS:
            continue
        words = kata_klip(page, a, b - a, brand.get("kapital", "kata_kunci"))
        ops.append({"op": "add_clip", "track_kind": "subtitle", "text": " ".join(w["text"] for w in words), "words": words,
                    "start_ms": a, "duration_ms": b - a, "style": dict(gaya)})


def jalankan(job_dir: Path, analisis=analisis_shot) -> int:
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    if job.get("mode") != "beatspot":
        return tolak(out_dir, "job.json bukan mode beatspot")
    bs = job.get("beatspot") or {}
    rng = random.Random(bs.get("seed", 1))
    if job.get("audio_pilihan") not in (None,) + gaya_mod.AUDIO_PILIHAN:
        return tolak(out_dir, "audio_pilihan harus salah satu dari " + ", ".join(gaya_mod.AUDIO_PILIHAN))
    target = tuple(bs.get("durasi") or DURASI_DEFAULT)
    if len(target) != 2 or not (5 <= target[0] <= target[1] <= 60):
        return tolak(out_dir, "beatspot.durasi harus [min, maks] detik, 5-60")
    peringatan = []

    progres("cek_input", 2, "Beat Spot")
    sumber = {s["kunci"]: Path(s["path"]) for s in job.get("sumber", []) if s.get("kunci") and s.get("path")}
    sound_kunci = bs.get("sound")
    if sound_kunci and sound_kunci not in sumber:
        return tolak(out_dir, f"beatspot.sound {sound_kunci} tidak ada di sumber")
    if not sound_kunci:  # file audio tanpa gambar di sumber = sound tim
        audio = [k for k, p in sumber.items() if p.suffix.lower() in EXT_AUDIO and not k.startswith("$vo:")]  # §22: VO bukan sound
        sound_kunci = audio[0] if len(audio) == 1 else None
    footage = {k.partition(":")[2]: p for k, p in sumber.items()
               if k != sound_kunci and p.suffix.lower() not in EXT_AUDIO and k.startswith("$sumber:")}
    hilang = [str(p.name) for p in footage.values() if not p.exists()]
    if hilang:
        return tolak(out_dir, "file footage tidak ditemukan: " + ", ".join(hilang))
    if not footage:
        return tolak(out_dir, "tidak ada footage video (orang jalan) di sumber")

    # §22 VO dari Library: VO jadi suara utama di atas sound; video diperpanjang sampai VO selesai.
    try:
        cfg_vo = vo_library.konfigurasi(job)
        idx_vo = None
        if cfg_vo:
            p_vo = sumber.get(cfg_vo["media"])
            if p_vo is None or not p_vo.exists():
                return tolak(out_dir, f"file VO {cfg_vo['media']} tidak ada di sumber job")
            idx_vo = vo_library.muat_index(job_dir / cfg_vo["index"], vo_library.durasi_media(p_vo))
            footage.pop(cfg_vo["media"].partition(":")[2], None)
    except vo_library.Ditolak as e:
        return tolak(out_dir, str(e))
    brand_path = job_dir / job.get("brand_kit", "brand_kit.json")
    brand = muat_brand_kit(brand_path) if brand_path.exists() else {}
    brand_raw = json.loads(brand_path.read_text(encoding="utf-8")) if brand_path.exists() else {}
    # R18 §17: preset aktif (job.preset) memberi bawaan beat; Brand Kit memberi tagline & watermark.
    brand, g = gaya_mod.siapkan(brand, brand_raw, job) if brand else (brand, {"beat": {}})
    beat = g.get("beat") or {}
    tagline = bs.get("tagline") or g.get("tagline")
    watermark = g.get("watermark")
    # Beat Spot gaya Hanagaki ("hanya watermark"): preset jenis beat_spot + watermark -> logo tidak dipasang.
    pakai_logo = not ((g.get("preset") or {}).get("jenis") == "beat_spot" and watermark)
    if job.get("audio_pilihan") == "vo":
        # Beat Spot tidak punya voice over: "vo" = tanpa musik; pola ketukan dari BPM, sound dipasang tim.
        if sound_kunci:
            peringatan.append({"level": "info", "jenis": "audio", "teks": "audio_pilihan vo: sound tim tidak dipasang"})
        sound_kunci = None

    # Ketukan: dari sound tim, atau pola BPM pilihan tim (sound tren dipasang tim di TikTok).
    progres("ketukan", 5, "membaca ketukan sound" if sound_kunci else "pola ketukan dari BPM")
    sound = None
    if sound_kunci:
        a = musik_mod.analisis(sumber[sound_kunci])
        if a["bpm"] and len(a["ketukan"]) >= 4:
            bpm, ketukan = a["bpm"], a["ketukan"]
            sound = {"kunci": sound_kunci, "durasi": a["durasi"], "mulai": ketukan[0], "sisa": a["durasi"] - ketukan[0]}
            sumber_ketukan = "sound"
        else:
            bpm = float(bs.get("bpm") or beat.get("bpm") or 120)
            ketukan = ketukan_bpm(bpm, a["durasi"])
            sound = {"kunci": sound_kunci, "durasi": a["durasi"], "mulai": 0.0, "sisa": a["durasi"]}
            sumber_ketukan = "bpm"
            peringatan.append({"level": "warn", "jenis": "ketukan",
                               "teks": f"ketukan sound tidak terbaca jelas; dipakai pola {bpm:.0f} BPM"})
    else:
        bpm = float(bs.get("bpm") or beat.get("bpm") or 0)
        if not bpm:
            bpm = 120.0
            peringatan.append({"level": "warn", "jenis": "ketukan", "teks": "tanpa sound dan tanpa BPM: dipakai 120 BPM"})
        if not 60 <= bpm <= 200:
            return tolak(out_dir, "beatspot.bpm harus 60-200")
        vo_dtk = float(idx_vo["kalimat"][-1]["akhir"]) if idx_vo else 0.0
        ketukan = ketukan_bpm(bpm, max(target[1], vo_dtk + 3) + 5)
        sumber_ketukan = "bpm"
    k = langkah(bpm, bs.get("ketukan_per_potong", beat.get("tiap_ketukan", "auto")))

    progres("shot", 10, f"memotong {len(footage)} footage per orang")
    with tempfile.TemporaryDirectory() as tmp:
        lib = analisis(footage, Path(tmp))
    layak, dibuang = kandidat_layak(lib["shots"], set(bs.get("kecualikan_shot", [])))
    if not layak:
        return tolak(out_dir, "tidak ada shot orang yang layak (semua buram/beku/tanpa orang)")

    progres("susun", 70, f"{bpm:.0f} BPM, potong tiap {k} ketukan")
    pen = brand.get("penutup") or {}
    pen_dtk = float(pen.get("detik") or PENUTUP_DEFAULT) if pen.get("aset") else 0.0
    batas_sound = sound["sisa"] if sound else 1e9
    video_maks = min(target[1], batas_sound) - pen_dtk
    if idx_vo:  # §22: gambar harus menutup seluruh VO (+0,5 dtk); target maks ikut naik bila VO lebih panjang
        vo_dtk = float(idx_vo["kalimat"][-1]["akhir"])
        video_maks = max(video_maks, min(vo_dtk + 0.5, batas_sound - pen_dtk))
        if vo_dtk + 0.5 + pen_dtk > target[1]:
            peringatan.append({"level": "info", "jenis": "durasi",
                               "teks": f"VO {vo_dtk:.1f} dtk lebih panjang dari target {target[1]:.0f} dtk: durasi mengikuti VO"})
            target = (target[0], round(vo_dtk + 0.5 + pen_dtk + 0.5, 1))
        if sound and vo_dtk > batas_sound:
            peringatan.append({"level": "warn", "jenis": "durasi",
                               "teks": f"sound ({batas_sound:.1f} dtk) lebih pendek dari VO ({vo_dtk:.1f} dtk)"})
    potong = titik_potong(ketukan, k, video_maks)
    if len(potong) < 2:
        return tolak(out_dir, "sound terlalu pendek untuk Beat Spot (butuh minimal 2 ketukan sesudah ketukan pertama)")
    dur_footage = {f: m["durasi"] for f, m in lib["footage"].items()}
    potongan, catatan = susun(potong, layak, dur_footage, rng, bs.get("urutan_shot"))
    if not potongan:
        return tolak(out_dir, "stok shot tidak cukup untuk satu potongan")
    video_akhir = potongan[-1]["mulai"] + potongan[-1]["durasi"]
    total = min(video_akhir + pen_dtk, batas_sound)
    for c in catatan:
        peringatan.append({"level": "warn", "jenis": "susun", "teks": c})
    if video_akhir + pen_dtk < target[0] - 0.5:
        peringatan.append({"level": "warn", "jenis": "durasi",
                           "teks": f"durasi {video_akhir + pen_dtk:.1f} dtk di bawah target {target[0]:.0f}: "
                                   "tambah footage orang / sound lebih panjang"})

    ops, menunggu, pen_dtk = buat_ops(potongan, sound, video_akhir, total, brand, tagline, watermark, pakai_logo)
    if idx_vo:
        pasang_vo(ops, cfg_vo, idx_vo, ms(video_akhir), brand, g, bool(sound))
        if float(idx_vo["kalimat"][-1]["akhir"]) > video_akhir + 0.05:
            peringatan.append({"level": "warn", "jenis": "footage_kurang",
                               "teks": "potongan footage tidak cukup menutup seluruh VO: tambah footage orang"})
    total = video_akhir + pen_dtk
    s0 = ketukan[0]
    ketukan_tl = [round(b - s0, 3) for b in ketukan]
    q = qc(potongan, ketukan_tl, ops, target, total)
    media_brand = [o["media"] for o in ops if o.get("media") and not o["media"].startswith("$sumber")]

    progres("tulis", 95, f"{len(potongan)} potongan")
    rencana = {
        "schema": "engine-rencana/1", "status": "siap",
        "durasi": {"mentah": round(sum(dur_footage.values()), 2), "akhir": round(total, 2), "target": list(target)},
        "dibuang": [], "hook": None, "kata_kunci": [], "efek": [],
        "audio": {"sfx": 0, "musik": sound["kunci"] if sound else None, "musik_bpm": round(bpm, 1),
                  "alasan_tanpa_musik": None if sound else "tanpa sound: sound tren dipasang tim di TikTok"},
        "cta": tagline or "", "peringatan": peringatan, "ragu": [], "menunggu_u3": menunggu,
        **({"sumber_suara": "vo_library", "vo": vo_library.laporan(cfg_vo, idx_vo)} if idx_vo else {}),
        "beatspot": {"bpm": round(bpm, 1), "sumber_ketukan": sumber_ketukan, "ketukan_per_potong": k,
                     "potongan": len(potongan), "end_card_dtk": round(pen_dtk, 2), "aset_brand": media_brand},
    }
    (out_dir / "rencana.json").write_text(json.dumps(rencana, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "ops.json").write_text(json.dumps({"schema": "ms-ops/1", "mode": "u3", "aset_lokal": [], "ops": ops},
                                                 ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "qc_rencana.json").write_text(json.dumps(q, ensure_ascii=False, indent=1), encoding="utf-8")
    dipakai = {p["shot"] for p in potongan}
    so = bs.get("sumber_orang") or {}

    def orang_dari(sid: str, fid: str) -> str:
        v = so.get(sid, so.get(fid, "umum"))
        return v if v in ("kreator", "umum") else "umum"

    for p in potongan:
        p["sumber_orang"] = orang_dari(p["shot"], p["footage"])
    laporan = {
        "schema": "beatspot/1", "job_id": job.get("job_id"), "bpm": round(bpm, 1), "sumber_ketukan": sumber_ketukan,
        "ketukan_per_potong": k, "detik_per_ketukan": round(60 / bpm, 3), "sound_mulai_detik": round(s0, 3) if sound else None,
        "ketukan": [b for b in ketukan_tl if 0 <= b <= total + 1e-6],
        "potongan": potongan, "durasi": round(total, 2), "end_card_dtk": round(pen_dtk, 2),
        "kandidat": [{k2: s[k2] for k2 in ("id", "footage", "dari", "sampai", "orang", "framing", "skor")}
                     | {"dipakai": s["id"] in dipakai, "sumber_orang": orang_dari(s["id"], s["footage"])}
                     for s in sorted(layak, key=lambda s: -s["skor"])],
        "dibuang": dibuang,
    }
    (out_dir / "beatspot.json").write_text(json.dumps(laporan, ensure_ascii=False, indent=1), encoding="utf-8")
    progres("selesai", 100, f"{len(potongan)} potongan · {bpm:.0f} BPM · {total:.1f} dtk")
    return 0


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # progres JSON-lines dibaca app sebagai UTF-8 (Windows: cp1252)
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    job_dir = Path(sys.argv[1])
    try:
        sys.exit(jalankan(job_dir))
    except Ditolak as e:
        sys.exit(tolak(job_dir / "out", str(e)))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
