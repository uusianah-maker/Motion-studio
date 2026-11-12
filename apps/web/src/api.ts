import type { TextStyle } from '../../../packages/core/dist/storage/textStyle.js';
/**
 * Typed client for the server API (apps/server). Local mode: URL token (memory/sessionStorage only).
 * Google mode (W09): no token at all; the HttpOnly session cookie travels by itself, and every call
 * carries `x-motion-request: 1`, which the server requires (a cross-site page cannot send it).
 */

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
  jenis: 'sfx' | 'musik' | 'broll' | 'logo' | 'penutup' | 'lainnya';
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
  caption: { mode: 'per_kata' | 'kalimat'; maks_kata: number; pop_ms: number };
  hook: { teks: boolean; maks_kata: number; dari_ucapan: boolean };
  efek: { wajib: string[]; boleh: string[]; jangan: string[]; maks: number; jarak_dtk: number };
  audio: { suara_asli: boolean; sfx: string; musik: string; lufs: number };
  qc: string[];
}
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
  outro: { ref: Ref | null; detik: number };
  gaya: string;
  grading: string;
  cta: Partial<Record<Platform, string>>;
  cta_wajib: string;
  disclaimer: { teks: string; kapan: 'selalu' | 'varian_warna' | 'harga' | 'manual' } | null;
  kosakata: string[];
  kamus: { salah: string; benar: string }[];
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

export interface ProjectSummary {
  project_id: string;
  name?: string;
  status?: 'active' | 'archived';
  /** X09: set on variant projects. */
  variant?: VariantTag;
  /** U1: the project's brand (missing = workspace default brand). */
  brand_id?: string;
  revision?: number;
  created_at?: number;
  updated_at?: number;
  error?: string;
}

export interface Clip {
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
}
export type Crop = { x: number; y: number; w: number; h: number };
export type BlurRegion = Crop & { dari_ms: number; sampai_ms: number; radius: number };
export type ClipEffect = { type: 'zoom'; scale: number; mode: 'cut' | 'smooth'; x: number; y: number } | { type: 'zoom_through'; scale: number; x: number; y: number };

export type EditOp =
  | { op: 'add_clip'; track_kind: Track['kind']; media?: { media_id: string; version_id: string }; text?: string; style?: Partial<TextStyle>; start_ms: number; duration_ms: number; in_ms?: number; volume?: number; words?: { text: string; start_ms: number; end_ms: number }[]; effect?: ClipEffect; crop?: Crop; blur?: BlurRegion[] }
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
  | { op: 'set_loudness'; lufs: number | null };
export interface Track {
  track_id: string;
  kind: 'video' | 'broll' | 'text' | 'subtitle' | 'audio' | 'music' | 'sfx' | 'effects';
  clips: Clip[];
  /** X04: media track silenced in preview and render. */
  muted?: boolean;
}
export interface Project extends Required<Omit<ProjectSummary, 'error' | 'variant' | 'brand_id'>> {
  brand_id?: string;
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
  probe?: { duration_ms: number; width: number | null; height: number | null; video_codec: string | null; audio_codec: string | null } | null;
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
  gc: { ok: boolean; errors: string[]; summary: Record<string, number>; candidates: number; next_eligible: { version_id: string; eligible_at: number }[] };
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
export interface EngineJob {
  job_id: string;
  project_id: string;
  mode: 'generate' | 'batch' | 'ulang';
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
  batch?: { batch: string; jumlah: number; tujuan: string; hak_pakai_jelas?: boolean; akun_sendiri?: string[] };
}
/** Engine plan summary (KONTRAK-ENGINE §5.1); every field optional — the engine writes it. */
export interface EngineRencana {
  status?: string;
  durasi?: { mentah?: number; akhir?: number; target?: number[] };
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
}
export type BatchRowStatus = 'usul' | 'disetujui' | 'dicoret';
export interface BatchTable {
  batch?: string;
  jumlah_diminta?: number;
  jumlah_jadi?: number;
  alasan_kurang?: string | null;
  varian: BatchRow[];
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
    createProject: (name: string) => call<{ project: ProjectSummary }>('POST', '/api/projects', { json: { name } }).then((r) => r.project),
    project: (id: string) => call<{ project: Project }>('GET', `/api/projects/${encodeURIComponent(id)}`).then((r) => r.project),
    brand: () => call<{ brand: BrandKit }>('GET', '/api/brand').then((r) => r.brand),
    saveBrand: (expected_revision: number, kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', '/api/brand', { json: { expected_revision, kit } }).then((r) => r.brand),
    // U1: brands
    brands: () => call<{ brands: BrandKit[]; default_id: string | null }>('GET', '/api/brands'),
    brandById: (id: string) => call<{ brand: BrandKit }>('GET', `/api/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
    createBrand: (kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', '/api/brands', { json: { kit } }).then((r) => r.brand),
    saveBrandById: (id: string, expected_revision: number, kit: BrandKitInput) => call<{ brand: BrandKit }>('POST', `/api/brands/${encodeURIComponent(id)}`, { json: { expected_revision, kit } }).then((r) => r.brand),
    setDefaultBrand: (id: string) => call<{ default_id: string }>('POST', `/api/brands/${encodeURIComponent(id)}/default`, { json: {} }),
    deleteBrand: (id: string) => call<{ deleted: string }>('POST', `/api/brands/${encodeURIComponent(id)}/delete`, { json: {} }),
    exportBrand: (id: string) => call<{ export: Record<string, unknown> }>('GET', `/api/brands/${encodeURIComponent(id)}/export`).then((r) => r.export),
    /** X05: rename and/or archive (read-only) / activate. */
    updateProject: (id: string, expected_revision: number, patch: { name?: string; status?: 'active' | 'archived'; brand_id?: string | null }) =>
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
    /** Short-lived signed playback URL for one media version (W07). */
    streamUrl: (versionId: string) => call<{ url: string; expires_at: number; mime: string }>('GET', `/api/media/${encodeURIComponent(versionId)}/stream-url`),
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
    cancelRender: (jobId: string) => call<{ job: RenderJob }>('POST', `/api/render/jobs/${encodeURIComponent(jobId)}/cancel`, { json: {} }).then((r) => r.job),
    /** Short-lived signed link to play (or download) one finished output. */
    // U7 review
    review: (id: string) => call<{ review: ReviewInfo }>('GET', `/api/projects/${encodeURIComponent(id)}/review`).then((r) => r.review),
    addComment: (id: string, at_ms: number, text: string) => call<{ comment: ReviewComment }>('POST', `/api/projects/${encodeURIComponent(id)}/comments`, { json: { at_ms, text } }).then((r) => r.comment),
    resolveComment: (id: string, commentId: string, resolved: boolean) =>
      call<{ comment: ReviewComment }>('POST', `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { json: { resolved } }).then((r) => r.comment),
    decideReview: (id: string, expected_revision: number, status: 'lulus' | 'revisi', note?: string) =>
      call<{ state: ReviewInfo['state'] }>('POST', `/api/projects/${encodeURIComponent(id)}/review`, { json: { expected_revision, status, ...(note ? { note } : {}) } }),
    // U6 engine runner
    engineInfo: () => call<{ installed: boolean; running: number; waiting: number }>('GET', '/api/engine'),
    engineJobs: (id: string) => call<{ jobs: EngineJob[] }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs`).then((r) => r.jobs),
    engineStart: (id: string, body: EngineStart) => call<{ job: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs`, { json: body }).then((r) => r.job),
    engineJob: (id: string, jobId: string) => call<{ job: EngineJob; log: string | null }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}`),
    engineCancel: (id: string, jobId: string) => call<{ ok?: true; job?: EngineJob }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/cancel`, { json: {} }),
    enginePlan: (id: string, jobId: string, variant?: string) =>
      call<PlanReply & { rencana: EngineRencana; qc: EngineQc | null }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/plan`, { json: variant ? { variant } : {} }),
    engineBatch: (id: string, jobId: string) =>
      call<{ batch: BatchTable; decisions: Record<string, { status: BatchRowStatus; project_id: string | null }> }>('GET', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/batch`),
    engineDecide: (id: string, jobId: string, rows: { varian: string; status: BatchRowStatus }[]) =>
      call<{ decisions: Record<string, { status: BatchRowStatus; project_id: string | null }> }>('POST', `/api/projects/${encodeURIComponent(id)}/engine/jobs/${encodeURIComponent(jobId)}/batch/decide`, { json: { rows } }).then((r) => r.decisions),
    outputUrl: (id: string, name: string, download = false) =>
      call<{ url: string; expires_at: number }>('GET', `/api/projects/${encodeURIComponent(id)}/output-url?${new URLSearchParams({ name, ...(download ? { download: '1' } : {}) })}`),
  };
}

export type Api = ReturnType<typeof createApi>;
