/**
 * Engine runner (U6, KONTRAK-ENGINE v0.3/v0.3.1). Motion Studio prepares a job folder, runs the
 * engine CLI (`D:\VIBECODING\remotion`, Python) as a child process and reads its plan back. The
 * engine never renders and never writes outside its job folder; Motion Studio never runs the
 * plan without the team's approval (it becomes a normal Copilot plan, source `engine`).
 *
 *  PROJECTS/<p>/06_ENGINE/<job_id>/        new non-media area: not scanned by GC, deleted with the
 *    job.json  brand_kit.json  status.json  project, never a source of media
 *    refs.json   placeholder → MediaRef decided by Motion Studio (sources, brand assets, imports)
 *    engine.log  stderr of the engine (tail)
 *    out/rencana.json + ops.json (+ batch.json, varian-NNN/ for Batch Remix)
 *
 * Exit codes: 0 done · 2 refused (reason in rencana.json) · 1 technical failure (may retry).
 * While the engine runs, a lease pins the source versions so Auto Trash never moves them.
 */
import { katalogUntukMesin } from './katalog.js';
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrandKit, assetKunci, brandReferences, exportBrandKit, readBrand, readBrandFor, sharedLibrary } from './brand.js';
import { OVERLAY_DEFAULT, type Overlay, validateOverlay } from './overlay.js';
import { localDate } from './brandGuard.js';
import { createLease, releaseLease, setLeaseStatus } from './deps.js';
import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import { isInside } from './paths.js';
import { lowerPriority } from './priority.js';
import { MEDIA_AREAS } from './permissions.js';
import type { MediaRef, Timeline, VariantInfo } from './project.js';
import { MAX_PROJECT_NAME, createWithTimeline } from './projectAdmin.js';
import { MAX_SERVER_OPS, applyOps, validateOps } from './timeline.js';
import { listVariants, setVariantApproval, variantState } from './variants.js';
import { newId } from './ids.js';
import { importMedia, loadRegistry } from './registry.js';
import { LAYOUT, type Workspace, listProjectIds, projectRel, readProject } from './workspace.js';
import { writeJsonAtomic } from './jsonStore.js';
import { audit } from './audit.js';
import { markEngineOrigin, readLearning } from './learning.js';
import { type PasanganKamus, kamusBelajar } from './kamusBelajar.js';
import { type TtsSettings, readVoIndex, validateTtsJob } from './tts.js';
import type { VoIndex } from './voText.js';
import { validateVisualJob } from './visual.js';
import { type SuaraProfilSettings, validateSuaraProfilJob } from './suaraOwner.js';
import { VISUAL_RESULT, type VisualTool } from './visualCalc.js';

export const ENGINE_DIR = '06_ENGINE';
/** `.motionstudio/engine-ids/<job_id>`: one empty-ish file per job id ever handed out (R4). */
export const ENGINE_ID_CLAIMS = 'engine-ids';
export const MAX_ENGINE_LOG = 64 * 1024;

export interface EngineConfig {
  /** Engine DATA folder (konten/, aset/, .venv): cwd of the CLI; every path check stays inside it. */
  root: string;
  /**
   * R20: engine CODE folder (pipeline/…), e.g. a separate release folder. Absent = `root` (one
   * folder for code and data, as before).
   */
  code?: string;
  /** Interpreter (default `<root>/.venv/Scripts/python.exe`). */
  command: string;
  /** CLI script (default `<code>/pipeline/engine.py`). */
  script: string;
  /** Kill the engine after this long (default 30 min). */
  timeout_ms: number;
}

/**
 * From env: MOTION_ENGINE_ROOT (data) + optional MOTION_ENGINE_CODE (R20: code from a release
 * folder; default = root) / _PYTHON / _SCRIPT / _TIMEOUT_MS. Null = not installed.
 */
export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig | null {
  const root = env.MOTION_ENGINE_ROOT?.trim();
  if (!root) return null;
  const code = env.MOTION_ENGINE_CODE?.trim() || root;
  const win = process.platform === 'win32';
  return {
    root: path.resolve(root),
    code: path.resolve(code),
    command: env.MOTION_ENGINE_PYTHON?.trim() || path.join(root, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    script: env.MOTION_ENGINE_SCRIPT?.trim() || path.join(code, 'pipeline', 'engine.py'),
    timeout_ms: Number(env.MOTION_ENGINE_TIMEOUT_MS) > 0 ? Number(env.MOTION_ENGINE_TIMEOUT_MS) : 30 * 60_000,
  };
}

export type EngineMode = 'generate' | 'batch' | 'ulang' | 'pisah' | 'transfer' | 'beatspot' | 'outfit' | 'tts' | 'visual' | 'suara_profil';
export type EngineState = 'menunggu' | 'berjalan' | 'siap' | 'ditolak' | 'gagal';

export interface EngineStatus {
  schema: 'engine-status/1';
  job_id: string;
  project_id: string;
  mode: EngineMode;
  state: EngineState;
  tahap: string;
  persen: number;
  pesan: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  /** Refusal (2) or failure (1) reason shown to the team. */
  alasan: string | null;
  lease_id: string | null;
}

export interface EngineBrief {
  produk: string;
  varian: string;
  harga: string;
  placement: 'tiktok' | 'instagram' | 'shopee' | 'youtube';
  catatan: string;
  area_produk?: 'bawah' | 'atas' | 'penuh';
  /** Motion Transfer (contract §15): extra words about the product for the image prompt. */
  deskripsi_produk?: string;
}

export interface EngineJobInput {
  project_id: string;
  mode: 'generate' | 'batch' | 'pisah' | 'transfer' | 'beatspot' | 'outfit' | 'tts' | 'visual' | 'suara_profil';
  /** `$sumber` (one video) or `$sumber:<id>` (several). */
  sources: { kunci: string; ref: MediaRef }[];
  preset: string;
  brief: EngineBrief;
  ai: boolean;
  mode_ops?: 'kompat' | 'u3';
  /**
   * R1 (G1, hybrid): the team's "tetap lanjut" after the engine refused the audio as a song
   * (lyrics). Generate only; written to job.json as `abaikan_cek_ucapan: true`.
   */
  abaikan_cek_ucapan?: true;
  /** Batch Remix extras (contract §3 + v0.3.1), passed through after validation. */
  batch?: { batch: string; jumlah: number; tujuan: string; seed?: number; izinkan_musik_tanpa_lisensi?: boolean; akun_sendiri?: string[]; hak_pakai_jelas?: boolean; shot_tiktok?: boolean; vo_batch?: string; buang_otomatis?: string[]; batas_durasi?: [number, number] | null; kecualikan_shot?: string[] };
  /**
   * Pisah Audio + Shot Library (audit yuki, fitur 1): the uploaded videos are copied to
   * `<job>/masuk/<id>.<ext>`; the engine copies them on to `konten/1-upload/<batch>` itself.
   */
  pisah?: { batch: string; video_saja?: boolean };
  /** R18 §17.2: voice over / music / both for this job (absent = engine behaviour as before). */
  audio_pilihan?: AudioPilihan;
  /** Beat Spot (contract §16): written to job.json as the `beatspot` object. */
  beatspot?: BeatspotSettings;
  /** §29 Beat Spot Ganti Outfit: written to job.json as `outfit` (+ `katalog.json` for tahap siapkan). */
  outfit?: OutfitSettings;
  /** R34 Suara dari Teks (contract §21): written to job.json as the `tts` object. */
  tts?: TtsSettings;
  /** R35 Visual Tools (contract §18.10): `{alat, …}`; job.json gets `masuk` = the source path. */
  visual?: { alat: VisualTool } & Record<string, unknown>;
  /** Suara owner (contract §23): written to job.json as the `suara_profil` object. */
  suara_profil?: SuaraProfilSettings;
  /**
   * R26 (app only, never in job.json): picture overlays chosen in "Buat video" before Generate,
   * added to the engine's draft as overlay clips (whole video, or [dari_ms, sampai_ms)).
   */
  overlay?: JobOverlay[];
  /**
   * R28 "Video penutup" for this job: a library / uploaded file, or `null` = no end card. Absent =
   * the Brand Kit's default outro. Applied to this job's copy of brand_kit.json (`visual.penutup` +
   * `$penutup`), so the engine contract is unchanged.
   */
  penutup?: { ref: MediaRef } | null;
  /**
   * R37 "VO dari Library" (contract §22): a brand VO asset (jenis `vo`, from "Suara dari Teks") is the
   * main voice; footage becomes pictures. job.json gets `vo: {media: "$vo:<id>", index, suara_footage,
   * subtitle}` and the app copies the VO's `vo-index/1` file to `<job>/vo_index.json`.
   */
  vo?: JobVo;
}

export const SUARA_FOOTAGE = ['mati', 'pelan', 'asli'] as const;
export interface JobVo {
  /** Brand asset id (jenis `vo`). */
  aset: string;
  suara_footage: (typeof SUARA_FOOTAGE)[number];
  subtitle: boolean;
}

/** R37: the job's VO choice (untrusted). The engine refuses `audio_pilihan: "musik"` with a VO (§22.1). */
export function validateJobVo(x: unknown, audio: unknown): JobVo {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('vo harus objek');
  const extra = Object.keys(o).filter((k) => !['aset', 'suara_footage', 'subtitle'].includes(k));
  if (extra.length) bad(`vo: field tidak dikenal ${extra.join(', ')}`);
  if (typeof o.aset !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.aset)) bad('vo.aset: pilih VO dari Aset brand');
  const sf = o.suara_footage ?? 'mati';
  if (!(SUARA_FOOTAGE as readonly unknown[]).includes(sf)) bad(`vo.suara_footage harus ${SUARA_FOOTAGE.join(' | ')}`);
  if (o.subtitle !== undefined && typeof o.subtitle !== 'boolean') bad('vo.subtitle harus true/false');
  if (audio === 'musik') bad('VO dari Library tidak bisa digabung dengan Audio "musik saja" — pilih VO atau VO + musik');
  return { aset: o.aset as string, suara_footage: sf as JobVo['suara_footage'], subtitle: o.subtitle !== false };
}

/** R37: the VO's brand asset + its sentence/word index, checked before the job is made. */
async function jobVoFiles(ws: Workspace, kit: BrandKit, vo: JobVo): Promise<{ ref: MediaRef; index: VoIndex }> {
  const a = kit.aset.find((x) => x.id === vo.aset);
  if (!a) bad(`VO "${vo.aset}" belum terdaftar sebagai aset brand ${kit.name}. Daftarkan dulu di Brand → Aset (jenis VO).`);
  if (a!.jenis !== 'vo') bad(`Aset "${vo.aset}" bukan VO (jenisnya ${a!.jenis}).`);
  const index = await readVoIndex(ws, a!.ref.version_id);
  if (!index || index.schema !== 'vo-index/1' || !Array.isArray(index.kalimat) || !index.kalimat.length) bad(`VO "${vo.aset}" tidak punya teks & waktu kalimat (bukan hasil "Suara dari Teks"), jadi tidak bisa dipakai sebagai VO utama.`);
  if (index!.kalimat.length > 60) bad(`VO "${vo.aset}" lebih dari 60 kalimat (batas mesin).`);
  return { ref: a!.ref, index: index! };
}

/** R28: the job's end-card choice (untrusted). */
export function validateJobPenutup(x: unknown): { ref: MediaRef } | null {
  if (x === null) return null;
  const o = (x ?? {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'ref');
  if (extra.length) bad(`penutup: field tidak dikenal ${extra.join(', ')}`);
  const r = (o.ref ?? {}) as Record<string, unknown>;
  if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad('penutup.ref tidak valid');
  return { ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
}

const OUTRO_FILE = /\.(mp4|mov|webm|png|jpe?g|webp)$/i;

/** R28: put the job's end card into its brand_kit.json copy + refs (`$penutup`); null = none. */
async function applyJobPenutup(ws: Workspace, brandExport: Record<string, unknown>, refs: Record<string, MediaRef>, choice: { ref: MediaRef } | null): Promise<void> {
  const visual = (brandExport.visual ?? {}) as { penutup?: { aset: string | null; detik: number } };
  const aset = ((brandExport.aset ?? []) as { kunci: string }[]).filter((a) => a.kunci !== '$penutup');
  delete refs.$penutup;
  if (choice) {
    const reg = await loadRegistry(ws);
    const v = reg.versions[choice.ref.version_id];
    if (!v || v.media_id !== choice.ref.media_id || v.lifecycle !== 'active') bad('Video penutup tidak dikenal atau sedang di Trash');
    if (!OUTRO_FILE.test(v!.original_name)) bad('Penutup harus video (MP4/MOV/WebM) atau gambar');
    aset.push({ kunci: '$penutup', jenis: 'penutup', tag: ['penutup'], lisensi_iklan: true, path: (await localPath(ws, choice.ref)).replace(/\\/g, '/') } as { kunci: string });
    refs.$penutup = { ...choice.ref };
  }
  visual.penutup = { aset: choice ? '$penutup' : null, detik: visual.penutup?.detik ?? 2 };
  brandExport.visual = visual;
  brandExport.aset = aset;
}

export interface JobOverlay {
  ref: MediaRef;
  overlay: Overlay;
  dari_ms?: number;
  sampai_ms?: number;
}
export const MAX_JOB_OVERLAYS = 10;

/** R26: overlays of a Generate / Batch request (untrusted). */
export function validateJobOverlays(x: unknown): JobOverlay[] {
  if (!Array.isArray(x) || x.length > MAX_JOB_OVERLAYS) return bad(`overlay harus daftar maks ${MAX_JOB_OVERLAYS}`);
  return x.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['ref', 'overlay', 'dari_ms', 'sampai_ms'].includes(k));
    if (extra.length) bad(`overlay[${i}]: field tidak dikenal ${extra.join(', ')}`);
    const r = (o.ref ?? {}) as Record<string, unknown>;
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`overlay[${i}].ref tidak valid`);
    let overlay: Overlay;
    try {
      overlay = validateOverlay(o.overlay, `overlay[${i}]`);
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'overlay tidak valid');
    }
    const ms = (v: unknown, w: string) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 3_600_000 ? Math.round(v) : bad(`overlay[${i}].${w} harus ms 0–1 jam`));
    const out: JobOverlay = { ref: { media_id: r.media_id as string, version_id: r.version_id as string }, overlay };
    if (!overlay.sepanjang) {
      out.dari_ms = ms(o.dari_ms ?? 0, 'dari_ms');
      out.sampai_ms = ms(o.sampai_ms, 'sampai_ms');
      if (out.sampai_ms - out.dari_ms < 100) bad(`overlay[${i}]: sampai harus setelah dari (min 0,1 dtk)`);
    }
    return out;
  });
}

/** R26: job overlays → add_clip ops on a draft that ends at `end` ms (parts past the end are dropped). */
export function jobOverlayOps(list: readonly JobOverlay[], end: number): Record<string, unknown>[] {
  if (end < 100) return [];
  return list.flatMap((o) => {
    const from = o.overlay.sepanjang ? 0 : Math.min(o.dari_ms ?? 0, end);
    const to = o.overlay.sepanjang ? end : Math.min(o.sampai_ms ?? end, end);
    return to - from >= 100 ? [{ op: 'add_clip', track_kind: 'overlay', media: { ...o.ref }, start_ms: from, duration_ms: to - from, overlay: { ...o.overlay } }] : [];
  });
}

/** Last clip end of a draft's add_clip ops (overlays excluded). */
const draftEnd = (ops: readonly Record<string, unknown>[]) => Math.max(0, ...ops.filter((o) => o?.op === 'add_clip' && o.track_kind !== 'overlay').map((o) => Number(o.start_ms ?? 0) + Number(o.duration_ms ?? 0)).filter(Number.isFinite));

export const AUDIO_PILIHAN = ['vo', 'musik', 'keduanya'] as const;
export type AudioPilihan = (typeof AUDIO_PILIHAN)[number];
const audioPilihan = (x: unknown): { audio_pilihan?: AudioPilihan } =>
  x === undefined || x === null || x === '' ? {} : AUDIO_PILIHAN.includes(x as AudioPilihan) ? { audio_pilihan: x as AudioPilihan } : bad('audio_pilihan harus vo | musik | keduanya');

/** Beat Spot settings (contract §16); the team's choices (order, exclusions, people) included. */
export interface BeatspotSettings {
  sound: string | null;
  bpm: number | null;
  ketukan_per_potong: 'auto' | 1 | 2 | 4;
  durasi: [number, number];
  tagline: string | null;
  urutan_shot: string[];
  kecualikan_shot: string[];
  sumber_orang: Record<string, 'kreator' | 'umum'>;
  seed: number;
}

/** Batch folder name in the engine's konten/ (one rule for batch, vo_batch, pisah and the library). */
const BATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const isBatchName = (x: unknown): x is string => typeof x === 'string' && BATCH_NAME.test(x) && !x.includes('..');

/** Engine-written text shown to the team: no local paths (drive letters, UNC). */
export const scrubPaths = (t: string): string =>
  t
    // A drive letter on its own ("D:\…"), not the "s:" of "https://…".
    .replace(/(?:(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)|\\\\[^\\\s]+\\)[^\s"'<>|]*/g, '<path>')
    // Linux / VPS paths too (audit Jenius #10); not URLs ("https://x/home/…" keeps its host).
    .replace(/(?<![\w:/.~-])\/(?:home|root|opt|srv|var|tmp|mnt|media|usr|etc|data|workspace|app)\/[^\s"'<>|]*/g, '<path>');

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};
const str = (v: unknown, what: string, max: number, allowEmpty = true): string => {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) bad(`${what} harus teks${allowEmpty ? '' : ' (wajib)'} maks ${max} karakter`);
  return (v as string).trim();
};
const KUNCI = /^\$sumber(?::[A-Za-z0-9_-]{1,40})?$/;
/** §26: footage per Video Iklan (the engine refuses more, see pipeline/gabung.py). */
export const MAKS_FOOTAGE_IKLAN = 20;
/** §26: the engine's joined footage (`out/gabungan.mp4`), imported as project media. */
export const KUNCI_GABUNGAN = '$gabungan:video';
const PLACEMENTS = ['tiktok', 'instagram', 'shopee', 'youtube'] as const;

/** Validate the browser's request (untrusted). */
export function validateEngineJob(x: unknown): EngineJobInput {
  const o = (x ?? {}) as Record<string, unknown>;
  if (o.mode === 'pisah') return validatePisahJob(o);
  if (o.mode === 'transfer') return validateTransferJob(o);
  if (o.mode === 'beatspot') return validateBeatspotJob(o);
  if (o.mode === 'outfit') return validateOutfitJob(o);
  if (o.mode === 'tts') return validateTtsJob(o);
  if (o.mode === 'visual') return validateVisualJob(o);
  if (o.mode === 'suara_profil') return validateSuaraProfilJob(o);
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'preset', 'brief', 'ai', 'mode_ops', 'batch', 'abaikan_cek_ucapan', 'audio_pilihan', 'overlay', 'penutup', 'vo'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (o.mode !== 'generate' && o.mode !== 'batch') bad('mode harus generate | batch');
  // §26: Video Iklan boleh beberapa footage (digabung mesin sesuai urutan daftar).
  if (!Array.isArray(o.sources) || o.sources.length > 50 || (o.mode === 'generate' && (o.sources.length < 1 || o.sources.length > MAKS_FOOTAGE_IKLAN))) bad(o.mode === 'generate' ? `Video iklan butuh 1–${MAKS_FOOTAGE_IKLAN} footage` : 'sumber maksimal 50');
  const sources = (o.sources as unknown[]).map((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const r = (so.ref ?? {}) as Record<string, unknown>;
    if (typeof so.kunci !== 'string' || !KUNCI.test(so.kunci)) bad(`sources[${i}].kunci harus $sumber atau $sumber:<id>`);
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`sources[${i}].ref tidak valid`);
    return { kunci: so.kunci as string, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
  });
  if (new Set(sources.map((s) => s.kunci)).size !== sources.length) bad('kunci sumber harus unik');
  // One video = `$sumber` (as before); several = `$sumber:<id>` each, in the order they are joined.
  if (o.mode === 'generate' && sources.length === 1 && sources[0]!.kunci !== '$sumber') bad('Generate Otomatis: kunci sumber harus $sumber');
  if (o.mode === 'generate' && sources.length > 1 && sources.some((s) => s.kunci === '$sumber')) bad('Video iklan dengan beberapa footage: kunci tiap footage harus $sumber:<id>');
  const preset = str(o.preset, 'preset', 60, false);
  if (!/^[a-z0-9-]+$/.test(preset)) bad('preset hanya huruf kecil, angka, tanda minus');
  const b = (o.brief ?? {}) as Record<string, unknown>;
  const bExtra = Object.keys(b).filter((k) => !['produk', 'varian', 'harga', 'placement', 'catatan', 'area_produk'].includes(k));
  if (bExtra.length) bad(`brief: field tidak dikenal ${bExtra.join(', ')}`);
  const placement = b.placement ?? 'tiktok';
  if (!PLACEMENTS.includes(placement as (typeof PLACEMENTS)[number])) bad(`placement harus ${PLACEMENTS.join(' | ')}`);
  if (b.area_produk !== undefined && !['bawah', 'atas', 'penuh'].includes(b.area_produk as string)) bad('area_produk harus bawah | atas | penuh');
  const brief: EngineBrief = {
    produk: str(b.produk ?? '', 'produk', 80),
    varian: str(b.varian ?? '', 'varian', 80),
    harga: str(b.harga ?? '', 'harga', 40),
    placement: placement as EngineBrief['placement'],
    catatan: str(b.catatan ?? '', 'catatan', 500),
    ...(b.area_produk ? { area_produk: b.area_produk as 'bawah' | 'atas' | 'penuh' } : {}),
  };
  if (typeof (o.ai ?? false) !== 'boolean') bad('ai harus true/false');
  if (o.mode_ops !== undefined && o.mode_ops !== 'kompat' && o.mode_ops !== 'u3') bad('mode_ops harus kompat | u3');
  if (o.abaikan_cek_ucapan !== undefined && (o.abaikan_cek_ucapan !== true || o.mode !== 'generate')) bad('abaikan_cek_ucapan hanya true, dan hanya untuk Generate');
  let batch: EngineJobInput['batch'];
  if (o.mode === 'batch') {
    const bo = (o.batch ?? {}) as Record<string, unknown>;
    const ok = ['batch', 'jumlah', 'tujuan', 'seed', 'izinkan_musik_tanpa_lisensi', 'akun_sendiri', 'hak_pakai_jelas', 'shot_tiktok', 'vo_batch', 'buang_otomatis', 'batas_durasi'];
    const be = Object.keys(bo).filter((k) => !ok.includes(k));
    if (be.length) bad(`batch: field tidak dikenal ${be.join(', ')}`);
    const name = str(bo.batch, 'nama batch', 80, false);
    if (!isBatchName(name)) bad('nama batch: mulai huruf/angka, lalu huruf, angka, _ . -');
    const jumlah = bo.jumlah;
    if (typeof jumlah !== 'number' || !Number.isInteger(jumlah) || jumlah < 1 || jumlah > 50) bad('jumlah varian 1–50');
    const tujuan = str(bo.tujuan ?? 'konversi', 'tujuan', 30, false);
    const bool = (k: string) => (bo[k] === undefined ? undefined : typeof bo[k] === 'boolean' ? (bo[k] as boolean) : bad(`batch.${k} harus true/false`));
    const akun = bo.akun_sendiri;
    if (akun !== undefined && (!Array.isArray(akun) || akun.length > 20 || !akun.every((a) => typeof a === 'string' && /^@?[A-Za-z0-9_.]{1,40}$/.test(a)))) bad('akun_sendiri harus daftar @akun');
    // Contract §8: VO taken from another batch (pictures stay from `batch`).
    const voBatch = bo.vo_batch === undefined || bo.vo_batch === '' ? undefined : str(bo.vo_batch, 'vo_batch', 80, false);
    if (voBatch !== undefined && !isBatchName(voBatch)) bad('vo_batch: mulai huruf/angka, lalu huruf, angka, _ . -');
    // Kinds of VO sentence the engine may drop by itself (superlatif, urgensi, live, musiman, …). Default [] = none.
    const buang = bo.buang_otomatis;
    if (buang !== undefined && (!Array.isArray(buang) || buang.length > 20 || !buang.every((a) => typeof a === 'string' && a.trim().length > 0 && a.length <= 60))) bad('buang_otomatis harus daftar alasan (maks 20, tiap alasan maks 60 karakter)');
    // [min, maks] seconds, or null = no limit (owner's decision; default).
    const batas = bo.batas_durasi;
    if (batas !== undefined && batas !== null && (!Array.isArray(batas) || batas.length !== 2 || !batas.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 600) || (batas[0] as number) > (batas[1] as number))) bad('batas_durasi harus [min, maks] detik (0–600, min ≤ maks) atau null');
    if (bo.seed !== undefined && (typeof bo.seed !== 'number' || !Number.isInteger(bo.seed) || bo.seed < 0)) bad('seed harus bilangan bulat ≥ 0');
    batch = {
      batch: name,
      jumlah: jumlah as number,
      tujuan,
      ...(bo.seed !== undefined ? { seed: bo.seed as number } : {}),
      ...(bool('izinkan_musik_tanpa_lisensi') !== undefined ? { izinkan_musik_tanpa_lisensi: bool('izinkan_musik_tanpa_lisensi')! } : {}),
      ...(akun !== undefined ? { akun_sendiri: akun as string[] } : {}),
      ...(bool('hak_pakai_jelas') !== undefined ? { hak_pakai_jelas: bool('hak_pakai_jelas')! } : {}),
      ...(bool('shot_tiktok') !== undefined ? { shot_tiktok: bool('shot_tiktok')! } : {}),
      ...(voBatch !== undefined && voBatch !== name ? { vo_batch: voBatch } : {}),
      ...(buang !== undefined ? { buang_otomatis: [...new Set((buang as string[]).map((a) => a.trim()))] } : {}),
      ...(batas !== undefined ? { batas_durasi: batas === null ? null : ([(batas as number[])[0], (batas as number[])[1]] as [number, number]) } : {}),
    };
  } else if (o.batch !== undefined) bad('batch hanya untuk mode batch');
  return { project_id: o.project_id as string, mode: o.mode as 'generate' | 'batch', sources, preset, brief, ai: (o.ai as boolean) ?? false, ...(o.mode_ops ? { mode_ops: o.mode_ops as 'kompat' | 'u3' } : {}), ...(batch ? { batch } : {}), ...(o.abaikan_cek_ucapan === true ? { abaikan_cek_ucapan: true as const } : {}), ...audioPilihan(o.audio_pilihan), ...(o.overlay !== undefined ? { overlay: validateJobOverlays(o.overlay) } : {}), ...(o.penutup !== undefined ? { penutup: validateJobPenutup(o.penutup) } : {}), ...(o.vo !== undefined && o.vo !== null ? { vo: validateJobVo(o.vo, o.audio_pilihan) } : {}) };
}

const PISAH_SRC = /^\$sumber:([A-Za-z0-9_-]{1,40})$/;

/** `engine pisah`: videos uploaded to the project → one batch in the engine's konten/. */
function validatePisahJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'pisah'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (!Array.isArray(o.sources) || o.sources.length < 1 || o.sources.length > 50) bad('Pisah Audio butuh 1–50 video');
  const sources = (o.sources as unknown[]).map((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const r = (so.ref ?? {}) as Record<string, unknown>;
    if (typeof so.kunci !== 'string' || !PISAH_SRC.test(so.kunci)) bad(`sources[${i}].kunci harus $sumber:<nama file>`);
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`sources[${i}].ref tidak valid`);
    return { kunci: so.kunci as string, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
  });
  // The id becomes a file name in the engine's folder: unique without case (Windows).
  if (new Set(sources.map((s) => s.kunci.toLowerCase())).size !== sources.length) bad('nama file sumber harus unik');
  if (new Set(sources.map((s) => s.ref.version_id)).size !== sources.length) bad('video yang sama dipilih dua kali');
  const po = (o.pisah ?? {}) as Record<string, unknown>;
  const pe = Object.keys(po).filter((k) => !['batch', 'video_saja'].includes(k));
  if (pe.length) bad(`pisah: field tidak dikenal ${pe.join(', ')}`);
  const name = str(po.batch, 'nama batch', 80, false);
  if (!isBatchName(name)) bad('nama batch: mulai huruf/angka, lalu huruf, angka, _ . -');
  if (po.video_saja !== undefined && typeof po.video_saja !== 'boolean') bad('pisah.video_saja harus true/false');
  return {
    project_id: o.project_id as string,
    mode: 'pisah',
    sources,
    preset: 'pisah',
    brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' },
    ai: false,
    pisah: { batch: name, ...(po.video_saja === true ? { video_saja: true } : {}) },
  };
}

/**
 * `engine transfer` (Motion Transfer tahap 1, contract §15): one reference video (any ratio, sound
 * optional) → scenes + best frame + copy-ready prompts. Product = a Brand Kit product name (the
 * engine falls back to the kit's first product); no AI API is called.
 */
function validateTransferJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'produk', 'deskripsi_produk'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (!Array.isArray(o.sources) || o.sources.length !== 1) bad('Motion Transfer butuh tepat satu video referensi');
  const so = ((o.sources as unknown[])[0] ?? {}) as Record<string, unknown>;
  const r = (so.ref ?? {}) as Record<string, unknown>;
  if (so.kunci !== '$sumber') bad('Motion Transfer: kunci sumber harus $sumber');
  if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad('sources[0].ref tidak valid');
  const produk = o.produk === undefined ? '' : str(o.produk, 'produk', 120);
  const deskripsi = o.deskripsi_produk === undefined ? '' : str(o.deskripsi_produk, 'deskripsi produk', 500);
  return {
    project_id: o.project_id as string,
    mode: 'transfer',
    sources: [{ kunci: '$sumber', ref: { media_id: r.media_id as string, version_id: r.version_id as string } }],
    preset: 'transfer',
    brief: { produk, varian: '', harga: '', placement: 'tiktok', catatan: '', ...(deskripsi ? { deskripsi_produk: deskripsi } : {}) },
    ai: false,
  };
}

const SHOT_ID = /^[A-Za-z0-9_-]{1,40}#\d{1,4}$/;
const FOOTAGE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Beat Spot settings from the browser (untrusted); `keys` = the job's `$sumber:<id>` keys. */
export function validateBeatspotSettings(x: unknown, keys: string[]): BeatspotSettings {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('beatspot harus objek');
  const extra = Object.keys(o).filter((k) => !['sound', 'bpm', 'ketukan_per_potong', 'durasi', 'tagline', 'urutan_shot', 'kecualikan_shot', 'sumber_orang', 'seed'].includes(k));
  if (extra.length) bad(`beatspot: field tidak dikenal ${extra.join(', ')}`);
  const sound = o.sound === undefined || o.sound === null ? null : typeof o.sound === 'string' && keys.includes(o.sound) ? o.sound : bad('beatspot.sound harus salah satu kunci sumber');
  const bpm = o.bpm === undefined || o.bpm === null ? null : typeof o.bpm === 'number' && o.bpm >= 60 && o.bpm <= 200 ? o.bpm : bad('beatspot.bpm harus 60–200');
  const kpp = o.ketukan_per_potong === undefined ? 'auto' : o.ketukan_per_potong === 'auto' || o.ketukan_per_potong === 1 || o.ketukan_per_potong === 2 || o.ketukan_per_potong === 4 ? o.ketukan_per_potong : bad('beatspot.ketukan_per_potong harus auto | 1 | 2 | 4');
  const dRaw: unknown = o.durasi === undefined ? [15, 20] : o.durasi;
  const d = (Array.isArray(dRaw) && dRaw.length === 2 && dRaw.every((n) => typeof n === 'number' && Number.isFinite(n)) ? dRaw : [0, 0]) as [number, number];
  if (!(5 <= d[0] && d[0] <= d[1] && d[1] <= 60)) bad('beatspot.durasi harus [min, maks] detik, 5–60');
  const tagline = o.tagline === undefined || o.tagline === null || o.tagline === '' ? null : str(o.tagline, 'tagline', 120) || null;
  const ids = (v: unknown, what: string, max: number): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max || !v.every((s) => typeof s === 'string' && SHOT_ID.test(s))) bad(`beatspot.${what} harus daftar id shot (<footage>#NN), maks ${max}`);
    return [...new Set(v as string[])];
  };
  const urutan = ids(o.urutan_shot, 'urutan_shot', 200);
  const kecuali = ids(o.kecualikan_shot, 'kecualikan_shot', 500);
  const so = o.sumber_orang === undefined ? {} : o.sumber_orang;
  if (typeof so !== 'object' || so === null || Array.isArray(so) || Object.keys(so).length > 500) bad('beatspot.sumber_orang harus objek (maks 500)');
  const orang: Record<string, 'kreator' | 'umum'> = {};
  for (const [k, v] of Object.entries(so as Record<string, unknown>)) {
    if (!(SHOT_ID.test(k) || FOOTAGE_ID.test(k)) || (v !== 'kreator' && v !== 'umum')) bad('beatspot.sumber_orang: { "<footage atau shot>": "kreator" | "umum" }');
    orang[k] = v as 'kreator' | 'umum';
  }
  const seed = o.seed === undefined ? 1 : Number.isInteger(o.seed) && (o.seed as number) >= 0 && (o.seed as number) < 2 ** 31 ? (o.seed as number) : bad('beatspot.seed harus bilangan bulat ≥ 0');
  return { sound, bpm, ketukan_per_potong: kpp as BeatspotSettings['ketukan_per_potong'], durasi: [d[0], d[1]] as [number, number], tagline, urutan_shot: urutan, kecualikan_shot: kecuali, sumber_orang: orang, seed };
}

/**
 * `engine beatspot` (contract §16): footage of people walking (several videos, `$sumber:<id>`)
 * + optionally the team's sound (video or audio) → cuts on the beat, logo + end card.
 */
function validateBeatspotJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'beatspot', 'preset', 'audio_pilihan', 'vo'].includes(k));
  // R18 §17: an optional Brand Kit preset (its beat defaults apply where the team set nothing).
  const preset = o.preset === undefined || o.preset === null || o.preset === '' ? 'beatspot' : typeof o.preset === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(o.preset) ? o.preset : bad('preset tidak valid');
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (!Array.isArray(o.sources) || o.sources.length < 1 || o.sources.length > 40) bad('Beat Spot butuh 1–40 file (footage + sound)');
  const sources = (o.sources as unknown[]).map((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const r = (so.ref ?? {}) as Record<string, unknown>;
    if (typeof so.kunci !== 'string' || !PISAH_SRC.test(so.kunci)) bad(`sources[${i}].kunci harus $sumber:<id>`);
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`sources[${i}].ref tidak valid`);
    return { kunci: so.kunci as string, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
  });
  if (new Set(sources.map((s) => s.kunci.toLowerCase())).size !== sources.length) bad('id sumber harus unik');
  if (new Set(sources.map((s) => s.ref.version_id)).size !== sources.length) bad('file yang sama dipilih dua kali');
  const beatspot = validateBeatspotSettings(o.beatspot ?? {}, sources.map((s) => s.kunci));
  if (beatspot.sound && sources.length < 2) bad('Beat Spot butuh minimal satu footage selain sound');
  return {
    project_id: o.project_id as string,
    mode: 'beatspot',
    sources,
    preset,
    ...audioPilihan(o.audio_pilihan),
    brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' },
    ai: false,
    beatspot,
    ...(o.vo !== undefined && o.vo !== null ? { vo: validateJobVo(o.vo, o.audio_pilihan) } : {}),
  };
}

/** §29 Beat Spot "Ganti Outfit": settings of one stage (siapkan → app makes the AI pictures → rakit). */
export interface OutfitSettings {
  tahap: 'siapkan' | 'rakit';
  /** `$sumber:<id>` of the template sound (beats are read from it). */
  sound: string;
  /** K6: AI outfit change only for the brand's own model / creator. Always true here. */
  model_sendiri: true;
  teks_atas: string | null;
  judul_akhir: string | null;
  sub_akhir: string | null;
  /** The team's look per footage: `"<produk>/<warna>"` per jenis; absent = automatic. */
  look: Record<string, { atasan?: string | null; bawahan?: string | null }>;
  /** Whose clothes change: the main person only, or everyone walking together (default: automatic). */
  target: Record<string, 'utama' | 'semua'>;
  seed: number;
  /** Tahap rakit: the siapkan job of the same project whose pictures are assembled. */
  siapkan_job?: string;
}
export const OUTFIT_MAKS_FOOTAGE = 5;
const KATALOG_KEY = /^[a-z0-9][a-z0-9_-]{0,39}\/[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateOutfitSettings(x: unknown, keys: string[]): OutfitSettings {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('outfit harus objek');
  const extra = Object.keys(o).filter((k) => !['tahap', 'sound', 'model_sendiri', 'teks_atas', 'judul_akhir', 'sub_akhir', 'look', 'target', 'seed', 'siapkan_job'].includes(k));
  if (extra.length) bad(`outfit: field tidak dikenal ${extra.join(', ')}`);
  const tahap = o.tahap === undefined ? 'siapkan' : o.tahap === 'siapkan' || o.tahap === 'rakit' ? o.tahap : bad('outfit.tahap harus siapkan | rakit');
  if (typeof o.sound !== 'string' || !keys.includes(o.sound)) bad('Sound template wajib dipilih');
  if (o.model_sendiri !== true) bad('AI ganti pakaian hanya untuk footage model/kreator sendiri: centang "model sendiri"');
  const opt = (v: unknown, what: string, max: number) => (v === undefined || v === null || v === '' ? null : str(v, what, max) || null);
  const fids = new Set(keys.filter((k) => k !== o.sound).map((k) => k.slice(8)));
  function per<T>(v: unknown, what: string, one: (x: unknown, fid: string) => T): Record<string, T> {
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`outfit.${what} harus objek per footage`);
    const out: Record<string, T> = {};
    for (const [fid, val] of Object.entries(v as Record<string, unknown>)) {
      if (!fids.has(fid)) bad(`outfit.${what}: footage ${fid} tidak ada`);
      out[fid] = one(val, fid);
    }
    return out;
  }
  const look = per(o.look, 'look', (v, fid) => {
    const lv = (v ?? {}) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Object.keys(lv).some((k) => k !== 'atasan' && k !== 'bawahan')) bad(`outfit.look.${fid} harus { atasan, bawahan }`);
    const one = (k: 'atasan' | 'bawahan') =>
      lv[k] === undefined ? {} : lv[k] === null ? { [k]: null } : typeof lv[k] === 'string' && KATALOG_KEY.test(lv[k] as string) ? { [k]: lv[k] as string } : bad(`outfit.look.${fid}.${k} harus "<produk>/<warna>" atau null`);
    const r = { ...one('atasan'), ...one('bawahan') } as { atasan?: string | null; bawahan?: string | null };
    if (r.atasan === null && r.bawahan === null) bad(`outfit.look.${fid}: pilih atasan atau bawahan`);
    return r;
  });
  const target = per(o.target, 'target', (v, fid) => (v === 'utama' || v === 'semua' ? v : bad(`outfit.target.${fid} harus utama | semua`)));
  const seed = o.seed === undefined ? 1 : Number.isInteger(o.seed) && (o.seed as number) >= 0 && (o.seed as number) < 2 ** 31 ? (o.seed as number) : bad('outfit.seed harus bilangan bulat ≥ 0');
  const siapkan_job = tahap === 'rakit' ? (isJobId(o.siapkan_job) ? (o.siapkan_job as string) : bad('outfit.siapkan_job wajib untuk tahap rakit')) : undefined;
  return { tahap, sound: o.sound as string, model_sendiri: true, teks_atas: opt(o.teks_atas, 'teks_atas', 120), judul_akhir: opt(o.judul_akhir, 'judul_akhir', 60), sub_akhir: opt(o.sub_akhir, 'sub_akhir', 90), look, target, seed, ...(siapkan_job ? { siapkan_job } : {}) };
}

/** `engine outfit` (contract §29): 1–5 footage of the brand's own model + the template sound. */
function validateOutfitJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'outfit'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (!Array.isArray(o.sources) || o.sources.length < 2 || o.sources.length > OUTFIT_MAKS_FOOTAGE + 1) bad(`Ganti Outfit butuh 1–${OUTFIT_MAKS_FOOTAGE} footage + 1 sound template`);
  const sources = (o.sources as unknown[]).map((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const r = (so.ref ?? {}) as Record<string, unknown>;
    if (typeof so.kunci !== 'string' || !PISAH_SRC.test(so.kunci)) bad(`sources[${i}].kunci harus $sumber:<id>`);
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`sources[${i}].ref tidak valid`);
    return { kunci: so.kunci as string, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
  });
  if (new Set(sources.map((s) => s.kunci.toLowerCase())).size !== sources.length) bad('id sumber harus unik');
  if (new Set(sources.map((s) => s.ref.version_id)).size !== sources.length) bad('file yang sama dipilih dua kali');
  const outfit = validateOutfitSettings(o.outfit ?? {}, sources.map((s) => s.kunci));
  return { project_id: o.project_id as string, mode: 'outfit', sources, preset: 'beatspot', brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' }, ai: false, outfit };
}

// ------------------------------------------------------------------ job folder

export const engineRel = (projectId: string, jobId?: string) => `${projectRel(projectId)}/${ENGINE_DIR}${jobId ? `/${jobId}` : ''}`;
const JOB_ID = /^[A-Z0-9]{2,5}-\d{8}-\d{3}$/;
export const isJobId = (x: unknown): x is string => typeof x === 'string' && JOB_ID.test(x);

/** Absolute folder of one engine job (ids checked, inside the workspace). */
export const engineJobDir = (ws: Workspace, projectId: string, jobId: string): string => jobAbs(ws, projectId, jobId);

function jobAbs(ws: Workspace, projectId: string, jobId?: string): string {
  if (!isSafeId(projectId)) bad('project_id tidak valid');
  if (jobId !== undefined && !isJobId(jobId)) throw new StorageError('NOT_FOUND', 'Job mesin tidak ditemukan', { job_id: jobId });
  const abs = path.join(ws.root, ...engineRel(projectId, jobId).split('/'));
  if (!isInside(ws.root, abs)) bad('path job di luar workspace');
  return abs;
}

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('PRECONDITION', `File mesin tidak bisa dibaca: ${path.basename(file)}`, { file: path.basename(file) });
  }
};

export async function readEngineStatus(ws: Workspace, projectId: string, jobId: string): Promise<EngineStatus> {
  const s = await readJson<EngineStatus>(path.join(jobAbs(ws, projectId, jobId), 'status.json'));
  if (!s || s.schema !== 'engine-status/1') throw new StorageError('NOT_FOUND', 'Job mesin tidak ditemukan', { job_id: jobId });
  return s;
}
const writeStatus = (ws: Workspace, s: EngineStatus) => writeJsonAtomic(path.join(jobAbs(ws, s.project_id, s.job_id), 'status.json'), s);

export async function listEngineJobs(ws: Workspace, projectId: string): Promise<EngineStatus[]> {
  const dir = jobAbs(ws, projectId);
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out: EngineStatus[] = [];
  for (const n of names.filter(isJobId).sort().reverse()) out.push(await readEngineStatus(ws, projectId, n).catch(() => null as never));
  return out.filter(Boolean);
}

/** Absolute local path of a media version (read-only for the engine). */
async function localPath(ws: Workspace, ref: MediaRef): Promise<string> {
  return withSourceFile(ws, ref, async (abs) => abs);
}
/** Run `fn` with the local file of an ACTIVE media version (the file only lives during `fn`). */
async function withSourceFile<T>(ws: Workspace, ref: MediaRef, fn: (abs: string) => Promise<T>): Promise<T> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[ref.version_id];
  if (!v || v.media_id !== ref.media_id || v.lifecycle !== 'active') throw new StorageError('PRECONDITION', 'Video sumber tidak aktif (di Trash atau tidak dikenal)', { ...ref });
  return ws.blobs.withLocalFile(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS), fn);
}

/** Brand placeholders in the export (`$logo`, `$sfx:pop-01`, …) → the kit's MediaRefs. */
export function brandPlaceholders(kit: BrandKit): Record<string, MediaRef> {
  const out: Record<string, MediaRef> = {};
  const slot: Record<string, string> = { font: '$font:judul', font_caption: '$font:caption', logo: '$logo', logo_light: '$logo:terang', outro: '$penutup' };
  for (const r of brandReferences(kit)) if (slot[r.slot]) out[slot[r.slot]!] = r.ref;
  for (const a of kit.aset) {
    out[`$${a.jenis}:${a.id}`] = a.ref;
    out[assetKunci(a)] = a.ref; // R26: overlay kinds travel as `$lainnya:id`
  }
  return out;
}

/**
 * Prepare a job: job folder + job.json + brand_kit.json (with local paths) + refs.json, and a lease
 * on the sources. Nothing runs yet (status `menunggu`).
 */

/**
 * R30: words the editors corrected in earlier subtitles of this brand become Whisper fixes for the
 * next job (`teks.kamus`). Only safe pairs (`otomatis`); the Brand Kit dictionary always wins.
 * Never fails the job: learning is a bonus.
 */
async function addLearnedKamus(ws: Workspace, kit: BrandKit, brandExport: Record<string, unknown>): Promise<void> {
  try {
    const teks = brandExport.teks as { kamus?: Record<string, string> } | undefined;
    if (!teks || !kit.brand_id) return;
    const pasangan = learnedFor(kit, await readLearning(ws, kit.brand_id));
    const kamus = { ...(teks.kamus ?? {}) };
    for (const p of pasangan) if (p.otomatis && !(p.salah in kamus)) kamus[p.salah] = p.benar;
    teks.kamus = kamus;
  } catch {
    /* learning must never break a job */
  }
}

/** R36: what a brand learned from editor corrections, minus the pairs the team chose to ignore. */
function learnedFor(kit: BrandKit, notes: readonly Record<string, unknown>[]): PasanganKamus[] {
  const abaikan = new Set((kit.kamus_abaikan ?? []).map((w) => w.toLowerCase()));
  return kamusBelajar(notes, [kit.name, ...kit.kosakata, ...kit.kata_kunci], kit.kamus).filter((p) => !abaikan.has(p.salah.toLowerCase()));
}

/**
 * R36 Brand "Dipelajari dari koreksi editor": learned pairs (`otomatis` = used in the next job,
 * else `usulan`) and the ignored wrong words. Pairs already in the Brand Kit dictionary are not listed.
 */
export async function readKamusBelajar(ws: Workspace, brandId: string): Promise<{ pasangan: PasanganKamus[]; abaikan: string[] }> {
  const kit = await readBrand(ws, brandId);
  return { pasangan: learnedFor(kit, await readLearning(ws, kit.brand_id)), abaikan: kit.kamus_abaikan };
}

/**
 * R35: job.json `visual` — the source path as `masuk`; for reframe the detection job's path file
 * (same project, finished) as `jalur`.
 */
async function visualJob(ws: Workspace, input: EngineJobInput, masuk: string | undefined): Promise<Record<string, unknown>> {
  const { jalur_job, ...rest } = input.visual!;
  if (rest.alat !== 'reframe') return { ...rest, masuk };
  const src = await readEngineStatus(ws, input.project_id, String(jalur_job));
  if (src.mode !== 'visual' || src.state !== 'siap') bad('Deteksi wajah/subjek untuk klip ini belum selesai');
  const file = path.join(jobAbs(ws, input.project_id, String(jalur_job)), 'out', 'jalur.json');
  if (!(await fsp.stat(file).catch(() => null))) bad('Hasil deteksi tidak ditemukan');
  return { ...rest, jalur: file.replace(/\\/g, '/'), masuk };
}

export async function prepareEngineJob(ws: Workspace, input: EngineJobInput, opts: { now?: number; actor?: 'user' } = {}): Promise<EngineStatus> {
  const project = await readProject(ws, input.project_id);
  const kit = await readBrandFor(ws, project.brand_id);
  if (!kit.kode) throw new StorageError('PRECONDITION', 'Brand proyek belum punya kode (Brand Kit → A)');
  // R37: the VO must be a brand asset with its index (checked before any job folder exists).
  const voFiles = input.vo ? await jobVoFiles(ws, kit, input.vo) : null;
  const now = opts.now ?? ws.clock.now();
  const day = localDate(now).replace(/-/g, '');
  const dir = jobAbs(ws, input.project_id);
  await fsp.mkdir(dir, { recursive: true });
  // R4 (G4): one number sequence per BRAND per DAY over ALL projects (AYS-20261114-007), not per
  // project. Taken = every project's job folders + the claims; an exclusive claim file is the lock,
  // so two projects starting at once never get the same number. Old job ids are left as they are.
  const prefix = `${kit.kode}-${day}-`;
  const claims = path.join(ws.root, LAYOUT.meta, ENGINE_ID_CLAIMS);
  await fsp.mkdir(claims, { recursive: true });
  const taken = new Set((await fsp.readdir(claims)).filter((n) => n.startsWith(prefix) && isJobId(n)));
  for (const pid of await listProjectIds(ws).catch(() => [] as string[])) {
    const names = await fsp.readdir(jobAbs(ws, pid)).catch(() => [] as string[]);
    for (const n of names) if (n.startsWith(prefix) && isJobId(n)) taken.add(n);
  }
  let n = 1;
  let job_id = '';
  let jdir = '';
  for (;;) {
    while (taken.has(`${prefix}${String(n).padStart(3, '0')}`)) n++;
    if (n > 999) throw new StorageError('PRECONDITION', 'Terlalu banyak job hari ini untuk brand ini (maks 999)');
    job_id = `${prefix}${String(n).padStart(3, '0')}`;
    try {
      await fsp.writeFile(path.join(claims, job_id), input.project_id, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      taken.add(job_id); // another request (any project) took it a moment ago
      continue;
    }
    jdir = jobAbs(ws, input.project_id, job_id);
    try {
      await fsp.mkdir(jdir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      taken.add(job_id);
    }
  }
  let lease: { lease_id: string } | null = null;
  try {
    const sumber = [];
    if (input.mode === 'pisah') {
      // Pinned BEFORE the copy (up to 50 big videos): Auto Trash never moves a source mid-copy.
      lease = await createLease(ws, { job: 'engine', label: `Mesin ${job_id}`, media: input.sources.map((s) => s.ref), actor: opts.actor ?? 'user', worker_pid: process.pid });
      // The engine reads uploads from <job>/masuk/ (contract: it copies them into konten/ itself).
      const masuk = path.join(jdir, 'masuk');
      await fsp.mkdir(masuk);
      for (const s of input.sources) {
        const dest = await withSourceFile(ws, s.ref, async (abs) => {
          const ext = path.extname(abs).toLowerCase();
          if (ext !== '.mp4' && ext !== '.mov') bad(`${s.kunci.slice(8)}: Pisah Audio hanya untuk video .mp4 / .mov`);
          const d = path.join(masuk, `${s.kunci.slice(8)}${ext}`);
          await fsp.copyFile(abs, d);
          return d;
        });
        sumber.push({ kunci: s.kunci, path: dest.replace(/\\/g, '/') });
      }
    } else for (const s of input.sources) sumber.push({ kunci: s.kunci, path: (await localPath(ws, s.ref)).replace(/\\/g, '/') });
    // R37 §22.1: Generate also lists the VO file in `sumber` (the engine validates the index against it).
    if (input.vo && voFiles && input.mode === 'generate') sumber.push({ kunci: `$vo:${input.vo.aset}`, path: (await localPath(ws, voFiles.ref)).replace(/\\/g, '/') });
    // §29 tahap rakit: the siapkan job (same project, finished) whose pictures are assembled.
    const outfitSiapkan = input.outfit?.tahap === 'rakit' ? await outfitSiapkanDir(ws, input.project_id, input.outfit.siapkan_job!) : null;
    if (input.outfit?.tahap === 'siapkan') await writeJsonAtomic(path.join(jdir, 'katalog.json'), await katalogUntukMesin(ws, kit.brand_id, (r) => localPath(ws, r)));
    const brandExport = await exportBrandKit(ws, kit.brand_id, { paths: true });
    await addLearnedKamus(ws, kit, brandExport);
    const penutupRefs: Record<string, MediaRef> = {};
    if (input.penutup !== undefined) await applyJobPenutup(ws, brandExport, penutupRefs, input.penutup);
    await writeJsonAtomic(path.join(jdir, 'brand_kit.json'), brandExport);
    const job = {
      schema: 'engine-job/1',
      job_id,
      mode: input.mode,
      sumber,
      brand_kit: 'brand_kit.json',
      preset: input.preset,
      brief: input.brief,
      ai: input.ai,
      ...(input.mode_ops ? { mode_ops: input.mode_ops } : {}),
      ...(input.abaikan_cek_ucapan ? { abaikan_cek_ucapan: true } : {}),
      ...(input.batch ?? {}),
      ...(input.pisah ?? {}),
      ...(input.audio_pilihan ? { audio_pilihan: input.audio_pilihan } : {}),
      // "auto" / empty BPM are left out, so a chosen preset's beat defaults can apply (§17.5).
      ...(input.tts ? { tts: input.tts } : {}),
      ...(input.suara_profil ? { suara_profil: input.suara_profil } : {}),
      ...(input.visual ? { visual: await visualJob(ws, input, sumber[0]?.path) } : {}),
      ...(input.vo ? { vo: { media: `$vo:${input.vo.aset}`, index: 'vo_index.json', suara_footage: input.vo.suara_footage, subtitle: input.vo.subtitle } } : {}),
      ...(input.outfit
        ? {
            ...(input.outfit.tahap === 'siapkan' ? { katalog: 'katalog.json' } : {}),
            outfit: { ...Object.fromEntries(Object.entries(input.outfit).filter(([k]) => k !== 'siapkan_job')), ...(outfitSiapkan ? { siapkan: outfitSiapkan.replace(/\\/g, '/') } : {}) },
          }
        : {}),
      ...(input.beatspot ? { beatspot: Object.fromEntries(Object.entries(input.beatspot).filter(([k, v]) => !((k === 'ketukan_per_potong' && v === 'auto') || (k === 'bpm' && v === null)))) } : {}),
    };
    await writeJsonAtomic(path.join(jdir, 'job.json'), job);
    // R37: the engine never reads .motionstudio — the VO index travels inside the job folder.
    if (voFiles) await writeJsonAtomic(path.join(jdir, 'vo_index.json'), voFiles.index);
    // R26: overlays stay with the app (the engine never sees them); added when the draft is opened.
    if (input.overlay?.length) {
      const reg = await loadRegistry(ws);
      for (const o of input.overlay) {
        const v = reg.versions[o.ref.version_id];
        if (!v || v.media_id !== o.ref.media_id || v.lifecycle !== 'active') bad('Gambar overlay tidak dikenal atau sedang di Trash');
      }
      await writeJsonAtomic(path.join(jdir, 'overlay.json'), { schema: 'ms-overlay/1', overlay: input.overlay });
    }
    const refs: Record<string, MediaRef> = { ...brandPlaceholders(kit) };
    // R38a: files other brands share with every brand are in brand_kit.json too.
    for (const a of (await sharedLibrary(ws, kit)).aset) {
      refs[`$${a.jenis}:${a.id}`] ??= a.ref;
      refs[assetKunci(a)] ??= a.ref;
    }
    // R28: this job's end card replaces the brand default (or removes it).
    if (input.penutup !== undefined) {
      delete refs.$penutup;
      Object.assign(refs, penutupRefs);
    }
    for (const s of input.sources) refs[s.kunci] = s.ref;
    await writeJsonAtomic(path.join(jdir, 'refs.json'), { schema: 'engine-refs/1', brand_id: kit.brand_id, refs });
    // §26: the same footage may appear twice in a Video Iklan; one pin per version is enough.
    const pinned = [...new Map(input.sources.map((s) => [s.ref.version_id, s.ref])).values()];
    lease ??= await createLease(ws, { job: 'engine', label: `Mesin ${job_id}`, media: pinned, actor: opts.actor ?? 'user', worker_pid: process.pid });
    const status: EngineStatus = { schema: 'engine-status/1', job_id, project_id: input.project_id, mode: input.mode, state: 'menunggu', tahap: 'antre', persen: 0, pesan: '', created_at: now, started_at: null, finished_at: null, exit_code: null, alasan: null, lease_id: lease.lease_id };
    await writeStatus(ws, status);
    await audit(ws, { op: 'engine.prepare', actor: opts.actor ?? 'user', outcome: 'ok', project_id: input.project_id, job_id, mode: input.mode, sources: input.sources.length });
    return status;
  } catch (e) {
    // Checkpoint I M4: nothing may stay pinned by a job that does not exist.
    if (lease) await releaseLease(ws, { lease_id: lease.lease_id, outcome: 'failed', actor: opts.actor ?? 'user' }).catch(() => undefined);
    await fsp.rm(jdir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Remove a Pisah Audio job's copies of the uploads. On Windows a just-killed Demucs / FFmpeg may
 * still hold a file for a moment (taskkill is async), so retry a few times.
 */
async function removeMasuk(jdir: string): Promise<void> {
  await fsp.rm(path.join(jdir, 'masuk'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
}

/** Stop the engine AND its children (Whisper, FFmpeg): on Windows `kill()` only ends the parent. */
export function killTree(child: { pid?: number | undefined; kill: () => boolean }): void {
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
  else child.kill();
}

/**
 * The engine's environment: only what Python / Whisper / FFmpeg need. Never the server's secrets
 * (MOTION_SECRET_KEY, Google client secret, …) — Checkpoint I M3.
 */
/** The engine's code folder (R20): `code`, or `root` when code and data are one folder. */
export const engineCode = (cfg: EngineConfig): string => cfg.code ?? cfg.root;

/**
 * This app's built storage core (packages/core/dist): the engine imports timeline.js from it, so a
 * released app is checked by its own core, never by a working copy (R20).
 */
export const MOTION_STUDIO_CORE = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/core/dist/storage (or src/storage in tests)
  const pkg = path.resolve(here, '..');
  return path.basename(pkg) === 'src' ? path.join(path.dirname(pkg), 'dist') : pkg;
})();

/**
 * The engine's environment: only what Python / FFmpeg / Whisper need (no app secrets), plus — with a
 * config — where its data is (MOTION_ENGINE_DATA) and which app core to use (MOTION_STUDIO_CORE).
 */
export function engineEnv(env: NodeJS.ProcessEnv = process.env, cfg?: EngineConfig | null): NodeJS.ProcessEnv {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|CUDA_VISIBLE_DEVICES|PYTHON[A-Z_]*|VIRTUAL_ENV|HF_HOME|XDG_CACHE_HOME)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) && v !== undefined) out[k] = v;
  return { ...out, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(cfg ? { MOTION_ENGINE_DATA: cfg.root, MOTION_STUDIO_CORE } : {}) };
}

/** Spawn seam for tests. */
export type Spawner = typeof spawn;

/**
 * Run the engine CLI for a prepared job. Progress lines update status.json; the lease is released
 * whatever happens. Resolves with the final status (never throws for engine failures).
 */
export async function runEngineJob(
  ws: Workspace,
  cfg: EngineConfig,
  projectId: string,
  jobId: string,
  opts: { mode?: EngineMode; signal?: AbortSignal; onProgress?: (s: EngineStatus) => void; spawnImpl?: Spawner } = {},
): Promise<EngineStatus> {
  let s = await readEngineStatus(ws, projectId, jobId);
  const jdir = jobAbs(ws, projectId, jobId);
  const mode = opts.mode ?? s.mode;
  // Checkpoint I H1: only a waiting job (with its lease) may start; a settled one never runs leaseless.
  if (s.state !== 'menunggu' || !s.lease_id) throw new StorageError('PRECONDITION', `Job ${jobId} tidak menunggu (${s.state}); jalankan job baru`);
  if (mode === 'ulang' && !(await fsp.stat(path.join(jdir, 'koreksi.json')).catch(() => null))) bad('koreksi.json belum ada');
  s = { ...s, state: 'berjalan', tahap: 'mulai', persen: 0, pesan: '', started_at: ws.clock.now(), finished_at: null, exit_code: null, alasan: null };
  await writeStatus(ws, s);
  if (s.lease_id) await setLeaseStatus(ws, { lease_id: s.lease_id, status: 'running', actor: 'user' }).catch(() => undefined);
  opts.onProgress?.(s);
  let log = '';
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve(); // progress writes in order, finished before the final one
  let code = await new Promise<number>((resolve) => {
    if (opts.signal?.aborted) {
      log += '[Motion Studio] dibatalkan sebelum mesin mulai';
      resolve(1);
      return;
    }
    let child: ReturnType<Spawner>;
    try {
      child = (opts.spawnImpl ?? spawn)(cfg.command, [cfg.script, mode, jdir], { cwd: cfg.root, windowsHide: true, env: engineEnv(process.env, cfg) });
      lowerPriority(child); // Whisper / Demucs / FFmpeg children inherit it
    } catch (e) {
      log += `tidak bisa menjalankan mesin: ${String(e)}`;
      resolve(1);
      return;
    }
    const timer = setTimeout(() => {
      log += `\n[Motion Studio] mesin dihentikan setelah ${Math.round(cfg.timeout_ms / 60000)} menit`;
      killTree(child);
    }, cfg.timeout_ms);
    const onAbort = () => {
      log += '\n[Motion Studio] dibatalkan';
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort(); // cancelled between the check above and the listener
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line) as { tahap?: unknown; persen?: unknown; pesan?: unknown };
          if (typeof p.tahap === 'string') s.tahap = p.tahap.slice(0, 40);
          if (typeof p.persen === 'number' && Number.isFinite(p.persen)) s.persen = Math.max(0, Math.min(100, Math.round(p.persen)));
          if (typeof p.pesan === 'string') s.pesan = p.pesan.slice(0, 200);
          opts.onProgress?.({ ...s });
          const t = Date.now();
          if (t - lastWrite > 500) {
            lastWrite = t;
            const snap = { ...s };
            writing = writing.then(() => writeStatus(ws, snap)).catch(() => undefined);
          }
        } catch {
          log = (log + line + '\n').slice(-MAX_ENGINE_LOG); // not JSON: keep as log
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      log = (log + chunk).slice(-MAX_ENGINE_LOG);
    });
    child.on('error', (e) => {
      log += `\n${String(e)}`;
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(typeof c === 'number' ? c : 1);
    });
  });
  await writing;
  await fsp.writeFile(path.join(jdir, 'engine.log'), log, 'utf8').catch(() => undefined);
  // The copies in masuk/ were for the engine only (it keeps its own in konten/1-upload).
  if (mode === 'pisah') await removeMasuk(jdir);
  // R35: a visual job's result depends on its tool.
  const alat = mode === 'visual' ? ((await readJson<{ visual?: { alat?: VisualTool } }>(path.join(jdir, 'job.json')))?.visual?.alat ?? 'deteksi') : null;
  const resultFile = mode === 'pisah' ? 'pisah.json' : mode === 'tts' ? 'tts.json' : mode === 'visual' ? 'visual.json' : mode === 'suara_profil' ? 'suara_profil.json' : 'rencana.json';
  const rencana = await readJson<{ status?: string; alasan?: string }>(path.join(jdir, 'out', resultFile)).catch(() => null);
  if (code === 0 && rencana?.status === 'ditolak') code = 2; // contract §5.1: the plan itself says refused
  // The log tail can hold local paths (D:\...): never shown to the browser as is.
  const tail = scrubPaths(log.trim().split('\n').slice(-3).join(' · ')).slice(0, 300);
  if (code === 0) {
    const outfitTahap = mode === 'outfit' ? ((await readJson<{ outfit?: { tahap?: string } }>(path.join(jdir, 'job.json')))?.outfit?.tahap ?? 'siapkan') : null;
    const need = outfitTahap ? (outfitTahap === 'siapkan' ? 'outfit.json' : 'ops.json') : mode === 'batch' ? 'batch.json' : mode === 'pisah' ? 'pisah.json' : mode === 'transfer' ? 'transfer.json' : mode === 'tts' ? 'tts.json' : mode === 'suara_profil' ? 'suara_profil.json' : alat ? VISUAL_RESULT[alat] : 'ops.json';
    const okFiles = await fsp.stat(path.join(jdir, 'out', need)).catch(() => null);
    s = okFiles
      ? { ...s, state: 'siap', tahap: 'selesai', persen: 100, ...(rencana?.status === 'perlu_keputusan' ? { pesan: 'Perlu keputusan tim (lihat kartu rencana)' } : {}) }
      : { ...s, state: 'gagal', alasan: `Mesin selesai tanpa ${need}` };
  } else if (code === 2) s = { ...s, state: 'ditolak', alasan: scrubPaths(typeof rencana?.alasan === 'string' ? rencana.alasan : 'Input ditolak mesin').slice(0, 300) };
  // Contract v0.3.2a: on a technical failure the result file may say why (`status: "gagal"`).
  else s = { ...s, state: 'gagal', alasan: (rencana?.status === 'gagal' && typeof rencana.alasan === 'string' && rencana.alasan.trim() ? scrubPaths(rencana.alasan) : tail || `Mesin gagal (kode ${code})`).slice(0, 300) };
  s = { ...s, exit_code: code, finished_at: ws.clock.now() };
  if (s.lease_id) {
    await releaseLease(ws, { lease_id: s.lease_id, outcome: s.state === 'siap' ? 'completed' : 'failed', actor: 'user' }).catch(() => undefined);
    s.lease_id = null;
  }
  await writeStatus(ws, s);
  await audit(ws, { op: 'engine.run', actor: 'user', outcome: s.state === 'siap' ? 'ok' : s.state === 'ditolak' ? 'blocked' : 'error', project_id: projectId, job_id: jobId, mode, exit_code: code });
  opts.onProgress?.(s);
  return s;
}

/** R1: the engine refused this Generate job only because the audio sounded like a song. */
export function lyricRefusal(s: Pick<EngineStatus, 'mode' | 'state' | 'alasan'>): boolean {
  return s.mode === 'generate' && s.state === 'ditolak' && /tetap lanjut/i.test(s.alasan ?? '');
}

/**
 * R1 (hybrid): "Tetap lanjut" — a NEW Generate job with the same video, preset and brief as the
 * refused one, telling the engine to skip its song check (`abaikan_cek_ucapan`). The refused job
 * stays as it was (its history).
 */
export async function continueRefusedJob(ws: Workspace, projectId: string, jobId: string, opts: { now?: number; actor?: 'user' } = {}): Promise<EngineStatus> {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (!lyricRefusal(s)) bad('"Tetap lanjut" hanya untuk Generate yang ditolak karena audio terdengar seperti lagu');
  const jdir = jobAbs(ws, projectId, jobId);
  const job = await readJson<{ preset?: unknown; brief?: unknown; ai?: unknown; mode_ops?: unknown; audio_pilihan?: unknown; sumber?: { kunci?: unknown }[] }>(path.join(jdir, 'job.json'));
  const refs = (await readJson<{ refs?: Record<string, MediaRef> }>(path.join(jdir, 'refs.json')))?.refs ?? {};
  // §26: the same footage in the same order (job.json `sumber` keeps the order; `$vo:` is not footage).
  const kunci = (job?.sumber ?? []).map((s) => s?.kunci).filter((k): k is string => typeof k === 'string' && KUNCI.test(k));
  const sources = kunci.map((k) => ({ kunci: k, ref: refs[k] }));
  if (!job || !sources.length || sources.some((s) => !s.ref)) throw new StorageError('PRECONDITION', 'Job lama tidak lengkap; jalankan Generate baru dari awal');
  const input = validateEngineJob({
    project_id: projectId,
    mode: 'generate',
    sources,
    preset: job.preset,
    brief: job.brief,
    ai: job.ai === true,
    ...(job.mode_ops === 'kompat' || job.mode_ops === 'u3' ? { mode_ops: job.mode_ops } : {}),
    ...(typeof job.audio_pilihan === 'string' ? { audio_pilihan: job.audio_pilihan } : {}),
    abaikan_cek_ucapan: true,
  });
  return prepareEngineJob(ws, input, opts);
}

/** A job left `berjalan` / `menunggu` by a server that stopped: mark it failed, free its lease. */
export async function settleOrphanJob(ws: Workspace, s: EngineStatus, alasan = 'Terhenti (server dimulai ulang); jalankan lagi'): Promise<EngineStatus> {
  if (s.state !== 'berjalan' && s.state !== 'menunggu') return s;
  if (s.lease_id) await releaseLease(ws, { lease_id: s.lease_id, outcome: 'failed', actor: 'user' }).catch(() => undefined);
  // A Pisah Audio job never run (cancelled in the queue / server restart): drop its copies of the uploads.
  if (s.mode === 'pisah') await removeMasuk(jobAbs(ws, s.project_id, s.job_id));
  const out: EngineStatus = { ...s, state: 'gagal', alasan, lease_id: null, finished_at: ws.clock.now() };
  await writeStatus(ws, out);
  return out;
}

// ------------------------------------------------------------------ reading the plan back

export interface EnginePlan {
  ops: unknown[];
  rencana: Record<string, unknown>;
  /** `qc_rencana.json` (contract §5.4): the engine's own checks of the plan, shown on the card. */
  qc: { butir: { butir: string; lulus: boolean; nilai?: unknown }[] } | null;
  /** Media imported from the engine's own `aset_lokal` while resolving. */
  imported: string[];
}

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|wav|mp3|m4a|aac|ogg|opus|flac|png|jpe?g|webp)$/i;

/**
 * Paths the engine may hand us to import: real media files inside its own repo, nothing else
 * (no symlink out of it, no `.env` or code — Checkpoint I L1).
 */
async function assertEnginePath(cfg: EngineConfig | null, p: string): Promise<string> {
  if (!cfg) throw new StorageError('PRECONDITION', 'Mesin belum dipasang (MOTION_ENGINE_ROOT); aset_lokal tidak bisa diimpor');
  const abs = path.resolve(cfg.root, p);
  const real = await fsp.realpath(abs).catch(() => null);
  const rootReal = await fsp.realpath(cfg.root).catch(() => cfg.root);
  if (!real || !isInside(rootReal, real)) throw new StorageError('PRECONDITION', 'aset_lokal di luar folder mesin ditolak', { path: path.basename(abs) });
  if (!MEDIA_EXT.test(real)) throw new StorageError('PRECONDITION', 'aset_lokal harus file media (video/audio/gambar)', { path: path.basename(abs) });
  return real;
}

/** §26: `out/gabungan.mp4` of THIS job only (no symlink out of it, video only). */
async function assertJobOutPath(jdir: string, p: string): Promise<string> {
  const out = await fsp.realpath(path.join(jdir, 'out')).catch(() => null);
  const real = await fsp.realpath(path.resolve(jdir, p)).catch(() => null);
  if (!out || !real || !isInside(out, real) || !/\.mp4$/i.test(real)) throw new StorageError('PRECONDITION', 'Video gabungan harus di folder out job ini', { path: path.basename(p) });
  return real;
}

/** §29: a Ganti Outfit file of THIS job (`out/outfit/*.mp4|png`, no symlink out of it). */
async function assertJobOutfitPath(jdir: string, p: string): Promise<string> {
  const out = await fsp.realpath(path.join(jdir, 'out', 'outfit')).catch(() => null);
  const real = await fsp.realpath(path.resolve(jdir, p)).catch(() => null);
  if (!out || !real || !isInside(out, real) || !/\.(mp4|png)$/i.test(real)) throw new StorageError('PRECONDITION', 'File Ganti Outfit harus di folder out/outfit job ini', { path: path.basename(p) });
  return real;
}

/** §29: folder of a finished Ganti Outfit siapkan job of the same project. */
export async function outfitSiapkanDir(ws: Workspace, projectId: string, jobId: string): Promise<string> {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'outfit' || s.state !== 'siap') bad('Job siapkan Ganti Outfit belum selesai');
  const dir = jobAbs(ws, projectId, jobId);
  const doc = await readJson<{ schema?: string; tahap?: string }>(path.join(dir, 'out', 'outfit.json'));
  if (doc?.schema !== 'beatspot-outfit/1' || doc.tahap !== 'siapkan') bad('Job itu bukan tahap siapkan Ganti Outfit');
  return dir;
}

/** A file inside the workspace (job out/) is imported through a temp copy, like Visual Tools results. */
async function importJobFile(ws: Workspace, abs: string, scope: Parameters<typeof importMedia>[1]['scope'], display_name: string) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-gabung-'));
  try {
    const copy = path.join(tmp, path.basename(abs));
    await fsp.copyFile(abs, copy);
    return await importMedia(ws, { sourcePath: copy, scope, display_name, actor: 'user' });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Read `out/[varian-NNN/]ops.json` and replace placeholders with MediaRefs (sources, brand assets,
 * `aset_lokal` imported as project media; Batch Remix footage from `batch.json` as shared media).
 * Unknown placeholders are refused — no guessing.
 */
export async function loadEnginePlan(ws: Workspace, cfg: EngineConfig | null, projectId: string, jobId: string, variant?: string): Promise<EnginePlan> {
  const jdir = jobAbs(ws, projectId, jobId);
  if (variant !== undefined && !/^varian-\d{3}$/.test(variant)) bad('varian tidak valid');
  const outDir = variant ? path.join(jdir, 'out', variant) : path.join(jdir, 'out');
  const opsFile = await readJson<{ schema?: string; ops?: unknown; aset_lokal?: unknown }>(path.join(outDir, 'ops.json'));
  if (!opsFile) throw new StorageError('NOT_FOUND', 'ops.json belum ada (mesin belum selesai)');
  if (opsFile.schema !== 'ms-ops/1' || !Array.isArray(opsFile.ops)) throw new StorageError('PRECONDITION', 'ops.json harus schema ms-ops/1 dengan daftar ops');
  const rencana = (await readJson<Record<string, unknown>>(path.join(outDir, 'rencana.json'))) ?? {};
  const qcRaw = await readJson<{ butir?: unknown }>(path.join(outDir, 'qc_rencana.json'));
  const qc = qcRaw && Array.isArray(qcRaw.butir)
    ? { butir: (qcRaw.butir as Record<string, unknown>[]).filter((b) => b && typeof b.butir === 'string').slice(0, 50).map((b) => ({ butir: String(b.butir).slice(0, 200), lulus: b.lulus === true, ...(b.nilai !== undefined ? { nilai: b.nilai } : {}) })) }
    : null;
  const refsFile = (await readJson<{ refs: Record<string, MediaRef> }>(path.join(jdir, 'refs.json'))) ?? { refs: {} };
  const refs = { ...refsFile.refs };
  const imported: string[] = [];
  // Batch Remix: the footage lives in the engine's own folder (`batch.json` → media) and is used by
  // several variant projects, so everything a batch plan brings in is imported as SHARED media.
  const status = await readEngineStatus(ws, projectId, jobId);
  const shared = status.mode === 'batch';
  const scope = shared ? ({ kind: 'shared' } as const) : ({ kind: 'project', project_id: projectId } as const);
  const found: { kunci: string; path: string }[] = [];
  const lokal = opsFile.aset_lokal === undefined ? [] : Array.isArray(opsFile.aset_lokal) ? opsFile.aset_lokal : bad('aset_lokal harus daftar');
  if (lokal.length > 200) bad('aset_lokal maksimal 200');
  for (const [i, a] of lokal.entries()) {
    const ao = (a ?? {}) as Record<string, unknown>;
    if (typeof ao.kunci !== 'string' || !/^\$[a-z]+:[A-Za-z0-9_.-]{1,60}$/.test(ao.kunci) || typeof ao.path !== 'string') bad(`aset_lokal[${i}] harus { kunci: "$jenis:id", path }`);
    found.push({ kunci: ao.kunci as string, path: ao.path as string });
  }
  if (shared) {
    const media = ((await readJson<{ media?: unknown }>(path.join(jdir, 'out', 'batch.json')))?.media ?? {}) as Record<string, unknown>;
    for (const op of opsFile.ops as Record<string, unknown>[]) {
      const k = op?.media;
      if (typeof k === 'string' && !refs[k] && typeof media[k] === 'string' && !found.some((f) => f.kunci === k)) found.push({ kunci: k, path: media[k] as string });
    }
  }
  // Import once (deduplicated by content), remembered in refs.json.
  for (const f of found) {
    if (refs[f.kunci]) continue;
    // §26: the joined footage is the one file the engine writes in the job's own out/ folder.
    const gab = f.kunci === KUNCI_GABUNGAN && !shared;
    // §29: Ganti Outfit clips / pictures / end card live in this job's out/outfit/.
    const outf = /^\$outfit:[A-Za-z0-9_.-]{1,60}$/.test(f.kunci) && !shared;
    const abs = gab ? await assertJobOutPath(jdir, f.path) : outf ? await assertJobOutfitPath(jdir, f.path) : await assertEnginePath(cfg, f.path);
    const r = gab ? await importJobFile(ws, abs, scope, 'Footage gabungan.mp4') : outf ? await importJobFile(ws, abs, scope, `${f.kunci.slice(8)}${path.extname(abs)}`) : await importMedia(ws, { sourcePath: abs, scope, display_name: `${f.kunci.slice(1).replace(/:/g, '-')}${path.extname(abs)}`, actor: 'user' });
    refs[f.kunci] = { media_id: r.media.media_id, version_id: r.version.version_id };
    imported.push(f.kunci);
  }
  if (imported.length) await writeJsonAtomic(path.join(jdir, 'refs.json'), { ...refsFile, schema: 'engine-refs/1', refs });
  const unknown = new Set<string>();
  const ops = opsFile.ops.map((op) => {
    const o = op as Record<string, unknown>;
    if (o && typeof o === 'object' && typeof o.media === 'string') {
      const r = refs[o.media];
      if (!r) unknown.add(o.media);
      return { ...o, media: r ?? null };
    }
    return op;
  });
  if (unknown.size) throw new StorageError('PRECONDITION', `Placeholder tidak dikenal: ${[...unknown].slice(0, 10).join(', ')}`, { unknown: [...unknown].slice(0, 50) });
  const project = await readProject(ws, projectId).catch(() => null);
  const ovFile = await readJson<{ overlay?: unknown }>(path.join(jdir, 'overlay.json'));
  const chosen = ovFile?.overlay !== undefined ? jobOverlayOps(validateJobOverlays(ovFile.overlay), draftEnd(ops as Record<string, unknown>[])) : [];
  const withChosen = [...(ops as Record<string, unknown>[]), ...chosen];
  const auto = autoLogoOp(await readBrandFor(ws, project?.brand_id), withChosen);
  return { ops: auto ? [...withChosen, auto] : withChosen, rencana, qc, imported };
}

/**
 * R26: Brand "pasang logo default otomatis" — one whole-video overlay of the default logo (its
 * corner / size / opacity from the kit), added to every engine draft (Generate, Batch, Beat Spot).
 * It is an ordinary overlay clip: the editor can move, resize or delete it (one undo). Skipped when
 * the draft is empty or already shows that logo (overlay or the brand-logo switch).
 */
export function autoLogoOp(kit: BrandKit, ops: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  if (!kit.logo_otomatis || !kit.logo) return null;
  const end = draftEnd(ops);
  if (end < 100) return null;
  const logo = kit.logo;
  const has = ops.some((o) => (o?.op === 'set_brand_logo' && o.on === true) || (o?.op === 'add_clip' && o.track_kind === 'overlay' && (o.media as MediaRef | null)?.version_id === logo.ref.version_id));
  if (has) return null;
  return {
    op: 'add_clip',
    track_kind: 'overlay',
    media: { ...logo.ref },
    start_ms: 0,
    duration_ms: Math.round(end),
    overlay: { ...OVERLAY_DEFAULT, pos: logo.corner, skala: logo.size, opasitas: logo.opacity, layer: 999, sepanjang: true },
  };
}

/** Batch Remix table (`out/batch.json`) as written by the engine. */
export async function readEngineBatch(ws: Workspace, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const b = await readJson<Record<string, unknown>>(path.join(jobAbs(ws, projectId, jobId), 'out', 'batch.json'));
  if (!b) throw new StorageError('NOT_FOUND', 'batch.json belum ada');
  return b;
}

export interface PisahFile {
  file: string;
  video: boolean;
  vokal: boolean;
  musik: boolean;
}
/** `out/pisah.json` (Pisah Audio): what was split, without local paths. */
export async function readPisahResult(ws: Workspace, projectId: string, jobId: string): Promise<{ batch: string | null; files: PisahFile[]; ditolak: { file: string; alasan: string }[]; alasan: string | null }> {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'pisah') bad('Job ini bukan Pisah Audio');
  const r = await readJson<unknown>(path.join(jobAbs(ws, projectId, jobId), 'out', 'pisah.json'));
  if (!r) throw new StorageError('NOT_FOUND', 'pisah.json belum ada');
  const o = (Array.isArray(r) ? { hasil: r } : r) as Record<string, unknown>;
  const list = (Array.isArray(o.hasil) ? o.hasil : Array.isArray(o.file) ? o.file : Array.isArray(o.files) ? o.files : []) as Record<string, unknown>[];
  const job = await readJson<{ batch?: unknown }>(path.join(jobAbs(ws, projectId, jobId), 'job.json'));
  const base = (v: unknown) => (typeof v === 'string' && v ? path.basename(v.replace(/\\/g, '/')).slice(0, 120) : '');
  return {
    batch: typeof job?.batch === 'string' ? job.batch : null,
    files: list.slice(0, 200).filter((f) => f && base(f.file)).map((f) => ({ file: base(f.file), video: !!f.video, vokal: !!f.vokal, musik: !!f.musik })),
    // Contract v0.3.2a: uploads the engine skipped (broken / not a video); the job itself went on.
    ditolak: (Array.isArray(o.file_ditolak) ? (o.file_ditolak as Record<string, unknown>[]) : [])
      .slice(0, 200)
      .filter((f) => f && base(f.file))
      .map((f) => ({ file: base(f.file), alasan: scrubPaths(typeof f.alasan === 'string' ? f.alasan : 'dilewati mesin').slice(0, 200) })),
    alasan: typeof o.alasan === 'string' ? scrubPaths(o.alasan).slice(0, 300) : null,
  };
}

export interface BatchLine {
  teks: string;
  dari: number;
  sampai: number;
  shot: string[];
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/**
 * The batch table for the browser: no `media` map (local paths), and every row with `kalimat`
 * (VO sentence → shots). The engine writes it (contract §8); older batches fall back to the
 * subtitle clips of the row's ops.json (no shots then).
 */
export async function readEngineBatchView(ws: Workspace, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const { media: _media, ...batch } = await readEngineBatch(ws, projectId, jobId);
  void _media;
  const rows = (Array.isArray(batch.varian) ? batch.varian : []) as Record<string, unknown>[];
  const jdir = jobAbs(ws, projectId, jobId);
  const varian = [];
  for (const r of rows.slice(0, 50)) {
    let kalimat: BatchLine[] = [];
    let sumber: 'mesin' | 'ops' | null = null;
    if (Array.isArray(r.kalimat)) {
      sumber = 'mesin';
      for (const k of (r.kalimat as Record<string, unknown>[]).slice(0, 100)) {
        const dari = num(k?.dari);
        const sampai = num(k?.sampai);
        if (typeof k?.teks !== 'string' || dari === null || sampai === null) continue;
        // Shot ids, or `footage＠in` (fullwidth @) for a fallback cut without a shot id (contract §9).
        kalimat.push({ teks: k.teks.slice(0, 300), dari, sampai, shot: Array.isArray(k.shot) ? (k.shot as unknown[]).filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_.#:@＠-]{1,80}$/.test(x)).slice(0, 20) : [] });
      }
    } else if (typeof r.id === 'string' && /^varian-\d{3}$/.test(r.id)) {
      const ops = await readJson<{ ops?: unknown }>(path.join(jdir, 'out', r.id, 'ops.json')).catch(() => null);
      const list = (Array.isArray(ops?.ops) ? ops.ops : []) as Record<string, unknown>[];
      kalimat = list
        .filter((o) => o?.op === 'add_clip' && o.track_kind === 'subtitle' && typeof o.text === 'string' && num(o.start_ms) !== null && num(o.duration_ms) !== null)
        .slice(0, 100)
        .map((o) => ({ teks: (o.text as string).slice(0, 300), dari: (o.start_ms as number) / 1000, sampai: ((o.start_ms as number) + (o.duration_ms as number)) / 1000, shot: [] }));
      sumber = kalimat.length ? 'ops' : null;
    }
    varian.push({ ...r, kalimat, kalimat_sumber: sumber });
  }
  return { ...batch, varian };
}

/** Engine log tail for the "gagal" card. */
export async function readEngineLog(ws: Workspace, projectId: string, jobId: string, cfg: EngineConfig | null = null): Promise<string> {
  let log = (await fsp.readFile(path.join(jobAbs(ws, projectId, jobId), 'engine.log'), 'utf8').catch(() => '')).slice(-4000);
  // Checkpoint I L2: no local paths in what the browser sees.
  const swap = (from: string, to: string) => {
    for (const v of [from, from.replace(/\\/g, '/')]) if (v) log = log.split(v).join(to);
  };
  if (cfg) {
    swap(cfg.root, '<mesin>');
    if (cfg.code && cfg.code !== cfg.root) swap(cfg.code, '<mesin>');
  }
  swap(ws.root, '<workspace>');
  return scrubPaths(log);
}

// ------------------------------------------------------------------ Batch Remix decisions (U5)

export type BatchRowStatus = 'usul' | 'disetujui' | 'dicoret';
export interface BatchDecision {
  status: BatchRowStatus;
  /** Variant project made when the row was approved (kept if the row is struck later). */
  project_id: string | null;
  /**
   * The engine's plan for this row cannot become a timeline (e.g. "Klip melebihi panjang video
   * sumber"): the row stays unapproved with this reason; the other rows are saved as asked.
   */
  rusak?: string;
}

const decisionsFile = (ws: Workspace, projectId: string, jobId: string) => path.join(jobAbs(ws, projectId, jobId), 'keputusan.json');

export async function readBatchDecisions(ws: Workspace, projectId: string, jobId: string): Promise<Record<string, BatchDecision>> {
  return ((await readJson<{ rows?: Record<string, BatchDecision> }>(decisionsFile(ws, projectId, jobId)))?.rows ?? {}) as Record<string, BatchDecision>;
}

/**
 * The team approves / strikes rows of the batch table (contract §5.3a). Approving a row makes a
 * variant project of the batch's master project with that row's plan, already approved, so
 * "Render varian disetujui" renders exactly the approved rows. Striking a row withdraws the
 * approval (the project stays, nothing is deleted). Rows are decided once per call, all checked
 * before any project is made.
 */
export async function decideBatch(
  ws: Workspace,
  cfg: EngineConfig | null,
  input: { project_id: string; job_id: string; rows: unknown; actor: 'user'; newId: () => string; plans?: ReadonlyMap<string, EnginePlan> },
): Promise<Record<string, BatchDecision>> {
  const s = await readEngineStatus(ws, input.project_id, input.job_id);
  if (s.mode !== 'batch') bad('Job ini bukan Batch Remix');
  if (s.state !== 'siap') bad('Batch belum siap');
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 50) bad('rows harus daftar 1–50');
  const batch = await readEngineBatch(ws, input.project_id, input.job_id);
  const table = (Array.isArray(batch.varian) ? batch.varian : []) as { id?: unknown; hook?: unknown; bukan_iklan?: unknown; rusak?: unknown }[];
  const byId = new Map(table.filter((r) => typeof r.id === 'string').map((r) => [r.id as string, r]));
  const wanted = (input.rows as unknown[]).map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.varian !== 'string' || !byId.has(o.varian)) bad(`rows[${i}].varian tidak ada di tabel batch`);
    if (o.status !== 'usul' && o.status !== 'disetujui' && o.status !== 'dicoret') bad(`rows[${i}].status harus usul | disetujui | dicoret`);
    return { varian: o.varian as string, status: o.status as BatchRowStatus };
  });
  // Checkpoint I H2: one decision per row per request.
  if (new Set(wanted.map((w) => w.varian)).size !== wanted.length) bad('Satu varian hanya boleh muncul sekali per keputusan');
  const master = await readProject(ws, input.project_id);
  if (master.variant) bad('Proyek batch tidak boleh varian');
  const decisions = await readBatchDecisions(ws, input.project_id, input.job_id);
  // Dry run: every newly approved row must be a valid timeline before its project is made. A row
  // that cannot (one broken engine plan) no longer stops the others: it is marked `rusak` with
  // the reason and stays unapproved (owner, 15 Nov: KORSET varian-003 blocked the whole save).
  const reg = await loadRegistry(ws);
  const dur = (ref: MediaRef) => reg.versions[ref.version_id]?.probe?.duration_ms;
  const toCreate: { varian: string; timeline: Timeline; label: string; hook: string | null; test: boolean }[] = [];
  const broken = new Map<string, string>();
  for (const w of wanted) {
    if (w.status !== 'disetujui' || decisions[w.varian]?.project_id) continue;
    // Contract v0.3.3 §10: the engine itself already found this row invalid — never approved.
    const engineSays = byId.get(w.varian)?.rusak;
    if (typeof engineSays === 'string' && engineSays.trim()) {
      broken.set(w.varian, scrubPaths(engineSays.trim()).slice(0, 300));
      continue;
    }
    let timeline: Timeline;
    try {
      const p = input.plans?.get(w.varian) ?? (await loadEnginePlan(ws, cfg, input.project_id, input.job_id, w.varian));
      timeline = applyOps({ tracks: [] }, validateOps(p.ops, MAX_SERVER_OPS), () => newId('c'), dur);
    } catch (e) {
      if (!(e instanceof StorageError) || (e.code !== 'EDIT_INVALID' && e.code !== 'PRECONDITION' && e.code !== 'NOT_FOUND')) throw e;
      broken.set(w.varian, scrubPaths(e.message).slice(0, 300));
      continue;
    }
    const row = byId.get(w.varian)!;
    const hook = typeof row.hook === 'string' && row.hook.trim() ? row.hook.trim().slice(0, 200) : null;
    const test = row.bukan_iklan === true;
    toCreate.push({ varian: w.varian, timeline, hook, test, label: `${test ? 'UJI · ' : ''}${w.varian}${hook ? ` · ${hook}` : ''}`.slice(0, 60) });
  }
  let number = Math.max(0, ...(await listVariants(ws, master.project_id)).map((p) => p.variant!.number));
  for (const c of toCreate) {
    const variant: VariantInfo = { master_id: master.project_id, number: ++number, label: c.label, brief: c.hook ? { hook: c.hook } : {}, approved_revision: null, ...(c.test ? { bukan_iklan: true as const } : {}) };
    const made = await createWithTimeline(ws, { project_id: input.newId(), name: `${master.name} · ${c.label}`.slice(0, MAX_PROJECT_NAME), timeline: c.timeline, actor: input.actor, variant, ...(master.brand_id ? { brand_id: master.brand_id } : {}), fitur: 'batch' });
    // R9: an engine draft — the editor's later changes to it are recorded as lessons.
    await markEngineOrigin(ws, made.project_id, { kind: 'batch', job_id: input.job_id, varian: c.varian }).catch(() => undefined);
    await setVariantApproval(ws, { project_id: made.project_id, expected_revision: made.revision, approved: true, actor: input.actor });
    decisions[c.varian] = { status: 'disetujui', project_id: made.project_id };
    // Recorded right away: a failure on a later row never leaves this project unknown (no duplicate on retry).
    await writeJsonAtomic(decisionsFile(ws, input.project_id, input.job_id), { schema: 'batch-keputusan/1', rows: decisions });
  }
  for (const w of wanted) {
    const why = broken.get(w.varian);
    if (why) {
      decisions[w.varian] = { status: 'usul', project_id: null, rusak: why };
      continue;
    }
    const { rusak: _old, ...d } = decisions[w.varian] ?? { status: 'usul' as const, project_id: null };
    void _old;
    if (w.status === 'disetujui' && d.project_id) {
      // Re-approving a struck row: approve the variant again at its current content.
      const p = await readProject(ws, d.project_id).catch(() => null);
      if (p?.variant && variantState(p) !== 'approved') await setVariantApproval(ws, { project_id: p.project_id, expected_revision: p.revision, approved: true, actor: input.actor });
    }
    if (w.status !== 'disetujui' && d.project_id) {
      const p = await readProject(ws, d.project_id).catch(() => null);
      if (p?.variant && p.variant.approved_revision !== null) await setVariantApproval(ws, { project_id: p.project_id, expected_revision: p.revision, approved: false, actor: input.actor });
    }
    decisions[w.varian] = { ...d, status: w.status };
  }
  await writeJsonAtomic(decisionsFile(ws, input.project_id, input.job_id), { schema: 'batch-keputusan/1', rows: decisions });
  await audit(ws, { op: 'engine.batch_decide', actor: input.actor, outcome: 'ok', project_id: input.project_id, job_id: input.job_id, approved: wanted.filter((w) => w.status === 'disetujui' && !broken.has(w.varian)).length, struck: wanted.filter((w) => w.status === 'dicoret').length, created: toCreate.length, broken: broken.size });
  return decisions;
}

/**
 * Checkpoint I M2: read (and import the media of) the plans of rows that will become variants,
 * OUTSIDE the workspace lock — imports hash and copy footage and may take minutes.
 */
export async function loadBatchPlans(ws: Workspace, cfg: EngineConfig | null, projectId: string, jobId: string, rows: unknown): Promise<Map<string, EnginePlan>> {
  const out = new Map<string, EnginePlan>();
  if (!Array.isArray(rows) || rows.length > 50) return out;
  const decisions = await readBatchDecisions(ws, projectId, jobId);
  for (const r of rows as Record<string, unknown>[]) {
    const v = r?.varian;
    if (r?.status !== 'disetujui' || typeof v !== 'string' || !/^varian-\d{3}$/.test(v) || out.has(v) || decisions[v]?.project_id) continue;
    // One unreadable plan never stops the others: decideBatch retries it and marks the row `rusak`.
    const plan = await loadEnginePlan(ws, cfg, projectId, jobId, v).catch(() => null);
    if (plan) out.set(v, plan);
  }
  return out;
}
