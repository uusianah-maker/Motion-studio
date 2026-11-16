import type { TextStyle } from '../../../packages/core/dist/storage/textStyle.js';
import type { Adjust, ClipExtras, Denoise, FitMode, LookId, Transition } from '../../../packages/core/dist/storage/clipLook.js';
import type { Keyframe } from '../../../packages/core/dist/storage/keyframes.js';
import type { Overlay } from '../../../packages/core/dist/storage/overlay.js';
/**
 * Typed client for the server API (apps/server). Local mode: URL token (memory/sessionStorage only).
 * Google mode (W09): no token at all; the HttpOnly session cookie travels by itself, and every call
 * carries `x-motion-request: 1`, which the server requires (a cross-site page cannot send it).
 */

/** R36: one word pair learned from editor corrections (core kamusBelajar). */
export interface KamusBelajarPasangan {
  salah: string;
  benar: string;
  kali: number;
  otomatis: boolean;
  terakhir: number;
}

/** X09: one ad variant of a master project. */
export interface VariantRow {
  project_id: string;
  name: string;
  revision: number;
  number: number;
  label: string;
  brief: { ratio?: '9:16' | '3:4' | '1:1' | '16:9'; hook?: string; cta?: string };
  state: 'draft' | 'approved' | 'changed';
  ratio: string;
  render: { job_id: string; status: string; progress: number; output_name: string; problems: { code: string }[]; error: { code: string; message: string } | null } | null;
  outputs: number;
}
export interface VariantTag {
  master_id: string;
  number: number;
  state?: 'draft' | 'approved' | 'changed';
  label?: string;
  approved_revision?: number | null;
}

/** X07: silences + scene changes of one media version (source times, ms). */
export interface MediaAnalysis {
  version_id: string;
  params: { noise_db: number; min_silence_ms: number; scene_threshold: number };
  duration_ms: number;
  has_audio: boolean;
  has_video: boolean;
  silences: { from_ms: number; to_ms: number }[];
  scenes: number[];
  cached: boolean;
}

/** X06: workspace Brand Kit. */
export type Ref = { media_id: string; version_id: string };
export type Platform = 'tiktok' | 'instagram' | 'shopee' | 'youtube';
/** E (U2): one file of a brand's asset library. */
export interface BrandAsset {
  id: string;
  ref: Ref;
  jenis: 'sfx' | 'musik' | 'broll' | 'logo' | 'watermark' | 'stiker' | 'frame' | 'penutup' | 'vo' | 'lainnya';
  nama: string;
  tag: string[];
  lisensi: { status: 'milik_sendiri' | 'berlisensi' | 'tanpa_lisensi' | 'belum_dicek'; bukti: string; iklan: boolean };
  mood: string;
  bpm: number | null;
  instrumental: boolean | null;
  produk: string;
  varian: string;
  ada_teks_bawaan: boolean;
  catatan: string;
}
/** F: one content preset per brand. */
export interface BrandPreset {
  id: string;
  nama: string;
  tujuan: string;
  placement: Platform[];
  durasi: { min: number; target: number; max: number };
  turunan: string[];
  babak: { dari: number; sampai: number; isi: string }[];
  ritme: string;
  caption: { mode: 'per_kata' | 'kalimat'; maks_kata: number; pop_ms: number; y?: number; warna?: string; outline?: string; kotak?: boolean };
  hook: { teks: boolean; maks_kata: number; dari_ucapan: boolean; y?: number; ukuran?: number; baris?: number; warna?: string; dari_kalimat_kuat?: boolean };
  efek: { wajib: string[]; boleh: string[]; jangan: string[]; maks: number; jarak_dtk: number };
  audio: { suara_asli: boolean; sfx: string; musik: string; lufs: number };
  qc: string[];
  /** R18 (KONTRAK-ENGINE §17.1): style learnt from winning videos; all optional. */
  jenis?: PresetJenis;
  shot?: { target_dtk?: number; maks_dtk?: number };
  transisi?: { ganti_orang: 'potong' | 'flash' };
  penutup?: { end_card: boolean };
  beat?: { tiap_ketukan?: 1 | 2 | 4; bpm?: number };
}
export type PresetJenis = 'street_interview' | 'test_produk' | 'harian_studio' | 'beat_spot' | 'lain';
/** R18 §17.2: voice over / music / both for one job ('' = engine default). */
export type AudioPilihan = 'vo' | 'musik' | 'keduanya';
/** X06 → U1: one Brand Kit per brand (sheet A–F). */
export interface BrandKit {
  schema_version: 2;
  brand_id: string;
  revision: number;
  updated_at: number;
  name: string;
  kode: string;
  handles: Partial<Record<Platform, string>>;
  target: string;
  nada: string[];
  bahasa: 'id' | 'en' | 'campur';
  produk: { nama: string; varian: string[]; ukuran: string }[];
  colors: string[];
  text_color: string;
  outline: { color: string; px: number };
  warna_dilarang: string[];
  font: Ref | null;
  font_caption: Ref | null;
  logo: { ref: Ref; corner: 'tl' | 'tr' | 'bl' | 'br'; size: number; opacity: number; show: 'sepanjang' | 'penutup' | 'sepanjang+penutup' } | null;
  logo_light: Ref | null;
  /** R26: put the default logo on every new video from Generate / Batch / Beat Spot (as an overlay). */
  logo_otomatis: boolean;
  outro: { ref: Ref | null; detik: number };
  gaya: string;
  grading: string;
  /** Malam 15 Nov: default colour look for video/b-roll clips (null = none). */
  filter_bawaan: LookId | null;
  cta: Partial<Record<Platform, string>>;
  cta_wajib: string;
  disclaimer: { teks: string; kapan: 'selalu' | 'varian_warna' | 'harga' | 'manual' } | null;
  /** R18 §17.3 */
  tagline: string;
  watermark: { teks: string; y: number; lebar: number; opasitas: number } | null;
  kosakata: string[];
  kamus: { salah: string; benar: string }[];
  /** R36: learned wrong words the team chose to ignore. */
  kamus_abaikan: string[];
  /** R34: how the TTS says a written word ("Aysilla" → "Ay-si-la"). */
  pelafalan: { tulisan: string; ucapan: string }[];
  kata_kunci: string[];
  kapital: 'normal' | 'kata_kunci' | 'semua';
  emoji: boolean;
  /** X08: promo prices with an end date + banned claims, checked before every render. */
  guard: BrandGuard;
  klaim_boleh: string[];
  visual_dilarang: string[];
  area_bebas_teks: ('wajah' | 'produk' | 'bawah_15' | 'atas_10' | 'kanan_tombol')[];
  aset: BrandAsset[];
  sfx_dilarang: string[];
  referensi: { link: string; tiru: string; jangan: string }[];
  presets: BrandPreset[];
}
export interface BrandGuard {
  prices: { text: string; valid_until: string }[];
  banned: string[];
  banned_level: 'block' | 'warn';
}
export interface GuardIssue {
  level: 'block' | 'warn';
  kind: 'PRICE_EXPIRED' | 'BANNED_CLAIM';
  clip_id: string;
  track_kind: Track['kind'];
  start_ms: number;
  end_ms: number;
  text: string;
  match: string;
  valid_until?: string;
}
export type BrandKitInput = Omit<BrandKit, 'schema_version' | 'brand_id' | 'revision' | 'updated_at'>;

/** X05: a project file (timeline + which media versions it uses; never files or paths). */
export interface ProjectExport {
  format: 'motion-studio-project';
  format_version: 1;
  exported_at: number;
  project: { name: string; timeline: Project['timeline'] };
  media: { media_id: string; version_id: string; content_hash: string; display_name: string; duration_ms: number | null }[];
}

/** R22: which feature page made the project (old projects: guessed by the server). */
export type ProjectFitur = 'iklan' | 'batch' | 'beatspot' | 'transfer' | 'editor';

export interface ProjectSummary {
  project_id: string;
  name?: string;
  status?: 'active' | 'archived';
  /** X09: set on variant projects. */
  variant?: VariantTag;
  /** U1: the project's brand (missing = workspace default brand). */
  brand_id?: string;
  /** R22. */
  fitur?: ProjectFitur;
  revision?: number;
  created_at?: number;
  updated_at?: number;
  error?: string;
}

/** Malam 15 Nov: + fades, denoise, fit, adjust, look, transition (ClipExtras). */
export interface Clip extends ClipExtras {
  /** Malam 15 Nov: position / scale / opacity keyframes. */
  keyframes?: Keyframe[];
  clip_id: string;
  start_ms: number;
  end_ms: number;
  in_ms?: number;
  media?: { media_id: string; version_id: string };
  text?: string;
  /** X01: text/subtitle look; missing fields = track default. */
  style?: Partial<TextStyle>;
  /** X04: media clip sound level 0..1 (missing = 1). */
  volume?: number;
  /** U3b: caption word timings relative to the clip start. */
  words?: { text: string; start_ms: number; end_ms: number }[];
  /** U3c: effects-track clip: zoom / zoom-through. */
  effect?: ClipEffect;
  /** U3d: part of the source shown + blurred areas (source fractions, source ms). */
  crop?: Crop;
  blur?: BlurRegion[];
  /** R26: picture/video overlay on the overlay track. */
  overlay?: Overlay;
  /** R23e: chroma key of an overlay clip. */
  chroma?: { warna: string; toleransi: number; halus: number };
}
export type Crop = { x: number; y: number; w: number; h: number };
export type BlurRegion = Crop & { dari_ms: number; sampai_ms: number; radius: number };
export type ClipEffect = { type: 'zoom'; scale: number; mode: 'cut' | 'smooth'; x: number; y: number } | { type: 'zoom_through'; scale: number; x: number; y: number };

export type EditOp =
  | ({ op: 'add_clip'; track_kind: Track['kind']; media?: { media_id: string; version_id: string }; text?: string; style?: Partial<TextStyle>; start_ms: number; duration_ms: number; in_ms?: number; volume?: number; words?: { text: string; start_ms: number; end_ms: number }[]; effect?: ClipEffect; crop?: Crop; blur?: BlurRegion[]; keyframes?: Keyframe[]; overlay?: Overlay } & ClipExtras)
  | { op: 'move_clip'; clip_id: string; start_ms: number }
  | { op: 'trim_clip'; clip_id: string; edge: 'start' | 'end'; to_ms: number }
  | { op: 'split_clip'; clip_id: string; at_ms: number }
  | { op: 'delete_clip'; clip_id: string }
  | { op: 'set_text'; clip_id: string; text: string }
  | { op: 'set_canvas'; ratio: '9:16' | '3:4' | '1:1' | '16:9' }
  | { op: 'set_brand_logo'; on: boolean }
  | { op: 'remove_range'; from_ms: number; to_ms: number }
  | { op: 'split_at'; track_kind: Track['kind']; at_ms: number }
  | { op: 'set_style'; clip_id: string; style: Partial<TextStyle> }
  | { op: 'set_volume'; clip_id: string; volume: number }
  | { op: 'set_framing'; clip_id: string; crop?: Crop | null; blur?: BlurRegion[] }
  | { op: 'set_track_mute'; track_kind: 'video' | 'broll' | 'audio' | 'music' | 'sfx'; muted: boolean }
  | { op: 'set_loudness'; lufs: number | null }
  | { op: 'set_audio'; clip_id: string; fade_in_ms?: number; fade_out_ms?: number; denoise?: Denoise | 'off'; eq?: { bass: number; mid: number; treble: number } | null; voice?: boolean }
  | { op: 'set_picture'; clip_id: string; fit?: FitMode | null; fit_color?: string | null; adjust?: Adjust | null; look?: LookId | 'none' | null; transition?: Transition | null }
  | { op: 'set_ducking'; on: boolean; level?: number }
  | { op: 'set_keyframes'; clip_id: string; keyframes: Keyframe[] }
  | { op: 'set_motion'; clip_id: string; rotate?: 0 | 90 | 180 | 270; flip_h?: boolean; flip_v?: boolean; speed?: number; reverse?: boolean; vdenoise?: 'off' | 'ringan' | 'sedang'; stabil?: 'off' | 'ringan' | 'kuat' }
  | { op: 'freeze_frame'; clip_id: string; at_ms: number; duration_ms: number }
  | { op: 'delete_clips'; clip_ids: string[] }
  | { op: 'shift_clips'; clip_ids: string[]; delta_ms: number }
  | { op: 'set_style_many'; clip_ids: string[]; style: Partial<TextStyle> }
  | { op: 'duplicate_clip'; clip_id: string }
  | { op: 'set_media'; clip_id: string; media: { media_id: string; version_id: string } }
  | { op: 'set_chroma'; clip_id: string; chroma: { warna: string; toleransi: number; halus: number } | null }
  | { op: 'set_overlay'; clip_id: string; overlay: Partial<Omit<Overlay, 'sepanjang'>> & { sepanjang?: boolean } }
  | { op: 'set_overlay_layer'; clip_id: string; to: 'depan' | 'maju' | 'mundur' | 'belakang' };
export interface Track {
  track_id: string;
  kind: 'video' | 'broll' | 'text' | 'subtitle' | 'overlay' | 'audio' | 'music' | 'sfx' | 'effects';
  clips: Clip[];
  /** X04: media track silenced in preview and render. */
  muted?: boolean;
  /** Malam 15 Nov: music track ducking level under speech. */
  duck?: number;
}
export interface Project extends Required<Omit<ProjectSummary, 'error' | 'variant' | 'brand_id' | 'fitur'>> {
  brand_id?: string;
  fitur?: ProjectFitur;
  variant?: VariantTag;
  timeline: { tracks: Track[]; canvas?: { ratio: '9:16' | '3:4' | '1:1' | '16:9' }; brand_logo?: boolean; loudness_lufs?: number };
  history: { undo: number; redo: number; undo_label: string | null; redo_label: string | null };
}

export interface Version {
  version_id: string;
  original_name: string;
  size: number;
  content_hash: string;
  imported_at: number;
  lifecycle: 'active' | 'trashed' | 'purged';
  integrity: 'ok' | 'missing' | 'changed';
  ever_referenced: boolean;
  keep: boolean;
  pin: boolean;
  legal_hold: boolean;
  trashed_at: number | null;
  probe?: { duration_ms: number; width: number | null; height: number | null; video_codec: string | null; audio_codec: string | null; pix_fmt?: string | null; fps?: number | null } | null;
  /** Browser can preview this codec. */
  preview?: boolean;
}

export interface Media {
  media_id: string;
  display_name: string;
  scope: { kind: 'shared' } | { kind: 'project'; project_id: string };
  created_at: number;
  current_version_id: string;
  versions: Version[];
  /** R14: the light preview copy of the current version (null = none / not needed). */
  proxy?: 'siap' | 'proses' | null;
}

export interface TrashItem extends Version {
  media_id: string;
  display_name: string;
  original_rel_path: string;
}

export interface PurgePlan {
  request_id: string;
  confirmation_token: string;
  required_phrase: string;
  expires_at: number;
  irreversible: true;
  total_bytes: number;
  items: {
    version_id: string;
    media_id: string;
    filename: string;
    size: number;
    trashed_at: number | null;
    referenced_by: ({ kind: 'project'; project_id: string; source: string } | { kind: 'lease'; lease_id: string; job: string } | { kind: 'brand'; slot: 'font' | 'logo' })[];
    protected_by: string[];
    backup: { status: 'verified' | 'unverified'; location?: string };
    purgeable: boolean;
    blockers: string[];
  }[];
}

export interface Dashboard {
  stats: {
    usage: Record<string, number>;
    media_bytes: number;
    disk: { free_bytes: number; total_bytes: number } | null;
    warnings: { code: string; advice: string }[];
  };
  gc: { ok: boolean; errors: string[]; summary: Record<string, number>; candidates: number; next_eligible: { version_id: string; eligible_at: number; filename?: string }[] };
  trash: { version_id: string; filename: string; size: number; trashed_at: number }[];
  pending_operations: number;
  corrupt_journal: number;
  backup: { verified: number; active_versions: number };
}

export type RenderStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type RenderPhase = 'preflight' | 'preparing' | 'encoding' | 'verifying' | 'saving';

export interface RenderJob {
  job_id: string;
  project_id: string;
  output_name: string;
  status: RenderStatus;
  phase: RenderPhase | null;
  progress: number;
  created_at: number;
  finished_at: number | null;
  output: { name: string; size: number; hash: string; duration_ms: number; width: number; height: number; metadata_clean: true; kept_tags: string[] } | null;
  problems: { code: string; media_id?: string; version_id?: string; issues?: GuardIssue[] }[];
  error: { code: string; message: string } | null;
}

export interface RenderOutputFile {
  name: string;
  size: number;
  mtime_ms: number;
}

/** Halaman Hasil: satu file render beserta proyeknya. */
/** R12a: AI gambar settings as the browser sees them (no key). */
export interface ImageAiView {
  provider: 'openai' | 'gemini' | 'lainnya' | null;
  endpoint: string | null;
  model: string | null;
  budget: { amount: number | null; currency: 'IDR' | 'USD' };
  key_saved: boolean;
  key_hint: string | null;
  last_test: { at: number; ok: boolean; message: string } | null;
  providers: { id: 'openai' | 'gemini' | 'lainnya'; label: string; model_hint: string; needs_endpoint: boolean }[];
}


export interface OutputItem {
  project_id: string;
  project_name: string;
  name: string;
  size: number;
  mtime_ms: number;
  variant?: { master_id: string; number: number; uji: boolean };
}

export interface RenderTools {
  ok: boolean;
  version: string | null;
  problems: string[];
  font: boolean;
}

// ------------------------------------------------------------ Copilot (W11)
export interface PlanOperation {
  op: EditOp;
  label: string;
}
export interface EditPlan {
  schema_version: 1;
  plan_id: string;
  project_id: string;
  project_revision: number;
  source: 'local' | 'ai' | 'transcript' | 'analysis' | 'engine';
  prompt: string;
  operations: PlanOperation[];
  rationale: string;
  warnings: string[];
  cost_estimate: { usd: number; note: string };
  requires_approval: true;
  provider: { connection_id: string; provider: string; model: string } | null;
  created_at: number;
}
export interface DiffItem {
  kind: 'add' | 'remove' | 'change' | 'canvas';
  summary: string;
}
export type PlanReply = { plan: EditPlan; diff: DiffItem[]; unsupported?: undefined } | { plan: null; diff?: undefined; unsupported: { message: string; examples: string[]; ai_available: boolean } };
export interface ApplyReply {
  project: Project;
  plan: EditPlan;
  status: 'applied';
  applied_revision: number;
  accepted: number[];
  already_applied: boolean;
}

// ------------------------------------------------------------ AI providers (W12/W13)
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai_compatible';
export type Capability = 'planner' | 'transcription';
export interface Prices {
  input_per_mtok: number;
  output_per_mtok: number;
  per_audio_minute: number;
}
export interface AiConnection {
  connection_id: string;
  provider: ProviderId;
  label: string;
  model: string;
  capabilities: Capability[];
  base_url: string | null;
  priority: number;
  enabled: boolean;
  prices: Prices;
  key_hint: string | null;
  has_key: boolean;
  status: 'untested' | 'ok' | 'error' | 'needs_admin';
  last_error: { class: string; status: number | null; message: string; at: number } | null;
  last_test_at: number | null;
  cooldown_until: number;
  cooling_down: boolean;
}
export interface AiSettings {
  mode: 'local' | 'auto' | 'ai';
  failover: boolean;
  max_retries: number;
  timeout_ms: number;
  cooldown_ms: number;
  max_output_tokens: number;
  budget: { daily_usd: number; monthly_usd: number; per_request_usd: number };
}
export interface AiCatalogItem {
  provider: ProviderId;
  label: string;
  base_url: string | null;
  capabilities: Capability[];
  key_required: boolean;
  model_hint: string;
}
export interface AiLogEntry {
  ts: number;
  op: string;
  outcome: string;
  provider?: string;
  model?: string;
  capability?: string;
  error_class?: string | null;
  status?: number | null;
  cost_usd?: number;
  request_id?: string | null;
  reason?: string;
}

export interface AiUsage {
  budget: AiSettings['budget'];
  today: { usd: number; calls: number };
  month: { usd: number; calls: number };
  in_flight_usd: number;
  by_model: { provider: string; model: string; calls: number; failed: number; usd: number; input_tokens: number; output_tokens: number; audio_seconds: number }[];
}

// ------------------------------------------------------------ Transcripts (W14)
export interface Cue {
  cue_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
}
export interface TranscriptSummary {
  transcript_id: string;
  project_id: string;
  media_id: string;
  version_id: string;
  language: string | null;
  provider: string;
  model: string;
  source_duration_ms: number;
  created_at: number;
  updated_at: number;
  rev: number;
  edited: boolean;
  cue_count: number;
}
export interface TranscriptFull extends Omit<TranscriptSummary, 'cue_count'> {
  cues: Cue[];
  word_count: number;
}
export interface SttJob {
  job_id: string;
  project_id: string;
  version_id: string;
  status: 'running' | 'completed' | 'failed';
  phase: 'extracting' | 'transcribing' | 'saving';
  transcript_id: string | null;
  error: { code: string; message: string } | null;
  created_at: number;
  finished_at: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** U7: who may do what (enforced by the server). */
export type Role = 'owner' | 'editor' | 'reviewer';
/** Halaman Tim: one account allowed to sign in with Google. `env` = from .env.local (locked here). */
export interface TeamMember {
  email: string;
  role: Role;
  source: 'env' | 'web';
  added_at: number | null;
  added_by: string | null;
}
export interface ReviewComment {
  comment_id: string;
  at_ms: number;
  text: string;
  author: { email: string | null; name: string };
  created_at: number;
  revision: number;
  resolved_at: number | null;
  resolved_by: { email: string | null; name: string } | null;
}
export interface ReviewInfo {
  comments: ReviewComment[];
  decision: { status: 'lulus' | 'revisi'; revision: number; by: { email: string | null; name: string }; at: number; note: string } | null;
  state: 'belum' | 'lulus' | 'revisi' | 'berubah';
  revision: number;
}

export interface Session {
  /** U7 (missing on servers before roles = owner). */
  role?: Role;
  actor: string;
  workspace_id: string;
  storage_backend: string;
  auth: 'local' | 'google';
  user: { email: string; name: string } | null;
}

/** Public: which login the server uses. */
export async function authMode(base = ''): Promise<'local' | 'google'> {
  const r = await fetch(`${base}/api/auth/mode`);
  if (!r.ok) throw new ApiError(r.status, 'UNKNOWN', `HTTP ${r.status}`);
  const data = (await r.json()) as { mode?: string };
  return data.mode === 'google' ? 'google' : 'local';
}

// ---- U6 engine runner (Generate Otomatis / Batch Remix)
export type EngineState = 'menunggu' | 'berjalan' | 'siap' | 'ditolak' | 'gagal';
/** R34 (contract §21). */
/** Suara owner (contract §23). */
export interface SuaraOwnerList {
  contoh: { media_id: string; version_id: string }[];
  dihapus: string[];
}
export interface SuaraProfilView {
  job_id: string;
  status: 'siap' | 'kurang_contoh' | 'perlu_latih_ulang' | 'ditolak' | 'lain';
  alasan: string;
  contoh: { kunci: string | null; media_id: string | null; durasi: number; durasi_bersih: number; snr_db: number | null; musik: boolean; clipping: boolean; dipakai: boolean; alasan: string }[];
  durasi_bersih_total: number;
  target_dtk: [number, number];
  minimal_dtk: number;
  backend: string;
  dilatih_pada: string | null;
  contoh_hasil: { teks: string; ref: { media_id: string; version_id: string } | null }[];
}
export interface TtsVoice {
  id: string;
  nama: string;
  bahasa: string;
  gender: string;
  backend: string;
}
export type { VoIndex } from '../../../packages/core/dist/storage/voText.js';
import type { VoIndex } from '../../../packages/core/dist/storage/voText.js';
export interface VisualView {
  job_id: string;
  alat: 'deteksi' | 'reframe' | 'lacak' | 'hapus_latar' | 'perjelas';
  hasil: { media_id: string; version_id: string } | null;
  masker: { media_id: string; version_id: string } | null;
  info: Record<string, unknown>;
  data: Record<string, unknown> | null;
}
export interface TtsView {
  job_id: string;
  suara: string;
  kecepatan: number;
  jeda_ms: number;
  total_durasi: number;
  gabungan: { media_id: string; version_id: string } | null;
  aset_id: string | null;
  kalimat: { no: number; teks: string; mulai: number; akhir: number; durasi: number; kata: { teks: string; mulai: number; akhir: number }[]; ref: { media_id: string; version_id: string } | null }[];
}
export interface EngineJob {
  job_id: string;
  project_id: string;
  mode: 'generate' | 'batch' | 'ulang' | 'pisah' | 'transfer' | 'beatspot' | 'tts' | 'visual' | 'suara_profil';
  state: EngineState;
  tahap: string;
  persen: number;
  pesan: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  alasan: string | null;
}
export interface EngineBrief {
  produk: string;
  varian: string;
  harga: string;
  placement: 'tiktok' | 'instagram' | 'shopee' | 'youtube';
  catatan: string;
}
export interface EngineStart {
  mode: 'generate' | 'batch';
  sources: { kunci: string; ref: { media_id: string; version_id: string } }[];
  preset: string;
  brief: EngineBrief;
  ai: boolean;
  mode_ops?: 'kompat' | 'u3';
  audio_pilihan?: AudioPilihan;
  batch?: { batch: string; jumlah: number; tujuan: string; hak_pakai_jelas?: boolean; akun_sendiri?: string[]; vo_batch?: string; izinkan_musik_tanpa_lisensi?: boolean; buang_otomatis?: string[] };
  /** R26: overlays chosen before Generate (app only; added to the draft as overlay clips). */
  overlay?: JobOverlay[];
  /** R28: end card for this job — a file, null = none; absent = Brand Kit default. */
  penutup?: { ref: { media_id: string; version_id: string } } | null;
}
/** R26: one overlay of a "Buat video" job. */
export interface JobOverlay {
  ref: { media_id: string; version_id: string };
  overlay: Overlay;
  dari_ms?: number;
  sampai_ms?: number;
}
/** Footage backup folders (Storage) + the background verification. */
export interface BackupInfo {
  lokasi: { location_id: string; nama: string; path?: string; registered_at: number; terverifikasi: number; terakhir: number | null }[];
  verifikasi: { location_id: string | null; state: 'idle' | 'berjalan' | 'selesai' | 'gagal'; started_at: number | null; finished_at: number | null; hasil: { scanned: number; hashed: number; matched: number } | null; alasan: string | null };
}
/** R16 Beat Spot settings (contract §16), the team's choices included. */
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
export interface EngineBeatspotStart {
  mode: 'beatspot';
  sources: { kunci: string; ref: { media_id: string; version_id: string } }[];
  beatspot: Partial<BeatspotSettings>;
  preset?: string;
  audio_pilihan?: AudioPilihan;
}
export interface BeatspotCut {
  no: number;
  mulai: number;
  durasi: number;
  shot: string;
  footage: string;
  in: number;
  skor: number | null;
  alasan: string;
  sumber_orang: 'kreator' | 'umum';
}
export interface BeatspotCandidate {
  id: string;
  footage: string;
  dari: number;
  sampai: number;
  orang: number | null;
  framing: string;
  skor: number | null;
  dipakai: boolean;
  sumber_orang: 'kreator' | 'umum';
}
export interface BeatspotView {
  job_id: string;
  laporan: { bpm: number; sumber_ketukan: string; ketukan_per_potong: number; durasi: number; end_card_dtk: number; potongan: BeatspotCut[]; kandidat: BeatspotCandidate[]; dibuang: { id: string; alasan: string }[] } | null;
  pengaturan: BeatspotSettings | null;
  sumber: { kunci: string; id: string; nama: string; sound: boolean }[];
}
/** R11 Motion Transfer: one reference video + a Brand Kit product → scenes + prompts to copy. */
export interface EngineTransferStart {
  mode: 'transfer';
  sources: [{ kunci: '$sumber'; ref: { media_id: string; version_id: string } }];
  produk?: string;
  deskripsi_produk?: string;
}
export interface TransferScene {
  /** Engine scene numbers ("3" or "3+4"). */
  id: string;
  nos: number[];
  dari: number;
  sampai: number;
  durasi: number;
  gambar_no: number;
  prompt_gambar: string;
  prompt_gerak: string;
  sumber: 'mesin' | 'tim';
}
export interface TransferView {
  job_id: string;
  referensi: string;
  durasi: number;
  produk: string;
  catatan: string;
  adegan: TransferScene[];
  jumlah_mesin: number;
  diubah: boolean;
  versi: number;
}
/** Pisah Audio + Shot Library: the project's uploaded videos → one batch in the engine. */
export interface EnginePisahStart {
  mode: 'pisah';
  sources: { kunci: string; ref: { media_id: string; version_id: string } }[];
  pisah: { batch: string; video_saja?: boolean };
}
export interface PisahResult {
  batch: string | null;
  files: { file: string; video: boolean; vokal: boolean; musik: boolean }[];
  /** Uploads the engine skipped (broken / not a video). */
  ditolak: { file: string; alasan: string }[];
  alasan: string | null;
}
/** One batch in the engine's konten/ (`engine daftar_batch`). */
export interface EngineBatchInfo {
  batch: string;
  upload: number;
  footage: number;
  vo: number;
  musik: number;
  dipisah: boolean;
  dipisah_pada: number | null;
  shot_library: boolean;
  jumlah_shot: number;
  siap_batch: boolean;
}
export interface LibraryShot {
  id: string;
  footage: string;
  dari: number;
  sampai: number;
  label: Record<string, string | number | boolean>;
  tag: string[];
  ucapan: string | null;
  teks: string[];
  thumb: boolean;
  koreksi: boolean;
}
export interface ShotLibrary {
  batch: string;
  footage: { id: string; durasi: number | null }[];
  shots: LibraryShot[];
}
export interface BatchLine {
  teks: string;
  dari: number;
  sampai: number;
  shot: string[];
}
/** Engine plan summary (KONTRAK-ENGINE §5.1); every field optional — the engine writes it. */
export interface EngineRencana {
  status?: string;
  /** target null = no length limit (owner, 13 Nov); saran = the preset's suggestion, info only. */
  durasi?: { mentah?: number; akhir?: number; target?: number[] | null; saran?: number[] | null };
  dibuang?: { dari?: number; sampai?: number; jenis?: string; teks?: string }[];
  hook?: { teks?: string };
  kata_kunci?: { teks?: string; detik?: number }[];
  efek?: { jenis?: string }[];
  audio?: { sfx?: number; musik?: string | null; alasan_tanpa_musik?: string | null; lisensi_musik?: string | null };
  posisi_caption?: number | null;
  cta?: string;
  menunggu_u3?: string[];
}
export interface EngineQc {
  butir: { butir: string; lulus: boolean; nilai?: unknown }[];
}
export interface BatchRow {
  id: string;
  vo?: string;
  hook?: string;
  shot?: string[];
  musik?: string | null;
  durasi?: number;
  cta?: string;
  bukan_iklan?: boolean;
  qc_lulus?: boolean;
  /** VO sentence → shots (engine), or the subtitle clips of ops.json (`ops`, no shots). */
  kalimat?: BatchLine[];
  kalimat_sumber?: 'mesin' | 'ops' | null;
  /** Contract v0.3.3 §10: the engine found this row invalid (reason); never approvable. */
  rusak?: string;
}
export type BatchRowStatus = 'usul' | 'disetujui' | 'dicoret';
/** A row's saved decision; `rusak` = the engine's plan cannot become a timeline (row stays unapproved). */
export interface BatchDecision {
  status: BatchRowStatus;
  project_id: string | null;
  rusak?: string;
}
export interface BatchTable {
  batch?: string;
  jumlah_diminta?: number;
  jumlah_jadi?: number;
  alasan_kurang?: string | null;
  vo_batch?: string | null;
  varian: BatchRow[];
}

/** Paket 1 timeline visuals (server: packages/core/src/storage/visuals.ts). */
export interface MediaVisuals {
  version_id: string;
  duration_ms: number;
  /** base64, one byte 0–255 per bucket_ms; null = no audio. */
  peaks: { bucket_ms: number; data: string } | null;
  /** One JPEG (base64) with `count` frames side by side; frame i = source time i*interval_ms. */
  thumbs: { interval_ms: number; count: number; frame_w: number; frame_h: number; jpeg: string } | null;
}

export function createApi(token: string | null, base = '') {
  const authHeaders = (): Record<string, string> => ({ 'x-motion-request': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  async function call<T>(method: string, path: string, init: { json?: unknown; body?: Blob | File; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...authHeaders(), ...init.headers };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) body = init.body;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Server tidak bisa dihubungi. Pastikan server masih jalan.');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
    if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'UNKNOWN', data.error?.message ?? `HTTP ${res.status}`);
    return data;
  }

  return {
    session: () => call<Session>('GET', '/api/session'),
    logout: () => call<{ ok: true }>('POST', '/api/auth/logout', { json: {} }),
    projects: () => call<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
    createProject: (name: string, fitur?: ProjectFitur) => call<{ project: ProjectSummary }>('POST', '/api/projects', { json: fitur ? { name, fitur } : { name } }).then((r) => r.project),
    project: (id: string) => call<{ project: Project }>('GET', `/api/projects/${encodeURIComponent(id)}`).then((r) => r.project),
    brand: () => call<{ brand: BrandKit }>('GET', '/api/brand').then((r) => r.brand),
    saveBrand: (expected_revision: number, kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', '/api/brand', { json: { expected_revision, kit } }).then((r) => r.brand),
    // U1: brands
    brands: () => call<{ brands: BrandKit[]; default_id: string | null }>('GET', '/api/brands'),
    brandById: (id: string) => call<{ brand: BrandKit }>('GET', `/api/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
    /** R36: pairs learned from editor corrections (+ ignored words). */
    kamusBelajar: (id: string) => call<{ pasangan: KamusBelajarPasangan[]; abaikan: string[] }>('GET', `/api/brands/${encodeURIComponent(id)}/kamus-belajar`),
    createBrand: (kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', '/api/brands', { json: { kit } }).then((r) => r.brand),
    saveBrandById: (id: string, expected_revision: number, kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', `/api/brands/${encodeURIComponent(id)}`, { json: { expected_revision, kit } }).then((r) => r.brand),
    /** R13: copy a Brand Kit (with presets) as a new brand. */
    duplicateBrand: (id: string, name: string, kode?: string) =>
      call<{ brand: BrandKit }>('POST', `/api/brands/${encodeURIComponent(id)}/duplicate`, { json: { name, ...(kode ? { kode } : {}) } }).then((r) => r.brand),
    setDefaultBrand: (id: string) => call<{ default_id: string }>('POST', `/api/brands/${encodeURIComponent(id)}/default`, { json: {} }),
    deleteBrand: (id: string) => call<{ deleted: string }>('POST', `/api/brands/${encodeURIComponent(id)}/delete`, { json: {} }),
    exportBrand: (id: string) => call<{ export: Record<string, unknown> }>('GET', `/api/brands/${encodeURIComponent(id)}/export`).then((r) => r.export),
    /** X05: rename and/or archive (read-only) / activate. */
    updateProject: (id: string, expected_revision: number, patch: { name?: string; status?: 'active' | 'archived'; brand_id?: string | null; fitur?: ProjectFitur }) =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/meta`, { json: { expected_revision, ...patch } }).then((r) => r.project),
    duplicateProject: (id: string, name?: string) =>
      call<{ project: ProjectSummary }>('POST', `/api/projects/${encodeURIComponent(id)}/duplicate`, { json: name ? { name } : {} }).then((r) => r.project),
    exportProject: (id: string) => call<{ export: ProjectExport }>('GET', `/api/projects/${encodeURIComponent(id)}/export`).then((r) => r.export),
    importProject: (data: unknown, name?: string) => call<{ project: ProjectSummary; remapped: number }>('POST', '/api/projects/import', { json: name ? { data, name } : { data } }),
    /** Server applies the ops atomically and returns the new revision (409 CONFLICT if stale). */
    editProject: (id: string, expected_revision: number, ops: EditOp[]) =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/edit`, { json: { expected_revision, ops } }).then((r) => r.project),
    stepHistory: (id: string, expected_revision: number, direction: 'undo' | 'redo') =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/${direction}`, { json: { expected_revision } }).then((r) => r.project),
    media: (q: { scope?: 'all' | 'shared' | 'project'; project_id?: string } = {}) => {
      const p = new URLSearchParams();
      if (q.scope) p.set('scope', q.scope);
      if (q.project_id) p.set('project_id', q.project_id);
      return call<{ media: Media[] }>('GET', `/api/media?${p}`).then((r) => r.media);
    },
    /** Upload with progress (XHR: fetch has no upload progress). Bytes go raw; the server hashes them. */
    /** R18 §17.4: the example presets ("Isi contoh preset Aysilla"). */
    presetContoh: () => call<{ presets: BrandPreset[] }>('GET', '/api/preset-contoh').then((r) => r.presets),
    backup: () => call<BackupInfo>('GET', '/api/backup'),
    backupAdd: (folder: string) => call<BackupInfo>('POST', '/api/backup/lokasi', { json: { path: folder } }),
    backupVerify: (locationId: string) => call<BackupInfo>('POST', `/api/backup/lokasi/${encodeURIComponent(locationId)}/verifikasi`, { json: {} }),
    /** Upload queue on the server (all pages / team members): one running, how many waiting. */
    importQueue: () => call<{ berjalan: boolean; menunggu: number }>('GET', '/api/media/import/antrean'),
    importFile: (file: File, scope: { kind: 'shared' } | { kind: 'project'; project_id: string }, onProgress?: (fraction: number) => void) => {
      const p = new URLSearchParams({ scope: scope.kind });
      if (scope.kind === 'project') p.set('project_id', scope.project_id);
      return new Promise<{ media_id: string; version: Version; duplicate: boolean }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/api/media/import?${p}`);
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload terputus. Pastikan server masih jalan.'));
        xhr.onload = () => {
          let data: { error?: { code: string; message: string } } = {};
          try {
            data = JSON.parse(xhr.responseText || '{}');
          } catch {
            /* non-JSON reply */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data as { media_id: string; version: Version; duplicate: boolean });
          else reject(new ApiError(xhr.status, data.error?.code ?? 'UNKNOWN', data.error?.message ?? `HTTP ${xhr.status}`));
        };
        xhr.send(file);
      });
    },
    trash: () => call<{ items: TrashItem[] }>('GET', '/api/trash').then((r) => r.items),
    restore: (versionId: string, opts: { on_conflict?: 'ask' | 'alternate' } = {}) =>
      call<{ result: { status: 'restored' | 'conflict' | 'failed'; reason?: string; wanted?: string; suggested?: string } }>('POST', `/api/trash/${encodeURIComponent(versionId)}/restore`, { json: opts }).then((r) => r.result),
    preparePurge: (versionIds: string[]) => call<{ plan: PurgePlan }>('POST', '/api/purge/prepare', { json: { version_ids: versionIds } }).then((r) => r.plan),
    executePurge: (plan: PurgePlan, typedPhrase: string) =>
      call<{ result: { purged: string[]; blocked: { version_id: string; reasons: string[] }[]; freed_bytes: number } }>('POST', '/api/purge/execute', {
        json: { request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: typedPhrase },
      }).then((r) => r.result),
    /** Paket 1: waveform + thumbnail strip of one media version (made once on the server, cached). */
    mediaVisuals: (versionId: string) => call<{ visuals: MediaVisuals }>('GET', `/api/media/${encodeURIComponent(versionId)}/visuals`).then((r) => r.visuals),
    /** Short-lived signed playback URL for one media version (W07). */
    /** R14: ask for the light preview copy (made in the background). */
    makeProxy: (versionId: string) => call<{ proxy: 'siap' | 'proses' | 'tidak_perlu' }>('POST', `/api/media/${encodeURIComponent(versionId)}/proxy`, { json: {} }).then((r) => r.proxy),
    streamUrl: (versionId: string, opts: { stabil?: string } = {}) => call<{ url: string; expires_at: number; mime: string; stabil?: string }>('GET', `/api/media/${encodeURIComponent(versionId)}/stream-url${opts.stabil ? `?stabil=${encodeURIComponent(opts.stabil)}` : ''}`),
    /** R23f: stabilised copy of a video version (background job). */
    stabilStatus: (versionId: string, level: string) => call<{ stabil: 'siap' | 'proses' | 'gagal' | null; alasan: string | null }>('GET', `/api/media/${encodeURIComponent(versionId)}/stabil?level=${encodeURIComponent(level)}`),
    stabilStart: (versionId: string, level: string) => call<{ stabil: 'siap' | 'proses' }>('POST', `/api/media/${encodeURIComponent(versionId)}/stabil`, { json: { level } }),
    copilotPlan: (id: string, body: { prompt: string; selected_clip_ids?: string[]; playhead_ms?: number; mode?: 'local' | 'auto' | 'ai' }) =>
      call<PlanReply>('POST', `/api/projects/${encodeURIComponent(id)}/copilot/plan`, { json: body }),
    copilotApply: (id: string, planId: string, expected_revision: number, accept?: number[]) =>
      call<ApplyReply>('POST', `/api/projects/${encodeURIComponent(id)}/copilot/plans/${encodeURIComponent(planId)}/apply`, { json: { expected_revision, ...(accept ? { accept } : {}) } }),
    /** Diff of exactly the ticked operations (Checkpoint E E7). */
    copilotPreview: (id: string, planId: string, accept: number[]) =>
      call<{ diff: DiffItem[] }>('POST', `/api/projects/${encodeURIComponent(id)}/copilot/plans/${encodeURIComponent(planId)}/preview`, { json: { accept } }).then((r) => r.diff),
    copilotReject: (id: string, planId: string) => call<{ status: string }>('POST', `/api/projects/${encodeURIComponent(id)}/copilot/plans/${encodeURIComponent(planId)}/reject`, { json: {} }),
    aiProviders: () => call<{ connections: AiConnection[]; settings: AiSettings; catalog: AiCatalogItem[] }>('GET', '/api/ai/providers'),
    aiAdd: (body: { provider: ProviderId; label?: string; model: string; api_key?: string; capabilities: Capability[]; base_url?: string; prices: Prices }) =>
      call<{ connection: AiConnection }>('POST', '/api/ai/providers', { json: body }).then((r) => r.connection),
    aiUpdate: (id: string, patch: Partial<Pick<AiConnection, 'label' | 'model' | 'capabilities' | 'priority' | 'enabled' | 'prices'>>) =>
      call<{ connection: AiConnection }>('POST', `/api/ai/providers/${encodeURIComponent(id)}`, { json: patch }).then((r) => r.connection),
    aiRotate: (id: string, api_key: string) => call<{ connection: AiConnection }>('POST', `/api/ai/providers/${encodeURIComponent(id)}/key`, { json: { api_key } }).then((r) => r.connection),
    aiTest: (id: string) => call<{ result: { ok: boolean; models: number | null; model_listed: boolean | null; error: { class: string; status: number | null; message: string } | null }; connection: AiConnection }>('POST', `/api/ai/providers/${encodeURIComponent(id)}/test`, { json: {} }),
    aiRemove: (id: string) => call<{ ok: true }>('DELETE', `/api/ai/providers/${encodeURIComponent(id)}`),
    team: () => call<{ members: TeamMember[]; me: string | null; max: number }>('GET', '/api/team'),
    teamAdd: (email: string, role: Role) => call<{ member: TeamMember; members: TeamMember[] }>('POST', '/api/team', { json: { email, role } }),
    teamSetRole: (email: string, role: Role) => call<{ member: TeamMember; members: TeamMember[] }>('PUT', '/api/team', { json: { email, role } }),
    teamRemove: (email: string) => call<{ removed: string; members: TeamMember[] }>('DELETE', '/api/team', { json: { email } }),
    // R12a: AI gambar (Motion Transfer stage 2) — owner only; the key is never returned.
    imageAi: () => call<{ gambar: ImageAiView }>('GET', '/api/ai/gambar').then((r) => r.gambar),
    saveImageAi: (cfg: { provider: string | null; endpoint?: string | null; model?: string | null; budget?: { amount: number | null; currency: 'IDR' | 'USD' } }) =>
      call<{ gambar: ImageAiView }>('POST', '/api/ai/gambar', { json: cfg }).then((r) => r.gambar),
    setImageAiKey: (api_key: string | null) => call<{ gambar: ImageAiView }>('POST', '/api/ai/gambar/key', { json: { api_key } }).then((r) => r.gambar),
    testImageAi: () => call<{ gambar: ImageAiView }>('POST', '/api/ai/gambar/tes', { json: {} }).then((r) => r.gambar),
    aiSettings: (patch: Partial<Omit<AiSettings, 'budget'>> & { budget?: Partial<AiSettings['budget']> }) => call<{ settings: AiSettings }>('POST', '/api/ai/settings', { json: patch }).then((r) => r.settings),
    aiUsage: () => call<{ usage: AiUsage }>('GET', '/api/ai/usage').then((r) => r.usage),
    aiLog: () => call<{ entries: AiLogEntry[] }>('GET', '/api/ai/log').then((r) => r.entries),
    // Captions / speech-to-text (W14)
    transcripts: (id: string) => call<{ transcripts: TranscriptSummary[]; jobs: SttJob[] }>('GET', `/api/projects/${encodeURIComponent(id)}/transcripts`),
    transcriptEstimate: (id: string, version_id: string) =>
      call<{ minutes: number; estimate_usd: number | null; provider: { connection_id: string; provider: string; model: string; label: string } | null; unavailable: string | null }>('POST', `/api/projects/${encodeURIComponent(id)}/transcripts/estimate`, { json: { version_id } }),
    transcriptStart: (id: string, version_id: string, language: 'id' | 'en' | 'auto', confirm_usd: number, connection_id: string) =>
      call<{ job: SttJob }>('POST', `/api/projects/${encodeURIComponent(id)}/transcripts`, { json: { version_id, language, confirm_usd, connection_id } }).then((r) => r.job),
    transcript: (id: string, tid: string) => call<{ transcript: TranscriptFull }>('GET', `/api/projects/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(tid)}`).then((r) => r.transcript),
    transcriptSave: (id: string, tid: string, expected_rev: number, cues: { cue_id?: string; start_ms: number; end_ms: number; text: string }[]) =>
      call<{ transcript: TranscriptFull }>('POST', `/api/projects/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(tid)}`, { json: { expected_rev, cues } }).then((r) => r.transcript),
    variants: (id: string) => call<{ variants: VariantRow[] }>('GET', `/api/projects/${encodeURIComponent(id)}/variants`).then((r) => r.variants),
    createVariants: (id: string, briefs: { label?: string; ratio?: string; hook?: string; cta?: string }[]) =>
      call<{ variants: VariantRow[] }>('POST', `/api/projects/${encodeURIComponent(id)}/variants`, { json: { briefs } }).then((r) => r.variants),
    setVariantApproval: (id: string, expected_revision: number, approved: boolean) =>
      call<{ project: Project }>('POST', `/api/projects/${encodeURIComponent(id)}/variant-approval`, { json: { expected_revision, approved } }).then((r) => r.project),
    renderVariants: (id: string, opts: { short_side?: 720 | 1080 }) =>
      call<{ jobs: RenderJob[]; skipped: { project_id: string; reason: string }[] }>('POST', `/api/projects/${encodeURIComponent(id)}/variants/render`, { json: opts }),
    analyzeMedia: (versionId: string, params: Partial<MediaAnalysis['params']>) =>
      call<{ analysis: MediaAnalysis }>('POST', `/api/media/${encodeURIComponent(versionId)}/analyze`, { json: { params } }).then((r) => r.analysis),
    cutPlan: (id: string, body: { clip_id: string; silences: { from_ms: number; to_ms: number }[]; scenes: number[]; padding_ms: number }) =>
      call<PlanReply>('POST', `/api/projects/${encodeURIComponent(id)}/cuts/plan`, { json: body }),
    transcriptSubtitles: (id: string, tid: string) => call<PlanReply>('POST', `/api/projects/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(tid)}/subtitles`, { json: {} }),
    dashboard: () => call<{ dashboard: Dashboard }>('GET', '/api/dashboard').then((r) => r.dashboard),
    // Render MP4 (W08)
    renderTools: () => call<RenderTools>('GET', '/api/render/tools'),
    brandCheck: (id: string) => call<{ today: string; issues: GuardIssue[] }>('GET', `/api/projects/${encodeURIComponent(id)}/brand-check`),
    startRender: (id: string, opts: { output_name?: string; short_side?: 720 | 1080; accept_brand_warnings?: boolean }) =>
      call<{ job: RenderJob }>('POST', `/api/projects/${encodeURIComponent(id)}/render`, { json: opts }).then((r) => r.job),
    renders: (id: string) => call<{ jobs: RenderJob[]; outputs: RenderOutputFile[] }>('GET', `/api/projects/${encodeURIComponent(id)}/renders`),
    allOutputs: (o: { q?: string; master?: string; offset?: number; limit?: number } = {}) =>
      call<{ outputs: OutputItem[]; total: number; offset: number; limit: number }>(
        'GET',
        `/api/outputs?${new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`,
      ),
    renderJob: (jobId: string) => call<{ job: RenderJob }>('GET', `/api/render/jobs/${encodeURIComponent(jobId)}`).then((r) => r.job),
    cancelRender: (jobId: string) => call<{ job: RenderJob }>('POST', `/api/render/jobs/${encodeURIComponent(jobId)}/cancel`, { json: {} }).then((r) => r.job),
    /** Short-lived signed link to play (or download) one finished output. */
    // U7 review
    review: (id: string) => call<{ review: ReviewInfo }>('GET', `/api/projects/${encodeURIComponent(id)}/review`).then((r) => r.review),
    addComment: (id: string, at_ms: number, text: string) => call<{ comment: ReviewComment }>('POST', `/api/projects/${encodeURIComponent(id)}/comments`, { json: { at_ms, text } }).then((r) => r.comment),
    resolveComment: (id: string, commentId: string, resolved: boolean) =>
      call<{ comment: ReviewComment }>('POST', `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { json: { resolved } }).then((r) => r.comment),
    decideReview: (id: string, expected_revision: number, status: 'lulus' | 'revisi', note?: string) =>
      call<{ state: ReviewInfo['state']; variant_approved?: boolean }>('POST', `/api/projects/${encodeURIComponent(id)}/review`, { json: { expected_revision, status, ...(note ? { note } : {}) } }),
    // U6 engine runner
    engineInfo: () => call<{ installed: boolean; running: number; waiting: number }>('GET', '/api/engine'),
    /** R34 Suara dari Teks: the engine's voices, a tts job, its voice over, a VO's known text. */
    engineSuara: () => call<{ tersedia: boolean; suara: TtsVoice[] }>('GET', '/api/engine/suara'),
    engineTts: (id: string, tts: { teks?: string; kalimat?: string[]; suara: string; kecepatan: number; jeda_ms: number }) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: { mode: 'tts', tts } }).then((r) => r.job),
    suaraOwner: () => call<{ suara_owner: SuaraOwnerList }>('GET', '/api/suara-owner').then((r) => r.suara_owner),
    suaraOwnerAdd: (contoh: { media_id: string; version_id: string }[]) => call<{ suara_owner: SuaraOwnerList }>('POST', '/api/suara-owner/contoh', { json: { contoh } }).then((r) => r.suara_owner),
    suaraOwnerRemove: (mediaId: string) => call<{ suara_owner: SuaraOwnerList }>('DELETE', `/api/suara-owner/contoh/${encodeURIComponent(mediaId)}`).then((r) => r.suara_owner),
    /** `latih` false = only check the samples; true = train the owner's voice. */
    suaraProfil: (projectId: string, contoh: { media_id: string; version_id: string }[], latih: boolean, hapus: string[]) =>
      call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(projectId)}/engine/jobs`, {
        json: { mode: 'suara_profil', sources: contoh.map((r) => ({ kunci: `$media:${r.media_id}`, ref: r })), suara_profil: { latih, ...(hapus.length ? { hapus_contoh: hapus } : {}) } },
      }).then((r) => r.job),
    suaraProfilResult: (projectId: string, jobId: string) => call<{ suara_profil: SuaraProfilView }>('GET', `/api/projects/${encodeURIComponent(projectId)}/engine/jobs/${encodeURIComponent(jobId)}/suara-profil`).then((r) => r.suara_profil),
    ttsResult: (id: string, jobId: string) => call<{ tts: TtsView }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/tts`).then((r) => r.tts),
    /** R35 Visual Tools (contract §18.10). */
    engineVisual: (id: string, ref: { media_id: string; version_id: string }, visual: Record<string, unknown>) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: { mode: 'visual', ref, visual } }).then((r) => r.job),
    visualResult: (id: string, jobId: string) => call<{ visual: VisualView }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/visual`).then((r) => r.visual),
    voIndex: (versionId: string) => call<{ vo: VoIndex | null }>('GET', `/api/vo/${encodeURIComponent(versionId)}`).then((r) => r.vo),
    /** R25: projects whose newest Generate plan is ready but not applied. */
    rencanaTertunda: () => call<{ tertunda: { project_id: string; job_id: string; mode: EngineJob['mode'] }[] }>('GET', '/api/engine/rencana-tertunda').then((r) => r.tertunda),
    engineJobs: (id: string) => call<{ jobs: EngineJob[] }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs`).then((r) => r.jobs),
    engineStart: (id: string, body: EngineStart) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: body }).then((r) => r.job),
    engineJob: (id: string, jobId: string) => call<{ job: EngineJob; log: string | null }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}`),
    /** R1: "Tetap lanjut" — a new Generate job that skips the engine's song check. */
    engineContinue: (id: string, jobId: string) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/lanjut`, { json: {} }).then((r) => r.job),
    engineCancel: (id: string, jobId: string) => call<{ ok?: true; job?: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/cancel`, { json: {} }),
    enginePlan: (id: string, jobId: string, variant?: string) =>
      call<PlanReply & { rencana: EngineRencana; qc: EngineQc | null }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/plan`, { json: variant ? { variant } : {} }),
    engineBatch: (id: string, jobId: string) =>
      call<{ batch: BatchTable; decisions: Record<string, BatchDecision> }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/batch`),
    engineDecide: (id: string, jobId: string, rows: { varian: string; status: BatchRowStatus }[]) =>
      call<{ decisions: Record<string, BatchDecision> }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/batch/decide`, { json: { rows } }).then((r) => r.decisions),
    // R16 Beat Spot
    engineBeatspot: (id: string, body: EngineBeatspotStart) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: body }).then((r) => r.job),
    beatspot: (id: string, jobId: string) => call<{ beatspot: BeatspotView }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/beatspot`).then((r) => r.beatspot),
    beatspotRerun: (id: string, jobId: string, beatspot: BeatspotSettings) =>
      call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/beatspot/ulang`, { json: { beatspot } }).then((r) => r.job),
    // R11 Motion Transfer
    engineTransfer: (id: string, body: EngineTransferStart) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: body }).then((r) => r.job),
    transfer: (id: string, jobId: string) => call<{ transfer: TransferView }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/transfer`).then((r) => r.transfer),
    transferEdit: (id: string, jobId: string, aksi: 'hapus' | 'gabung' | 'pulihkan', expected_versi: number, sceneId?: string) =>
      call<{ transfer: TransferView }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/transfer/edit`, { json: { aksi, expected_versi, ...(sceneId ? { id: sceneId } : {}) } }).then((r) => r.transfer),
    /** A scene frame as a Blob (an <img> cannot send the session header). */
    transferImage: async (id: string, jobId: string, no: number): Promise<Blob> => {
      let res: Response;
      try {
        res = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/transfer/gambar/${no}`, { headers: authHeaders() });
      } catch {
        throw new ApiError(0, 'NETWORK', 'Server tidak bisa dihubungi. Pastikan server masih jalan.');
      }
      if (!res.ok) throw new ApiError(res.status, 'NOT_FOUND', 'Gambar adegan tidak bisa dimuat');
      return res.blob();
    },
    // Batch Remix library (Pisah Audio, batch list, Shot Library)
    enginePisah: (id: string, body: EnginePisahStart) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: body }).then((r) => r.job),
    enginePisahResult: (id: string, jobId: string) => call<{ pisah: PisahResult }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/pisah`).then((r) => r.pisah),
    engineBatches: () => call<{ tersedia: boolean; batches: EngineBatchInfo[]; alasan: string | null }>('GET', '/api/engine/batches'),
    engineShots: (batch: string) => call<{ library: ShotLibrary; kecualikan: string[] }>('GET', `/api/engine/batches/${encodeURIComponent(batch)}/shots`),
    engineThumbs: (batch: string, ids: string[]) => call<{ thumbs: Record<string, string> }>('GET', `/api/engine/batches/${encodeURIComponent(batch)}/thumbs?ids=${encodeURIComponent(ids.join(','))}`).then((r) => r.thumbs),
    engineSetExcluded: (batch: string, shots: string[]) => call<{ kecualikan: string[] }>('POST', `/api/engine/batches/${encodeURIComponent(batch)}/kecualikan`, { json: { shots } }).then((r) => r.kecualikan),
    outputUrl: (id: string, name: string, download = false) =>
      call<{ url: string; expires_at: number }>('GET', `/api/projects/${encodeURIComponent(id)}/output-url?${new URLSearchParams({ name, ...(download ? { download: '1' } : {}) })}`),
  };
}

export type Api = ReturnType<typeof createApi>;
