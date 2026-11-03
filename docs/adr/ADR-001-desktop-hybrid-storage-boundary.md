# ADR-001 — Arsitektur desktop/hybrid & batas akses filesystem

- **Status:** Accepted untuk storage core · shell desktop = **Pending (PC-1)**
- **Tanggal:** 2026-11-03 · Task: T03
- **Sumber:** PRD_MASTER v1.0 §0.1 (1–7), §0.3, Bagian II (v0.8) §C–§H

## Konteks
PRD mengunci target **desktop/hybrid, local-first** (§0.1-1). Prototype HTML hanya referensi UI. Arsitektur web di PRD §11 (Next.js, Postgres, S3) masih relevan untuk layanan cloud (AI provider, kolaborasi), tapi **storage media dan Smart GC berjalan lokal** di mesin user. Operasi destruktif harus fail-closed (§0.3), dan path traversal/symlink/junction wajib divalidasi di backend, bukan di UI.

## Keputusan

### D1. Storage core = modul TypeScript/Node.js yang tidak tergantung shell
Paket `src/storage` berisi seluruh logika workspace, registry, dependency index, eligibility, Trash, restore, purge, scheduler, kuota dan render preflight. Modul ini:
- hanya memakai API bawaan Node (`fs`, `crypto`, `path`), tanpa dependensi runtime pihak ketiga;
- dipanggil lewat satu fasad `StorageService` (API bertipe), bukan akses `fs` langsung dari UI;
- bisa jalan di **main process Electron** atau sebagai **sidecar Node di Tauri** → keputusan shell (PC-1) tidak memblokir T04–T15.

### D2. Batas proses (trust boundary)
```
[UI / renderer]  --(IPC bertipe, allowlist operasi)-->  [StorageService (Node)]  -->  filesystem workspace
   tanpa akses fs                                         satu-satunya penulis
[AI planner]     --(hanya: status, minta scan dry-run)-->  StorageService   (tidak bisa trash/purge/hapus)
```
- Renderer **tidak** punya akses `fs`/`shell` (Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; Tauri: allowlist fs dimatikan).
- Setiap operasi membawa `actor`: `user` | `scheduler` | `ai`. Aturan ditegakkan di StorageService, **bukan** di flag UI:
  - `ai` tidak boleh Auto Trash, restore, purge, atau menulis file (GC-12, §H).
  - `scheduler` boleh scan + Auto Trash, **tidak boleh** purge (§F).
  - Purge hanya `user`, dengan token konfirmasi sekali pakai + audit dependensi ulang yang terkunci (§F, GC-08).

### D3. Aturan path (dijalankan di backend untuk setiap path)
1. Input path selalu **relatif terhadap root workspace** atau referensi `shared://<media_id>/<version_id>`; path absolut dari luar ditolak (kecuali sumber import, yang hanya dibaca).
2. Tolak: segmen `..`, karakter NUL, `:` (Alternate Data Stream / drive), nama perangkat Windows (`CON`, `NUL`, `COM1`…), segmen berakhiran titik/spasi, segmen kosong.
3. Kanonisasi dengan `realpath` pada leluhur yang sudah ada; target harus tetap di dalam `realpath(root)`. Pembandingan **case-insensitive di Windows**.
4. Setiap komponen yang sudah ada di dalam workspace diperiksa `lstat`: **symlink/junction ditolak** (Node melaporkan junction Windows sebagai symbolic link).
5. Operasi file hanya pada area yang diizinkan per operasi (mis. Trash hanya memindah dari area media ke `.trash/`).

### D4. Persistensi metadata
- Dokumen JSON di `.motionstudio/` (registry, dependency index, leases, policy, purge requests) dengan **atomic write** (tulis file tmp → `fsync` → `rename`) dan **lock workspace** (file lock eksklusif `O_EXCL`, deteksi lock basi).
- Audit log append-only `audit.log.jsonl`, dengan redaksi otomatis field bernama `key|secret|token|password|authorization`.
- Journal intent untuk operasi pindah file (crash recovery, ST-09).
- **API secret tidak pernah ditulis ke workspace** (registry, manifest proyek, audit log, export). Penyimpanan secret provider AI di luar scope storage core (PRD §17, v0.5).
- Alasan: nol dependensi native, mudah diaudit manual. Migrasi ke SQLite bisa dilakukan nanti di balik antarmuka store yang sama (keputusan internal, bisa dibalik).

### D5. Media read-only & imutabel
- File versi media diberi atribut read-only setelah import. Versi tidak pernah ditimpa; byte berubah = status `CHANGED` + alert, bukan upgrade diam-diam (GC-11).
- Original media tidak pernah diperlakukan sebagai cache.

### D6. Waktu bisa disuntik
Semua logika 30 hari memakai `Clock` yang disuntikkan, supaya GC-01..GC-06 bisa diuji deterministik.

## Akibat
- (+) T04–T15 bisa dikerjakan & dites tanpa menunggu PC-1.
- (+) Satu jalur validasi path & izin, mudah diuji (path traversal, junction, symlink).
- (−) Integrasi UI (dashboard storage, dialog purge) baru bisa dibangun setelah PC-1. Sampai saat itu, akses manual via CLI `motion-storage`.
- (−) JSON store tidak cocok untuk ratusan ribu versi; cukup untuk MVP, dicatat sebagai risiko kapasitas.

## Opsi shell (PC-1)
| Opsi | Kelebihan | Kekurangan |
|---|---|---|
| **A. Electron** (rekomendasi) | Storage core jalan langsung di main process (satu bahasa TS), ekosistem FFmpeg/Node matang, tooling test sama | Installer besar (~100 MB+), memori lebih tinggi |
| B. Tauri + sidecar Node | Installer kecil, UI ringan | Dua runtime (Rust + Node sidecar), packaging & IPC lebih rumit |
| C. Tauri + port storage ke Rust | Paling ringan & cepat | Tulis ulang storage core, test ganda, waktu jauh lebih lama |
