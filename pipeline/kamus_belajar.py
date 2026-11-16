"""R30b Belajar otomatis: koreksi subtitle editor (R9 catatan belajar) -> USULAN entri kamus per brand (yuki).

  python pipeline/kamus_belajar.py <belajar.jsonl> [--brand-kit brand_kit.json] [--min 2]
  stdout: satu JSON {"schema": "kamus-usulan/1", ...}

Sumber: `.motionstudio/brands/<brand_id>/belajar.jsonl` (Motion Studio, R9), baris
  {"jenis": "koreksi", "bagian": "kata", "op": "set_text", "sebelum": "mau punya cana", "sesudah": "mau punya celana", ...}

Cara kerja:
- Teks sebelum/sesudah dibandingkan per kata (difflib). Yang diambil hanya PENGGANTIAN 1–3 kata
  ("cana" -> "celana", "icy love" -> "aysilla"); beda huruf besar/kecil atau tanda baca saja diabaikan,
  kata yang hanya ditambah/dihapus juga diabaikan (bukan salah dengar).
- Pasangan yang muncul >= `--min` kali (bawaan 2, owner: "cana → celana muncul 2x -> usul") = `usulan`;
  sekali saja = `pantau` (ditampilkan, belum diusulkan).
- Sudah ada di kamus Brand Kit = dilewati. `periksa: true` bila berisiko diterapkan GLOBAL oleh apply_kamus:
  kata salah <= 3 huruf, atau kata salah itu di koreksi lain justru dibiarkan tim (berarti kata yang benar).
- Hybrid: ini hanya usulan. Motion Studio menampilkannya di menu Brand, tim menyetujui sekali klik, lalu app
  menyimpannya ke `teks.kamus` (dan `benar` yang belum ada ke `teks.kosakata_whisper`). Mesin tidak menulis Brand Kit.
"""

from __future__ import annotations

import difflib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

MIN_JUMLAH = 2
MAKS_KATA = 3


def token(teks: str) -> list[str]:
    return [t for t in re.split(r"\s+", str(teks or "").strip()) if t]


def norm(t: str) -> str:
    return re.sub(r"[^\w-]+", "", t.lower())


def penggantian(sebelum: str, sesudah: str) -> list[tuple[str, str]]:
    """Pasangan (salah, benar) dalam bentuk ternormalisasi (huruf kecil, tanpa tanda baca) + bentuk tulisan benar."""
    a, b = token(sebelum), token(sesudah)
    na, nb = [norm(x) for x in a], [norm(x) for x in b]
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, na, nb, autojunk=False).get_opcodes():
        if tag != "replace":
            continue
        if not (1 <= i2 - i1 <= MAKS_KATA and 1 <= j2 - j1 <= MAKS_KATA):
            continue
        salah = " ".join(x for x in na[i1:i2] if x)
        benar_n = " ".join(x for x in nb[j1:j2] if x)
        if not salah or not benar_n or salah == benar_n:
            continue
        benar = " ".join(re.sub(r"^[^\w]+|[^\w]+$", "", x) for x in b[j1:j2]).strip()
        out.append((salah, benar))
    return out


def baca_catatan(path: Path) -> list[dict]:
    hasil = []
    for baris in path.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(baris)
        except ValueError:
            continue
        if d.get("jenis") == "koreksi" and d.get("bagian") == "kata" and isinstance(d.get("sebelum"), str) \
                and isinstance(d.get("sesudah"), str):
            hasil.append(d)
    return hasil


def usulan(catatan: list[dict], kamus: dict | None = None, kosakata: list | None = None, minimal: int = MIN_JUMLAH) -> dict:
    kamus_n = {norm(k): v for k, v in (kamus or {}).items()}
    kosakata_n = {norm(x) for x in (kosakata or [])}
    hit: dict[tuple[str, str], dict] = defaultdict(lambda: {"jumlah": 0, "proyek": set(), "contoh": []})
    dibiarkan: set[str] = set()  # kata yang muncul di teks SESUDAH koreksi (tim menganggapnya benar)
    for d in catatan:
        for t in token(d["sesudah"]):
            dibiarkan.add(norm(t))
        for salah, benar in penggantian(d["sebelum"], d["sesudah"]):
            h = hit[(salah, benar.lower())]
            h["jumlah"] += 1
            h["benar"] = benar
            if d.get("project_id"):
                h["proyek"].add(d["project_id"])
            if len(h["contoh"]) < 3:
                h["contoh"].append({"sebelum": d["sebelum"][:120], "sesudah": d["sesudah"][:120]})
    usul, pantau, sudah = [], [], []
    for (salah, _), h in sorted(hit.items(), key=lambda kv: (-kv[1]["jumlah"], kv[0][0])):
        e = {"salah": salah, "benar": h["benar"], "jumlah": h["jumlah"], "proyek": len(h["proyek"]),
             "contoh": h["contoh"]}
        if salah in kamus_n:
            sudah.append(e)
            continue
        alasan = []
        if all(len(w) <= 3 for w in salah.split()):
            alasan.append("kata salah sangat pendek: bisa mengganti kata lain yang benar")
        if any(w in dibiarkan for w in salah.split()):
            alasan.append("kata ini di koreksi lain dibiarkan tim (mungkin kata yang benar)")
        e["periksa"] = bool(alasan)
        if alasan:
            e["alasan_periksa"] = alasan
        e["kosakata_baru"] = [w for w in [h["benar"]] if norm(w) not in kosakata_n]
        (usul if h["jumlah"] >= minimal else pantau).append(e)
    return {"schema": "kamus-usulan/1", "minimal": minimal, "koreksi_kata": len(catatan),
            "usulan": usul, "pantau": pantau, "sudah_di_kamus": sudah}


def main() -> int:
    import argparse
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="catatan belajar (koreksi subtitle) -> usulan kamus brand")
    ap.add_argument("belajar")
    ap.add_argument("--brand-kit")
    ap.add_argument("--min", type=int, default=MIN_JUMLAH)
    a = ap.parse_args()
    kamus, kosakata = {}, []
    if a.brand_kit:
        bk = json.loads(Path(a.brand_kit).read_text(encoding="utf-8"))
        t = bk.get("teks") or {}
        kamus = t.get("kamus") or bk.get("kamus_kata") or {}
        kosakata = t.get("kosakata_whisper") or bk.get("kosakata_whisper") or []
    p = Path(a.belajar)
    catatan = baca_catatan(p) if p.exists() else []
    print(json.dumps(usulan(catatan, kamus, kosakata, max(1, a.min)), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
