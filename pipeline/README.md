# Pipeline auto-edit

Semua perintah dijalankan dari `D:\VIBECODING\remotion` (PowerShell).

## Sekali saja
```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r pipelineequirements.txt   # faster-whisper, OpenCV (deteksi wajah)
node pipeline/make-sfx.mjs        # buat public/sfx/pop.wav + whoosh.wav
```

## Cara cepat: satu perintah
```powershell
$env:PYTHONIOENCODING="utf-8"
.\.venv\Scripts\python pipeline\jalan.py C:\Users\distc\Videos\a3.mp4 --brand aysilla --produk celana
```
Menyalin video ke `public/masuk/`, transkrip (dilewati kalau sudah ada dan videonya
tidak berubah), rencana edit, render, lalu mencetak ringkasan + waktu tiap tahap.
Tambah `--draf` untuk render cepat setengah resolusi saat revisi
(`<brand>_th_<produk>_draf.mp4`, selalu ditimpa). Opsi lain sama dengan `edit.py` di bawah.

Semua video jadi masuk ke **`public/Output/`** (`<brand>_th_<produk>_vNN.mp4`).
Data kerja (transkrip, potongan, props) tetap di `out/<nama>/`.

Kecepatan (diukur 11 Nov 2026, a3 27 dtk):
- Render memakai GPU (ANGLE) + 12 thread, diatur di `remotion.config.ts`: 104 -> 76 dtk.
- Render memakai salinan video dengan keyframe tiap 15 frame (`public/masuk/_render/`),
  dibuat otomatis oleh jalan.py. Video unduhan dengan keyframe jarang: a5 55,5 -> 32,5 dtk per 300 frame.
- `--sembunyikan 22.6`: kata salah dengar di detik itu tidak ditampilkan (audio tetap).
- Render hanya membawa file yang dipakai (folder `out/<nama>/_public` sementara),
  bukan seluruh `public/`.
- Whisper otomatis memakai GPU NVIDIA kalau library CUDA terpasang
  (`pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"`), selain itu CPU.

## Per video, langkah manual (gaya brand, contoh Aysilla)
```powershell
$env:PYTHONIOENCODING="utf-8"
# 1. Transkrip per kata (kosakata brand membantu Whisper)
.\.venv\Scripts\python pipeline\transcribe.py public\masuk\a3.mp4 out\a3\transkrip.json --brandkit brandkit\aysilla.json
# 2. Rencana edit: kamus, auto-cut, kata kunci, hook, efek, SFX, CTA -> out\a3\potongan.json + props.json
.\.venv\Scripts\python pipeline\edit.py out\a3\transkrip.json --brandkit brandkit\aysilla.json --video masuk/a3.mp4 --out out\a3 --placement tiktok
# 3. Render + loudness -14 LUFS + versi otomatis (_v01, _v02, ...)
.\.venv\Scripts\python pipeline\render.py out\a3\props.json --name aysilla_th_celana
```

Rencana edit **tidak** langsung dirender: `jalan.py` berhenti setelah rencana dan menampilkan ringkasan.
Render baru jalan kalau ditambah `--setuju` (aturan: rencana disetujui dulu).

Video tanpa ucapan (hanya musik) ditolak otomatis (`pipeline/cek_ucapan.py`, kode keluar 2).

Opsi `edit.py`:
- `--placement tiktok|instagram`: CTA dari brand kit (keranjang kuning hanya TikTok).
- `--caption-pos auto` (default): posisi caption dipilih otomatis supaya tidak menutup wajah (`pipeline/posisi_caption.py`). `bawah`/`atas` untuk memaksa.
- `--area-produk bawah|atas|penuh`: letak produk di frame; caption menghindarinya (wajah tetap prioritas).
- `--brandkit`: format lama `brandkit/<brand>.json` atau ekspor Motion Studio `brand-kit-export/1`.
- `--hook-end-sec 3.4`: judul hook ditahan sampai detik ini, misalnya untuk menutup teks yang sudah tertanam di video sumber.

## File
| File | Isi |
|---|---|
| `brandkit/<brand>.json` | warna, CTA, kosakata Whisper, kamus koreksi, kata kunci, superlatif terlarang |
| `out/<nama>/transkrip.json` | kata + waktu dari Whisper (waktu sumber) |
| `out/<nama>/potongan.json` | bagian dibuang, koreksi kamus, efek, kata kunci, SFX, keraguan: untuk dicek manusia |
| `out/<nama>/props.json` | input composition `AdVideo` |
| `public/musik/` | musik latar berlisensi aman (kosong = render tanpa musik) |

`pipeline/autocut.py` = versi dasar tanpa brand kit (dipakai uji-01).
