# Batch Remix (modul yuki)

Bikin banyak varian video dari footage campuran: **VO dari satu footage + shot dari footage lain + musik**.
Mesin **tidak merender**. Hasilnya rencana edit (`batch.json`, `rencana.json`, `ops.json`) sesuai
`docs/KONTRAK-ENGINE.md` v0.3; Motion Studio (U5) menampilkan tabel, tim mencoret/menyetujui sekali,
lalu Motion Studio merender varian yang disetujui.

## Modul

| # | File | Isi |
|---|---|---|
| Y1 | `pipeline/pisah.py` | Pisah Audio + Stem Splitter → `konten/2-dipisah/<batch>/{video-bisu,audio-asli,vokal,musik}` |
| Y2 | `shotlib.py` | Shot Library: potong per shot (≤ 3 dtk) + label → `konten/2-dipisah/<batch>/shots.json` |
| Y3 | `vo.py`, `matcher.py` | Pilih VO + kalimat; susun shot per kalimat |
| Y4 | `musik.py` | Musik berlisensi, tempo & ketukan; potongan ikut ketukan |
| Y5 | `perencana.py` | N varian unik → `<job_dir>/out/batch.json` + `varian-NNN/{rencana,ops,qc_rencana}.json` |
| – | `pratinjau.py` | Pratinjau kasar 540×960 (bukan render final) untuk mengecek rencana |
| – | `common.py` | Topik, pemecah kalimat, aturan kalimat terlarang (memakai modul inti venus) |
| – | `test_batch.py` | Uji unit |

## Dua Python

- `.venv` (repo): `perencana.py`, `pratinjau.py`, tes. Butuh `transcribe.py` / `edit.py` / `brandkit.py` (milik venus, hanya diimpor).
- `<TOOLS>\demucs-venv`: Demucs (`pisah.py`) + OpenCV + RapidOCR (`shotlib.py`).
  Perencana memanggil Shot Library sendiri lewat Python ini kalau `shots.json` belum ada.

## Alur

```
.venv\Scripts\python pipeline\pisah.py <batch>                                   # Y1
<TOOLS>\demucs-venv\Scripts\python pipeline\batch\shotlib.py <batch>  # Y2 (sekali per batch, ±1 mnt/footage)
.venv\Scripts\python pipeline\batch\perencana.py <job_dir>                        # Y3-Y5
.venv\Scripts\python pipeline\batch\pratinjau.py <job_dir> varian-001 [--blur]    # opsional, cek visual
```

`<job_dir>/job.json` (mode batch, kontrak bagian 3):

```json
{ "schema": "engine-job/1", "job_id": "AYS-20261113-B01", "mode": "batch",
  "batch": "2026-11-13_video-winning", "jumlah": 20, "tujuan": "konversi", "seed": 42,
  "izinkan_musik_tanpa_lisensi": false, "brand_kit": "brand_kit.json",
  "brief": { "produk": "Loose Pants", "placement": "tiktok", "harga": "" },
  "akun_sendiri": ["@aysilla_factory", "@aln_store.id"],
  "hak_pakai_jelas": false, "mode_ops": "kompat" }
```

| Field tambahan | Arti |
|---|---|
| `buang_otomatis` | Default `[]` = tidak ada kalimat VO yang dibuang. Isi jenis yang boleh dibuang otomatis, mis. `["superlatif", "urgensi", "live", "musiman"]`. |
| `batas_durasi` | Default `null` = tanpa batas (durasi ikut VO). Isi `[min, maks]` detik supaya kalimat tengah dibuang sampai masuk dan VO di luar batas tidak dipakai. Saran per tujuan tetap ditulis di `rencana.json` `durasi.saran`. |
| `akun_sendiri` | Akun watermark milik brand. Footage ber-watermark akun lain tidak dipakai. Kosong = semua dipakai + peringatan. |
| `hak_pakai_jelas` | `true` = blur watermark/teks boleh dipasang (kontrak 5.3: blur hanya untuk footage milik brand). |
| `mode_ops` | `kompat` (default) = semua operasi yang sudah diterima Motion Studio: U3a (`set_loudness`, `volume`), U3b (track `music`, caption per kata `words` + `pop` + `highlight`), U3c (hook kotak kaca, `highlight.box`), U3d (`Clip.blur`, waktu = ms sumber, maks 8 area). `menunggu_u3` sekarang kosong. Caption memakai `kata_klip`/`_bersih` dari `pipeline/ops.py`, jadi bentuknya sama dengan Generate Otomatis. |
| `shot_tiktok` | Paksa anggap semua footage unduhan TikTok (watermark + footer) saat membuat Shot Library. |

## Aturan yang dipegang mesin

- **Bibir sinkron**: shot dari kreator VO dipakai di detik sumber yang sama dengan ucapannya. Shot dari footage lain
  hanya yang wajahnya tidak sedang bicara (wajah kecil < 7% tinggi frame boleh), tanpa teks bawaan, tidak buram.
- **Hook & CTA** diutamakan shot sinkron. Kalimat pertama tidak pernah dibuang; kalimat CTA terakhir juga.
- **Kalimat VO tidak dibuang (default, keputusan owner)**: semua kalimat dipakai, durasi mengikuti VO asli, tanpa batas.
  Kalimat yang kena aturan (superlatif `SUPERLATIF_UMUM` + Brand Kit + kata "paling", urgensi, ajakan live, musiman)
  hanya muncul sebagai peringatan `saran_buang` di `rencana.json` (`block` untuk kata terlarang Brand Kit). Tim yang
  memutuskan. Membuang otomatis baru jalan kalau job menulis `buang_otomatis` dan/atau `batas_durasi`.
  Yang selalu dibuang hanya potongan Whisper < 0,35 dtk (teknis: klip < 100 ms ditolak Motion Studio).
- **Ritme**: potongan 2–3 dtk, tidak ada potongan < 1 dtk, titik potong ditarik ke ketukan musik (±0,35 dtk).
- **Unik**: varian dengan VO sama harus beda shot broll (Jaccard ≤ 0,6). Kalau bahan habis, `batch.json`
  menulis `alasan_kurang` (tidak dipaksa).
- **Musik**: hanya Brand Kit (`lisensi_iklan: true`) atau `public/musik` + `lisensi.txt`. Stem dari footage lain hanya
  kalau `izinkan_musik_tanpa_lisensi`, dan varian ditandai `bukan_iklan` + peringatan `block`.
- **Track** (mode `u3`): video, audio (VO), music, subtitle (caption per frasa ≤ 3 kata, `words` + `anim: pop` + `highlight`),
  text (judul hook + CTA). Tidak ada klip tumpang tindih dalam satu track (dicek `qc_rencana.json`).

Placeholder di luar `$sumber:<id>` (`$vokal:<id>`, `$musik:<id>`) ditulis di `ops.json` `aset_lokal` (kontrak v0.3.1 §8).
Cek dengan validator asli Motion Studio: `node pipeline/validasi_ops.mjs <job_dir>/out/varian-001/ops.json`.

## Label Shot Library (`shots.json`)

| Label | Cara |
|---|---|
| `framing` | Deteksi wajah (OpenCV Haar): tanpa wajah = `closeup_produk`; tinggi wajah > 14% = `wajah_dekat`; < 7% = `full_body`; sisanya `medium` |
| `wajah_bicara` | Wajah ≥ 7% + ada ucapan ≥ 40% durasi shot. Konservatif: gerak mulut belum bisa membedakan bicara vs pose |
| `teks_bawaan` + `teks[]` | OCR (RapidOCR) di 2 frame per shot; watermark TikTok, @akun, dan footer dipisahkan. Kotak teks dipakai untuk blur |
| `watermark` per footage | Posisi awal/akhir + detik pindah, footer, dan `akun` (@handle dari OCR) sebagai petunjuk hak pakai |
| `tag` | Topik dari ucapan kreator di detik itu (anti_kusut, bahan, high_waist, warna, styling, cta, ...) |
| `koreksi` | Tim boleh menulis `"koreksi": {"wajah_bicara": false}` di satu shot; dipertahankan saat Shot Library dijalankan ulang |

## Antarmuka untuk Motion Studio (app tidak menulis ke folder mesin)

| Perintah | Isi | Keluaran |
|---|---|---|
| `pipeline/batch/daftar.py` (read-only) | Daftar batch untuk dropdown | stdout `{"schema":"daftar-batch/1","batch":[{batch, upload, footage, vo, musik, dipisah, dipisah_pada, shot_library, jumlah_shot, thumb, siap_batch}]}` |
| `pipeline/pisah.py --job <job_dir>` | job.json `{"mode":"pisah","batch","video_saja"?,"shot_tiktok"?}`, video unggahan di `<job_dir>/masuk/` | Disalin ke `konten/1-upload/<batch>` (nama sama + isi beda → `-2`), dipisah, Shot Library + thumbnail dibuat untuk footage baru. Progres JSON-lines. `out/pisah.json` `{schema:"pisah/1", status, batch, dipisah_pada, video_saja, hasil:[{file, video, vokal, musik}], shot_library, jumlah_shot}`. Kode 0 / 2 ditolak / 1 gagal |
| `pipeline/batch/perencana.py <job_dir>` | job.json batch + `kecualikan_shot: [id]` (pilihan tim, disimpan di app) | Shot itu tidak dipakai (b-roll maupun sinkron). Per varian di `batch.json`: `kalimat: [{teks, dari, sampai, shot:[id]}]` (detik di timeline varian) |

`shots.json` per shot kini punya `thumb`: path absolut JPG (lebar 270) di `konten/2-dipisah/<batch>/thumb/<footage>__NN.jpg`.
Batch lama dilengkapi dengan `shotlib.py <batch> --thumb-saja` (tanpa analisis ulang).
Koreksi label dari app (nanti): lewat job.json `koreksi_shot`, bukan menulis `shots.json`.
