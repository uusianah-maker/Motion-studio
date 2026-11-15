import { promises as fsp } from 'node:fs';
import { LOOK_IDS, type LookId } from './clipLook.js';
import path from 'node:path';
import { audit } from './audit.js';
import { type BrandGuard, EMPTY_GUARD, validateGuard } from './brandGuard.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { isSafeId } from './ids.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { type Actor, MEDIA_AREAS } from './permissions.js';
import { probeFile, probeImage } from './probe.js';
import { CANVAS_RATIOS, type MediaRef, type Timeline } from './project.js';
import { type Registry, type VersionRecord, loadRegistry, saveRegistry } from './registry.js';
import { LAYOUT, META_FILES, type Workspace, listProjectIds, metaPath, readProject, withWorkspaceLock } from './workspace.js';

/**
 * Brand Kits (X06 → U1 / PC-16): one kit PER BRAND, chosen per project. Fields follow the team's
 * Brand Kit sheet A–F (identity, visual, text, rules, presets; assets come with U2). Fonts, logos
 * and the outro are ordinary imported media versions: a kit holds them in the dependency index
 * (never moved to Trash while in use) and renders lease + re-verify them. A kit can be exported in
 * the engine contract shape (`brand-kit-export/1`, KONTRAK-ENGINE §4).
 */

export const LOGO_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export type LogoCorner = (typeof LOGO_CORNERS)[number];
export const LOGO_LIMITS = { size: [5, 40] as const, opacity: [0.1, 1] as const };
export const MAX_BRAND_COLORS = 6;
export const LOGO_SHOW = ['sepanjang', 'penutup', 'sepanjang+penutup'] as const;
export const LANGS = ['id', 'en', 'campur'] as const;
export const CAPITALS = ['normal', 'kata_kunci', 'semua'] as const;
export const PLATFORMS = ['tiktok', 'instagram', 'shopee', 'youtube'] as const;
export const TEXT_FREE_AREAS = ['wajah', 'produk', 'bawah_15', 'atas_10', 'kanan_tombol'] as const;
export const DISCLAIMER_WHEN = ['selalu', 'varian_warna', 'harga', 'manual'] as const;
export const ASSET_KINDS = ['sfx', 'musik', 'broll', 'logo', 'penutup', 'lainnya'] as const;
export const LICENSE_STATUS = ['milik_sendiri', 'berlisensi', 'tanpa_lisensi', 'belum_dicek'] as const;
export const MAX_BRAND_ASSETS = 500;
/** Event tags the engine's presets look for (KONTRAK-ENGINE, U2 notes from venus). */
export const SUGGESTED_TAGS = { sfx: ['teks-muncul', 'kata-kunci', 'transisi', 'penutup'], musik: ['ceria', 'santai', 'energik', 'elegan'], broll: ['detail-bahan', 'try-on', 'packing', 'lifestyle'] } as const;
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
const LOGO_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const FONT_EXT = ['.ttf', '.otf'];
const OUTRO_EXT = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];

type Platform = (typeof PLATFORMS)[number];

export interface BrandLogo {
  ref: MediaRef;
  corner: LogoCorner;
  /** Logo width as % of the canvas width. */
  size: number;
  opacity: number;
  /** When the logo shows (B "Kapan logo tampil"); the per-project switch still decides if at all. */
  show: (typeof LOGO_SHOW)[number];
}

export interface BrandProduct {
  nama: string;
  varian: string[];
  ukuran: string;
}

/** E (U2): one file of the brand's asset library, with tags and licence status. */
export interface BrandAsset {
  /** Unique within the brand: `pop-01` → placeholder `$sfx:pop-01`. */
  id: string;
  ref: MediaRef;
  jenis: (typeof ASSET_KINDS)[number];
  nama: string;
  tag: string[];
  lisensi: {
    status: (typeof LICENSE_STATUS)[number];
    /** Licence proof (link / invoice no. / note); required for licensed music. */
    bukti: string;
    /** May be used in (paid) ads. Only own or licensed files can be. */
    iklan: boolean;
  };
  mood: string;
  bpm: number | null;
  /** Music: no lyrics (the engine refuses songs with lyrics under speech). null = not set. */
  instrumental: boolean | null;
  /** B-roll: which product (name from A "Daftar produk") and variant it shows. */
  produk: string;
  varian: string;
  /** B-roll: footage already has burned-in text (Batch Remix avoids or blurs it). */
  ada_teks_bawaan: boolean;
  catatan: string;
}

/** F: one content preset (konversi, awareness, …). Free text where the sheet is free text. */
export interface BrandPreset {
  id: string;
  nama: string;
  tujuan: string;
  placement: Platform[];
  /** Seconds. */
  durasi: { min: number; target: number; max: number };
  turunan: string[];
  babak: { dari: number; sampai: number; isi: string }[];
  ritme: string;
  caption: { mode: 'per_kata' | 'kalimat'; maks_kata: number; pop_ms: number; y?: number; warna?: string; outline?: string; kotak?: boolean };
  hook: { teks: boolean; maks_kata: number; dari_ucapan: boolean; y?: number; ukuran?: number; baris?: number; warna?: string; dari_kalimat_kuat?: boolean };
  efek: { wajib: string[]; boleh: string[]; jangan: string[]; maks: number; jarak_dtk: number };
  audio: { suara_asli: boolean; sfx: string; musik: string; lufs: number };
  qc: string[];
  // R18 (KONTRAK-ENGINE §17.1, from Hanagaki's study). All optional: absent = behaviour as before.
  jenis?: (typeof PRESET_JENIS)[number];
  shot?: { target_dtk?: number; maks_dtk?: number };
  transisi?: { ganti_orang: 'potong' | 'flash' };
  penutup?: { end_card: boolean };
  beat?: { tiap_ketukan?: 1 | 2 | 4; bpm?: number };
}

export const PRESET_JENIS = ['street_interview', 'test_produk', 'harian_studio', 'beat_spot', 'lain'] as const;

export interface BrandKit {
  schema_version: 2;
  brand_id: string;
  revision: number;
  updated_at: number;
  // A. Identity
  name: string;
  /** 2–5 letters/digits, unique per workspace (job ids, file names). */
  kode: string;
  handles: Partial<Record<Platform, string>>;
  target: string;
  nada: string[];
  bahasa: (typeof LANGS)[number];
  produk: BrandProduct[];
  // B. Visual
  /** Brand colours, most important first (`colors[0]` = main colour). */
  colors: string[];
  /** Text colour that reads well on the main colour. */
  text_color: string;
  outline: { color: string; px: number };
  warna_dilarang: string[];
  /** Title font (hook, judul, CTA): style `font: 'brand'`. */
  font: MediaRef | null;
  /** Caption font: style `font: 'caption'`. */
  font_caption: MediaRef | null;
  logo: BrandLogo | null;
  /** Light version of the logo for dark footage. */
  logo_light: MediaRef | null;
  outro: { ref: MediaRef | null; detik: number };
  gaya: string;
  grading: string;
  /** Malam 15 Nov: colour look every video/b-roll clip gets unless it picks its own (null = none). */
  filter_bawaan: LookId | null;
  // C. Text & language
  cta: Partial<Record<Platform, string>>;
  cta_wajib: string;
  disclaimer: { teks: string; kapan: (typeof DISCLAIMER_WHEN)[number] } | null;
  /** R18 §17.3: end card / Beat Spot line, e.g. "CUCI · JEMUR · LANGSUNG PAKAI". */
  tagline: string;
  /** R18 §17.3: small text watermark (fills the gaps between hook / CTA / disclaimer). */
  watermark: { teks: string; y: number; lebar: number; opasitas: number } | null;
  kosakata: string[];
  kamus: { salah: string; benar: string }[];
  kata_kunci: string[];
  kapital: (typeof CAPITALS)[number];
  emoji: boolean;
  // D. Rules
  /** X08: promo prices with an end date + banned claims, checked before every render. */
  guard: BrandGuard;
  klaim_boleh: string[];
  visual_dilarang: string[];
  area_bebas_teks: (typeof TEXT_FREE_AREAS)[number][];
  // E. Assets (U2)
  aset: BrandAsset[];
  /** SFX words/tags never to use (e.g. "kaget", "kartun"). */
  sfx_dilarang: string[];
  /** Winning reference videos: what to copy / not copy. */
  referensi: { link: string; tiru: string; jangan: string }[];
  // F. Presets
  presets: BrandPreset[];
}

export type BrandKitInput = Omit<BrandKit, 'schema_version' | 'brand_id' | 'revision' | 'updated_at'>;

const EMPTY_FIELDS: Omit<BrandKitInput, 'name' | 'kode'> = {
  handles: {},
  target: '',
  nada: [],
  bahasa: 'id',
  produk: [],
  colors: [],
  text_color: '#ffffff',
  outline: { color: '#000000', px: 0 },
  warna_dilarang: [],
  font: null,
  font_caption: null,
  logo: null,
  logo_light: null,
  outro: { ref: null, detik: 2 },
  gaya: '',
  grading: '',
  filter_bawaan: null,
  cta: {},
  cta_wajib: '',
  disclaimer: null,
  tagline: '',
  watermark: null,
  kosakata: [],
  kamus: [],
  kata_kunci: [],
  kapital: 'normal',
  emoji: false,
  guard: EMPTY_GUARD,
  klaim_boleh: [],
  visual_dilarang: [],
  area_bebas_teks: [],
  aset: [],
  sfx_dilarang: [],
  referensi: [],
  presets: [],
};

/** "No brand yet": what a project without any kit sees (nothing to apply, nothing to check). */
export const EMPTY_BRAND: BrandKit = { schema_version: 2, brand_id: '', revision: 0, updated_at: 0, name: 'Brand', kode: 'BRD', ...EMPTY_FIELDS };

const HEX = /^#[0-9a-f]{6}$/;
const KODE = /^[A-Z0-9]{2,5}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', `Brand Kit: ${msg}`);
};
const ext = (name: string) => (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '').toLowerCase();
const oneLine = (s: string) => [...s].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();
const exists = (f: string) =>
  fsp.access(f).then(
    () => true,
    () => false,
  );

// ------------------------------------------------------------------ field validators

const obj = (x: unknown, w: string, keys: readonly string[]): Record<string, unknown> => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return bad(`${w} harus objek`);
  const extra = Object.keys(x).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${w}: field tidak dikenal ${extra.join(', ')}`);
  return x as Record<string, unknown>;
};
const text = (x: unknown, w: string, max: number, opt = true): string => {
  if (x === undefined || x === null) return opt ? '' : bad(`${w} wajib diisi`);
  if (typeof x !== 'string') return bad(`${w} harus teks`);
  const t = oneLine(x);
  if (!opt && !t) bad(`${w} wajib diisi`);
  if (t.length > max) bad(`${w} maksimal ${max} karakter`);
  return t;
};
const list = (x: unknown, w: string, maxItems: number, maxLen: number): string[] => {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return bad(`${w} harus daftar`);
  if (x.length > maxItems) bad(`${w} maksimal ${maxItems}`);
  return [...new Set(x.map((v, i) => text(v, `${w} ${i + 1}`, maxLen)).filter(Boolean))];
};
const num = (x: unknown, w: string, min: number, max: number, dflt?: number): number => {
  if (x === undefined && dflt !== undefined) return dflt;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) return bad(`${w} harus angka ${min}–${max}`);
  return Math.round(x * 100) / 100;
};
const bool = (x: unknown, w: string, dflt: boolean): boolean => (x === undefined ? dflt : typeof x === 'boolean' ? x : bad(`${w} harus ya/tidak`));
const oneOf = <T extends string>(x: unknown, w: string, allowed: readonly T[], dflt: T): T => (x === undefined ? dflt : allowed.includes(x as T) ? (x as T) : bad(`${w} harus ${allowed.join(' | ')}`));
const hex = (x: unknown, w: string, dflt?: string): string => {
  if (x === undefined && dflt !== undefined) return dflt;
  return typeof x === 'string' && HEX.test(x.toLowerCase()) ? x.toLowerCase() : bad(`${w} harus #rrggbb`);
};
function ref(x: unknown, w: string): MediaRef | null {
  if (x === undefined || x === null) return null;
  const o = obj(x, w, ['media_id', 'version_id']);
  if (!isSafeId(o.media_id) || !isSafeId(o.version_id)) bad(`${w} tidak valid`);
  return { media_id: o.media_id as string, version_id: o.version_id as string };
}
const perPlatform = (x: unknown, w: string, max: number): Partial<Record<Platform, string>> => {
  if (x === undefined || x === null) return {};
  const o = obj(x, w, PLATFORMS);
  const out: Partial<Record<Platform, string>> = {};
  for (const p of PLATFORMS) {
    const t = text(o[p], `${w} ${p}`, max);
    if (t) out[p] = t;
  }
  return out;
};

function validateAsset(x: unknown, i: number): BrandAsset {
  const w = `aset ${i + 1}`;
  const o = obj(x, w, ['id', 'ref', 'jenis', 'nama', 'tag', 'lisensi', 'mood', 'bpm', 'instrumental', 'produk', 'varian', 'ada_teks_bawaan', 'catatan']);
  const id = typeof o.id === 'string' && SLUG.test(o.id) ? o.id : bad(`${w}: id huruf kecil/angka/strip, mis. "pop-01"`);
  const l = obj(o.lisensi ?? {}, `${w} lisensi`, ['status', 'bukti', 'iklan']);
  const status = oneOf(l.status, `${w} status lisensi`, LICENSE_STATUS, 'belum_dicek');
  const jenis = oneOf(o.jenis, `${w} jenis`, ASSET_KINDS, 'lainnya');
  const bukti = text(l.bukti, `${w} bukti lisensi`, 300);
  const iklan = bool(l.iklan, `${w} boleh untuk iklan`, false);
  // PRD sheet E: paid ads need a clear right to use the file; licensed music needs proof.
  if (iklan && status !== 'milik_sendiri' && status !== 'berlisensi') bad(`${w}: hanya file milik sendiri atau berlisensi yang boleh untuk iklan`);
  if (iklan && jenis === 'musik' && status === 'berlisensi' && !bukti) bad(`${w}: musik berlisensi untuk iklan wajib ada bukti lisensi`);
  return {
    id,
    ref: ref(o.ref, w) ?? bad(`${w}: pilih file`),
    jenis,
    nama: text(o.nama, `${w} nama`, 80),
    tag: list(o.tag, `${w} tag`, 20, 30).map((t) => t.toLowerCase()),
    lisensi: { status, bukti, iklan },
    mood: text(o.mood, `${w} mood`, 40),
    bpm: o.bpm === undefined || o.bpm === null ? null : num(o.bpm, `${w} BPM`, 20, 300),
    instrumental: o.instrumental === undefined || o.instrumental === null ? null : bool(o.instrumental, `${w} instrumental`, false),
    produk: text(o.produk, `${w} produk`, 60),
    varian: text(o.varian, `${w} varian`, 40),
    ada_teks_bawaan: bool(o.ada_teks_bawaan, `${w} ada teks bawaan`, false),
    catatan: text(o.catatan, `${w} catatan`, 200),
  };
}

function validatePreset(x: unknown, i: number): BrandPreset {
  const w = `preset ${i + 1}`;
  const o = obj(x, w, ['id', 'nama', 'tujuan', 'placement', 'durasi', 'turunan', 'babak', 'ritme', 'caption', 'hook', 'efek', 'audio', 'qc', 'jenis', 'shot', 'transisi', 'penutup', 'beat']);
  const id = typeof o.id === 'string' && SLUG.test(o.id) ? o.id : bad(`${w}: id huruf kecil/angka/strip, mis. "aysilla-konversi"`);
  const d = obj(o.durasi ?? {}, `${w} durasi`, ['min', 'target', 'max']);
  const durasi = { min: num(d.min, `${w} durasi min`, 1, 600, 15), target: num(d.target, `${w} durasi target`, 1, 600, 20), max: num(d.max, `${w} durasi maks`, 1, 600, 30) };
  if (!(durasi.min <= durasi.target && durasi.target <= durasi.max)) bad(`${w}: durasi harus min ≤ target ≤ maks`);
  const placement = Array.isArray(o.placement) ? (o.placement as unknown[]).map((p) => oneOf(p, `${w} placement`, PLATFORMS, 'tiktok')) : o.placement === undefined ? [] : bad(`${w} placement harus daftar`);
  const turunan = list(o.turunan, `${w} turunan`, 8, 10);
  for (const t of turunan) if (t !== 'cover' && !CANVAS_RATIOS.includes(t as never)) bad(`${w}: turunan "${t}" harus ${CANVAS_RATIOS.join(', ')} atau cover`);
  const babak = o.babak === undefined ? [] : Array.isArray(o.babak) ? o.babak : bad(`${w} babak harus daftar`);
  if (babak.length > 12) bad(`${w}: babak maksimal 12`);
  const c = obj(o.caption ?? {}, `${w} caption`, ['mode', 'maks_kata', 'pop_ms', 'y', 'warna', 'outline', 'kotak']);
  const h = obj(o.hook ?? {}, `${w} hook`, ['teks', 'maks_kata', 'dari_ucapan', 'y', 'ukuran', 'baris', 'warna', 'dari_kalimat_kuat']);
  // R18 §17.1: optional style fields — only written when set (absent = engine behaviour as before).
  const opt = <T>(v: unknown, f: () => T): T | undefined => (v === undefined || v === null || v === '' ? undefined : f());
  const some = <T extends object>(x: T): T | undefined => (Object.values(x).some((v) => v !== undefined) ? (Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T) : undefined);
  const sh = o.shot === undefined || o.shot === null ? {} : obj(o.shot, `${w} shot`, ['target_dtk', 'maks_dtk']);
  const tr = o.transisi === undefined || o.transisi === null ? {} : obj(o.transisi, `${w} transisi`, ['ganti_orang']);
  const pe = o.penutup === undefined || o.penutup === null ? {} : obj(o.penutup, `${w} penutup`, ['end_card']);
  const be = o.beat === undefined || o.beat === null ? {} : obj(o.beat, `${w} beat`, ['tiap_ketukan', 'bpm']);
  const shot = some({ target_dtk: opt(sh.target_dtk, () => num(sh.target_dtk, `${w} shot target`, 0.3, 30)), maks_dtk: opt(sh.maks_dtk, () => num(sh.maks_dtk, `${w} shot maks`, 0.5, 60)) });
  const ganti = opt(tr.ganti_orang, () => oneOf(tr.ganti_orang, `${w} transisi ganti orang`, ['potong', 'flash'] as const, 'potong'));
  const endCard = opt(pe.end_card, () => bool(pe.end_card, `${w} end card`, false));
  const tiap = opt(be.tiap_ketukan, () => (be.tiap_ketukan === 1 || be.tiap_ketukan === 2 || be.tiap_ketukan === 4 ? be.tiap_ketukan : bad(`${w} beat tiap ketukan harus 1 | 2 | 4`)));
  const beat = some({ tiap_ketukan: tiap as 1 | 2 | 4 | undefined, bpm: opt(be.bpm, () => num(be.bpm, `${w} BPM`, 60, 200)) });
  const capX = some({ y: opt(c.y, () => num(c.y, `${w} posisi caption`, 0, 1)), warna: opt(c.warna, () => hex(c.warna, `${w} warna caption`)), outline: opt(c.outline, () => hex(c.outline, `${w} outline caption`)), kotak: opt(c.kotak, () => bool(c.kotak, `${w} kotak caption`, false)) }) ?? {};
  const hookX =
    some({
      y: opt(h.y, () => num(h.y, `${w} posisi hook`, 0, 1)),
      ukuran: opt(h.ukuran, () => num(h.ukuran, `${w} ukuran hook`, 1, 8)),
      baris: opt(h.baris, () => (h.baris === 1 || h.baris === 2 || h.baris === 3 ? h.baris : bad(`${w} baris hook harus 1–3`))) as number | undefined,
      warna: opt(h.warna, () => hex(h.warna, `${w} warna hook`)),
      dari_kalimat_kuat: opt(h.dari_kalimat_kuat, () => bool(h.dari_kalimat_kuat, `${w} hook dari kalimat kuat`, false)),
    }) ?? {};
  const jenis = opt(o.jenis, () => oneOf(o.jenis, `${w} jenis`, PRESET_JENIS, 'lain'));
  const e = obj(o.efek ?? {}, `${w} efek`, ['wajib', 'boleh', 'jangan', 'maks', 'jarak_dtk']);
  const a = obj(o.audio ?? {}, `${w} audio`, ['suara_asli', 'sfx', 'musik', 'lufs']);
  return {
    id,
    nama: text(o.nama, `${w} nama`, 60, false),
    tujuan: text(o.tujuan, `${w} tujuan`, 120),
    placement: [...new Set(placement)],
    durasi,
    turunan,
    babak: babak.map((b, j) => {
      const bo = obj(b, `${w} babak ${j + 1}`, ['dari', 'sampai', 'isi']);
      const dari = num(bo.dari, `${w} babak ${j + 1} dari`, 0, 600);
      const sampai = num(bo.sampai, `${w} babak ${j + 1} sampai`, 0, 600);
      if (sampai <= dari) bad(`${w} babak ${j + 1}: "sampai" harus setelah "dari"`);
      return { dari, sampai, isi: text(bo.isi, `${w} babak ${j + 1} isi`, 80, false) };
    }),
    ritme: text(o.ritme, `${w} ritme`, 300),
    caption: { mode: oneOf(c.mode, `${w} caption mode`, ['per_kata', 'kalimat'] as const, 'per_kata'), maks_kata: num(c.maks_kata, `${w} caption maks kata`, 1, 12, 3), pop_ms: num(c.pop_ms, `${w} caption pop`, 0, 1000, 100), ...capX },
    hook: { teks: bool(h.teks, `${w} hook teks`, true), maks_kata: num(h.maks_kata, `${w} hook maks kata`, 1, 20, 6), dari_ucapan: bool(h.dari_ucapan, `${w} hook dari ucapan`, true), ...hookX },
    efek: { wajib: list(e.wajib, `${w} efek wajib`, 20, 40), boleh: list(e.boleh, `${w} efek boleh`, 20, 40), jangan: list(e.jangan, `${w} efek jangan`, 20, 40), maks: num(e.maks, `${w} efek maks`, 0, 30, 3), jarak_dtk: num(e.jarak_dtk, `${w} jarak efek`, 0, 60, 4) },
    audio: { suara_asli: bool(a.suara_asli, `${w} suara asli`, true), sfx: text(a.sfx, `${w} sfx`, 200), musik: text(a.musik, `${w} musik`, 200), lufs: num(a.lufs, `${w} LUFS`, -30, -6, -14) },
    qc: list(o.qc, `${w} qc`, 30, 120),
    ...(jenis ? { jenis } : {}),
    ...(shot ? { shot } : {}),
    ...(ganti ? { transisi: { ganti_orang: ganti } } : {}),
    ...(endCard !== undefined ? { penutup: { end_card: endCard } } : {}),
    ...(beat ? { beat } : {}),
  };
}

/**
 * R18 §17.4: the four example presets learnt from Aysilla's winning videos (Hanagaki's study).
 * "Isi contoh preset Aysilla" adds the ones a brand does not have yet (never overwrites).
 */
export function examplePresets(): BrandPreset[] {
  const raw = [
    { id: 'aysilla-interview', nama: 'Aysilla · Street interview', tujuan: 'Tanya orang di jalan, potong cepat antar narasumber', jenis: 'street_interview', durasi: { min: 40, target: 48, max: 55 }, caption: { y: 0.76, warna: '#f5efa0', maks_kata: 4 }, hook: { y: 0.18, ukuran: 4.5 }, shot: { target_dtk: 1.9, maks_dtk: 3.5 }, transisi: { ganti_orang: 'flash' } },
    { id: 'aysilla-test-produk', nama: 'Aysilla · Test produk', tujuan: 'Uji / demo produk di depan kamera', jenis: 'test_produk', durasi: { min: 15, target: 25, max: 35 }, caption: { y: 0.45 }, hook: { baris: 2 }, shot: { target_dtk: 1.6 } },
    { id: 'aysilla-harian', nama: 'Aysilla · Harian studio', tujuan: 'Konten harian dari studio, pendek', jenis: 'harian_studio', durasi: { min: 13, target: 15, max: 18 }, hook: { y: 0.54, ukuran: 3.4, baris: 2, warna: '#ffffff' }, shot: { target_dtk: 1.2, maks_dtk: 3.5 } },
    { id: 'aysilla-beatspot', nama: 'Aysilla · Beat Spot', tujuan: 'Awareness: orang memakai produk, potong di ketukan (hanya watermark)', jenis: 'beat_spot', durasi: { min: 15, target: 16, max: 18 }, beat: { tiap_ketukan: 4, bpm: 120 } },
  ];
  return raw.map(validatePreset);
}

const INPUT_KEYS = ['name', 'kode', ...Object.keys(EMPTY_FIELDS)] as const;

/** Shape check for the editable part (HTTP body or stored file). Missing fields = empty (older kits). */
export function validateBrandInput(raw: unknown): BrandKitInput {
  const o = obj(raw, 'kit', INPUT_KEYS);
  const name = text(o.name, 'nama', 60, false);
  // An empty code field means "derive it from the name".
  const kode = o.kode === undefined || o.kode === null || (typeof o.kode === 'string' && !o.kode.trim()) ? deriveKode(name) : typeof o.kode === 'string' && KODE.test(o.kode.trim().toUpperCase()) ? o.kode.trim().toUpperCase() : bad('kode brand 2–5 huruf/angka, mis. AYS');
  const rawColors = o.colors === undefined ? [] : Array.isArray(o.colors) ? (o.colors as unknown[]) : bad('warna harus daftar');
  if (rawColors.length > MAX_BRAND_COLORS) bad(`warna maksimal ${MAX_BRAND_COLORS}`);
  const colors = rawColors.map((c, i) => hex(c, `warna ${i + 1}`));
  if (new Set(colors).size !== colors.length) bad('warna tidak boleh dobel');
  let logo: BrandLogo | null = null;
  if (o.logo !== null && o.logo !== undefined) {
    const l = obj(o.logo, 'logo', ['ref', 'corner', 'size', 'opacity', 'show']);
    logo = {
      ref: ref(l.ref, 'logo') ?? bad('logo: pilih file logo'),
      corner: oneOf(l.corner, 'posisi logo', LOGO_CORNERS, 'tr'),
      size: num(l.size, 'ukuran logo', ...LOGO_LIMITS.size),
      opacity: num(l.opacity, 'opasitas logo', ...LOGO_LIMITS.opacity),
      show: oneOf(l.show, 'kapan logo tampil', LOGO_SHOW, 'sepanjang'),
    };
  }
  const ol = obj(o.outline ?? EMPTY_FIELDS.outline, 'outline', ['color', 'px']);
  const out = obj(o.outro ?? EMPTY_FIELDS.outro, 'penutup', ['ref', 'detik']);
  const produk = o.produk === undefined ? [] : Array.isArray(o.produk) ? o.produk : bad('produk harus daftar');
  if (produk.length > 50) bad('produk maksimal 50');
  const kamus = o.kamus === undefined ? [] : Array.isArray(o.kamus) ? o.kamus : bad('kamus harus daftar');
  if (kamus.length > 300) bad('kamus maksimal 300 pasang');
  const presets = o.presets === undefined ? [] : Array.isArray(o.presets) ? o.presets : bad('preset harus daftar');
  if (presets.length > 12) bad('preset maksimal 12');
  const presetList = presets.map(validatePreset);
  if (new Set(presetList.map((p) => p.id)).size !== presetList.length) bad('id preset tidak boleh dobel');
  let disclaimer: BrandKitInput['disclaimer'] = null;
  if (o.disclaimer !== undefined && o.disclaimer !== null) {
    const d = obj(o.disclaimer, 'disclaimer', ['teks', 'kapan']);
    const t = text(d.teks, 'disclaimer', 160);
    disclaimer = t ? { teks: t, kapan: oneOf(d.kapan, 'kapan disclaimer', DISCLAIMER_WHEN, 'selalu') } : null;
  }
  let watermark: BrandKitInput['watermark'] = null;
  if (o.watermark !== undefined && o.watermark !== null) {
    const wm = obj(o.watermark, 'watermark', ['teks', 'y', 'lebar', 'opasitas']);
    const t = text(wm.teks, 'teks watermark', 60);
    // Defaults from Hanagaki's study / §17.3: top centre, small, clearly visible. The bottom 15 % is
    // covered by the TikTok / Reels buttons (text-free area), so a watermark is never put there.
    const y = num(wm.y, 'posisi watermark', 0, 1, 0.07);
    if (y > 0.85) bad('Posisi watermark terlalu bawah, tertutup tombol TikTok (maks 0,85)');
    watermark = t ? { teks: t, y, lebar: num(wm.lebar, 'lebar watermark', 0.05, 1, 0.25), opasitas: num(wm.opasitas, 'opasitas watermark', 0.05, 1, 0.85) } : null;
  }
  const areas = o.area_bebas_teks === undefined ? [] : Array.isArray(o.area_bebas_teks) ? [...new Set(o.area_bebas_teks as unknown[])] : bad('area bebas teks harus daftar');
  const assets = o.aset === undefined ? [] : Array.isArray(o.aset) ? o.aset : bad('aset harus daftar');
  if (assets.length > MAX_BRAND_ASSETS) bad(`aset maksimal ${MAX_BRAND_ASSETS}`);
  const assetList = assets.map(validateAsset);
  const dupe = assetList.find((a, i) => assetList.findIndex((b) => b.id === a.id) !== i);
  if (dupe) bad(`id aset "${dupe.id}" dobel`);
  if (assetList.some((a) => a.jenis === 'musik' && a.lisensi.iklan && a.instrumental === false)) bad('musik dengan lirik tidak boleh ditandai untuk iklan (suara bicara tertutup)');
  const refs = o.referensi === undefined ? [] : Array.isArray(o.referensi) ? o.referensi : bad('referensi harus daftar');
  if (refs.length > 20) bad('referensi maksimal 20');
  const produkNames = new Set((produk as Record<string, unknown>[]).map((p) => (typeof p?.nama === 'string' ? oneLine(p.nama) : '')));
  const unknownProduct = assetList.find((a) => a.produk && !produkNames.has(a.produk));
  if (unknownProduct) bad(`aset ${unknownProduct.id}: produk "${unknownProduct.produk}" tidak ada di daftar produk (bagian A)`);
  return {
    name,
    kode,
    handles: perPlatform(o.handles, 'handle', 40),
    target: text(o.target, 'target penonton', 200),
    nada: list(o.nada, 'nada', 5, 30),
    bahasa: oneOf(o.bahasa, 'bahasa', LANGS, 'id'),
    produk: produk.map((p, i) => {
      const po = obj(p, `produk ${i + 1}`, ['nama', 'varian', 'ukuran']);
      return { nama: text(po.nama, `produk ${i + 1} nama`, 60, false), varian: list(po.varian, `produk ${i + 1} varian`, 30, 40), ukuran: text(po.ukuran, `produk ${i + 1} ukuran`, 40) };
    }),
    colors,
    text_color: hex(o.text_color, 'warna teks', '#ffffff'),
    outline: { color: hex(ol.color, 'warna outline', '#000000'), px: num(ol.px, 'tebal outline', 0, 20, 0) },
    warna_dilarang: list(o.warna_dilarang, 'warna dilarang', 20, 30),
    font: ref(o.font, 'font judul'),
    font_caption: ref(o.font_caption, 'font caption'),
    logo,
    logo_light: ref(o.logo_light, 'logo terang'),
    outro: { ref: ref(out.ref, 'penutup'), detik: num(out.detik, 'durasi penutup', 0.5, 10, 2) },
    gaya: text(o.gaya, 'gaya keseluruhan', 120),
    grading: text(o.grading, 'color grading', 120),
    filter_bawaan: o.filter_bawaan === undefined || o.filter_bawaan === null || o.filter_bawaan === '' ? null : LOOK_IDS.includes(o.filter_bawaan as LookId) ? (o.filter_bawaan as LookId) : bad(`filter bawaan harus salah satu dari ${LOOK_IDS.join(', ')}`),
    cta: perPlatform(o.cta, 'CTA', 120),
    cta_wajib: text(o.cta_wajib, 'CTA wajib', 200),
    disclaimer,
    tagline: text(o.tagline, 'tagline', 120),
    watermark,
    kosakata: list(o.kosakata, 'kosakata Whisper', 300, 60),
    kamus: kamus.map((k, i) => {
      const ko = obj(k, `kamus ${i + 1}`, ['salah', 'benar']);
      return { salah: text(ko.salah, `kamus ${i + 1} salah`, 60, false), benar: text(ko.benar, `kamus ${i + 1} benar`, 60, false) };
    }),
    kata_kunci: list(o.kata_kunci, 'kata kunci', 100, 40),
    kapital: oneOf(o.kapital, 'aturan kapital', CAPITALS, 'normal'),
    emoji: bool(o.emoji, 'emoji', false),
    // A kit saved before X08 has no guard: same as an empty one.
    guard: validateGuard(o.guard),
    klaim_boleh: list(o.klaim_boleh, 'klaim boleh', 100, 80),
    visual_dilarang: list(o.visual_dilarang, 'visual dilarang', 50, 80),
    area_bebas_teks: areas.map((a) => oneOf(a, 'area bebas teks', TEXT_FREE_AREAS, 'wajah')),
    aset: assetList,
    sfx_dilarang: list(o.sfx_dilarang, 'SFX dilarang', 50, 40),
    referensi: refs.map((r, i) => {
      const ro = obj(r, `referensi ${i + 1}`, ['link', 'tiru', 'jangan']);
      const link = text(ro.link, `referensi ${i + 1} link`, 300, false);
      if (!/^https?:\/\/\S+$/i.test(link)) bad(`referensi ${i + 1}: link harus http(s)://…`);
      return { link, tiru: text(ro.tiru, `referensi ${i + 1} yang ditiru`, 200), jangan: text(ro.jangan, `referensi ${i + 1} yang tidak ditiru`, 200) };
    }),
    presets: presetList,
  };
}

/** "Aysilla Factory" → "AF"; "Lucy" → "LUCY"; never shorter than 2. */
export function deriveKode(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const k = (words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '')).toUpperCase().slice(0, 5);
  return k.length >= 2 ? k : `${k}BR`.slice(0, 5);
}

// ------------------------------------------------------------------ storage

const BRANDS_DIR = 'brands';
const dir = (ws: Workspace) => path.join(ws.root, LAYOUT.meta, BRANDS_DIR);
const brandFile = (ws: Workspace, id: string) => path.join(dir(ws), `${id}.json`);
const indexFile = (ws: Workspace) => path.join(dir(ws), 'index.json');

function validateStored(x: unknown): BrandKit {
  const o = x as Record<string, unknown>;
  if (!o || (o.schema_version !== 1 && o.schema_version !== 2) || !Number.isSafeInteger(o.revision) || typeof o.updated_at !== 'number') throw new StorageError('WORKSPACE_INVALID', 'file Brand Kit tidak valid');
  try {
    const { schema_version: _s, revision, updated_at, brand_id, ...rest } = o;
    void _s;
    if (!isSafeId(brand_id)) throw new Error('brand_id tidak valid');
    return { schema_version: 2, brand_id: brand_id as string, revision: revision as number, updated_at: updated_at as number, ...validateBrandInput(rest) };
  } catch (e) {
    throw new StorageError('WORKSPACE_INVALID', `file Brand Kit tidak valid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const validateIndex = (x: unknown): { default_id: string | null } => {
  const o = x as Record<string, unknown>;
  if (!o || (o.default_id !== null && !isSafeId(o.default_id))) throw new StorageError('WORKSPACE_INVALID', 'index Brand Kit tidak valid');
  return { default_id: o.default_id as string | null };
};

/**
 * One-time move of the X06 single kit (`.motionstudio/brand_kit.json`) into `brands/`, as the
 * default brand. Runs under the workspace lock; the old file is renamed, never deleted.
 */
async function migrateLegacy(ws: Workspace): Promise<void> {
  const legacy = metaPath(ws, META_FILES.brand);
  if (!(await exists(legacy))) return;
  await withWorkspaceLock(ws, 'brand.migrate', async () => {
    if (!(await exists(legacy))) return;
    const raw = JSON.parse(await fsp.readFile(legacy, 'utf8')) as Record<string, unknown>;
    const { schema_version: _s, revision, updated_at, ...rest } = raw;
    void _s;
    const kit: BrandKit = { schema_version: 2, brand_id: 'b-utama', revision: Number(revision) || 1, updated_at: Number(updated_at) || ws.clock.now(), ...validateBrandInput(rest) };
    await fsp.mkdir(dir(ws), { recursive: true });
    await writeJsonAtomic(brandFile(ws, kit.brand_id), kit);
    await writeJsonAtomic(indexFile(ws), { default_id: kit.brand_id });
    await fsp.rename(legacy, `${legacy}.migrated`);
    await audit(ws, { op: 'brand.migrate', actor: 'system', outcome: 'ok', brand_id: kit.brand_id });
  });
}

/** All brands, sorted by name. */
export async function listBrands(ws: Workspace): Promise<BrandKit[]> {
  await migrateLegacy(ws);
  const names = await fsp.readdir(dir(ws)).catch(() => [] as string[]);
  const out: BrandKit[] = [];
  for (const n of names.filter((x) => x.endsWith('.json') && x !== 'index.json').sort()) out.push(await readJson(path.join(dir(ws), n), validateStored));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Brand files (for the dependency-index fingerprint): sorted absolute paths. */
export async function brandFiles(ws: Workspace): Promise<string[]> {
  const names = await fsp.readdir(dir(ws)).catch(() => [] as string[]);
  return names
    .filter((x) => x.endsWith('.json'))
    .sort()
    .map((n) => path.join(dir(ws), n));
}

export async function defaultBrandId(ws: Workspace): Promise<string | null> {
  await migrateLegacy(ws);
  const idx = await readJson(indexFile(ws), validateIndex).catch(() => ({ default_id: null }));
  if (idx.default_id && (await exists(brandFile(ws, idx.default_id)))) return idx.default_id;
  return (await listBrands(ws))[0]?.brand_id ?? null;
}

export async function readBrand(ws: Workspace, brandId: string): Promise<BrandKit> {
  if (!isSafeId(brandId)) throw new StorageError('NOT_FOUND', 'Brand tidak ditemukan');
  await migrateLegacy(ws);
  const f = brandFile(ws, brandId);
  if (!(await exists(f))) throw new StorageError('NOT_FOUND', 'Brand tidak ditemukan', { brand_id: brandId });
  return readJson(f, validateStored);
}

/** The kit a project uses: its own brand, else the workspace default, else the empty kit. */
export async function readBrandFor(ws: Workspace, brandId: string | null | undefined): Promise<BrandKit> {
  if (brandId) {
    const k = await readBrand(ws, brandId).catch((e: unknown) => (e instanceof StorageError && e.code === 'NOT_FOUND' ? null : Promise.reject(e)));
    if (k) return k;
  }
  const d = await defaultBrandId(ws);
  return d ? readBrand(ws, d) : { ...EMPTY_BRAND };
}

/** The default brand (X06 API: one "workspace" kit). */
export const readBrandKit = (ws: Workspace): Promise<BrandKit> => readBrandFor(ws, null);

/** Media versions a kit holds (for the dependency index). */
export const brandReferences = (k: BrandKit): { slot: 'font' | 'font_caption' | 'logo' | 'logo_light' | 'outro' | 'aset'; ref: MediaRef }[] => [
  ...(k.font ? [{ slot: 'font' as const, ref: k.font }] : []),
  ...(k.font_caption ? [{ slot: 'font_caption' as const, ref: k.font_caption }] : []),
  ...(k.logo ? [{ slot: 'logo' as const, ref: k.logo.ref }] : []),
  ...(k.logo_light ? [{ slot: 'logo_light' as const, ref: k.logo_light }] : []),
  ...(k.outro.ref ? [{ slot: 'outro' as const, ref: k.outro.ref }] : []),
  ...k.aset.map((a) => ({ slot: 'aset' as const, ref: a.ref })),
];

function usable(reg: Registry, r: MediaRef, what: string): VersionRecord {
  const v = reg.versions[r.version_id];
  if (!v || v.media_id !== r.media_id) throw new StorageError('PRECONDITION', `${what}: media tidak dikenal`);
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', `${what}: media sedang ${v.lifecycle}; pulihkan dulu`);
  if (v.integrity !== 'ok') throw new StorageError('INTEGRITY', `${what}: media ${v.integrity}, perlu verifikasi`);
  return v;
}

/** TrueType / OpenType magic: 00 01 00 00, "OTTO" or "true". */
const isFontMagic = (b: Buffer) => b.length >= 4 && (b.readUInt32BE(0) === 0x00010000 || b.toString('latin1', 0, 4) === 'OTTO' || b.toString('latin1', 0, 4) === 'true');

async function head(ws: Workspace, v: VersionRecord): Promise<Buffer> {
  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  const s = await ws.blobs.readStream(rel, { start: 0, end: 3 });
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Files of the right kind, usable now. */
async function checkFiles(ws: Workspace, reg: Registry, kit: BrandKitInput): Promise<void> {
  const fonts: [MediaRef | null, string][] = [
    [kit.font, 'Font judul'],
    [kit.font_caption, 'Font caption'],
  ];
  for (const [r, what] of fonts) {
    if (!r) continue;
    const v = usable(reg, r, what);
    if (!FONT_EXT.includes(ext(v.original_name)) || !isFontMagic(await head(ws, v))) bad(`${what.toLowerCase()} harus file .ttf atau .otf`);
  }
  const images: [MediaRef | null, string][] = [
    [kit.logo?.ref ?? null, 'Logo'],
    [kit.logo_light, 'Logo terang'],
  ];
  for (const [r, what] of images) {
    if (!r) continue;
    const v = usable(reg, r, what);
    const img = LOGO_EXT.includes(ext(v.original_name)) ? await ws.blobs.withLocalFile(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS), probeImage) : null;
    if (!img) bad(`${what.toLowerCase()} harus gambar PNG/JPG/WebP yang bisa dibaca (maks 8192 px)`);
  }
  if (kit.outro.ref) {
    const v = usable(reg, kit.outro.ref, 'Penutup');
    if (!OUTRO_EXT.includes(ext(v.original_name))) bad('penutup harus video (MP4/MOV/WebM) atau gambar');
  }
  // U2: library files must be of their kind (sound for SFX/music, picture for b-roll/logo).
  for (const a of kit.aset) {
    const v = usable(reg, a.ref, `Aset ${a.id}`);
    const e = ext(v.original_name);
    if ((a.jenis === 'sfx' || a.jenis === 'musik') && !AUDIO_EXT.includes(e) && !['.mp4', '.mov', '.webm'].includes(e)) bad(`aset ${a.id}: ${a.jenis} harus file suara (MP3/WAV/M4A/…)`);
    if ((a.jenis === 'broll' || a.jenis === 'penutup') && !OUTRO_EXT.includes(e)) bad(`aset ${a.id}: ${a.jenis} harus video atau gambar`);
    if (a.jenis === 'logo' && !LOGO_EXT.includes(e)) bad(`aset ${a.id}: logo harus gambar PNG/JPG/WebP`);
  }
}

async function save(ws: Workspace, kit: BrandKit, actor: Actor, op: string): Promise<BrandKit> {
  const reg = await loadRegistry(ws);
  await checkFiles(ws, reg, kit);
  const clash = (await listBrands(ws)).find((b) => b.brand_id !== kit.brand_id && b.kode === kit.kode);
  if (clash) bad(`kode ${kit.kode} sudah dipakai brand "${clash.name}"`);
  await fsp.mkdir(dir(ws), { recursive: true });
  await writeJsonAtomic(brandFile(ws, kit.brand_id), kit);
  if (!(await exists(indexFile(ws)))) await writeJsonAtomic(indexFile(ws), { default_id: kit.brand_id });
  for (const { ref: r } of brandReferences(kit)) {
    const v = reg.versions[r.version_id]!;
    v.ever_referenced = true;
    v.unreferenced_since = null;
  }
  await saveRegistry(ws, reg);
  await audit(ws, { op, actor, outcome: 'ok', brand_id: kit.brand_id, kode: kit.kode, revision: kit.revision, font: kit.font?.version_id ?? null, logo: kit.logo?.ref.version_id ?? null });
  return kit;
}

/** New brand (user only). The first brand becomes the default. */
export async function createBrand(ws: Workspace, input: { kit: unknown; actor: Actor; newId: () => string }): Promise<BrandKit> {
  await guard(ws, input.actor, 'commit_project', { step: 'brand_create' });
  const fields = validateBrandInput(input.kit);
  return withWorkspaceLock(ws, 'brand.create', async () => {
    await migrateLegacy(ws);
    return save(ws, { schema_version: 2, brand_id: input.newId(), revision: 1, updated_at: ws.clock.now(), ...fields }, input.actor, 'brand.create');
  });
}

/**
 * R13: a new brand fast — a copy of an existing Brand Kit (identity, visuals, text, rules, assets,
 * presets) under a new name and code. Files (fonts, logo, assets) are shared, not copied; the
 * source brand's learning notes stay with it.
 */
export async function duplicateBrand(ws: Workspace, input: { brand_id: string; name: unknown; kode?: unknown; actor: Actor; newId: () => string }): Promise<BrandKit> {
  const src = await readBrand(ws, input.brand_id);
  const copy: Record<string, unknown> = {};
  for (const k of INPUT_KEYS) if ((src as unknown as Record<string, unknown>)[k] !== undefined) copy[k] = (src as unknown as Record<string, unknown>)[k];
  if (typeof input.name !== 'string' || !input.name.trim()) bad('Nama brand baru wajib diisi');
  if ((input.name as string).trim().toLowerCase() === src.name.trim().toLowerCase()) bad('Nama brand baru harus beda dari brand asalnya');
  // No code given: one is made from the new name (a clash with an existing brand is refused).
  return createBrand(ws, { kit: { ...copy, name: (input.name as string).trim(), kode: input.kode === undefined || input.kode === '' ? null : input.kode }, actor: input.actor, newId: input.newId });
}

/**
 * Save a brand (user only, optimistic revision). Without `brand_id` this is the default brand —
 * the X06 single-kit API — and saving revision 0 creates it.
 */
export async function setBrandKit(ws: Workspace, input: { brand_id?: string; expected_revision: number; kit: unknown; actor: Actor }): Promise<BrandKit> {
  await guard(ws, input.actor, 'commit_project', { step: 'brand_kit' });
  const fields = validateBrandInput(input.kit);
  return withWorkspaceLock(ws, 'setBrandKit', async () => {
    const id = input.brand_id ?? (await defaultBrandId(ws));
    const current = id ? await readBrand(ws, id) : { ...EMPTY_BRAND, brand_id: 'b-utama' };
    if (current.revision !== input.expected_revision) throw new StorageError('CONFLICT', 'Brand Kit sudah berubah; muat ulang dulu', { expected: input.expected_revision, actual: current.revision });
    return save(ws, { schema_version: 2, brand_id: current.brand_id, revision: current.revision + 1, updated_at: ws.clock.now(), ...fields }, input.actor, 'brand.save');
  });
}

export async function setDefaultBrand(ws: Workspace, input: { brand_id: string; actor: Actor }): Promise<void> {
  await guard(ws, input.actor, 'commit_project', { step: 'brand_default' });
  await withWorkspaceLock(ws, 'brand.default', async () => {
    await readBrand(ws, input.brand_id);
    await writeJsonAtomic(indexFile(ws), { default_id: input.brand_id });
    await audit(ws, { op: 'brand.default', actor: input.actor, outcome: 'ok', brand_id: input.brand_id });
  });
}

/** Projects that chose this brand. */
export async function projectsUsingBrand(ws: Workspace, brandId: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of await listProjectIds(ws)) {
    const p = await readProject(ws, id).catch(() => null);
    if (p?.brand_id === brandId) out.push(p.project_id);
  }
  return out;
}

/** Delete a brand nobody uses (its files stay in the media library; nothing is purged). */
export async function deleteBrand(ws: Workspace, input: { brand_id: string; actor: Actor }): Promise<void> {
  await guard(ws, input.actor, 'commit_project', { step: 'brand_delete' });
  await withWorkspaceLock(ws, 'brand.delete', async () => {
    const kit = await readBrand(ws, input.brand_id);
    const used = await projectsUsingBrand(ws, kit.brand_id);
    if (used.length) throw new StorageError('PRECONDITION', `Brand "${kit.name}" masih dipakai ${used.length} proyek; pindahkan proyeknya ke brand lain dulu`, { projects: used });
    await fsp.rm(brandFile(ws, kit.brand_id));
    const rest = (await listBrands(ws)).filter((b) => b.brand_id !== kit.brand_id);
    const idx = await readJson(indexFile(ws), validateIndex).catch(() => ({ default_id: null as string | null }));
    if (idx.default_id === kit.brand_id) await writeJsonAtomic(indexFile(ws), { default_id: rest[0]?.brand_id ?? null });
    await audit(ws, { op: 'brand.delete', actor: input.actor, outcome: 'ok', brand_id: kit.brand_id, kode: kit.kode });
  });
}

/** Media a render of `t` needs from the kit: logo when switched on, each font a text uses. */
export function brandRenderRefs(t: Timeline, k: BrandKit): { font: MediaRef | null; font_caption: MediaRef | null; logo: BrandLogo | null } {
  const uses = (f: 'brand' | 'caption') => t.tracks.some((tr) => (tr.kind === 'text' || tr.kind === 'subtitle') && tr.clips.some((c) => c.text?.trim() && c.style?.font === f));
  return { font: uses('brand') ? k.font : null, font_caption: uses('caption') ? k.font_caption : null, logo: t.brand_logo && k.logo ? k.logo : null };
}

// ------------------------------------------------------------------ export for the engine

/** Nearest standard ratio within 3 %, else "lainnya". */
export function orientationOf(w: number, h: number): string {
  const r = w / h;
  const hit = ([['9:16', 9 / 16], ['3:4', 3 / 4], ['1:1', 1], ['16:9', 16 / 9]] as const).find(([, v]) => Math.abs(r - v) / v < 0.03);
  return hit ? hit[0] : 'lainnya';
}

export interface BrandExportAsset {
  kunci: string;
  jenis: 'font' | 'logo' | 'penutup' | 'sfx' | 'musik' | 'broll' | 'lainnya';
  path?: string;
  tag: string[];
  lisensi_iklan: boolean;
  nama?: string;
  status_lisensi?: (typeof LICENSE_STATUS)[number];
  sumber_lisensi?: string;
  /** Always set for sound/video; null only for still pictures. */
  durasi_ms?: number | null;
  mood?: string;
  bpm?: number | null;
  instrumental?: boolean | null;
  produk?: string;
  varian?: string;
  /** 9:16 | 3:4 | 1:1 | 16:9 | lainnya (from the file), null for sound. */
  orientasi?: string | null;
  ada_teks_bawaan?: boolean;
}

/**
 * The kit in the engine contract shape (KONTRAK-ENGINE §4, `brand-kit-export/1`). Media are
 * placeholders (`$logo`, `$font:judul`, …). `paths: true` (runner only, same PC) adds each file's
 * local path; the browser download never contains paths.
 */
export async function exportBrandKit(ws: Workspace, brandId: string, opts: { paths: boolean }): Promise<Record<string, unknown>> {
  const k = await readBrand(ws, brandId);
  const reg = await loadRegistry(ws);
  const aset: BrandExportAsset[] = [];
  const add = async (kunci: string, jenis: BrandExportAsset['jenis'], r: MediaRef | null) => {
    if (!r) return null;
    const v = usable(reg, r, kunci);
    const item: BrandExportAsset = { kunci, jenis, tag: [jenis], lisensi_iklan: true };
    if (opts.paths) item.path = await ws.blobs.withLocalFile(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS), async (abs) => abs);
    aset.push(item);
    return kunci;
  };
  const fontJudul = await add('$font:judul', 'font', k.font);
  const fontCaption = await add('$font:caption', 'font', k.font_caption);
  const logo = await add('$logo', 'logo', k.logo?.ref ?? null);
  const logoLight = await add('$logo:terang', 'logo', k.logo_light);
  const outro = await add('$penutup', 'penutup', k.outro.ref);
  // U2 library: `$sfx:pop-01`, `$musik:ceria-01`, `$broll:detail-bahan` … with tags + licence.
  for (const a of k.aset) {
    const v = usable(reg, a.ref, `$${a.jenis}:${a.id}`);
    // Duration + orientation come from the file itself (probed now if the import has not yet).
    const local = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
    const probe = v.probe ?? (await ws.blobs.withLocalFile(local, probeFile));
    const still = !probe ? await ws.blobs.withLocalFile(local, probeImage) : null;
    const w = probe?.width ?? still?.width ?? null;
    const h = probe?.height ?? still?.height ?? null;
    const item: BrandExportAsset = {
      kunci: `$${a.jenis}:${a.id}`,
      jenis: a.jenis,
      tag: a.tag,
      lisensi_iklan: a.lisensi.iklan,
      nama: a.nama || v.original_name,
      status_lisensi: a.lisensi.status,
      sumber_lisensi: a.lisensi.bukti,
      durasi_ms: probe?.duration_ms ?? null,
      mood: a.mood,
      bpm: a.bpm,
      instrumental: a.instrumental,
      produk: a.produk,
      varian: a.varian,
      orientasi: w && h ? orientationOf(w, h) : null,
      ada_teks_bawaan: a.ada_teks_bawaan,
    };
    if (opts.paths) item.path = await ws.blobs.withLocalFile(local, async (abs) => abs);
    aset.push(item);
  }
  return {
    schema: 'brand-kit-export/1',
    brand: { id: k.brand_id, nama: k.name, kode: k.kode, handle: k.handles, target: k.target, nada: k.nada, bahasa: k.bahasa, produk: k.produk },
    visual: {
      warna: k.colors,
      warna_teks: k.text_color,
      outline: { warna: k.outline.color, px: k.outline.px },
      warna_dilarang: k.warna_dilarang,
      font_judul: fontJudul,
      font_caption: fontCaption,
      logo: logo ? { aset: logo, aset_terang: logoLight, pojok: k.logo!.corner, ukuran: k.logo!.size, opasitas: k.logo!.opacity, tampil: k.logo!.show } : null,
      penutup: { aset: outro, detik: k.outro.detik },
      gaya: k.gaya,
      grading: k.grading,
      ...(k.watermark ? { watermark: k.watermark } : {}),
    },
    teks: {
      cta: k.cta,
      cta_wajib: k.cta_wajib,
      disclaimer: k.disclaimer,
      ...(k.tagline ? { tagline: k.tagline } : {}),
      kosakata_whisper: k.kosakata,
      kamus: Object.fromEntries(k.kamus.map((x) => [x.salah, x.benar])),
      kata_kunci: k.kata_kunci,
      kapital: k.kapital,
      emoji: k.emoji,
    },
    aturan: {
      terlarang: k.guard.banned,
      level: k.guard.banned_level,
      harga: k.guard.prices.map((p) => ({ teks: p.text, berlaku_sampai: p.valid_until })),
      klaim_boleh: k.klaim_boleh,
      visual_dilarang: k.visual_dilarang,
      area_bebas_teks: k.area_bebas_teks,
      sfx_dilarang: k.sfx_dilarang,
    },
    referensi: k.referensi,
    aset,
    preset: Object.fromEntries(k.presets.map((p) => [p.id, p])),
  };
}
