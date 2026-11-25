# Rencana kerja: Beat Spot tahap 2 "Ganti Outfit" (Tahap B, langsung untuk tim)

Tanggal: 25 Nov 2026 · Penyusun & pelaksana: jenius (owner 25 Nov: venus dipecat, "kerjain di sesi ini aja")
Status: **DIKERJAKAN** di branch `fitur/beatspot-outfit` (Motion Studio) + `fitur/beatspot-outfit` (mesin). Tes lulus, uji ujung-ke-ujung lokal lulus. Belum di-commit / dirilis (menunggu izin owner).

## 0. Yang berbeda dari rencana awal (hasil uji)
- **Ketukan**: `musik.analisis` membaca sound referensi 123 BPM (WAV) / 117,5 BPM (MP4), padahal tempo aslinya 119,95. Mesin Ganti Outfit memakai pembaca presisi sendiri (§29), dikalibrasi dengan klik (≤ 3 ms). Draf v1/v2 kemarin dipotong di grid 123, jadi makin ke belakang makin meleset (±0,4 dtk di detik 16).
- **Impor katalog**: bukan API Google Drive (W10 Drive dibatalkan), tapi **impor folder** di halaman: unduh folder katalog dari Drive, pilih foldernya. Nama warna & jenis (atasan/bawahan) diisi di Motion Studio; nama file asli boleh berantakan.
- **MS-2** (latar foto putih) dikerjakan mesin saat membuat end card. Foto aslinya tidak diubah.
- **Gambar diam & end card = klip MP4** (renderer Motion Studio hanya menerima gambar di track overlay). Tiap klip +1 frame cadangan, jadi durasi klip tidak pernah melebihi file.
- **Ulang gambar**: maks 2 per footage. Gambar yang gagal boleh diulang tanpa dihitung. Tidak ada ulang otomatis yang memakan biaya.
- **Biaya**: batas bulanan R12a × "perkiraan harga per gambar" (kolom baru). Pemakaian tercatat dan tampil di menu AI.
- **Penyedia AI gambar**: dikenali otomatis dari key (`sk-` = OpenAI). Model kosong = model gambar terbaru yang terbaca saat Tes koneksi.

## 1. Tujuan
Tim mengunggah 1–5 footage model sendiri. Sistem lalu membuat video Beat Spot gaya reel referensi secara otomatis:
- untuk setiap footage, video orang berjalan beberapa ketukan, lalu terpotong TEPAT di ketukan ke gambar diam hasil AI;
- di gambar diam itu, orang yang sama memakai **1 look dari katalog**: 1 atasan (kemeja) + 1 bawahan 1 warna;
- di akhir ada end card berisi foto katalog asli dari semua look.

Format ini sudah diuji manual dan disetujui owner pada 24 Nov 2026 (draf "lucy-loose-kemeja-v2"):
- 4 footage menghasilkan 4 look, durasi 16,6 detik;
- 123 BPM, selisih potong ≤ 16 ms;
- generate memakai prompt edit gambar sekitar 1,5 menit per gambar, dan semuanya berhasil di percobaan pertama.

## 2. Keputusan owner (25 Nov 2026)
| No | Keputusan |
|---|---|
| K1 | Langsung Tahap B: dipakai tim, generate lewat **API key OpenAI** (kolom R12a "AI gambar"). Codex/akun ChatGPT tidak dipakai di server. |
| K2 | Pasangan look **otomatis** dipilih sistem. Tim tetap bisa mengganti di layar cek (hybrid). |
| K3 | **Semua akun tim** boleh memakai fitur ini. |
| K4 | **Maksimal 5 footage** per video. 1 footage = 1 look. Kalau ada 2 orang dalam 1 footage, keduanya memakai look yang sama. |
| K5 | Sound dan ketukan **mengikuti template referensi**. Pola potongnya: jalan 3–4 ketukan, diam 4 ketukan, end card 4 ketukan. |
| K6 | AI ganti pakaian hanya boleh untuk footage yang ditandai "model/kreator sendiri" (`sumber_orang: kreator`, aturan Beat Spot sejak tahap 1). Kalau tidak dicentang, mesin menolak. |

Catatan risiko (sudah disampaikan ke owner): sound reel referensi berstatus "Original audio" milik akun lain. Owner memutuskan template tetap memakai sound itu (K5).

## 3. Alur yang dilihat tim
1. Pilih template **"Ganti Outfit per Ketukan"**. Sound dan ketukan sudah terkunci di template.
2. Unggah 1–5 footage, lalu centang **"model sendiri"**.
3. Sistem mengusulkan look untuk setiap footage (kemeja + celana + warna dari Katalog Produk). Tim boleh mengganti usulan itu.
4. Sistem membuat gambar. Di **layar cek**, tim melihat sebelum/sesudah per footage, dengan tombol "Ulang gambar ini" (maks 1 kali per gambar) dan "Ganti look".
5. Setelah disetujui, hasil masuk ke editor sebagai proyek yang bisa diedit (potongan, teks, end card), lalu dirender.

Tidak ada render sebelum tim menyetujui layar cek. Ini sesuai aturan "tunjukkan rencana, tahan render".

## 4. Pekerjaan

### 4.1 Motion Studio (server + halaman)
| ID | Pekerjaan | Selesai bila |
|---|---|---|
| MS-1 | **Katalog Produk** per brand: produk (nama, jenis `atasan`/`bawahan`), warna (nama + foto). Impor dari folder Drive (1 subfolder = 1 produk, 1 file = 1 warna). | Folder Drive "Katalog" (Lucy Pants, Loose Pants, Kemeja) bisa diimpor. Nama warna bisa diisi/diganti di Motion Studio, jadi nama file di Drive tidak wajib rapi (contoh "ChatGPT Image …" bisa langsung dinamai "Krem"). |
| MS-2 | Latar foto katalog dibersihkan otomatis menjadi putih: transparansi asli, latar hijau polos, dan "kotak-kotak transparan palsu" (lihat 4.2 ME-6). Hasilnya disimpan sebagai salinan; aslinya tetap. | 4 foto kemeja contoh tampil bersih di end card. |
| MS-3 | Template "Ganti Outfit per Ketukan": sound, ketukan (dihitung sekali dengan `musik.analisis`), pola ketukan (jalan/diam/end), dan teks atas default yang bisa diedit. | Template tersimpan. Mengganti teks atas tidak mengubah ketukan. |
| MS-4 | Halaman buat video: unggah 1–5 footage, centang "model sendiri", lalu usulan look otomatis (bisa diganti). | Footage ke-6 ditolak dengan pesan jelas. Tanpa centang, tombol buat tidak aktif. |
| MS-5 | Permudah form R12a. Owner 25 Nov: "kenapa harus ada penyedia, model, batas?". Penyedia dikenali otomatis dari awalan key (`sk-` = OpenAI, `AIza` = Gemini). Model kosong = model gambar terbaru dari provider itu. Batas biaya tetap opsional, tapi diberi saran isi. Teks "Belum dipakai sekarang" diganti setelah fitur ini rilis. Sambungkan R12a ke generate: key dibuka hanya di server dan dikirim hanya ke host resmi provider. Antrian **1 gambar per waktu** per server. Ada hitungan biaya + batas budget (pakai `budget` R12a). | Saat budget habis, job berhenti dengan pesan, tanpa tagihan lanjut. Key tidak pernah muncul di log, respons, atau berkas job. |
| MS-6 | **Layar cek** sebelum/sesudah per footage + ulang 1 gambar + ganti look. Hasil disetujui lalu dibuka di editor. | Mengulang 1 gambar tidak mengulang gambar lain. Hasil di editor bisa digeser/diganti (hybrid). |
| MS-7 | Izin: semua akun tim boleh memakai fitur. Hanya owner yang boleh mengubah key/budget (sudah begitu di R12a). | Dicek dengan akun anggota tim dan akun owner. |

### 4.2 Mesin (pipeline/batch, mode `beatspot` diperluas)
| ID | Pekerjaan | Selesai bila |
|---|---|---|
| ME-1 | `beatspot_shot.py`: selain ada/tidak orang, keluarkan **kotak posisi orang per sampel** (HOG badan + wajah yang sudah ada), ketajaman, dan apakah badannya utuh kepala–kaki. | Untuk 4 footage contoh, kotaknya mengenai orang yang berjalan. |
| ME-2 | Pilih **rentang jalan** per footage (3–4 ketukan sesuai sisa durasi) dan **crop 9:16 yang mengikuti orang**. Crop boleh bergeser linear selama segmen jalan; orang mengisi ±35–50 % tinggi frame. | Contoh: footage pendek 1,8 dtk mendapat 3 ketukan, footage 4K berorang kecil di-crop dan diikuti seperti draf v2. |
| ME-3 | **Frame diam = frame terakhir segmen jalan** (setelah crop + fps 30). Frame ini menjadi acuan AI supaya sambungannya mulus. | Deteksi potongan (scene > 0,2) tidak menandai sambungan jalan→diam. |
| ME-4 | **Usulan look otomatis**: tiap footage mendapat look berbeda (kemeja tidak berulang selama masih ada stok, warna celana tidak berulang). Pasangan harus serasi (aturan kontras terang/gelap dan nada warna). Seed bisa diatur. | Dengan 4 kemeja + 2 celana, 4 footage mendapat 4 kemeja berbeda. |
| ME-5 | **Generate lewat API** (mesin menerima endpoint + key dari server lewat stdin/env sementara, bukan job.json). Edit gambar dengan 3 acuan: frame + foto atasan + foto bawahan. Prompt = prompt draf v2 (lampiran A). | Hasil 1080x1920 (diubah ukurannya kalau perlu) tersimpan di folder job. |
| ME-6 | **QC gambar otomatis**: ukuran; latar & wajah tidak berubah (bandingkan area di luar kotak orang, misalnya SSIM); warna bawahan mendekati warna katalog. Gagal → ulang 1 kali, lalu ditandai untuk dicek tim. | Contoh draf v2 lulus semua. Gambar dengan latar yang bergeser ditandai. |
| ME-7 | **Rakit**: ops (ms-ops/1) berisi klip jalan, klip gambar diam, teks atas, end card (foto katalog asli semua look), dan sound template. Potongan dibulatkan ke frame terdekat. Mesin tetap TIDAK merender. | Selisih potong ≤ 1 frame. Teks atas tampil di semua adegan dan hilang di end card. |
| ME-8 | Kontrak: tambah bagian baru di KONTRAK-ENGINE untuk Beat Spot Ganti Outfit (field `beatspot.outfit`, output `beatspot.json` dengan look + status QC per footage). **Cek nomor bagian & versi terakhir dulu** (terakhir dilihat §28 v0.5.1). | Kontrak + tes `test_batch.py` diperbarui. |

### 4.3 Beban PC server
Generate berjalan di server provider, jadi PC kantor ringan. Analisa shot dan potong segmen tetap mengikuti aturan PC server: prioritas Idle/BelowNormal, maks 2 pekerja.

## 5. Uji terima (venus)
1. Pakai 4 footage contoh latihan (konten ai 1, DJI_0023, IMG_0799, IMG_0795) + katalog Lucy/Loose/Kemeja. Hasilnya harus setara draf v2 yang disetujui owner.
2. Uji 5 footage (batas atas) dan 6 footage (harus ditolak).
3. Uji tanpa centang "model sendiri" (harus ditolak).
4. Uji budget habis di tengah job.
5. Uji dengan akun anggota tim (bukan owner).
6. Cek key tidak muncul di log, berkas job, atau respons API.

## 6. Yang dilakukan owner
- Tempel API key OpenAI di **Pengaturan → AI gambar** (khusus owner), isi budget, lalu klik **Tes koneksi**. Per 25 Nov, key **belum tersimpan** di server.
- Nama file katalog di Drive tidak wajib dirapikan, karena penamaan warna dilakukan di Katalog Produk Motion Studio (MS-1).

## Lampiran A: prompt edit gambar (draf v2, berhasil 4/4)
> Use your image generation tool to EDIT image 1 (a real photo). Keep EVERYTHING else identical: same people, faces, hijabs or hair, bags, shoes, hands, pose, background, lighting, camera angle, framing and size. Change ONLY the clothes of {siapa}: (1) the top becomes the shirt in image 2: a {warna kemeja} long-sleeve shirt with thin vertical pinstripes, pointed collar, a long self-tie neck scarf hanging down the front, small chest welt pocket, curved hem, worn untucked over the trousers, copy its exact stripes, collar and tie from image 2; (2) the trousers become the trousers in image 3: {deskripsi celana} in {warna celana}, copy the colour and cut exactly from image 3. Natural folds that follow the walking pose, realistic shadows. No text, no logo, no extra people. Portrait 9:16 (1080x1920). Generate exactly one image.

Lewat API, kalimat "Use your image generation tool…" dan "save the image file…" dibuang. Deskripsi kemeja/celana diambil dari Katalog Produk, bukan ditulis tetap di kode. `{siapa}` diisi dari jumlah orang di frame: "both women … same new outfit" atau "only the woman …".
