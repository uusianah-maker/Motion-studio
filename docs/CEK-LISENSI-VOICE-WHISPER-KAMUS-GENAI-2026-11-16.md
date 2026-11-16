# Cek lisensi dan kelayakan: VoiceStudio, Whisper Indonesia, daftar kata, Open Generative AI (16 Nov 2026, sukma)

Ini permintaan owner 16 Nov lewat venus. Semua dicek dari halaman resmi dan file LICENSE. **Tidak ada yang dipasang atau diunduh.**
Isi dokumen ini bukan nasihat hukum. Spesifikasi PC ada di `docs/R23-R24-LISENSI-KAPASITAS-2026-11-16.md`: GTX 1650 4 GB, RAM 23,7 GB dengan sekitar 5 GB bebas, C: sisa 30 GB.

## Ringkasan

| # | Barang | Putusan |
|---|---|---|
| 1 | VoiceStudio + OmniVoice | **Jangan dipakai untuk VO iklan.** Bobot OmniVoice berlisensi **CC-BY-NC** (non-komersial). CosyVoice tidak punya Bahasa Indonesia. |
| 2 | Whisper Indonesia `Dafisns/whisper-turbo-multilingual-cf-ct2` | **Boleh komersial.** Model Apache-2.0, dasar Whisper MIT, dataset CC0 / CC-BY / CC-BY-SA. Perlu uji mutu dulu. |
| 3 | Daftar kata untuk penanda typo | **Pakai Hunspell `id_ID` (LGPL-3.0).** Daftar damzaky (dibongkar dari apk KBBI, tanpa lisensi) **jangan.** perlancar tidak terverifikasi, jangan. |
| 4 | Open Generative AI | Kode MIT, tapi hampir semua fitur butuh **Muapi.ai berbayar**. Yang lokal hanya gambar kelas SD 1.5 yang muat di 4 GB. Video lokal praktis **tidak bisa** di PC ini. **Jangan "aplikasikan semuanya".** |

## 1. VoiceStudio (github.com/debpalash/VoiceStudio)
- **Aplikasi:** AGPL-3.0, teks standar tanpa tambahan. README: bobot model, suara, dan hasil suara punya lisensi masing-masing.
- **Engine bawaan OmniVoice (k2-fsa/OmniVoice):**
  - Kodenya Apache-2.0.
  - **Bobot pra-latih berlisensi CC-BY-NC** karena batasan data latihnya (dataset Emilia), menurut kartu model HF `k2-fsa/OmniVoice`.
  - Ukuran 0,6 miliar parameter.
  - Bahasa Indonesia **ada** di daftar bahasanya (id, sekitar 6.300 jam data), juga Jawa (sekitar 11 jam). Sunda tidak ada.
  - Fitur "voice design" hanya dilatih Mandarin dan Inggris.
  - **Kesimpulan:** VO untuk iklan jualan adalah pemakaian komersial, jadi **tidak boleh** memakai OmniVoice.
- **CosyVoice (FunAudioLLM):**
  - Kodenya Apache-2.0.
  - Fun-CosyVoice 3 hanya mendukung 9 bahasa (zh, en, ja, ko, de, es, fr, it, ru). **Bahasa Indonesia tidak ada.**
  - Ukuran 0,5 miliar parameter.
- **VRAM:**
  - Tidak ada angka resmi. Dokumen performa VoiceStudio hanya menyebut bahwa kartu yang VRAM-nya di bawah kebutuhan engine diperlakukan seperti CPU.
  - Kalau VRAM hampir penuh, kerja tumpah ke RAM dan jadi beberapa kali lebih lambat.
  - Model 0,5–0,6 miliar parameter kira-kira butuh 1,5–3 GB VRAM (perkiraan). Kemungkinan muat di 4 GB, tapi **tidak bisa berbarengan dengan Whisper.**
- **Internet dan telemetri:**
  - README: "aplikasi bertanya sebelum mengunduh model"; aplikasi gratis tidak butuh akun; versi Cloud/Pro butuh akun.
  - Ada fitur "Remote Model Downloads".
  - Installer resmi mengambil skrip dari `voicestudio.sh`, sebuah **skrip dari domain pihak ketiga**. Jangan jalankan begitu saja.
  - **Ada atau tidaknya telemetri di dalam aplikasi belum bisa dipastikan.** Dokumen tidak menyebutnya, dan kodenya belum diperiksa.
  - Kalau tetap mau dicoba: jalankan di venv atau folder terpisah, tutup akses keluar lewat Windows Firewall, lalu lihat apakah ada koneksi keluar.
- **Risiko AGPL kalau dipakai internal tanpa modifikasi:**
  - Menjalankan dan memakai sendiri tidak menimbulkan kewajiban apa pun.
  - Kewajiban muncul kalau **dimodifikasi lalu dipakai pengguna lewat jaringan.** Ini berlaku juga untuk tim di motionproject.online. Kode sumber versi modifikasi harus ditawarkan ke para pengguna itu.
  - Kalau dipanggil sebagai proses terpisah lewat Local API HTTP, Motion Studio sendiri **tidak** ikut menjadi AGPL.
  - Jangan menyalin atau menempel kode VoiceStudio ke repo Motion Studio.
  - Risiko yang lebih besar justru lisensi bobot engine (lihat OmniVoice di atas), bukan AGPL-nya.
- **Rekomendasi:** jangan pasang untuk VO jualan. Kalau owner tetap mau VO AI berbahasa Indonesia, cari engine dengan bobot MIT/Apache yang mendukung bahasa Indonesia, cek lisensinya dulu, dan uji terpisah. VO Windows (System.Speech) yang sekarang tetap bisa dipakai.

## 2. Whisper Indonesia: `Dafisns/whisper-turbo-multilingual-cf-ct2`
- Ini konversi CTranslate2 dari `Dafisns/whisper-turbo-multilingual-fleurs`.
  - Repo `-ct2` tidak punya isian lisensi.
  - Repo aslinya **Apache-2.0**. Konversi format mewarisi lisensi itu.
- Dasarnya `openai/whisper-large-v3-turbo`, berlisensi MIT.
- Data fine-tune:
  - Common Voice 22 (versi tidak resmi `fsicoli/common_voice_22_0`): **CC0**.
  - Google FLEURS: **CC-BY-4.0**.
  - EdAcc (bahasa Inggris beraksen): **CC-BY-SA**.
  - Tidak ada yang non-komersial.
- Bahasa: Inggris dan Indonesia. WER menurut pembuatnya: Indonesia 6,97%, Inggris 9,09%.
- **Kesimpulan: boleh dipakai komersial**, risiko rendah.
- **Catatan:**
  - Ini buatan perorangan, jadi bandingkan dulu dengan `large-v3-turbo` yang dipakai sekarang. Ukur WER pada 10–20 klip owner dan periksa ketepatan cap waktu per kata, karena caption kita bergantung pada cap waktu per kata.
  - Ukuran dan VRAM sama dengan turbo yang sekarang, jadi muat.
  - Cache model di D: (`HF_HOME`).

## 3. Daftar kata Bahasa Indonesia untuk penanda typo
| Sumber | Lisensi | Putusan |
|---|---|---|
| `damzaky/kumpulan-kata-bahasa-indonesia-KBBI` | **Tidak ada lisensi.** README: "diperoleh dengan reverse engineering file database dari apk KBBI resmi". | **Jangan.** Hak cipta KBBI ada pada Badan Bahasa. Tanpa lisensi berarti tidak ada izin. |
| perlancar `WordList-ID-KBBI` (CPAN) | Halamannya tidak bisa dibuka (404 di GitHub; metacpan menolak, 402). Modul CPAN biasanya berlisensi Perl, tapi isinya diambil dari KBBI. | **Jangan**, kecuali sudah dicek ulang. Lisensi kode tidak menjamin izin untuk datanya. |
| **Hunspell `id_ID`** (LibreOffice/dictionaries, folder `id`) | **LGPL-3.0** (SPDX `LGPL-3.0-only`). Daftar awal disumbangkan Kurniadi, Volker Mueller, dan Arno Brevoort. Sudah dicocokkan dengan lemma KBBI edisi 3. | **Pakai ini.** Dipakai sebagai data di server sendiri tidak menimbulkan kewajiban. Kalau didistribusikan, file dan teks LGPL disertakan tanpa diubah. |
| Wiktionary | Teksnya CC-BY-SA | Boleh untuk pelengkap, dengan atribusi. Biasanya tidak perlu. |

Catatan:
- Hunspell sudah membawa aturan imbuhan (`.aff`), jadi kata berimbuhan seperti "menggunakan" tidak ditandai typo.
- Tetap perlu daftar putih tambahan untuk kata gaul, nama brand, dan nama produk (Aysilla, ALN, dsb.).

## 4. Open Generative AI (github.com/anil-matcha/open-generative-ai)
- Kodenya **MIT**. Studio Gambar, Video, Audio, Lip Sync, AI Clipping, Cinema, Marketing, dan lain-lain **semuanya lewat Muapi.ai (cloud, berbayar)**. Versi web selalu memakai cloud.
- **Bagian lokal (hanya aplikasi desktop):**
  - **sd.cpp** (bawaan): hanya gambar, yaitu SD 1.5, SDXL, dan Z-Image.
    - Z-Image butuh RAM 16 GB (bobot 7,4 GB). **Tidak layak di PC ini**, karena RAM bebas sekitar 5 GB dan situs live bisa ikut tersendat.
    - SD 1.5 (512 px) muat di 4 GB, kira-kira belasan detik per gambar (perkiraan), tapi mutunya jauh di bawah model cloud.
    - SDXL di 4 GB perlu offload ke RAM, jadi lambat (perkiraan).
  - **Wan2GP** (dipasang sendiri; video Wan 2.1/2.2, Hunyuan, LTX-2; gambar Flux, Qwen Image):
    - README open-generative-ai menyebut Wan 2.1 1.3B butuh sekitar **8 GB VRAM**.
    - Wan2GP sendiri hanya mengklaim "model tertentu" jalan di 4 GB, dan tidak menyebut model video mana.
    - Di GTX 1650, video lokal paling banter klip pendek 480p yang memakan puluhan menit per klip (perkiraan) dan memakai GPU yang juga dipakai Whisper.
    - **Tidak praktis**, dan bertentangan dengan aturan job berat di PC server.
  - **Lisensi model lokal perlu dicek per model:**
    - Wan 2.1/2.2: Apache-2.0.
    - FLUX.1-dev: bobotnya berlisensi non-komersial.
    - LTX-2 dan Hunyuan: lisensi komunitas dengan syarat.
    - SD 1.5/SDXL: OpenRAIL dengan larangan penggunaan tertentu.
- **Harga Muapi.ai** (dari halaman Muapi, bisa berubah):
  - flux-dev sekitar **USD 0,025 per gambar**.
  - Seedance 2.5 image-to-video **USD 0,17/detik (480p) – 0,34/detik (720p)**, jadi sekitar USD 0,85–1,70 per klip 5 detik.
  - Seedance 2 Pro **USD 0,25/detik**.
  - Seedance 2 VIP 1080p sekitar **USD 3,38 per generate**.
  - Harga pasti per model ada di endpoint harga Muapi.
- **Rekomendasi singkat:**
  1. **Jangan pasang semuanya.** Sebagian besar fiturnya adalah cloud berbayar, dan bagian lokalnya tidak muat di GPU 4 GB.
  2. Kalau owner mau mencoba gambar/video AI: pakai Muapi dengan kunci API milik owner, **batas anggaran bulanan**, dan uji dari satu fitur saja (misalnya image-to-video dari foto produk untuk b-roll). Catatan: foto/footage yang diunggah keluar dari PC (beda dengan aturan R24 yang serba lokal), jadi butuh keputusan owner.
  3. Untuk produk fashion (Aysilla/ALN), hasil AI bisa mengubah detail produk (warna, motif, potongan). Hasilnya wajib dicek sebelum dipakai di iklan.
  4. Lokal yang masuk akal di PC ini hanya alat ringan R24: rembg, MediaPipe, Real-ESRGAN.

## Sumber
- VoiceStudio: https://github.com/debpalash/VoiceStudio (README, LICENSE, docs/performance.md, docs/feature-catalog.md)
- OmniVoice: https://github.com/k2-fsa/OmniVoice, https://huggingface.co/k2-fsa/OmniVoice, docs/languages.md
- CosyVoice: https://github.com/FunAudioLLM/CosyVoice
- Whisper ID: https://huggingface.co/Dafisns/whisper-turbo-multilingual-cf-ct2, https://huggingface.co/Dafisns/whisper-turbo-multilingual-fleurs, https://huggingface.co/datasets/fsicoli/common_voice_22_0, https://huggingface.co/datasets/edinburghcstr/edacc
- Kamus: https://github.com/damzaky/kumpulan-kata-bahasa-indonesia-KBBI, https://github.com/LibreOffice/dictionaries/tree/master/id (LICENSE-dict, README-dict.adoc)
- Open Generative AI: https://github.com/anil-matcha/open-generative-ai; Wan2GP: https://github.com/deepbeepmeep/Wan2GP
- Harga Muapi: https://www.muapi.ai/docs/pricing, https://muapi.ai/comparison/seedance-2.5-image-to-video, https://muapi.ai/comparison/seedance-pro-i2v, https://muapi.ai/comparison/seedance-2-vip-image-to-video-1080p
