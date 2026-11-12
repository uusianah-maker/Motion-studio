# Ekspor Brand Kit untuk mesin (`brand-kit-export/1`)

Status: **final untuk U1** (2026-11-13). Sesuai KONTRAK-ENGINE v0.3 bagian 4 dan 7. Sumber: `packages/core/src/storage/brand.ts` (`exportBrandKit`). Tes: `packages/core/test/u1-multi-brand.test.ts`.

## Cara dibuat

- **Runner (U6)** memanggil `exportBrandKit(ws, brand_id, { paths: true })`, lalu menulis hasilnya ke `<job_dir>/brand_kit.json`. Setiap item di `aset` punya `path` absolut ke file asli di workspace. File itu hanya untuk dibaca, jangan diubah.
- **Browser** (`GET /api/brands/:brand_id/export`) mendapat bentuk yang sama, tetapi **tanpa `path`**. Bentuk ini hanya untuk melihat isi.
- Brand yang dipakai adalah brand milik proyek (`project.brand_id`). Kalau proyek belum memilih brand, dipakai brand bawaan workspace.

## Bentuk

```json
{
  "schema": "brand-kit-export/1",
  "brand": {
    "id": "b-1a2b3c4d5e6f",
    "nama": "Aysilla Factory",
    "kode": "AYS",
    "handle": { "tiktok": "@aysillafactoryid", "instagram": "@aysillafactoryid" },
    "target": "Wanita 20–35, kantoran, suka celana yang nggak panas",
    "nada": ["santai", "meyakinkan", "ceria"],
    "bahasa": "campur",
    "produk": [{ "nama": "Loose Pants", "varian": ["Espresso", "Black"], "ukuran": "M–XL" }]
  },
  "visual": {
    "warna": ["#ffffff", "#000000"],
    "warna_teks": "#ffffff",
    "outline": { "warna": "#000000", "px": 4 },
    "warna_dilarang": ["merah", "kuning", "biru"],
    "font_judul": "$font:judul",
    "font_caption": "$font:caption",
    "logo": { "aset": "$logo", "aset_terang": "$logo:terang", "pojok": "tr", "ukuran": 25, "opasitas": 1, "tampil": "sepanjang+penutup" },
    "penutup": { "aset": "$penutup", "detik": 2.5 },
    "gaya": "Clean minimalis",
    "grading": ""
  },
  "teks": {
    "cta": { "tiktok": "Cek keranjang kuning sekarang", "instagram": "Cek link di bio" },
    "cta_wajib": "",
    "disclaimer": { "teks": "Warna dapat sedikit berbeda karena cahaya", "kapan": "varian_warna" },
    "kosakata_whisper": ["Aysilla Factory", "Loose Pants"],
    "kamus": { "Icila Factory": "Aysilla Factory" },
    "kata_kunci": ["anti kusut", "flowy"],
    "kapital": "kata_kunci",
    "emoji": false
  },
  "aturan": {
    "terlarang": ["paling murah", "termurah"],
    "level": "block",
    "harga": [{ "teks": "80rb-an", "berlaku_sampai": "2026-11-30" }],
    "klaim_boleh": ["bahan adem", "anti kusut"],
    "visual_dilarang": [],
    "area_bebas_teks": ["wajah", "produk", "bawah_15", "kanan_tombol"]
  },
  "aset": [
    { "kunci": "$font:judul", "jenis": "font", "tag": ["font"], "lisensi_iklan": true, "path": "D:/…" },
    { "kunci": "$logo", "jenis": "logo", "tag": ["logo"], "lisensi_iklan": true, "path": "D:/…" }
  ],
  "preset": {
    "aysilla-konversi": {
      "id": "aysilla-konversi",
      "nama": "Konversi",
      "tujuan": "Jualan langsung",
      "placement": ["tiktok", "shopee"],
      "durasi": { "min": 15, "target": 20, "max": 30 },
      "turunan": ["9:16", "3:4", "cover"],
      "babak": [{ "dari": 0, "sampai": 3, "isi": "Hook" }],
      "ritme": "Ganti shot tiap 2–5 dtk",
      "caption": { "mode": "per_kata", "maks_kata": 3, "pop_ms": 100 },
      "hook": { "teks": true, "maks_kata": 6, "dari_ucapan": true },
      "efek": { "wajib": ["glass type"], "boleh": ["digital zoom"], "jangan": [], "maks": 3, "jarak_dtk": 4 },
      "audio": { "suara_asli": true, "sfx": "tiap teks besar & transisi", "musik": "di bawah suara", "lufs": -14 },
      "qc": ["durasi", "hook 3 dtk", "ejaan"]
    }
  }
}
```

## Nilai yang dibatasi

| Field | Nilai |
| --- | --- |
| `brand.kode` | 2–5 huruf besar/angka, unik per workspace |
| `brand.bahasa` | `id` · `en` · `campur` |
| `handle`, `teks.cta` | kunci: `tiktok` · `instagram` · `shopee` · `youtube` |
| `visual.logo.pojok` | `tl` · `tr` · `bl` · `br`; `ukuran` 5–40 (% lebar kanvas); `opasitas` 0,1–1 |
| `visual.logo.tampil` | `sepanjang` · `penutup` · `sepanjang+penutup` |
| `teks.kapital` | `normal` · `kata_kunci` · `semua` |
| `teks.disclaimer.kapan` | `selalu` · `varian_warna` · `harga` · `manual` (atau `disclaimer: null`) |
| `aturan.level` | `block` · `warn` |
| `aturan.area_bebas_teks` | `wajah` · `produk` · `bawah_15` · `atas_10` · `kanan_tombol` |
| `preset.*.caption.mode` | `per_kata` · `kalimat` |
| `preset.*.turunan` | `9:16` · `3:4` · `1:1` · `16:9` · `cover` |
| warna | `#rrggbb` huruf kecil |

- Field yang kosong tetap ditulis, sebagai `""`, `[]`, `{}`, atau `null`.
- Placeholder aset hanya muncul kalau file-nya ada. Kalau file tidak ada, nilainya `null`.

## Library aset (U2, sejak 2026-11-13)

`aset` juga berisi library aset per brand. Bentuk setiap itemnya:

```json
{ "kunci": "$sfx:pop-01", "jenis": "sfx", "tag": ["teks-muncul"], "lisensi_iklan": true,
  "nama": "Pop 01", "status_lisensi": "milik_sendiri", "sumber_lisensi": "",
  "durasi_ms": 300, "mood": "", "bpm": null, "instrumental": null,
  "produk": "", "varian": "", "orientasi": null, "ada_teks_bawaan": false, "path": "D:/… (runner saja)" }
```

- `kunci`: `$sfx:<id>`, `$musik:<id>`, `$broll:<id>`, `$logo:<id>`, `$penutup:<id>`, atau `$lainnya:<id>`. `id` unik per brand dan ditulis dengan huruf kecil, angka, dan tanda strip.
- `durasi_ms` dibaca langsung dari file saat ekspor. Nilainya `null` hanya untuk gambar diam.
- `orientasi` diisi untuk video atau gambar: `9:16`, `3:4`, `1:1`, `16:9`, atau `lainnya`. Untuk suara nilainya `null`.
- `lisensi_iklan: true` hanya bisa diberikan kalau `status_lisensi` = `milik_sendiri` atau `berlisensi`.
  - Musik berlisensi wajib punya `sumber_lisensi`.
  - Musik dengan `instrumental: false` ditolak untuk iklan.
  - Aset dengan `lisensi_iklan: false` tetap ikut diekspor supaya mesin tahu aset itu ada, tetapi mesin tidak boleh memakainya di iklan.
- Tag yang disarankan untuk preset mesin:
  - SFX: `teks-muncul`, `kata-kunci`, `transisi`, `penutup`.
  - Musik: mood.
  - B-roll: `detail-bahan`, `try-on`, dan seterusnya.
- `produk` (b-roll) harus nama dari `brand.produk`.
- `aturan.sfx_dilarang` berisi kata atau tag SFX yang tidak boleh dipakai.
- `referensi` berisi daftar `{ link, tiru, jangan }` (video winning).

## Gaya teks di ops

- Font judul: `style.font: "brand"`.
- Font caption: `style.font: "caption"`.
- Font bawaan: `style.font: "default"`.
