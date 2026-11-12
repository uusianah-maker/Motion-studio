import { z } from "zod";

// Satu kata hasil transkripsi, format sama dengan `Caption` dari @remotion/captions.
// Waktu sudah dalam timeline HASIL EDIT (setelah jeda dibuang), bukan waktu sumber.
export const captionSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  timestampMs: z.number().nullable(),
  confidence: z.number().nullable(),
  /** Dipasang pipeline/edit.py: halaman caption berakhir di kata ini. */
  pageBreakAfter: z.boolean().optional(),
  /** Dipasang pipeline/edit.py: kata kunci yang diperbesar. */
  emphasis: z.boolean().optional(),
});

// Potongan video sumber yang dipakai, dalam frame komposisi (30 fps).
export const segmentSchema = z.object({
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(1),
});

export const styleSchema = z.object({
  captionColor: z.string(),
  outlineColor: z.string(),
  accentColor: z.string(),
  outroBg: z.string(),
  /** Pusat vertikal caption, 0..1 dari tinggi frame. */
  captionCenterY: z.number().min(0.3).max(0.85),
  keywordScale: z.number().min(1).max(2),
  /** true = semua kata kapital; false = hanya kata kunci kapital. */
  uppercaseAll: z.boolean(),
  /** Bagian kanan layar yang harus bebas teks (tombol TikTok/Reels), 0..1. */
  safeRight: z.number().min(0).max(0.3),
  titleFont: z.enum(["Montserrat", "Anton", "Oswald"]).optional(),
  captionFont: z.enum(["Montserrat", "Anton", "Oswald"]).optional(),
  /** "color" = kata kunci warna aksen; "box" = teks gelap di kotak warna aksen. */
  keywordStyle: z.enum(["color", "box"]).optional(),
  /** Tebal outline caption (px). Kosong = proporsional ukuran huruf. */
  outlinePx: z.number().min(0).max(20).optional(),
});

export const adVideoSchema = z.object({
  /** File di public/ (mis. "uji01.mp4") atau URL http(s). */
  videoSrc: z.string(),
  /** Potongan yang dipakai, diputar berurutan. Dibuat oleh pipeline/autocut.py / edit.py. */
  segments: z.array(segmentSchema).min(1),
  captions: z.array(captionSchema),
  /** Kata kunci brand (dipakai kalau caption tidak membawa `emphasis`). */
  keywords: z.array(z.string()),
  /** File logo di public/. Kosong = pakai teks `brandName`. */
  logoSrc: z.string(),
  brandName: z.string().optional(),
  handle: z.string().optional(),
  /** Teks di bawah logo (CTA). Hanya dari brief/brand kit, jangan mengarang. */
  outroTagline: z.string(),
  outroSeconds: z.number().min(1).max(5),
  maxWordsPerPage: z.number().int().min(1).max(6),
  maxDurationSeconds: z.number().min(5).max(60),
  style: styleSchema.optional(),
  /** Efek 17 glass type: judul hook dari ucapan. */
  hook: z
    .object({
      text: z.string(),
      startMs: z.number(),
      endMs: z.number(),
      /** Posisi atas panel judul (0..1). Kosong = 0,30. */
      top: z.number().min(0.1).max(0.8).optional(),
      /** Tinggi minimum panel (0..1), mis. untuk menutup teks tertanam yang tinggi. */
      height: z.number().min(0.05).max(0.4).optional(),
    })
    .optional(),
  /** Efek 05 digital zoom: pergantian framing. */
  framing: z
    .array(z.object({ atMs: z.number(), scale: z.number(), mode: z.enum(["cut", "smooth"]) }))
    .optional(),
  /** Efek 09 zoom-through cut, waktu output (ms). */
  zoomThroughs: z.array(z.number()).optional(),
  sfx: z.array(z.object({ src: z.string(), atMs: z.number(), volume: z.number() })).optional(),
  musicSrc: z.string().optional(),
  /** Teks kecil di bawah, mis. "Warna dapat sedikit berbeda karena cahaya" (dari brand kit). */
  disclaimer: z.string().optional(),
});

export type AdVideoProps = z.infer<typeof adVideoSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type BrandStyle = z.infer<typeof styleSchema>;

export const resolveSrc = (src: string, staticFileFn: (p: string) => string) =>
  /^https?:\/\//.test(src) ? src : staticFileFn(src);
