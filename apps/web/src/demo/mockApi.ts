/**
 * Demo mode: the real UI over an in-browser fake of the server API. Sample data only, nothing is
 * saved or sent anywhere (no server, no AI calls, no render). Used to share how the app looks
 * and feels before it is online. The Copilot rule engine is the real one from the core.
 */
import { emptyKit } from '../brand';
import { checkBrandGuard, localDate, validateGuard } from '../../../../packages/core/dist/storage/brandGuard.js';
import { checkPlan, diffTimelines, planLocal } from '../../../../packages/core/dist/storage/copilot.js';
import { applyOps } from '../../../../packages/core/dist/storage/timeline.js';
import {
  type AiConnection,
  type AiLogEntry,
  type AiSettings,
  type Api,
  type ReviewComment,
  type TeamMember,
  type ReviewInfo,
  ApiError,
  type ApplyReply,
  type BrandKit,
  type VariantRow,
  type GuardIssue,
  type Clip,
  type Cue,
  type Dashboard,
  type EditOp,
  type EditPlan,
  type Media,
  type PlanReply,
  type Project,
  type ProjectSummary,
  type PurgePlan,
  type RenderJob,
  type SttJob,
  type TrashItem,
  type TranscriptFull,
  type Version,
} from '../api';

type Timeline = Project['timeline'];
const DAY = 86_400_000;
const now = () => Date.now();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 100;
const nid = (p: string) => `${p}_${(++seq).toString(16).padStart(16, '0')}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const team: TeamMember[] = [
  { email: 'owner@contoh.com', role: 'owner', source: 'env', added_at: null, added_by: null },
  { email: 'editor@contoh.com', role: 'editor', source: 'web', added_at: Date.now() - 3 * 86_400_000, added_by: 'owner@contoh.com' },
];
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};

// ------------------------------------------------------------------ sample media (embedded by the build)
declare global {
  interface Window {
    __DEMO_MEDIA__?: Record<string, string>;
  }
}
const blobUrls = new Map<string, string>();
function sampleUrl(key: string): string | null {
  if (blobUrls.has(key)) return blobUrls.get(key)!;
  const b64 = window.__DEMO_MEDIA__?.[key];
  if (!b64) return null;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  blobUrls.set(key, url);
  return url;
}

const version = (id: string, name: string, size: number, probe: Version['probe'], extra: Partial<Version> = {}): Version => ({
  version_id: id,
  original_name: name,
  size,
  content_hash: `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
  imported_at: now() - 3 * DAY,
  lifecycle: 'active',
  integrity: 'ok',
  ever_referenced: true,
  keep: false,
  pin: false,
  legal_hold: false,
  trashed_at: null,
  probe,
  preview: true,
  ...extra,
});

const V_HOOK = 'v_00000000000000a1';
const V_BROLL = 'v_00000000000000b1';
const V_OLD = 'v_00000000000000a0';
const media: Media[] = [
  {
    media_id: 'm_00000000000000a1',
    display_name: 'Hook-Produk.mp4',
    scope: { kind: 'shared' },
    created_at: now() - 5 * DAY,
    current_version_id: V_HOOK,
    versions: [version(V_HOOK, 'Hook-Produk.mp4', 121_584, { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' })],
  },
  {
    media_id: 'm_00000000000000b1',
    display_name: 'B-roll-Toko.mp4',
    scope: { kind: 'shared' },
    created_at: now() - 4 * DAY,
    current_version_id: V_BROLL,
    versions: [version(V_BROLL, 'B-roll-Toko.mp4', 22_741, { duration_ms: 3000, width: 640, height: 360, video_codec: 'h264', audio_codec: 'aac' })],
  },
];
const mediaUrl: Record<string, string> = { [V_HOOK]: 'hook', [V_BROLL]: 'broll' };
const trash: TrashItem[] = [
  {
    ...version(V_OLD, 'Hook-Produk-lama.mp4', 98_200, { duration_ms: 7000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' }, { lifecycle: 'trashed', trashed_at: now() - 2 * DAY, ever_referenced: true }),
    media_id: 'm_00000000000000a1',
    display_name: 'Hook-Produk.mp4',
    original_rel_path: 'SHARED_MEDIA/Hook-Produk-lama.mp4',
  },
];

// ------------------------------------------------------------------ projects + history
interface Stored {
  p: Project;
  undo: { t: Timeline; label: string }[];
  redo: { t: Timeline; label: string }[];
}
const hookRef = { media_id: 'm_00000000000000a1', version_id: V_HOOK };
const brollRef = { media_id: 'm_00000000000000b1', version_id: V_BROLL };
const projects = new Map<string, Stored>();
const demoBrand = (brand_id: string, name: string, kode: string, colors: string[], banned: string[]): BrandKit => ({
  ...emptyKit(),
  schema_version: 2,
  brand_id,
  revision: 1,
  updated_at: Date.now(),
  name,
  kode,
  colors,
  guard: { prices: [], banned, banned_level: 'block' },
});
const brandStore = new Map<string, BrandKit>([
  ['b-demo', demoBrand('b-demo', 'Toko Demo', 'TD', ['#7a1f5c', '#f4d35e'], ['paling murah'])],
  ['b-lucy', demoBrand('b-lucy', 'Lucy Pants', 'LCY', ['#1b998b'], [])],
]);
let defaultBrand = 'b-demo';
const brandOf = (id?: string | null) => brandStore.get(id ?? '') ?? brandStore.get(defaultBrand)!;
function addProject(id: string, name: string, tracks: Project['timeline']['tracks'], ageDays: number) {
  const t = now() - ageDays * DAY;
  projects.set(id, {
    p: { project_id: id, name, status: 'active', revision: 3, created_at: t, updated_at: t + 3_600_000, timeline: { tracks, canvas: { ratio: '9:16' } }, history: { undo: 0, redo: 0, undo_label: null, redo_label: null } },
    undo: [],
    redo: [],
  });
}
addProject(
  'promo-lebaran',
  'Promo Lebaran',
  [
    { track_id: 'video', kind: 'video', clips: [{ clip_id: 'c_v1', start_ms: 0, end_ms: 8000, in_ms: 0, media: hookRef }] },
    { track_id: 'broll', kind: 'broll', clips: [{ clip_id: 'c_b1', start_ms: 3000, end_ms: 5000, in_ms: 500, media: brollRef }] },
    { track_id: 'text', kind: 'text', clips: [{ clip_id: 'c_t1', start_ms: 0, end_ms: 2000, text: 'Diskon 50% hari ini!' }, { clip_id: 'c_t2', start_ms: 6000, end_ms: 8000, text: 'Cek keranjang kuning 👇' }] },
    { track_id: 'subtitle', kind: 'subtitle', clips: [{ clip_id: 'c_s1', start_ms: 2200, end_ms: 4600, text: 'Bahannya adem, nggak nerawang' }] },
  ],
  1,
);
addProject('talking-head', 'Talking Head Edukasi', [{ track_id: 'video', kind: 'video', clips: [{ clip_id: 'c_v9', start_ms: 0, end_ms: 8000, in_ms: 0, media: hookRef }] }], 3);

function variantRow(s: Stored): VariantRow {
  const job = renderJobs.find((j) => j.project_id === s.p.project_id) ?? null;
  const v = s.p.variant!;
  return {
    project_id: s.p.project_id,
    name: s.p.name,
    revision: s.p.revision,
    number: v.number,
    label: v.label ?? '',
    brief: {},
    state: v.approved_revision === null || v.approved_revision === undefined ? 'draft' : v.approved_revision === s.p.revision ? 'approved' : 'changed',
    ratio: s.p.timeline.canvas?.ratio ?? '9:16',
    render: job ? { job_id: job.job_id, status: job.status, progress: job.progress, output_name: job.output?.name ?? job.output_name, problems: job.problems, error: job.error } : null,
    outputs: (outputs.get(s.p.project_id) ?? []).length,
  };
}
const view = (s: Stored): Project => ({
  ...clone(s.p),
  history: { undo: s.undo.length, redo: s.redo.length, undo_label: s.undo.at(-1)?.label ?? null, redo_label: s.redo.at(-1)?.label ?? null },
});
const get = (id: string) => projects.get(id) ?? fail(404, 'NOT_FOUND', 'Proyek tidak ada');
const sourceDuration = (ref: { version_id: string }) => media.flatMap((m) => m.versions).find((v) => v.version_id === ref.version_id)?.probe?.duration_ms;

function commit(s: Stored, expected: number, ops: EditOp[], label: string): Project {
  if (s.p.revision !== expected) fail(409, 'CONFLICT', 'Revisi proyek sudah berubah; muat ulang dulu');
  if (s.p.status === 'archived') fail(422, 'PRECONDITION', 'Proyek diarsipkan (hanya-baca). Aktifkan lagi untuk mengedit.');
  let next: Timeline;
  try {
    next = applyOps(s.p.timeline, ops, () => nid('c'), sourceDuration) as Timeline;
  } catch (e) {
    fail(422, 'EDIT_INVALID', e instanceof Error ? e.message : 'Edit tidak valid');
  }
  s.undo.push({ t: clone(s.p.timeline), label });
  s.redo = [];
  s.p.timeline = next!;
  s.p.revision++;
  s.p.updated_at = now();
  return view(s);
}

const OP_LABEL: Record<EditOp['op'], string> = { add_clip: 'Tambah klip', move_clip: 'Geser klip', trim_clip: 'Trim klip', split_clip: 'Split klip', delete_clip: 'Hapus klip', set_text: 'Ubah teks', set_canvas: 'Ubah rasio', set_style: 'Ubah gaya teks', set_volume: 'Ubah volume', set_framing: 'Crop / blur', set_brand_logo: 'Logo brand', remove_range: 'Hapus jeda', split_at: 'Potong di adegan', set_loudness: 'Loudness', set_track_mute: 'Bisukan/nyalakan track', set_audio: 'Fade / reduksi noise', set_picture: 'Tampilan gambar', set_ducking: 'Ducking musik', set_keyframes: 'Keyframe' };

// ------------------------------------------------------------------ copilot plans
const plans = new Map<string, { plan: EditPlan; status: 'proposed' | 'applied' | 'rejected'; applied_revision: number | null }>();
function propose(projectId: string, source: EditPlan['source'], prompt: string, ops: unknown, rationale: string, warnings: string[], provider: EditPlan['provider'] = null, cost = 0): PlanReply {
  const s = get(projectId);
  let checked: { ops: EditOp[]; labels: string[]; diff: { kind: string; summary: string }[] };
  try {
    checked = checkPlan(s.p.timeline, ops, sourceDuration, source === 'transcript' || source === 'analysis' ? 1000 : undefined) as typeof checked;
  } catch (e) {
    return fail(422, 'EDIT_INVALID', e instanceof Error ? e.message : 'Rencana tidak valid');
  }
  const plan: EditPlan = {
    schema_version: 1,
    plan_id: nid('plan'),
    project_id: projectId,
    project_revision: s.p.revision,
    source,
    prompt,
    operations: checked.ops.map((op, i) => ({ op, label: checked.labels[i]! })),
    rationale,
    warnings,
    cost_estimate: { usd: cost, note: source === 'ai' ? 'biaya panggilan AI (simulasi demo)' : 'tanpa AI, tanpa biaya API' },
    requires_approval: true,
    provider,
    created_at: now(),
  };
  plans.set(plan.plan_id, { plan, status: 'proposed', applied_revision: null });
  return { plan, diff: checked.diff as PlanReply['diff'] & object };
}

// ------------------------------------------------------------------ AI (simulated)
const settings: AiSettings = { mode: 'auto', failover: true, max_retries: 2, timeout_ms: 60_000, cooldown_ms: 60_000, max_output_tokens: 8000, budget: { daily_usd: 1, monthly_usd: 10, per_request_usd: 0.25 } };
const conn = (c: Partial<AiConnection> & Pick<AiConnection, 'connection_id' | 'provider' | 'label' | 'model' | 'capabilities' | 'priority'>): AiConnection => ({
  base_url: null,
  enabled: true,
  prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 0 },
  key_hint: '…a1b2',
  has_key: true,
  status: 'ok',
  last_error: null,
  last_test_at: now() - DAY,
  cooldown_until: 0,
  cooling_down: false,
  ...c,
});
const connections: AiConnection[] = [
  conn({ connection_id: 'conn_demo_claude', provider: 'anthropic', label: 'Claude utama', model: 'claude-opus-5-5', capabilities: ['planner'], priority: 1, prices: { input_per_mtok: 4, output_per_mtok: 20, per_audio_minute: 0 } }),
  conn({ connection_id: 'conn_demo_whisper', provider: 'openai', label: 'Whisper', model: 'whisper-1', capabilities: ['transcription'], priority: 2, key_hint: '…c3d4', prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 0.006 } }),
];
const usage = { day: 0.0216, month: 0.1844, calls: 2 };
const log: AiLogEntry[] = [
  { ts: now() - 3_600_000, op: 'ai.call', outcome: 'ok', provider: 'anthropic', model: 'claude-opus-5-5', capability: 'planner', cost_usd: 0.0108, request_id: 'req_demo_2' },
  { ts: now() - 7_200_000, op: 'ai.call', outcome: 'ok', provider: 'anthropic', model: 'claude-opus-5-5', capability: 'planner', cost_usd: 0.0108, request_id: 'req_demo_1' },
  { ts: now() - DAY, op: 'ai.provider.test', outcome: 'ok', provider: 'anthropic' },
];
const catalog = [
  { provider: 'anthropic' as const, label: 'Anthropic (Claude)', base_url: 'https://api.anthropic.com', capabilities: ['planner' as const], key_required: true, model_hint: 'claude-opus-5-5' },
  { provider: 'openai' as const, label: 'OpenAI', base_url: 'https://api.openai.com', capabilities: ['planner' as const, 'transcription' as const], key_required: true, model_hint: 'gpt-… / whisper-1' },
  { provider: 'gemini' as const, label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com', capabilities: ['planner' as const], key_required: true, model_hint: 'gemini-…' },
  { provider: 'openai_compatible' as const, label: 'Kompatibel OpenAI (Ollama, LM Studio, …)', base_url: null, capabilities: ['planner' as const, 'transcription' as const], key_required: false, model_hint: 'nama model lokal' },
];

/** A plausible AI answer for prompts the rules don't know: a short text in the first free 2 s. */
function simulatedAiOps(t: Timeline, prompt: string): unknown[] {
  const used = (t.tracks.find((x) => x.kind === 'text')?.clips ?? []).map((c) => [c.start_ms, c.end_ms]);
  let start = 0;
  while (used.some(([a, b]) => a! < start + 2000 && start < b!)) start += 500;
  const words = prompt.replace(/["“”]/g, '').trim().split(/\s+/).slice(0, 5).join(' ');
  return [{ op: 'add_clip', track_kind: 'text', text: words ? `✨ ${words}` : '✨ Stok terbatas!', start_ms: start, duration_ms: 2000 }];
}

// ------------------------------------------------------------------ render + transcripts (simulated)
const renderJobs: RenderJob[] = [];
const outputs = new Map<string, { name: string; size: number; mtime_ms: number }[]>([['promo-lebaran', [{ name: 'Promo Lebaran.mp4', size: 2_840_112, mtime_ms: now() - DAY }]]]);
const sttJobs: SttJob[] = [];
const transcripts = new Map<string, TranscriptFull>();

function runRender(job: RenderJob, short: number) {
  const phases: NonNullable<RenderJob['phase']>[] = ['preflight', 'preparing', 'encoding', 'verifying', 'saving'];
  job.status = 'running';
  let step = 0;
  const tick = setInterval(() => {
    if (job.status !== 'running') return clearInterval(tick);
    step++;
    job.progress = Math.min(1, step / 20);
    job.phase = phases[Math.min(phases.length - 1, Math.floor(step / 4))]!;
    if (step >= 20) {
      clearInterval(tick);
      const list = outputs.get(job.project_id) ?? [];
      let name = `${job.output_name.replace(/\.mp4$/i, '')}.mp4`;
      for (let n = 2; list.some((o) => o.name === name); n++) name = `${job.output_name.replace(/\.mp4$/i, '')}_v${n}.mp4`;
      const size = short === 720 ? 1_412_908 : 2_903_441;
      list.unshift({ name, size, mtime_ms: now() });
      outputs.set(job.project_id, list);
      Object.assign(job, { status: 'completed', progress: 1, finished_at: now(), output_name: name, output: { name, size, hash: 'sha256:demo', duration_ms: 8000, width: short, height: Math.round((short * 16) / 9 / 2) * 2, metadata_clean: true, kept_tags: ['major_brand', 'minor_version', 'compatible_brands'] } });
    }
  }, 220);
}

// ------------------------------------------------------------------ the fake API
const reviews = new Map<string, { comments: ReviewComment[]; decision: ReviewInfo['decision'] }>();

export function createDemoApi(): Api {
  const api: Api = {
    session: async () => ({ actor: 'user', workspace_id: 'ws_demo', storage_backend: 'local-fs', auth: 'google', user: { email: 'owner@contoh.com', name: 'Owner' } }),
    logout: async () => ({ ok: true }),
    projects: async () => [...projects.values()].map((s) => ({ project_id: s.p.project_id, name: s.p.name, status: s.p.status, revision: s.p.revision, created_at: s.p.created_at, updated_at: s.p.updated_at }) satisfies ProjectSummary),
    createProject: async (name) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || nid('p');
      if (projects.has(id)) fail(409, 'CONFLICT', 'Proyek dengan nama itu sudah ada');
      addProject(id, name, [], 0);
      const s = projects.get(id)!;
      s.p.revision = 0;
      s.p.created_at = s.p.updated_at = now();
      return { project_id: id, name, status: 'active', revision: 0, created_at: s.p.created_at, updated_at: s.p.updated_at };
    },
    project: async (id) => view(get(id)),
    // X09 demo variants (same rules as the server, simplified): clone master, set ratio/hook/CTA.
    variants: async (id) => [...projects.values()].filter((s) => s.p.variant?.master_id === id).sort((a, b) => a.p.variant!.number - b.p.variant!.number).map(variantRow),
    createVariants: async (id, briefs) => {
      const m = get(id);
      if (m.p.variant) fail(422, 'EDIT_INVALID', 'Ini sudah varian. Buat varian dari proyek master-nya.');
      if (!briefs.length || briefs.length > 8) fail(422, 'EDIT_INVALID', 'Isi 1–8 varian');
      let num = Math.max(0, ...[...projects.values()].filter((s) => s.p.variant?.master_id === id).map((s) => s.p.variant!.number));
      const made = briefs.map((b) => {
        if (!b.ratio && !b.hook && !b.cta) fail(422, 'EDIT_INVALID', 'Isi minimal rasio, hook, atau CTA');
        const texts = (m.p.timeline.tracks.find((t) => t.kind === 'text')?.clips ?? []).slice().sort((a, c) => a.start_ms - c.start_ms);
        const ops: EditOp[] = [];
        if (b.ratio) ops.push({ op: 'set_canvas', ratio: b.ratio as '1:1' });
        if (b.hook && texts[0]) ops.push({ op: 'set_text', clip_id: texts[0].clip_id, text: b.hook });
        if (b.cta && texts.length > 1) ops.push({ op: 'set_text', clip_id: texts[texts.length - 1]!.clip_id, text: b.cta });
        const label = b.label || [b.ratio, b.hook && `Hook “${b.hook.slice(0, 18)}”`, b.cta && `CTA “${b.cta.slice(0, 18)}”`].filter(Boolean).join(' · ');
        const pid = nid('p');
        const tl = applyOps(m.p.timeline, ops, () => nid('c'), sourceDuration) as Timeline;
        projects.set(pid, { p: { ...clone(m.p), project_id: pid, name: `${m.p.name} · ${label}`, revision: 1, created_at: now(), updated_at: now(), timeline: tl, variant: { master_id: id, number: ++num, label, approved_revision: null } }, undo: [], redo: [] });
        return variantRow(projects.get(pid)!);
      });
      return made;
    },
    setVariantApproval: async (id, rev, approved) => {
      const s = get(id);
      if (!s.p.variant) fail(422, 'EDIT_INVALID', 'Proyek ini bukan varian');
      if (s.p.revision !== rev) fail(409, 'CONFLICT', 'Revisi proyek sudah berubah');
      s.p.revision++;
      s.p.variant = { ...s.p.variant!, approved_revision: approved ? s.p.revision : null };
      s.p.updated_at = now();
      return view(s);
    },
    renderVariants: async (id, opts) => {
      const jobs: RenderJob[] = [];
      const skipped: { project_id: string; reason: string }[] = [];
      for (const s of [...projects.values()].filter((x) => x.p.variant?.master_id === id)) {
        if (s.p.variant!.approved_revision !== s.p.revision) {
          skipped.push({ project_id: s.p.project_id, reason: s.p.variant!.approved_revision ? 'diubah setelah disetujui' : 'belum disetujui' });
          continue;
        }
        const job: RenderJob = { job_id: nid('job'), project_id: s.p.project_id, output_name: s.p.name, status: 'queued', phase: null, progress: 0, created_at: now(), finished_at: null, output: null, problems: [], error: null };
        renderJobs.unshift(job);
        runRender(job, opts.short_side ?? 1080);
        jobs.push(clone(job));
      }
      return { jobs, skipped };
    },
    brand: async () => clone(brandOf(null)),
    saveBrand: async (rev, kit) => api.saveBrandById(defaultBrand, rev, kit),
    brands: async () => ({ brands: clone([...brandStore.values()].sort((a, b) => a.name.localeCompare(b.name))), default_id: defaultBrand }),
    brandById: async (id) => clone(brandStore.get(id) ?? fail(404, 'NOT_FOUND', 'Brand tidak ditemukan')),
    createBrand: async (kit) => {
      if (!kit.name.trim()) fail(422, 'EDIT_INVALID', 'Brand Kit: nama wajib diisi');
      const kode = (kit.kode || kit.name.slice(0, 3)).toUpperCase();
      if ([...brandStore.values()].some((b) => b.kode === kode)) fail(422, 'EDIT_INVALID', `Brand Kit: kode ${kode} sudah dipakai`);
      const b: BrandKit = { ...clone(kit), kode, schema_version: 2, brand_id: nid('b'), revision: 1, updated_at: now() };
      brandStore.set(b.brand_id, b);
      return clone(b);
    },
    saveBrandById: async (id, rev, kit) => {
      const cur = brandStore.get(id) ?? fail(404, 'NOT_FOUND', 'Brand tidak ditemukan');
      if (rev !== cur.revision) fail(409, 'CONFLICT', 'Brand Kit sudah berubah; muat ulang dulu');
      if (!kit.name.trim()) fail(422, 'EDIT_INVALID', 'Brand Kit: nama wajib diisi');
      const b: BrandKit = { ...cur, ...clone(kit), kode: (kit.kode || cur.kode).toUpperCase(), revision: cur.revision + 1, updated_at: now() };
      brandStore.set(id, b);
      return clone(b);
    },
    duplicateBrand: async () => fail(409, 'DEMO', 'Duplikat brand tidak tersedia di demo browser'),
    setDefaultBrand: async (id) => {
      if (!brandStore.has(id)) fail(404, 'NOT_FOUND', 'Brand tidak ditemukan');
      defaultBrand = id;
      return { default_id: id };
    },
    deleteBrand: async (id) => {
      if ([...projects.values()].some((s) => s.p.brand_id === id)) fail(422, 'PRECONDITION', 'Brand masih dipakai proyek');
      brandStore.delete(id);
      if (defaultBrand === id) defaultBrand = [...brandStore.keys()][0] ?? '';
      return { deleted: id };
    },
    exportBrand: async (id) => {
      const k = brandStore.get(id) ?? fail(404, 'NOT_FOUND', 'Brand tidak ditemukan');
      return { schema: 'brand-kit-export/1', brand: { id: k.brand_id, nama: k.name, kode: k.kode }, visual: { warna: k.colors, warna_teks: k.text_color }, aturan: { terlarang: k.guard.banned, level: k.guard.banned_level }, aset: [], preset: {} };
    },
    updateProject: async (id, rev, patch) => {
      const s = get(id);
      if (s.p.revision !== rev) fail(409, 'CONFLICT', 'Revisi proyek sudah berubah');
      if (patch.name !== undefined) s.p.name = patch.name.trim() || fail(422, 'EDIT_INVALID', 'Nama proyek tidak boleh kosong');
      if (patch.status) s.p.status = patch.status;
      if (patch.brand_id !== undefined) {
        if (patch.brand_id === null) delete s.p.brand_id;
        else s.p.brand_id = (brandStore.get(patch.brand_id) ?? fail(404, 'NOT_FOUND', 'Brand tidak ditemukan')).brand_id;
      }
      s.p.revision++;
      s.p.updated_at = now();
      return view(s);
    },
    duplicateProject: async (id, name) => {
      const s = get(id);
      const nidp = nid('p');
      projects.set(nidp, { p: { ...clone(s.p), project_id: nidp, name: name ?? `${s.p.name} (salinan)`, status: 'active', revision: 1, created_at: now(), updated_at: now() }, undo: [], redo: [] });
      const p = projects.get(nidp)!.p;
      return { project_id: p.project_id, name: p.name, status: p.status, revision: p.revision, created_at: p.created_at, updated_at: p.updated_at };
    },
    exportProject: async (id) => {
      const s = get(id);
      return { format: 'motion-studio-project', format_version: 1, exported_at: now(), project: { name: s.p.name, timeline: clone(s.p.timeline) }, media: [] };
    },
    importProject: async (data, name) => {
      const d = data as { format?: string; project?: { name: string; timeline: Timeline } };
      if (d?.format !== 'motion-studio-project' || !d.project) fail(422, 'EDIT_INVALID', 'File impor bukan proyek Motion Studio');
      const idp = nid('p');
      projects.set(idp, { p: { project_id: idp, name: name ?? d.project!.name, status: 'active', revision: 1, created_at: now(), updated_at: now(), timeline: clone(d.project!.timeline), history: { undo: 0, redo: 0, undo_label: null, redo_label: null } }, undo: [], redo: [] });
      const p = projects.get(idp)!.p;
      return { project: { project_id: p.project_id, name: p.name, status: p.status, revision: p.revision, created_at: p.created_at, updated_at: p.updated_at }, remapped: 0 };
    },
    editProject: async (id, rev, ops) => {
      const s = get(id);
      return commit(s, rev, ops, ops.length === 1 ? OP_LABEL[ops[0]!.op] : `${ops.length} perubahan`);
    },
    stepHistory: async (id, rev, dir) => {
      const s = get(id);
      if (s.p.revision !== rev) fail(409, 'CONFLICT', 'Revisi proyek sudah berubah');
      const from = dir === 'undo' ? s.undo : s.redo;
      const to = dir === 'undo' ? s.redo : s.undo;
      const step = from.pop() ?? fail(422, 'EDIT_INVALID', dir === 'undo' ? 'Tidak ada yang bisa di-undo' : 'Tidak ada yang bisa di-redo');
      to.push({ t: clone(s.p.timeline), label: step.label });
      s.p.timeline = step.t;
      s.p.revision++;
      s.p.updated_at = now();
      return view(s);
    },
    media: async (q = {}) => clone(media.filter((m) => q.scope !== 'shared' || m.scope.kind === 'shared')),
    importQueue: async () => ({ berjalan: false, menunggu: 0 }),
    backup: async () => ({ lokasi: [], verifikasi: { location_id: null, state: 'idle' as const, started_at: null, finished_at: null, hasil: null, alasan: null } }),
    backupAdd: async () => fail(409, 'PRECONDITION', 'Folder backup tidak tersedia di demo browser'),
    backupVerify: async () => fail(409, 'PRECONDITION', 'Folder backup tidak tersedia di demo browser'),
    importFile: async (file, scope, onProgress) => {
      for (let i = 1; i <= 10; i++) {
        await wait(60);
        onProgress?.(i / 10);
      }
      const url = URL.createObjectURL(file);
      const probe = await new Promise<Version['probe']>((resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve({ duration_ms: Math.round(v.duration * 1000), width: v.videoWidth || null, height: v.videoHeight || null, video_codec: v.videoWidth ? 'h264' : null, audio_codec: 'aac' });
        v.onerror = () => resolve(null);
        v.src = url;
      });
      const vid = nid('v');
      blobUrls.set(vid, url);
      mediaUrl[vid] = vid;
      const m: Media = { media_id: nid('m'), display_name: file.name, scope: scope.kind === 'shared' ? { kind: 'shared' } : { kind: 'project', project_id: scope.project_id }, created_at: now(), current_version_id: vid, versions: [version(vid, file.name, file.size, probe, { imported_at: now(), ever_referenced: false, preview: !!probe })] };
      media.push(m);
      return { media_id: m.media_id, version: m.versions[0]!, duplicate: false };
    },
    trash: async () => clone(trash),
    restore: async (vid) => {
      const i = trash.findIndex((t) => t.version_id === vid);
      if (i >= 0) trash.splice(i, 1);
      return { status: 'restored' as const };
    },
    preparePurge: async (ids) => {
      const items = trash.filter((t) => ids.includes(t.version_id));
      const plan: PurgePlan = {
        request_id: nid('pr'),
        confirmation_token: 'demo',
        required_phrase: 'HAPUS PERMANEN',
        expires_at: now() + 600_000,
        irreversible: true,
        total_bytes: items.reduce((n, t) => n + t.size, 0),
        items: items.map((t) => ({ version_id: t.version_id, media_id: t.media_id, filename: t.original_name, size: t.size, trashed_at: t.trashed_at, referenced_by: [], protected_by: [], backup: { status: 'unverified' as const }, purgeable: true, blockers: [] })),
      };
      return plan;
    },
    executePurge: async (plan, phrase) => {
      if (phrase !== plan.required_phrase) fail(422, 'PRECONDITION', 'Frasa konfirmasi tidak cocok');
      const ids = plan.items.map((i) => i.version_id);
      for (const id of ids) {
        const i = trash.findIndex((t) => t.version_id === id);
        if (i >= 0) trash.splice(i, 1);
      }
      return { purged: ids, blocked: [], freed_bytes: plan.total_bytes };
    },
    // Demo: no waveform/thumbnails (the timeline simply shows plain clips).
    mediaVisuals: async (vid) => ({ version_id: vid, duration_ms: 0, peaks: null, thumbs: null }),
    makeProxy: async () => 'tidak_perlu' as const,
    streamUrl: async (vid) => {
      const url = sampleUrl(mediaUrl[vid] ?? '') ?? fail(404, 'NOT_FOUND', 'Video contoh tidak termuat');
      return { url, expires_at: now() + 600_000, mime: 'video/mp4' };
    },
    copilotPlan: async (id, body) => {
      await wait(250);
      const s = get(id);
      const local = planLocal(body.prompt, { timeline: s.p.timeline, selected_clip_ids: body.selected_clip_ids ?? [], playhead_ms: body.playhead_ms ?? 0 }) as { ok: true; ops: EditOp[]; rationale: string; warnings: string[] } | { ok: false; message: string };
      if (local.ok) return propose(id, 'local', body.prompt, local.ops, local.rationale, local.warnings);
      if (settings.mode === 'local') return { plan: null, unsupported: { message: local.message, examples: ['hook "Diskon 50% hari ini!" 2 detik', 'CTA "Join live jam 7" di akhir', 'subtitle "Halo semua" 0:01-0:04', 'ubah rasio ke 1:1', 'potong di detik 3'], ai_available: false } };
      await wait(900);
      usage.day += 0.0108;
      usage.month += 0.0108;
      usage.calls++;
      log.unshift({ ts: now(), op: 'ai.call', outcome: 'ok', provider: 'anthropic', model: 'claude-opus-5-5', capability: 'planner', cost_usd: 0.0108, request_id: nid('req') });
      return propose(id, 'ai', body.prompt, simulatedAiOps(s.p.timeline, body.prompt), 'Simulasi demo: AI menambah teks pendek di awal yang masih kosong.', ['Demo: jawaban AI disimulasikan, tidak ada panggilan sungguhan.'], { connection_id: 'conn_demo_claude', provider: 'anthropic', model: 'claude-opus-5-5' }, 0.0108);
    },
    copilotApply: async (id, planId, rev, accept) => {
      const r = plans.get(planId) ?? fail(404, 'NOT_FOUND', 'Rencana tidak ada');
      if (r.status === 'rejected') fail(409, 'CONFLICT', 'Rencana ini sudah ditolak');
      if (rev !== r.plan.project_revision) fail(409, 'CONFLICT', 'Proyek sudah berubah sejak rencana dibuat. Buat rencana baru.');
      const idx = accept ?? r.plan.operations.map((_, i) => i);
      const s = get(id);
      const project = commit(s, rev, idx.sort((a, b) => a - b).map((i) => r.plan.operations[i]!.op), `Copilot: ${r.plan.prompt}`.slice(0, 80));
      r.status = 'applied';
      r.applied_revision = project.revision;
      const out: ApplyReply = { project, plan: r.plan, status: 'applied', applied_revision: project.revision, accepted: idx, already_applied: false };
      return out;
    },
    copilotPreview: async (id, planId, accept) => {
      const r = plans.get(planId) ?? fail(404, 'NOT_FOUND', 'Rencana tidak ada');
      const s = get(id);
      const ops = [...accept].sort((a, b) => a - b).map((i) => r.plan.operations[i]!.op);
      let n = 0;
      return diffTimelines(s.p.timeline, applyOps(s.p.timeline, ops, () => `plan_new_${++n}`)) as { kind: 'add' | 'remove' | 'change' | 'canvas'; summary: string }[];
    },
    copilotReject: async (_id, planId) => {
      const r = plans.get(planId);
      if (r) r.status = 'rejected';
      return { status: 'rejected' };
    },
    aiProviders: async () => ({ connections: clone(connections), settings: clone(settings), catalog: clone(catalog) }),
    aiAdd: async (b) => {
      const c = conn({ connection_id: nid('conn'), provider: b.provider, label: b.label ?? b.provider, model: b.model, capabilities: b.capabilities, priority: connections.length + 1, prices: b.prices, key_hint: b.api_key ? `…${b.api_key.slice(-4)}` : null, has_key: !!b.api_key, status: 'untested', last_test_at: null, base_url: b.base_url ?? null });
      connections.push(c);
      return clone(c);
    },
    aiUpdate: async (id, patch) => {
      const c = connections.find((x) => x.connection_id === id) ?? fail(404, 'NOT_FOUND', 'Koneksi tidak ada');
      Object.assign(c, patch);
      return clone(c);
    },
    aiRotate: async (id, key) => {
      const c = connections.find((x) => x.connection_id === id) ?? fail(404, 'NOT_FOUND', 'Koneksi tidak ada');
      Object.assign(c, { key_hint: `…${key.slice(-4)}`, has_key: true, status: 'untested', last_error: null });
      return clone(c);
    },
    aiTest: async (id) => {
      await wait(600);
      const c = connections.find((x) => x.connection_id === id) ?? fail(404, 'NOT_FOUND', 'Koneksi tidak ada');
      Object.assign(c, { status: 'ok', last_test_at: now(), last_error: null });
      return { result: { ok: true, models: 12, model_listed: true, error: null }, connection: clone(c) };
    },
    aiRemove: async (id) => {
      const i = connections.findIndex((x) => x.connection_id === id);
      if (i >= 0) connections.splice(i, 1);
      return { ok: true };
    },
    team: async () => ({ members: clone(team), me: 'owner@contoh.com', max: 200 }),
    teamAdd: async (email, role) => {
      if (team.some((m) => m.email === email)) fail(409, 'ALREADY_MEMBER', 'Email ini sudah ada di daftar tim');
      const member: TeamMember = { email, role, source: 'web', added_at: now(), added_by: 'owner@contoh.com' };
      team.push(member);
      return { member: clone(member), members: clone(team) };
    },
    teamSetRole: async (email, role) => {
      const m = team.find((x) => x.email === email && x.source === 'web') ?? fail(404, 'NOT_FOUND', 'Email ini tidak ada di daftar tim');
      m.role = role;
      return { member: clone(m), members: clone(team) };
    },
    teamRemove: async (email) => {
      const i = team.findIndex((x) => x.email === email && x.source === 'web');
      if (i < 0) fail(404, 'NOT_FOUND', 'Email ini tidak ada di daftar tim');
      team.splice(i, 1);
      return { removed: email, members: clone(team) };
    },
    imageAi: async () => ({ provider: null, endpoint: null, model: null, budget: { amount: null, currency: 'IDR' as const }, key_saved: false, key_hint: null, last_test: null, providers: [] }),
    saveImageAi: async () => fail(409, 'DEMO', 'Tidak tersedia di demo browser'),
    setImageAiKey: async () => fail(409, 'DEMO', 'Tidak tersedia di demo browser'),
    testImageAi: async () => fail(409, 'DEMO', 'Tidak tersedia di demo browser'),
    aiSettings: async (patch) => {
      Object.assign(settings, { ...patch, budget: { ...settings.budget, ...patch.budget } });
      return clone(settings);
    },
    aiUsage: async () => ({
      budget: clone(settings.budget),
      today: { usd: usage.day, calls: usage.calls },
      month: { usd: usage.month, calls: 17 },
      in_flight_usd: 0,
      by_model: [
        { provider: 'anthropic', model: 'claude-opus-5-5', calls: 15, failed: 1, usd: usage.month - 0.0144, input_tokens: 18_400, output_tokens: 4_600, audio_seconds: 0 },
        { provider: 'openai', model: 'whisper-1', calls: 2, failed: 0, usd: 0.0144, input_tokens: 0, output_tokens: 0, audio_seconds: 144 },
      ],
    }),
    aiLog: async () => clone(log),
    transcripts: async (id) => ({ transcripts: [...transcripts.values()].filter((t) => t.project_id === id).map(({ cues, word_count: _w, ...rest }) => ({ ...rest, cue_count: cues.length })), jobs: clone(sttJobs.filter((j) => j.project_id === id)).reverse() }),
    transcriptEstimate: async (_id, vid) => {
      const d = sourceDuration({ version_id: vid }) ?? 8000;
      const minutes = Math.ceil((d / 60_000) * 100) / 100;
      const c = connections.find((x) => x.enabled && x.capabilities.includes('transcription'));
      return c ? { minutes, estimate_usd: Math.round(minutes * c.prices.per_audio_minute * 1e6) / 1e6, provider: { connection_id: c.connection_id, provider: c.provider, model: c.model, label: c.label }, unavailable: null } : { minutes, estimate_usd: null, provider: null, unavailable: 'Belum ada koneksi AI untuk transkripsi.' };
    },
    transcriptStart: async (id, vid, language) => {
      const job: SttJob = { job_id: nid('stt'), project_id: id, version_id: vid, status: 'running', phase: 'extracting', transcript_id: null, error: null, created_at: now(), finished_at: null };
      sttJobs.push(job);
      setTimeout(() => (job.phase = 'transcribing'), 700);
      setTimeout(() => (job.phase = 'saving'), 2200);
      setTimeout(() => {
        const d = sourceDuration({ version_id: vid }) ?? 8000;
        const lines = ['Halo semua, ini promo spesial.', 'Bahannya adem dan nggak nerawang.', 'Cek keranjang kuning sekarang ya!'];
        const step = Math.floor(d / lines.length);
        const cues: Cue[] = lines.map((text, i) => ({ cue_id: nid('cue'), start_ms: i * step + 200, end_ms: Math.min(d, (i + 1) * step - 100), text }));
        const t: TranscriptFull = { transcript_id: nid('tr'), project_id: id, media_id: media.find((m) => m.current_version_id === vid)?.media_id ?? 'm', version_id: vid, language: language === 'auto' ? 'id' : language, provider: 'openai', model: 'whisper-1', source_duration_ms: d, created_at: now(), updated_at: now(), rev: 0, edited: false, cues, word_count: 18 };
        transcripts.set(t.transcript_id, t);
        Object.assign(job, { status: 'completed', transcript_id: t.transcript_id, finished_at: now() });
        usage.day += 0.0008;
        usage.month += 0.0008;
      }, 3200);
      return clone(job);
    },
    transcript: async (_id, tid) => clone(transcripts.get(tid) ?? fail(404, 'NOT_FOUND', 'Transkrip tidak ada')),
    transcriptSave: async (_id, tid, rev, cues) => {
      const t = transcripts.get(tid) ?? fail(404, 'NOT_FOUND', 'Transkrip tidak ada');
      if (t.rev !== rev) fail(409, 'CONFLICT', 'Transkrip sudah diubah di tempat lain');
      const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms);
      sorted.forEach((c, i) => {
        if (!c.text.trim()) fail(422, 'EDIT_INVALID', `Cue #${i + 1}: teks wajib diisi`);
        if (!(c.end_ms - c.start_ms >= 200)) fail(422, 'EDIT_INVALID', `Cue #${i + 1}: minimal 200 ms (akhir harus setelah awal)`);
        if (c.end_ms > t.source_duration_ms + 50) fail(422, 'EDIT_INVALID', `Cue #${i + 1} melewati panjang media (${(t.source_duration_ms / 1000).toFixed(1)} dtk)`);
        if (i && c.start_ms < sorted[i - 1]!.end_ms) fail(422, 'EDIT_INVALID', `Cue "${sorted[i - 1]!.text.slice(0, 30)}" dan "${c.text.slice(0, 30)}" tumpang tindih`);
      });
      Object.assign(t, { cues: sorted.map((c) => ({ cue_id: c.cue_id ?? nid('cue'), ...c })), rev: t.rev + 1, edited: true, updated_at: now() });
      return clone(t);
    },
    // X07 demo: fixed pauses/scenes (no FFmpeg in the browser); the plan path is the real one.
    analyzeMedia: async (vid, params) => {
      await wait(500);
      const v = media.flatMap((m) => m.versions).find((x) => x.version_id === vid) ?? fail(404, 'NOT_FOUND', 'Versi media tidak ditemukan');
      const d = v.probe?.duration_ms ?? 8000;
      return { version_id: vid, params: { noise_db: -35, min_silence_ms: 600, scene_threshold: 0.3, ...params }, duration_ms: d, has_audio: true, has_video: true, silences: [{ from_ms: Math.round(d * 0.3), to_ms: Math.round(d * 0.3) + 900 }, { from_ms: Math.round(d * 0.7), to_ms: Math.round(d * 0.7) + 700 }], scenes: [Math.round(d * 0.5)], cached: false };
    },
    cutPlan: async (id, body) => {
      const s = get(id);
      const c = s.p.timeline.tracks.flatMap((t) => t.clips.map((x) => ({ ...x, kind: t.kind }))).find((x) => x.clip_id === body.clip_id) ?? fail(422, 'EDIT_INVALID', 'Pilih klip video/audio di linimasa');
      const inMs = c.in_ms ?? 0;
      const ops: EditOp[] = body.silences
        .map((x) => ({ from: c.start_ms + Math.max(x.from_ms + body.padding_ms, inMs) - inMs, to: c.start_ms + Math.min(x.to_ms - body.padding_ms, inMs + c.end_ms - c.start_ms) - inMs }))
        .filter((x) => x.to - x.from >= 200)
        .sort((a, b) => b.from - a.from)
        .map((x) => ({ op: 'remove_range', from_ms: x.from, to_ms: x.to }));
      if (!ops.length) fail(422, 'EDIT_INVALID', 'Tidak ada potongan yang dipilih.');
      return propose(id, 'analysis', `Potong ${ops.length} jeda (deteksi otomatis)`, ops, 'Menghapus jeda di semua track.', []);
    },
    transcriptSubtitles: async (id, tid) => {
      const t = transcripts.get(tid) ?? fail(404, 'NOT_FOUND', 'Transkrip tidak ada');
      const s = get(id);
      const ops: unknown[] = [];
      const taken = (s.p.timeline.tracks.find((x) => x.kind === 'subtitle')?.clips ?? []).map((c) => [c.start_ms, c.end_ms] as const);
      let clashes = 0;
      for (const tr of s.p.timeline.tracks) {
        if (!['video', 'broll', 'audio'].includes(tr.kind)) continue;
        for (const c of tr.clips as Clip[]) {
          if (c.media?.version_id !== t.version_id) continue;
          const inMs = c.in_ms ?? 0;
          for (const cue of t.cues) {
            const a = Math.max(cue.start_ms, inMs);
            const b = Math.min(cue.end_ms, inMs + (c.end_ms - c.start_ms));
            if (b - a < 200) continue;
            const start = c.start_ms + a - inMs;
            const end = c.start_ms + b - inMs;
            if (taken.some(([x, y]) => x < end && start < y)) {
              clashes++;
              continue;
            }
            taken.push([start, end]);
            ops.push({ op: 'add_clip', track_kind: 'subtitle', text: cue.text, start_ms: start, duration_ms: end - start });
          }
        }
      }
      if (!ops.length) fail(422, 'EDIT_INVALID', clashes ? 'Semua cue bertabrakan dengan subtitle yang sudah ada. Hapus subtitle lama dulu.' : 'Media transkrip ini belum ada di linimasa.');
      return propose(id, 'transcript', `Subtitle dari transkrip (${t.cues.length} cue)`, ops, `${ops.length} subtitle dari transkrip`, clashes ? [`${clashes} cue dilewati karena bertabrakan dengan subtitle yang sudah ada.`] : []);
    },
    dashboard: async () => {
      const d: Dashboard = {
        stats: { usage: { shared_media: 144_325, project_input: 0, project_output: 2_840_112, project_cache: 512_000, trash: 98_200 }, media_bytes: 144_325, disk: { free_bytes: 1.21e12, total_bytes: 1.5e12 }, warnings: [] },
        gc: { ok: true, errors: [], summary: { protected_unused: 0, referenced: 2, eligible: 0, waiting: 1 }, candidates: 0, next_eligible: [{ version_id: V_OLD, eligible_at: now() + 27 * DAY }] },
        trash: trash.map((t) => ({ version_id: t.version_id, filename: t.original_name, size: t.size, trashed_at: t.trashed_at ?? now() })),
        pending_operations: 0,
        corrupt_journal: 0,
        backup: { verified: 1, active_versions: 2 },
      };
      return d;
    },
    brandCheck: async (id) => {
      const today = localDate(now());
      const p = get(id).p;
      return { today, issues: checkBrandGuard(p.timeline, validateGuard(brandOf(p.brand_id).guard), today) as GuardIssue[] };
    },
    renderTools: async () => ({ ok: true, version: '9.0.2 (demo)', problems: [], font: true }),
    startRender: async (id, opts) => {
      const job: RenderJob = { job_id: nid('job'), project_id: id, output_name: opts.output_name ?? 'render', status: 'queued', phase: null, progress: 0, created_at: now(), finished_at: null, output: null, problems: [], error: null };
      renderJobs.unshift(job);
      runRender(job, opts.short_side ?? 1080);
      return clone(job);
    },
    renders: async (id) => ({ jobs: clone(renderJobs.filter((j) => j.project_id === id)), outputs: clone(outputs.get(id) ?? []) }),
    allOutputs: async (o = {}) => {
      const all = [...outputs.entries()].flatMap(([pid, list]) => list.map((f) => ({ project_id: pid, project_name: projects.get(pid)?.p.name ?? pid, ...f })));
      const q = (o.q ?? '').toLowerCase();
      const found = all.filter((i) => !q || i.name.toLowerCase().includes(q) || i.project_name.toLowerCase().includes(q)).sort((a, b) => b.mtime_ms - a.mtime_ms);
      return { outputs: found.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 200)), total: found.length, offset: o.offset ?? 0, limit: o.limit ?? 200 };
    },
    renderJob: async (jobId) => clone(renderJobs.find((j) => j.job_id === jobId) ?? fail(404, 'NOT_FOUND', 'Job render tidak ditemukan')),
    cancelRender: async (jobId) => {
      const j = renderJobs.find((x) => x.job_id === jobId) ?? fail(404, 'NOT_FOUND', 'Job tidak ada');
      if (j.status === 'running' || j.status === 'queued') Object.assign(j, { status: 'cancelled', finished_at: now(), error: { code: 'CANCELLED', message: 'Render dibatalkan' } });
      return clone(j);
    },
    review: async (id) => {
      const s = get(id);
      const r = reviews.get(id) ?? { comments: [], decision: null };
      return clone({ ...r, revision: s.p.revision, state: !r.decision ? 'belum' : r.decision.status === 'revisi' ? 'revisi' : r.decision.revision === s.p.revision ? 'lulus' : 'berubah' });
    },
    addComment: async (id, at_ms, text) => {
      const s = get(id);
      const r = reviews.get(id) ?? { comments: [], decision: null };
      const c = { comment_id: nid('cm'), at_ms, text, author: { email: 'owner@contoh.com', name: 'Owner' }, created_at: now(), revision: s.p.revision, resolved_at: null, resolved_by: null };
      r.comments = [...r.comments, c].sort((a, b) => a.at_ms - b.at_ms);
      reviews.set(id, r);
      return clone(c);
    },
    resolveComment: async (id, cid, resolved) => {
      const c = reviews.get(id)?.comments.find((x) => x.comment_id === cid) ?? fail(404, 'NOT_FOUND', 'Komentar tidak ada');
      Object.assign(c, resolved ? { resolved_at: now(), resolved_by: { email: 'owner@contoh.com', name: 'Owner' } } : { resolved_at: null, resolved_by: null });
      return clone(c);
    },
    decideReview: async (id, rev, status, note) => {
      const s = get(id);
      if (s.p.revision !== rev) fail(409, 'CONFLICT', 'Proyek sudah berubah');
      const r = reviews.get(id) ?? { comments: [], decision: null };
      if (status === 'lulus' && r.comments.some((c) => !c.resolved_at)) fail(422, 'EDIT_INVALID', 'Masih ada komentar terbuka; selesaikan dulu');
      r.decision = { status, revision: rev, by: { email: 'owner@contoh.com', name: 'Owner' }, at: now(), note: note ?? '' };
      reviews.set(id, r);
      return { state: status === 'lulus' ? 'lulus' : 'revisi' };
    },
    engineInfo: async () => ({ installed: false, running: 0, waiting: 0 }),
    engineJobs: async () => [],
    engineStart: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineJob: async () => fail(404, 'NOT_FOUND', 'Job mesin tidak ditemukan'),
    approvalQueue: async () => [],
    engineContinue: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineCancel: async () => fail(409, 'NOT_RUNNING', 'Job tidak sedang berjalan'),
    enginePlan: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineBatch: async () => fail(404, 'NOT_FOUND', 'batch.json belum ada'),
    engineDecide: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineBeatspot: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    beatspot: async () => fail(404, 'NOT_FOUND', 'beatspot.json belum ada'),
    beatspotRerun: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineTransfer: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    transfer: async () => fail(404, 'NOT_FOUND', 'transfer.json belum ada'),
    transferEdit: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    transferImage: async () => fail(404, 'NOT_FOUND', 'Gambar adegan tidak ada'),
    enginePisah: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    enginePisahResult: async () => fail(404, 'NOT_FOUND', 'pisah.json belum ada'),
    engineBatches: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineShots: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    engineThumbs: async () => ({}),
    engineSetExcluded: async () => fail(409, 'ENGINE_MISSING', 'Mesin tidak tersedia di demo browser'),
    outputUrl: async () => ({ url: sampleUrl('hook') ?? fail(404, 'NOT_FOUND', 'Video contoh tidak termuat'), expires_at: now() + 600_000 }),
  };
  return api;
}
