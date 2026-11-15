"""Y3 Matcher (Batch Remix): kalimat VO -> susunan shot.

Aturan:
- Shot dari footage VO sendiri dipakai di detik yang SAMA dengan ucapannya (bibir sinkron) = "sinkron".
- Shot dari footage lain ("broll") hanya yang tidak menampilkan wajah bicara, tanpa teks bawaan, tidak buram.
  Diutamakan yang topiknya sama dengan kalimat (mis. "anti kusut" -> shot demo kucek).
- Pembuka (potongan pertama) SELALU b-roll kalau ada (owner 14 Nov): detik pertama tidak boleh sama dengan
  video asli. Judul hook tetap tampil sebagai teks di atas b-roll. CTA (potongan terakhir) diutamakan sinkron.
- Porsi gambar sinkron (footage asli VO) dibatasi MAKS_SINKRON dari durasi supaya varian tidak mirip video asli.
- Ganti framing tiap 2-3 dtk; titik potong di dalam kalimat ditarik ke ketukan musik terdekat (±0,35 dtk).
"""

import random
from collections import Counter

MIN_POTONG = 1.2
MAKS_SINKRON = 0.35  # porsi maksimal durasi yang memakai footage asli VO (owner 14 Nov)
JEDA = 0.12  # sama dengan vo.JEDA
FRAMING_BONUS = {"closeup_produk": 1.0, "full_body": 0.6, "medium": 0.0, "wajah_dekat": -0.5}


def _blur_watermark(meta: dict, dari: float, sampai: float) -> list[dict]:
    """Kotak blur (pecahan frame) untuk watermark TikTok + footer, dalam waktu sumber (ms)."""
    wm = meta["watermark"]
    out = []

    def kotak(box, a, b):
        if b - a > 0.01:
            x0, y0, x1, y1 = box
            out.append({"x": x0, "y": y0, "w": round(x1 - x0, 3), "h": round(y1 - y0, 3),
                        "dari_ms": round(a * 1000), "sampai_ms": round(b * 1000), "radius": 12})

    if wm["tiktok"]:
        p = wm["pindah_detik"]
        kotak(wm["kotak_awal"], dari, min(sampai, p + 0.05))
        kotak(wm["kotak_akhir"], max(dari, p - 0.05), sampai)
    if wm["footer"]:
        kotak(wm["kotak_footer"], dari, sampai)
    # Teks bawaan hasil OCR Shot Library (kotak presisi, sedikit diperlebar).
    for a, b, k in meta.get("_teks", []):
        lo, hi = max(dari, a), min(sampai, b)
        if hi - lo > 0.01:
            x, y, w, h = k
            kotak((max(0, x - 0.02), max(0, y - 0.01), min(1, x + w + 0.02), min(1, y + h + 0.01)), lo, hi)
    return out


def _snap(t: float, beats: list[float], batas: tuple[float, float]) -> float:
    if not beats:
        return t
    b = min(beats, key=lambda x: abs(x - t))
    return b if abs(b - t) <= 0.35 and batas[0] + MIN_POTONG <= b <= batas[1] - MIN_POTONG else t


def susun_shot(rencana_vo: dict, lib: dict, footage_boleh: set[str], rng: random.Random,
               beats: list[float] | None = None, global_pakai: Counter | None = None,
               boleh_teks: bool = False, kecuali: set[str] | frozenset = frozenset(),
               hindari_pembuka: set[str] | frozenset = frozenset()) -> dict:
    """Return {"potongan": [...], "durasi": detik timeline, "vo_klip": [...], "rasio_sinkron": x}.

    boleh_teks: shot ber-teks bawaan boleh jadi b-roll karena teksnya ikut di-blur (hak pakai jelas).
    Kalau footage VO tidak ada di Shot Library (jalur VO: gambar dari batch lain), semua potongan b-roll.
    kecuali: id shot yang dikecualikan tim (job.kecualikan_shot): tidak dipakai sebagai b-roll maupun sinkron.
    hindari_pembuka: shot yang sudah pernah jadi pembuka (riwayat lintas batch, R6): tidak dipilih sebagai pembuka.
    """
    global_pakai = global_pakai if global_pakai is not None else Counter()
    fid = rencana_vo["vo"]
    shots = lib["shots"]
    for f, meta in lib["footage"].items():
        if "_teks" not in meta:
            meta["_teks"] = [(x["dari"], x["sampai"], t["kotak"]) for x in shots if x["footage"] == f
                             for t in x.get("teks", [])]
    # Wajah dekat dari footage lain tidak dipakai: bibirnya terbaca, padahal suaranya VO orang lain.
    broll_pool = [s for s in shots if s["footage"] != fid and s["footage"] in footage_boleh
                  and not s["wajah_bicara"] and s["framing"] != "wajah_dekat"
                  and (boleh_teks or not s["teks_bawaan"]) and not s["buram"] and not s.get("beku") and not s.get("kosong")
                  and s["sampai"] - s["dari"] >= MIN_POTONG and s["id"] not in kecuali]
    own = [s for s in shots if s["footage"] == fid and not s["buram"] and not s.get("beku") and s["id"] not in kecuali]
    dipakai = Counter()
    potongan, vo_klip = [], []
    t_out = 0.0
    ks = rencana_vo["kalimat"]
    total_rencana = sum(k["sampai"] - k["dari"] for k in ks) + JEDA * max(0, len(ks) - 1) + 1.5
    jatah_sinkron = MAKS_SINKRON * total_rencana
    n_sinkron = 0.0
    for ki, k in enumerate(ks):
        dur_k = k["sampai"] - k["dari"]
        vo_klip.append({"start": t_out, "in": k["dari"], "dur": dur_k, "kalimat": k["id"]})
        # Titik potong di dalam kalimat: tiap 2-3 dtk, ditarik ke ketukan musik.
        cuts, c = [0.0], 0.0
        while dur_k - c > 3.2:
            c += rng.uniform(2.0, 3.0)
            cuts.append(_snap(t_out + c, beats or [], (t_out, t_out + dur_k)) - t_out)
        cuts.append(dur_k)
        cuts = sorted(set(round(x, 3) for x in cuts))
        # Gambar menutup jeda antar kalimat; sesudah kalimat terakhir (CTA) ditahan 1,5 dtk.
        cuts[-1] = dur_k + (1.5 if ki == len(ks) - 1 else JEDA)
        # Tidak ada potongan di bawah 1 dtk (kedip): titik potong yang terlalu rapat dibuang.
        rapi = [cuts[0]]
        for c in cuts[1:-1]:
            if c - rapi[-1] >= 1.0 and cuts[-1] - c >= 1.0:
                rapi.append(c)
        cuts = rapi + [cuts[-1]]
        for pi, (a, b) in enumerate(zip(cuts, cuts[1:])):
            src_a = k["dari"] + a
            pertama = ki == 0 and pi == 0
            terakhir = ki == len(ks) - 1 and pi == len(cuts) - 2
            sinkron_ok = any(s["dari"] <= src_a < s["sampai"] for s in own) and n_sinkron + (b - a) <= jatah_sinkron
            ingin_sinkron = not pertama and (terakhir or rng.random() < 0.4)
            pilihan = None
            if not (ingin_sinkron and sinkron_ok):
                skor = []
                for s in broll_pool:
                    # Shot harus cukup panjang untuk seluruh jatah (tanpa potongan pengisi).
                    if dipakai[s["id"]] or s["sampai"] - s["dari"] < (b - a):
                        continue
                    if pertama and s["id"] in hindari_pembuka:
                        continue
                    cocok = len(set(s["tag"]) & set(k["topik"]))
                    sk = 3 * cocok + FRAMING_BONUS.get(s["framing"], 0) - 1.5 * global_pakai[s["id"]] \
                        - 0.8 * sum(1 for p in potongan if p["footage"] == s["footage"]) + rng.random()
                    skor.append((sk, s))
                if skor:
                    pilihan = max(skor, key=lambda x: x[0])[1]
                elif (not sinkron_ok or pertama) and broll_pool:
                    # Jalur VO tanpa gambar kreator: pakai ulang shot / sambung ke shot berikutnya di file yang sama.
                    pilihan = max(broll_pool, key=lambda x: (x["sampai"] - x["dari"] >= (b - a)) * 2
                                  - dipakai[x["id"]] + rng.random())
            dur = b - a
            if pilihan is not None:
                dmax = lib["footage"][pilihan["footage"]]["durasi"]
                if pilihan["sampai"] - pilihan["dari"] < dur:  # cadangan: lanjut ke shot sesudahnya di file sama
                    in_s = max(0.0, min(pilihan["dari"], dmax - dur - 0.05))
                else:
                    in_s = pilihan["dari"]
                if pilihan["sampai"] - pilihan["dari"] > dur:  # ambil bagian acak dari shot panjang
                    in_s += rng.uniform(0, pilihan["sampai"] - pilihan["dari"] - dur)
                p = {"jenis": "broll", "footage": pilihan["footage"], "shot": pilihan["id"],
                     "alasan": "topik sama: " + ",".join(sorted(set(pilihan["tag"]) & set(k["topik"])))
                     if set(pilihan["tag"]) & set(k["topik"]) else "variasi angle"}
                dipakai[pilihan["id"]] += 1
            else:
                in_s = src_a
                shot = next((s for s in own if s["dari"] <= src_a < s["sampai"]), None)
                p = {"jenis": "sinkron", "footage": fid, "shot": shot["id"] if shot else None,
                     "alasan": "kreator VO, bibir sinkron"}
                n_sinkron += dur
            p.update({"start": round(t_out + a, 3), "dur": round(dur, 3), "in": round(in_s, 3)})
            p["blur"] = _blur_watermark(lib["footage"][p["footage"]], in_s, in_s + dur)
            potongan.append(p)
        t_out += dur_k + (JEDA if ki < len(ks) - 1 else 0)
    total = round(t_out + 1.5, 3)
    # Potongan < 1 dtk (biasanya kalimat sangat pendek, mis. "Serius?") diserap potongan tetangga.
    by_id = {x["id"]: x for x in shots}

    def muat_shot(q, extra, depan):
        if q["jenis"] == "broll":
            sh = by_id[q["shot"]]
            return q["in"] - extra >= sh["dari"] if depan else q["in"] + q["dur"] + extra <= sh["sampai"]
        return False

    i = 0
    while i < len(potongan):
        p = potongan[i]
        if p["dur"] < 1.0 and len(potongan) > 1:
            prev = potongan[i - 1] if i > 0 else None
            nxt = potongan[i + 1] if i + 1 < len(potongan) else None
            if prev and (muat_shot(prev, p["dur"], False) or (
                    prev["jenis"] == p["jenis"] == "sinkron" and prev["footage"] == p["footage"]
                    and abs(p["in"] - (prev["in"] + prev["dur"])) < 0.4)):
                prev["dur"] = round(prev["dur"] + p["dur"], 3)
                prev["blur"] = _blur_watermark(lib["footage"][prev["footage"]], prev["in"], prev["in"] + prev["dur"])
                potongan.pop(i)
                continue
            # Terakhir: ganti potongan broll tetangga dengan shot lain yang cukup panjang untuk keduanya.
            for j in (i - 1, i + 1):
                if 0 <= j < len(potongan) and potongan[j]["jenis"] == "broll":
                    q = potongan[j]
                    need = q["dur"] + p["dur"]
                    pakai_ids = {x["shot"] for x in potongan}
                    calon = [x for x in broll_pool if x["id"] not in pakai_ids and x["sampai"] - x["dari"] >= need]
                    if calon:
                        sh = max(calon, key=lambda x: FRAMING_BONUS.get(x["framing"], 0) + rng.random())
                        q.update({"footage": sh["footage"], "shot": sh["id"], "in": sh["dari"], "dur": round(need, 3),
                                  "start": min(q["start"], p["start"]), "alasan": "variasi angle"})
                        q["blur"] = _blur_watermark(lib["footage"][q["footage"]], q["in"], q["in"] + q["dur"])
                        potongan.pop(i)
                        break
            else:
                j = None
            if j is not None and (i >= len(potongan) or potongan[i] is not p):
                continue
            if nxt and muat_shot(nxt, p["dur"], True):
                nxt["in"] = round(nxt["in"] - p["dur"], 3)
                nxt["start"], nxt["dur"] = p["start"], round(nxt["dur"] + p["dur"], 3)
                nxt["blur"] = _blur_watermark(lib["footage"][nxt["footage"]], nxt["in"], nxt["in"] + nxt["dur"])
                potongan.pop(i)
                continue
        i += 1
    # Potongan sinkron yang bersambung (footage sama, waktu sumber menyambung) digabung jadi satu klip.
    gabung = []
    for p in potongan:
        q = gabung[-1] if gabung else None
        if (q and q["jenis"] == p["jenis"] == "sinkron" and q["footage"] == p["footage"]
                and abs(q["in"] + q["dur"] - p["in"]) < 0.05 and abs(q["start"] + q["dur"] - p["start"]) < 0.05):
            q["dur"] = round(q["dur"] + p["dur"], 3)
            q["blur"] = _blur_watermark(lib["footage"][q["footage"]], q["in"], q["in"] + q["dur"])
        else:
            gabung.append(p)
    potongan = gabung
    for p in potongan:
        if p["jenis"] == "broll":
            global_pakai[p["shot"]] += 1
    n_sync = sum(p["dur"] for p in potongan if p["jenis"] == "sinkron")
    return {"potongan": potongan, "vo_klip": vo_klip, "durasi": total,
            "rasio_sinkron": round(n_sync / max(total, 1e-6), 2)}
