// Deteksi kata kunci otomatis: angka/harga/persen yang DIUCAPKAN + daftar brand.

export const normalize = (word: string) =>
  word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

// Kata bilangan Bahasa Indonesia + satuan harga.
const NUMBER_WORDS = new Set([
  "nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan",
  "sepuluh", "sebelas", "seratus", "seribu", "sejuta", "belas", "puluh", "ratus", "ribu",
  "juta", "miliar", "setengah", "persen", "rupiah", "rp", "rb", "k", "jt", "goceng", "ceban",
  "gocap", "cepek", "gopek", "sejuta",
]);

const isNumberish = (raw: string) => {
  const n = normalize(raw);
  if (n === "") return false;
  if (/\d/.test(raw)) return true; // "129.000", "20%", "Rp50rb"
  return NUMBER_WORDS.has(n);
};

export const makeKeywordTest = (brandKeywords: string[]) => {
  const set = new Set(brandKeywords.map(normalize));
  return (raw: string) => isNumberish(raw) || set.has(normalize(raw));
};

// Tanda baca titik/koma tidak ditampilkan di layar; ? dan ! tetap.
export const displayText = (raw: string) => raw.trim().replace(/[.,;:]+$/u, "");
