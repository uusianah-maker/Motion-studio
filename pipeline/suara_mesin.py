"""R31 §23 mesin "Suara owner" — DIJALANKAN DENGAN suara-venv (bukan .venv). Dipanggil oleh suara_profil.py & tts.py.

  suara_mesin.py latih <perintah.json>   {"contoh":[wav...], "model_dir":..., "backend":"applio|openvoice",
                                           "epoch":150, "batch":4, "kerja_dir":...,
                                           "jeda_pukul":"06:00", "mulai_baru":false}  (§25, Applio)
  suara_mesin.py ubah  <perintah.json>   {"model_dir":..., "masuk":[wav...], "keluar":[wav...]}

Progres: JSON-lines di stdout. Kode: 0 selesai, 1 gagal teknis.
Aturan (KONTRAK §18.0/§23): proses sendiri Idle, maks 4 thread, bobot hanya dari <TOOLS>/models/suara (SHA256 dicek),
tanpa unduhan apa pun saat jalan, edge-tts diblokir (mengirim teks ke server luar), watermark OpenVoice (wavmark,
mengunduh model) tidak dipakai. Kunci AI global dipegang PEMANGGIL (suara_profil.py / tts.py).
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import suara_lanjut as lanjut  # noqa: E402

sys.modules["edge_tts"] = None  # type: ignore[assignment]  # import edge_tts -> ImportError
for _k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_k] = "4"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

TOOLS = Path(os.environ.get("MOTION_TOOLS_DIR") or Path(os.environ.get("MOTION_ENGINE_DATA", ".")).resolve().parent / "tools")
APPLIO = Path(os.environ.get("MOTION_APPLIO_DIR") or TOOLS / "applio")
OPENVOICE = Path(os.environ.get("MOTION_OPENVOICE_DIR") or TOOLS / "openvoice")
BOBOT = Path(os.environ.get("MOTION_MODELS_DIR") or TOOLS / "models") / "suara"
SR_LATIH = 40000
IDLE = 0x40

# Bobot resmi (HF IAHispano/Applio & myshell-ai/OpenVoiceV2, MIT) — SHA256 dari API HF, dicek sebelum dipakai.
SHA = {
    "f0G40k.pth": "3b2c44035e782c4b14ddc0bede9e2f4a724d025cd073f736d4f43708453adfcb",
    "f0D40k.pth": "6b6ab091e70801b28e3f41f335f2fc5f3f35c75b39ae2628d419644ec2b0fa09",
    "rmvpe.pt": "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193",
    "contentvec/pytorch_model.bin": "d8dd400e054ddf4e6be75dab5a2549db748cc99e756a097c496c099f65a4854e",
    "openvoice_v2/checkpoint.pth": "9652c27e92b6b2a91632590ac9962ef7ae2b712e5c5b7f4c34ec55ee2b37ab9e",
}
# Tempat yang dibaca Applio (relatif ke folder Applio) -> berkas kita (hardlink, tanpa salinan ganda).
TAUT_APPLIO = {
    "rvc/models/predictors/rmvpe.pt": "rmvpe.pt",
    "rvc/models/embedders/contentvec/pytorch_model.bin": "contentvec/pytorch_model.bin",
    "rvc/models/embedders/contentvec/config.json": "contentvec/config.json",
}


def progres(tahap: str, persen: int, pesan: str = "", **lain) -> None:
    print(json.dumps({"tahap": tahap, "persen": persen, "pesan": pesan, **lain}, ensure_ascii=False), flush=True)


def prioritas_idle() -> None:
    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        k32.SetPriorityClass(k32.GetCurrentProcess(), IDLE)


def sha256(p: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def cek_bobot() -> None:
    """SHA256 tiap bobot; cap (ukuran+mtime) disimpan supaya tidak menghitung ulang 800 MB tiap panggilan."""
    cap_f = BOBOT / "sha_ok.json"
    try:
        cap = json.loads(cap_f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cap = {}
    baru = {}
    for nama, sha in SHA.items():
        p = BOBOT / nama
        if not p.exists():
            raise RuntimeError(f"bobot {nama} tidak ada di {BOBOT} (unduh dulu sesuai docs R31)")
        st = p.stat()
        tanda = f"{st.st_size}:{int(st.st_mtime)}"
        if cap.get(nama) != tanda and sha256(p) != sha:
            raise RuntimeError(f"SHA256 bobot {nama} tidak cocok — jangan dipakai")
        baru[nama] = tanda
    for nama in ("contentvec/config.json", "openvoice_v2/config.json"):
        if not (BOBOT / nama).exists():
            raise RuntimeError(f"bobot {nama} tidak ada di {BOBOT}")
    if baru != cap:
        cap_f.write_text(json.dumps(baru), encoding="utf-8")


def taut_applio() -> None:
    for tujuan, asal in TAUT_APPLIO.items():
        t, a = APPLIO / tujuan, BOBOT / asal
        if t.exists() and t.stat().st_size == a.stat().st_size:
            continue
        t.parent.mkdir(parents=True, exist_ok=True)
        t.unlink(missing_ok=True)
        try:
            os.link(a, t)
        except OSError:
            shutil.copy2(a, t)


def env_applio(logs: Path) -> dict:
    cfg = BOBOT / "applio_config.json"
    if not cfg.exists():  # fp32: GTX 1650 (Turing tanpa tensor core) lebih stabil
        cfg.write_text(json.dumps({"precision": "fp32"}), encoding="utf-8")
    return {**os.environ, "APPLIO_LOGS_DIR": str(logs), "APPLIO_CONFIG_FILE": str(cfg), "APPLIO_ROOT": str(APPLIO),
            "PYTHONIOENCODING": "utf-8", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}


def hentikan_proses(proc: subprocess.Popen) -> None:
    """Hanya pohon proses Applio milik job ini."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()
    proc.wait()


def jalan_applio(args: list, logs: Path, tahap: str, p0: int, p1: int, total_epoch: int = 0, pada_epoch=None) -> bool:
    """Skrip Applio sebagai proses anak (Idle, cwd = folder Applio). Baris 'epoch=N' -> progres.
    `pada_epoch(N)` True = hentikan sekarang (§25); hasil True berarti dijeda."""
    cmd = [sys.executable, *map(str, args)]
    proc = subprocess.Popen(cmd, cwd=APPLIO, env=env_applio(logs), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", creationflags=IDLE if os.name == "nt" else 0)
    ekor: list[str] = []
    terakhir = 0
    catatan = open(logs / f"applio_{tahap}.log", "a", encoding="utf-8", errors="replace")  # bukti bila Applio crash
    for baris in proc.stdout:  # type: ignore[union-attr]
        baris = baris.rstrip()
        ekor = (ekor + [baris])[-30:]
        if "| batch=" not in baris:
            print(baris[:2000], file=catatan)
            catatan.flush()
        m = re.search(r"\bepoch=(\d+)", baris)
        if m and total_epoch and int(m.group(1)) > terakhir:  # satu baris per epoch
            terakhir = e = min(int(m.group(1)), total_epoch)
            progres(tahap, p0 + int((p1 - p0) * e / total_epoch), f"epoch {e}/{total_epoch}")
            if pada_epoch:
                try:
                    henti = pada_epoch(e)
                except Exception:
                    hentikan_proses(proc)
                    catatan.close()
                    raise
                if henti:
                    hentikan_proses(proc)
                    catatan.close()
                    return True
    catatan.close()
    if proc.wait() != 0:
        raise RuntimeError(f"Applio {tahap} gagal: " + " | ".join(ekor[-6:])[-600:])
    progres(tahap, p1, "")
    return False


def ubah_ke_wav(masuk: Path, keluar: Path, sr: int) -> None:
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(masuk), "-ac", "1", "-ar", str(sr), "-sample_fmt", "s16",
                        str(keluar)], capture_output=True, text=True, creationflags=IDLE if os.name == "nt" else 0)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg gagal: {r.stderr[-300:]}")


def f0_median(files: list[Path]) -> float:
    """Median nada (Hz) bagian bersuara — dipakai menyetel pitch TTS dasar ke nada owner."""
    import librosa
    import numpy as np
    nilai = []
    for f in files:
        y, sr = librosa.load(str(f), sr=16000, mono=True, duration=120)
        if len(y) < sr:
            continue
        f0, vo, _ = librosa.pyin(y, fmin=65, fmax=400, sr=sr, frame_length=1024)
        nilai.extend(f0[vo & ~np.isnan(f0)].tolist())
    return float(np.median(nilai)) if nilai else 0.0


def potong_ref(files: list[Path], d: Path, dtk: float = 10.0, maks: int = 60) -> list[Path]:
    """Contoh bersih -> potongan 10 dtk (OpenVoice merata-ratakan embedding per potongan)."""
    import soundfile as sf
    out = []
    for f in files:
        y, sr = sf.read(str(f), dtype="float32")
        n = int(dtk * sr)
        for i in range(0, max(1, len(y) - n // 2), n):
            seg = y[i:i + n]
            if len(seg) >= sr * 3:
                p = d / f"ref_{len(out):03d}.wav"
                sf.write(str(p), seg, sr)
                out.append(p)
            if len(out) >= maks:
                return out
    return out


class Konverter:
    """OpenVoice V2 tone color converter tanpa openvoice.api (api.py menarik modul teks/inflect & wavmark yang
    tidak dipakai). Sama dengan ToneColorConverter.extract_se/convert, tanpa watermark."""

    def __init__(self, device: str):
        sys.path.insert(0, str(OPENVOICE))
        import torch
        from openvoice import utils
        from openvoice.models import SynthesizerTrn
        hps = utils.get_hparams_from_file(str(BOBOT / "openvoice_v2" / "config.json"))
        self.model = SynthesizerTrn(len(getattr(hps, "symbols", [])), hps.data.filter_length // 2 + 1,
                                    n_speakers=hps.data.n_speakers, **hps.model).to(device)
        ck = torch.load(str(BOBOT / "openvoice_v2" / "checkpoint.pth"), map_location=device, weights_only=True)
        self.model.load_state_dict(ck["model"], strict=False)
        self.model.eval()
        self.hps, self.device = hps, device

    def _spek(self, path: str):
        import librosa
        import torch
        from openvoice.mel_processing import spectrogram_torch
        h = self.hps.data
        y, _ = librosa.load(path, sr=h.sampling_rate)
        y = torch.FloatTensor(y).to(self.device).unsqueeze(0)
        return spectrogram_torch(y, h.filter_length, h.sampling_rate, h.hop_length, h.win_length, center=False).to(self.device)

    def extract_se(self, files: list[str], se_save_path: str | None = None):
        import torch
        with torch.no_grad():
            g = torch.stack([self.model.ref_enc(self._spek(f).transpose(1, 2)).unsqueeze(-1) for f in files]).mean(0)
        if se_save_path:
            torch.save(g.cpu(), se_save_path)
        return g

    def convert(self, audio_src_path: str, src_se, tgt_se, output_path: str, tau: float = 0.3) -> None:
        import soundfile
        import torch
        with torch.no_grad():
            spec = self._spek(audio_src_path)
            n = torch.LongTensor([spec.size(-1)]).to(self.device)
            a = self.model.voice_conversion(spec, n, sid_src=src_se, sid_tgt=tgt_se.to(self.device), tau=tau)[0][0, 0]
        soundfile.write(output_path, a.data.cpu().float().numpy(), self.hps.data.sampling_rate)


def openvoice(device: str) -> Konverter:
    return Konverter(device)


def perangkat() -> str:
    import torch
    return "cuda:0" if torch.cuda.is_available() else "cpu"


# ---------------- latih ----------------
def latih(cmd: dict) -> dict:
    contoh = [Path(p) for p in cmd["contoh"]]
    model_dir = Path(cmd["model_dir"])
    backend = cmd.get("backend", "applio")
    model_dir.mkdir(parents=True, exist_ok=True)
    cek_bobot()
    info: dict = {"backend": backend, "dibuat": time.strftime("%Y-%m-%dT%H:%M:%S")}
    dev = perangkat()
    se_baru = model_dir / "openvoice_se.baru.pth"
    progres("latih", 2, "nada & warna suara (OpenVoice)")
    with tempfile.TemporaryDirectory() as d:
        ref = potong_ref(contoh, Path(d))
        if not ref:
            raise RuntimeError("contoh terlalu pendek untuk diambil warna suaranya")
        c = openvoice(dev)
        # §25: model aktif baru diganti setelah latihan selesai (bukan saat dijeda/gagal).
        c.extract_se([str(p) for p in ref], se_save_path=str(se_baru))
        del c
    info["f0_hz"] = round(f0_median(contoh), 1)
    progres("latih", 8, f"nada tengah owner ±{info['f0_hz']:.0f} Hz")
    if backend == "applio":
        taut_applio()
        kerja = Path(cmd.get("kerja_dir") or model_dir / "_kerja")
        data = kerja / "dataset"
        logs = kerja / "logs"
        exp = logs / "owner"
        epoch = int(cmd.get("epoch") or 150)
        batch = int(cmd.get("batch") or 4)
        jeda_pada = lanjut.waktu_jeda(cmd.get("jeda_pukul"))  # dihitung sebelum persiapan yang bisa melewati jam itu
        sidik = lanjut.sidik_latih(contoh, batch, SR_LATIH)
        # §25: progres sah dilanjutkan; progres meragukan = gagal keras (tidak dihapus diam-diam).
        rencana = {"aksi": "baru"} if cmd.get("mulai_baru") else lanjut.putuskan(kerja, exp, sidik, epoch)
        tr = APPLIO / "rvc" / "train"
        mulai_dari = 0
        if rencana["aksi"] == "lanjut":
            m_lanjut = lanjut.baca_manifest(kerja) or {}
            if not lanjut.sempat_checkpoint(time.time(), jeda_pada, m_lanjut.get("dtk_blok") or lanjut.perkiraan_blok(exp)):
                se_baru.unlink(missing_ok=True)
                progres("latih", 20, "tidak sempat mencapai checkpoint berikutnya sebelum jam jeda; latihan tidak dimulai")
                return {"backend": backend, "dijeda": True, "tidak_mulai": True, "epoch": rencana["epoch"], "total_epoch": epoch}
            mulai_dari = lanjut.pulihkan(kerja, exp)
            progres("latih", 20, f"melanjutkan dari epoch {mulai_dari}/{epoch}")
        else:
            if kerja.exists():
                shutil.rmtree(kerja)
            data.mkdir(parents=True)
            for i, f in enumerate(contoh):
                shutil.copy2(f, data / f"{i:03d}.wav")
            exp.mkdir(parents=True)
            jalan_applio([tr / "preprocess" / "preprocess.py", exp, data, SR_LATIH, 2, "Automatic", False, 3.0, 0.3, "none"],
                         logs, "latih_siapkan", 8, 12)
            jalan_applio([tr / "extract" / "extract.py", exp, "rmvpe", 2, "0" if dev.startswith("cuda") else "-", SR_LATIH,
                          "contentvec", "", 2], logs, "latih_fitur", 12, 20)
            lanjut.tulis_manifest(kerja, {"schema": "suara-lanjut/1", "sidik": sidik, "total_epoch": epoch, "batch": batch})
        penjaga = lanjut.Penjaga(kerja, exp, epoch, mulai_dari, jeda_pada)
        dijeda = jalan_applio([tr / "train.py", "owner", lanjut.SETIAP_EPOCH, epoch, BOBOT / "f0G40k.pth", BOBOT / "f0D40k.pth",
                               "0" if dev.startswith("cuda") else "-", batch, SR_LATIH, True, True, False, False, "HiFi-GAN", False],
                              logs, "latih", 20, 92, total_epoch=epoch, pada_epoch=penjaga)
        if dijeda:
            se_baru.unlink(missing_ok=True)
            progres("latih", 92, f"dijeda aman di epoch {penjaga.epoch_aman}/{epoch}")
            return {"backend": backend, "dijeda": True, "epoch": penjaga.epoch_aman, "total_epoch": epoch}
        jalan_applio([tr / "process" / "extract_index.py", exp, "Auto"], logs, "latih_index", 92, 96)
        bobot = sorted(exp.glob("owner_*e_*s.pth"), key=lambda p: p.stat().st_mtime)
        index = sorted(exp.glob("*.index"), key=lambda p: p.stat().st_mtime)
        if not bobot:
            raise RuntimeError("Applio selesai tanpa file model")
        (model_dir / "applio").mkdir(exist_ok=True)
        shutil.copy2(bobot[-1], model_dir / "applio" / "owner.pth")
        if index:
            shutil.copy2(index[-1], model_dir / "applio" / "owner.index")
        info.update(epoch=epoch, batch=batch, applio_bobot=bobot[-1].name, applio_index=bool(index))
        if not os.environ.get("MOTION_SUARA_SIMPAN_KERJA"):  # simpan = latihan masih bisa diteruskan ke epoch lebih tinggi
            shutil.rmtree(kerja, ignore_errors=True)  # checkpoint G/D besar; model akhir sudah disalin
    os.replace(se_baru, model_dir / "openvoice_se.pth")
    (model_dir / "info.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    progres("latih", 97, "model tersimpan")
    return info


# ---------------- ubah (TTS dasar -> suara owner) ----------------
def ubah(cmd: dict) -> dict:
    model_dir = Path(cmd["model_dir"])
    info = json.loads((model_dir / "info.json").read_text(encoding="utf-8"))
    masuk, keluar = [Path(p) for p in cmd["masuk"]], [Path(p) for p in cmd["keluar"]]
    cek_bobot()
    dev = perangkat()
    backend = info.get("backend", "openvoice")
    pitch = 0
    if info.get("f0_hz"):
        import math
        dasar = f0_median(masuk)
        if dasar > 0:
            pitch = max(-12, min(12, round(12 * math.log2(info["f0_hz"] / dasar))))
    with tempfile.TemporaryDirectory() as d:
        if backend == "applio":
            taut_applio()
            os.environ.update({k: v for k, v in env_applio(model_dir).items() if k.startswith(("APPLIO_", "HF_", "TRANS"))})
            prev = os.getcwd()
            os.chdir(APPLIO)
            sys.path.insert(0, str(APPLIO))
            try:
                from rvc.infer.infer import VoiceConverter
                vc = VoiceConverter()
                for i, (a, b) in enumerate(zip(masuk, keluar)):
                    progres("ubah_suara", 10 + int(85 * i / len(masuk)), f"kalimat {i + 1}/{len(masuk)}")
                    tmp = Path(d) / f"{i:02d}.wav"
                    vc.convert_audio(audio_input_path=str(a), audio_output_path=str(tmp),
                                     model_path=str(model_dir / "applio" / "owner.pth"),
                                     index_path=str(model_dir / "applio" / "owner.index") if (model_dir / "applio" / "owner.index").exists() else "",
                                     pitch=pitch, f0_method="rmvpe", index_rate=0.5, protect=0.33, volume_envelope=1.0,
                                     embedder_model="contentvec", export_format="WAV")
                    ubah_ke_wav(tmp, b, 48000)
            finally:
                os.chdir(prev)
        else:
            import torch
            c = openvoice(dev)
            tgt = torch.load(str(model_dir / "openvoice_se.pth"), map_location=dev)
            for i, (a, b) in enumerate(zip(masuk, keluar)):
                progres("ubah_suara", 10 + int(85 * i / len(masuk)), f"kalimat {i + 1}/{len(masuk)}")
                src = c.extract_se([str(a)])
                tmp = Path(d) / f"{i:02d}.wav"
                c.convert(audio_src_path=str(a), src_se=src, tgt_se=tgt, output_path=str(tmp), tau=0.3)
                ubah_ke_wav(tmp, b, 48000)
    progres("ubah_suara", 96, "")
    return {"backend": backend, "pitch": pitch}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 3 or sys.argv[1] not in ("latih", "ubah"):
        print("pakai: suara_mesin.py latih|ubah <perintah.json>", file=sys.stderr)
        sys.exit(1)
    prioritas_idle()
    try:
        perintah = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        hasil = (latih if sys.argv[1] == "latih" else ubah)(perintah)
        print(json.dumps({"tahap": "hasil", "persen": 100, "hasil": hasil}, ensure_ascii=False), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"GAGAL: {e!r}", file=sys.stderr)
        progres("gagal", 100, str(e)[:300])
        sys.exit(1)
