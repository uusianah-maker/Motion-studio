"""R6 Riwayat pakai lintas batch (Batch Remix), per brand.

Keputusan owner (15 Nov, no. 16): konten yang sudah dipakai tidak boleh dipakai berulang, TERMASUK antar batch.
Perencana membaca riwayat brand sebelum menyusun, lalu mencatat varian batch ini sesudahnya:
  - pembuka (shot pertama) yang pernah dipakai tidak dipakai lagi sebagai pembuka;
  - susunan kalimat VO (urutan id kalimat per footage VO) yang pernah dipakai tidak diulang;
  - varian dengan VO sama dibandingkan juga dengan riwayat (aturan mirip KONTRAK §11: Jaccard shot > 0,4,
    pembuka sama, > 50% kalimat bergambar identik);
  - shot yang pernah dipakai diberi penalti di Matcher (dipilih paling akhir).

File: <MOTION_RIWAYAT_DIR atau konten/riwayat>/<kode brand>.json (data mesin, di luar folder job, tidak di-commit:
konten/** ada di .gitignore). Satu entri per varian; job yang dijalankan ulang MENGGANTI entrinya sendiri
(riwayat job itu tidak membatasi dirinya sendiri).

Status entri: "direncanakan" (dicatat perencana saat batch selesai; mesin belum tahu keputusan tim),
"disetujui"/"dirender" (bila app/tim menandai), "dicoret" (tidak dihitung). Selama app belum mengirim
keputusan, entri "direncanakan" DIHITUNG (aman: lebih baik tidak mengulang). Varian yang dicoret dilepas
dengan `riwayat.py lepas`.

Hybrid (prinsip owner): job.abaikan_riwayat = true -> riwayat tidak dibaca dan job ini tidak dicatat.

CLI (dari root repo mesin):
  python pipeline/batch/riwayat.py lihat <brand>
  python pipeline/batch/riwayat.py reset <brand>                       (riwayat lama disimpan sebagai cadangan)
  python pipeline/batch/riwayat.py tandai <brand> <job_id> <status> [varian-001 ...]
  python pipeline/batch/riwayat.py lepas <brand> <job_id> [varian-001 ...]   (= tandai ... dicoret)
"""

import json
import os
import re
import sys
import time
from pathlib import Path

from jalur import KONTEN

SCHEMA = "riwayat-batch/1"
STATUS = {"direncanakan", "disetujui", "dirender", "dicoret"}
DIHITUNG = {"direncanakan", "disetujui", "dirender"}


def folder() -> Path:
    return Path(os.environ["MOTION_RIWAYAT_DIR"]) if os.environ.get("MOTION_RIWAYAT_DIR") else KONTEN / "riwayat"


def kunci_brand(brand_raw: dict, brand: dict | None = None) -> str:
    """Kode brand (AYS) dari ekspor Brand Kit; cadangan: nama brand. Aman untuk nama file."""
    b = brand_raw.get("brand") if isinstance(brand_raw.get("brand"), dict) else {}
    nilai = b.get("kode") or b.get("id") or b.get("nama") or brand_raw.get("nama") or (brand or {}).get("nama") or "tanpa-brand"
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(nilai)).strip("._")[:60] or "tanpa-brand"


def path(brand_key: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,60}", brand_key) or ".." in brand_key:
        raise ValueError(f"kunci brand tidak valid: {brand_key!r}")
    return folder() / f"{brand_key}.json"


def muat(brand_key: str) -> dict:
    """Riwayat brand. File rusak tidak menggagalkan batch: dipindah ke <kode>.rusak-<waktu>.json,
    lanjut dengan riwayat kosong + `_peringatan` (ditampilkan di batch.json)."""
    p = path(brand_key)
    kosong = {"schema": SCHEMA, "brand": brand_key, "entri": []}
    if not p.exists():
        return kosong
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(d, dict) or not isinstance(d.get("entri", []), list) \
                or not all(isinstance(e, dict) for e in d.get("entri", [])):
            raise ValueError("struktur riwayat tidak dikenal")
    except (ValueError, OSError) as e:  # json.JSONDecodeError turunan ValueError
        rusak = p.with_name(f"{p.stem}.rusak-{time.strftime('%Y%m%d-%H%M%S')}.json")
        os.replace(p, rusak)
        return {**kosong, "_peringatan": f"riwayat {brand_key} rusak ({type(e).__name__}); dipindah ke {rusak.name}, "
                                          "batch ini memakai riwayat kosong"}
    d.setdefault("entri", [])
    d["brand"] = brand_key
    return d


def simpan(d: dict) -> None:
    p = path(d["brand"])
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    d = {k: v for k, v in d.items() if not k.startswith("_")}
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def kunci_vo(vo_batch: str, footage: str) -> str:
    return f"{vo_batch}|{footage}"


def kunci_shot(batch: str, vo_batch: str, p: dict) -> str:
    """Id shot unik lintas batch: '<batch>|<shot>' (sinkron = gambar footage VO, batch VO)."""
    b = vo_batch if p["jenis"] == "sinkron" else batch
    return f"{b}|{p['shot'] or p['footage'] + '@' + format(p['in'], '.0f')}"


class Riwayat:
    """Ringkasan riwayat untuk satu job: yang harus dihindari perencana."""

    def __init__(self, data: dict, batch: str, vo_batch: str, job_id: str | None):
        self.data = data
        self.batch, self.vo_batch, self.job_id = batch, vo_batch, job_id
        # Entri job ini sendiri yang masih "direncanakan" akan diganti oleh jalan ulang ini, jadi tidak membatasi.
        # Yang SUDAH disetujui/dirender tetap dihitung, juga untuk job yang sama (kontennya sudah dipakai).
        self.entri = [e for e in data["entri"] if e.get("status", "direncanakan") in DIHITUNG
                      and not (job_id and e.get("job_id") == job_id
                               and e.get("status", "direncanakan") == "direncanakan")]

    def pembuka(self) -> set[str]:
        """Shot pembuka yang pernah dipakai (batch gambar ini), dalam id shot lokal batch ini."""
        pre = f"{self.batch}|"
        return {e["pembuka"][len(pre):] for e in self.entri if e.get("pembuka", "").startswith(pre)}

    def urutan(self, footage_vo: str) -> set[tuple]:
        k = kunci_vo(self.vo_batch, footage_vo)
        return {tuple(e["urutan"]) for e in self.entri if e.get("vo") == k and e.get("urutan")}

    def shot_terpakai(self) -> dict[str, int]:
        """{id shot lokal batch ini: berapa kali pernah dipakai} untuk penalti Matcher."""
        pre, n = f"{self.batch}|", {}
        for e in self.entri:
            for s in e.get("shots", []):
                if s.startswith(pre):
                    n[s[len(pre):]] = n.get(s[len(pre):], 0) + 1
        return n

    def sebanding(self, footage_vo: str) -> list[dict]:
        """Entri dengan VO sama (untuk cek mirip §11): {_shots, _pembuka, _per_kalimat} dalam kunci lintas batch."""
        k = kunci_vo(self.vo_batch, footage_vo)
        return [{"_shots": set(e.get("shots", [])), "_pembuka": e.get("pembuka"),
                 "_per_kalimat": {int(i): tuple(v) for i, v in e.get("per_kalimat", {}).items()}}
                for e in self.entri if e.get("vo") == k]

    def ringkas(self) -> dict:
        r = {"aktif": True, "entri_dihitung": len(self.entri), "pembuka_dihindari": len(self.pembuka())}
        if self.data.get("_peringatan"):
            r["peringatan"] = self.data["_peringatan"]
        return r


def entri_varian(job_id, batch, vo_batch, v: dict, sus: dict, rv: dict, per_kalimat: dict) -> dict:
    ks = lambda p: kunci_shot(batch, vo_batch, p)  # noqa: E731
    pertama = sus["potongan"][0] if sus["potongan"] else None
    lokal = {}  # per_kalimat dari id lokal -> kunci lintas batch
    for p in sus["potongan"]:
        lokal[p["shot"] or f"{p['footage']}@{p['in']:.0f}"] = ks(p)
    return {
        "job_id": job_id, "varian": v["id"], "batch": batch, "vo_batch": vo_batch,
        "vo": kunci_vo(vo_batch, rv["vo"]), "urutan": list(rv["urutan"]),
        "pembuka": ks(pertama) if pertama else None,
        "shots": sorted({ks(p) for p in sus["potongan"]}),
        "per_kalimat": {str(i): [lokal.get(s, s) for s in t] for i, t in per_kalimat.items()},
        "status": "direncanakan", "sumber": "perencana", "waktu": int(time.time() * 1000),
    }


def isi(e: dict) -> tuple:
    """Identitas isi varian: sama persis = varian yang sama (bukan sekadar nama varian-NNN yang sama)."""
    return (e.get("vo"), tuple(e.get("urutan", [])), e.get("pembuka"), tuple(sorted(e.get("shots", []))))


def catat(brand_key: str, job_id: str, entri: list[dict]) -> int:
    """Catat varian job ini. Jalan ulang job yang sama:
    - entri lama "direncanakan" / "dicoret" diganti (tidak menumpuk);
    - entri lama "disetujui" / "dirender" TIDAK dihapus (kontennya sudah dipakai): tetap dihitung, ditandai
      `diganti` kalau varian baru isinya beda;
    - status lama hanya dibawa ke varian baru kalau isinya identik."""
    if not job_id:
        raise ValueError("job_id wajib (perencana memakai nama folder job kalau job.json tidak punya job_id)")
    d = muat(brand_key)
    lama = [e for e in d["entri"] if e.get("job_id") == job_id]
    d["entri"] = [e for e in d["entri"] if e.get("job_id") != job_id]
    tetap = [e for e in lama if e.get("status") in {"disetujui", "dirender"}]
    status_lama = {(e.get("varian"), isi(e)): e.get("status") for e in lama}
    baru = []
    for e in entri:
        st = status_lama.get((e["varian"], isi(e)))
        if st in {"disetujui", "dirender"}:
            continue  # identik dengan entri terpakai yang dipertahankan: tidak dicatat dobel
        if st == "dicoret":
            e["status"], e["sumber_status"] = "dicoret", "tim"
        baru.append(e)
    isi_baru = {(e["varian"], isi(e)) for e in entri}
    for e in tetap:
        if (e.get("varian"), isi(e)) not in isi_baru:
            e["diganti"] = True
    d["entri"].extend(tetap + baru)
    simpan(d)
    return len(baru)


def tandai(brand_key: str, job_id: str, status: str, varian: list[str] | None = None) -> int:
    if status not in STATUS:
        raise ValueError(f"status harus salah satu dari {sorted(STATUS)}")
    d = muat(brand_key)
    n = 0
    for e in d["entri"]:
        if e.get("job_id") == job_id and (not varian or e.get("varian") in varian):
            e["status"], e["sumber_status"] = status, "tim"
            n += 1
    simpan(d)
    return n


def reset(brand_key: str) -> Path | None:
    p = path(brand_key)
    if not p.exists():
        return None
    cadangan = p.with_name(f"{p.stem}.reset-{time.strftime('%Y%m%d-%H%M%S')}.json")
    os.replace(p, cadangan)
    return cadangan


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in {"lihat", "reset", "tandai", "lepas"}:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, brand_key = argv[0], argv[1]
    if cmd == "lihat":
        d = muat(brand_key)
        per = {}
        for e in d["entri"]:
            per[e.get("status", "?")] = per.get(e.get("status", "?"), 0) + 1
        print(json.dumps({"brand": brand_key, "entri": len(d["entri"]), "status": per,
                          "job": sorted({e.get("job_id") for e in d["entri"] if e.get("job_id")})}, ensure_ascii=False))
        return 0
    if cmd == "reset":
        c = reset(brand_key)
        print(json.dumps({"brand": brand_key, "reset": bool(c), "cadangan": c.name if c else None}))
        return 0
    if len(argv) < 3:
        print("butuh <job_id>", file=sys.stderr)
        return 2
    if cmd == "lepas":
        n = tandai(brand_key, argv[2], "dicoret", argv[3:] or None)
    else:
        if len(argv) < 4:
            print("butuh <status>", file=sys.stderr)
            return 2
        n = tandai(brand_key, argv[2], argv[3], argv[4:] or None)
    print(json.dumps({"brand": brand_key, "job_id": argv[2], "diubah": n}))
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main(sys.argv[1:]))
