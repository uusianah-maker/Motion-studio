import { StorageError } from './errors.js';
import { CANVAS_RATIOS, type CanvasRatio, MAX_TEXT_LEN, type TrackKind } from './project.js';
import { COLOR_WORDS, type PresetId, TONES, presetById } from './textPresets.js';
import type { TextStyle } from './textStyle.js';
import { type EditOp, MIN_CLIP_MS, type SourceDuration, type Timeline, applyOps, validateOps } from './timeline.js';

/**
 * Motion Copilot (W11, PRD §8 + "Provider-neutral planning schema"). A planner turns a prompt
 * into an EDIT PLAN: typed timeline operations (the same `EditOp`s the manual editor uses),
 * validated against the current revision, shown as a diff, and applied only after the user
 * approves — as ONE undo step. Planners (the local rule engine here, an LLM in W12) never
 * touch files or the database; they only return JSON.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const MAX_PLAN_OPS = 60;
export const MAX_PROMPT_LEN = 1000;

export type PlanSource = 'local' | 'ai' | 'transcript' | 'analysis';

export interface PlanOperation {
  op: EditOp;
  /** Human description (Indonesian), computed by the server, never trusted from a planner. */
  label: string;
}

export interface EditPlan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  plan_id: string;
  project_id: string;
  /** Revision the plan was made for: applying to any other revision is refused (stale plan). */
  project_revision: number;
  source: PlanSource;
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
  track_kind: TrackKind | null;
  clip_id: string | null;
  before: { start_ms: number; end_ms: number; text?: string } | null;
  after: { start_ms: number; end_ms: number; text?: string } | null;
  summary: string;
}

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
};
const TRACK_NAME: Record<TrackKind, string> = { video: 'video', broll: 'b-roll', text: 'teks', subtitle: 'subtitle', audio: 'audio', music: 'musik', sfx: 'SFX', effects: 'efek' };
const quote = (t: string) => `“${t.length > 40 ? `${t.slice(0, 39)}…` : t}”`;

function findClip(t: Timeline, id: string) {
  for (const track of t.tracks) {
    const clip = track.clips.find((c) => c.clip_id === id);
    if (clip) return { track, clip };
  }
  return null;
}

const STYLE_WORD: Record<keyof TextStyle, string> = { x: 'posisi', y: 'posisi', size: 'ukuran', width: 'lebar', color: 'warna', bg: 'kotak', bg_opacity: 'opasitas kotak', bold: 'tebal', outline: 'outline', align: 'perataan', font: 'font', anim: 'animasi', anim_ms: 'durasi animasi', highlight: 'sorot kata' };
/** "warna #e53935, kotak, posisi" — which properties a style change touches. */
export const styleSummary = (s: Partial<TextStyle>) =>
  [
    ...new Set(
      Object.keys(s)
        .filter((k) => !(k === 'bg_opacity' && 'bg' in s))
        .map((k) => (k === 'color' ? `warna ${s.color}` : k === 'bg' ? (s.bg ? `kotak ${s.bg}` : 'tanpa kotak') : k === 'font' ? (s.font === 'brand' ? 'font brand' : 'font bawaan') : STYLE_WORD[k as keyof TextStyle])),
    ),
  ].join(', ');

/** m:ss.d — cuts need tenths of a second. */
const fmtPrecise = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0').replace('.', ',')}`;

/** One line per op, against the timeline the op will run on. */
export function describeOp(op: EditOp, t: Timeline): string {
  const ref = (id: string) => {
    const f = findClip(t, id);
    if (!f) return `klip ${id}`;
    return `klip ${TRACK_NAME[f.track.kind]}${f.clip.text ? ` ${quote(f.clip.text)}` : ''} (${fmtTime(f.clip.start_ms)}–${fmtTime(f.clip.end_ms)})`;
  };
  switch (op.op) {
    case 'add_clip':
      return op.text !== undefined
        ? `Tambah ${TRACK_NAME[op.track_kind]} ${quote(op.text)} di ${fmtTime(op.start_ms)}–${fmtTime(op.start_ms + op.duration_ms)}`
        : `Tambah klip ${TRACK_NAME[op.track_kind]} di ${fmtTime(op.start_ms)}–${fmtTime(op.start_ms + op.duration_ms)}`;
    case 'move_clip':
      return `Geser ${ref(op.clip_id)} ke ${fmtTime(op.start_ms)}`;
    case 'trim_clip':
      return `Pangkas ${op.edge === 'start' ? 'awal' : 'akhir'} ${ref(op.clip_id)} ke ${fmtTime(op.to_ms)}`;
    case 'split_clip':
      return `Potong ${ref(op.clip_id)} di ${fmtTime(op.at_ms)}`;
    case 'delete_clip':
      return `Hapus ${ref(op.clip_id)}`;
    case 'set_text':
      return `Ubah teks ${ref(op.clip_id)} → ${quote(op.text)}`;
    case 'set_canvas':
      return `Ubah rasio ke ${op.ratio}`;
    case 'set_brand_logo':
      return op.on ? 'Tampilkan logo brand' : 'Sembunyikan logo brand';
    case 'set_loudness':
      return op.lufs === null ? 'Loudness: biarkan apa adanya' : `Loudness akhir ${op.lufs} LUFS`;
    case 'remove_range':
      return `Hapus ${fmtPrecise(op.from_ms)}–${fmtPrecise(op.to_ms)} (${((op.to_ms - op.from_ms) / 1000).toFixed(1).replace('.', ',')} dtk) di semua track`;
    case 'split_at':
      return `Potong ${TRACK_NAME[op.track_kind]} di ${fmtPrecise(op.at_ms)}`;
    case 'set_style':
      return `Ubah gaya ${ref(op.clip_id)}: ${styleSummary(op.style)}`;
    case 'set_volume':
      return op.volume === 0 ? `Bisukan ${ref(op.clip_id)}` : `Volume ${ref(op.clip_id)} → ${Math.round(op.volume * 100)}%`;
    case 'set_track_mute':
      return `${op.muted ? 'Bisukan' : 'Nyalakan suara'} track ${TRACK_NAME[op.track_kind]}`;
  }
}

/** Labels for a whole op list, each described against the timeline as it is before that op. */
export function describeOps(ops: EditOp[], t: Timeline): string[] {
  const labels: string[] = [];
  let cur = t;
  let n = 0;
  for (const op of ops) {
    labels.push(describeOp(op, cur));
    try {
      cur = applyOps(cur, [op], () => `plan_new_${++n}`);
    } catch {
      /* the full validation reports it */
    }
  }
  return labels;
}

/** What changes between two timelines (clip identity by id; new clips are "add"). */
export function diffTimelines(before: Timeline, after: Timeline): DiffItem[] {
  const items: DiffItem[] = [];
  const index = (t: Timeline) => {
    const m = new Map<string, { kind: TrackKind; start_ms: number; end_ms: number; text?: string; style: string; volume: number }>();
    for (const tr of t.tracks) for (const c of tr.clips) m.set(c.clip_id, { kind: tr.kind, start_ms: c.start_ms, end_ms: c.end_ms, ...(c.text !== undefined ? { text: c.text } : {}), style: JSON.stringify(c.style ?? {}), volume: c.volume ?? 1 });
    return m;
  };
  const a = index(before);
  const b = index(after);
  const shape = (x: { start_ms: number; end_ms: number; text?: string }) => ({ start_ms: x.start_ms, end_ms: x.end_ms, ...(x.text !== undefined ? { text: x.text } : {}) });
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y) {
      items.push({ kind: 'remove', track_kind: x.kind, clip_id: id, before: shape(x), after: null, summary: `− ${TRACK_NAME[x.kind]}${x.text ? ` ${quote(x.text)}` : ''} ${fmtTime(x.start_ms)}–${fmtTime(x.end_ms)}` });
    } else if (x.start_ms !== y.start_ms || x.end_ms !== y.end_ms || x.text !== y.text || x.style !== y.style || x.volume !== y.volume) {
      const parts: string[] = [];
      if (x.start_ms !== y.start_ms || x.end_ms !== y.end_ms) parts.push(`${fmtTime(x.start_ms)}–${fmtTime(x.end_ms)} → ${fmtTime(y.start_ms)}–${fmtTime(y.end_ms)}`);
      if (x.text !== y.text) parts.push(`${quote(x.text ?? '')} → ${quote(y.text ?? '')}`);
      if (x.style !== y.style) {
        const a = JSON.parse(x.style) as Record<string, unknown>;
        const b = JSON.parse(y.style) as Record<string, unknown>;
        const changed = Object.fromEntries(Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => [k, b[k]])) as Partial<TextStyle>;
        parts.push(`${y.text ? `${quote(y.text)} ` : ''}gaya: ${styleSummary(changed)}`);
      }
      if (x.volume !== y.volume) parts.push(`volume ${Math.round(x.volume * 100)}% → ${Math.round(y.volume * 100)}%`);
      items.push({ kind: 'change', track_kind: x.kind, clip_id: id, before: shape(x), after: shape(y), summary: `~ ${TRACK_NAME[x.kind]}: ${parts.join(', ')}` });
    }
  }
  for (const [id, y] of b) {
    if (!a.has(id)) items.push({ kind: 'add', track_kind: y.kind, clip_id: null, before: null, after: shape(y), summary: `+ ${TRACK_NAME[y.kind]}${y.text ? ` ${quote(y.text)}` : ''} ${fmtTime(y.start_ms)}–${fmtTime(y.end_ms)}` });
  }
  // X04: track mute on/off.
  for (const kind of ['video', 'broll', 'audio'] as const) {
    const ma = before.tracks.some((t) => t.kind === kind && t.muted);
    const mb = after.tracks.some((t) => t.kind === kind && t.muted);
    if (ma !== mb) items.push({ kind: 'change', track_kind: kind, clip_id: null, before: null, after: null, summary: `~ track ${TRACK_NAME[kind]}: ${mb ? 'dibisukan' : 'suara dinyalakan'}` });
  }
  if (!!before.brand_logo !== !!after.brand_logo) items.push({ kind: 'canvas', track_kind: null, clip_id: null, before: null, after: null, summary: after.brand_logo ? 'Logo brand: tampil' : 'Logo brand: disembunyikan' });
  const ra = before.canvas?.ratio ?? '9:16';
  const rb = after.canvas?.ratio ?? '9:16';
  if (ra !== rb) items.push({ kind: 'canvas', track_kind: null, clip_id: null, before: null, after: null, summary: `Rasio ${ra} → ${rb}` });
  return items;
}

/**
 * Validate planner output (untrusted, from rules or an LLM) against the current timeline:
 * shape (same validator as HTTP edits), op count, and a dry-run of the whole list — an invalid
 * plan is rejected as a whole, never half-applied. Returns the ops, their labels and the diff.
 */
export function checkPlan(timeline: Timeline, rawOps: unknown, sourceDuration?: SourceDuration, maxOps = MAX_PLAN_OPS): { ops: EditOp[]; labels: string[]; diff: DiffItem[] } {
  if (Array.isArray(rawOps) && rawOps.length > maxOps) bad(`Rencana maksimal ${maxOps} operasi`);
  const ops = validateOps(rawOps, maxOps);
  // Checkpoint E E1: a plan may only touch clips that exist now. Clips created by the plan get
  // their real ids only when applied, so referring to them would validate here and fail later
  // (and break "approve some operations").
  const existing = new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.clip_id)));
  for (const op of ops) {
    if ('clip_id' in op && !existing.has(op.clip_id)) bad(`Rencana merujuk klip yang tidak ada di linimasa sekarang (${op.clip_id}). Pisahkan jadi dua perintah: jalankan yang pertama dulu.`, { clip_id: op.clip_id });
  }
  let n = 0;
  const after = applyOps(timeline, ops, () => `plan_new_${++n}`, sourceDuration);
  return { ops, labels: describeOps(ops, timeline), diff: diffTimelines(timeline, after) };
}

/** Selected subset (approve some operations only). Indices must be unique and in range. */
export function pickOps(ops: EditOp[], accept: unknown): EditOp[] {
  if (accept === undefined) return ops;
  if (!Array.isArray(accept) || !accept.length || accept.length > ops.length || !accept.every((i) => Number.isInteger(i) && i >= 0 && i < ops.length) || new Set(accept).size !== accept.length) {
    bad('Pilihan operasi tidak valid');
  }
  return [...(accept as number[])].sort((a, b) => a - b).map((i) => ops[i]!);
}

// ------------------------------------------------------------------ local rule planner

/** X06: what the planner may use from the Brand Kit (no file ids: only what words can ask for). */
export interface BrandContext {
  colors: string[];
  text_color: string;
  has_font: boolean;
  has_logo: boolean;
}

export interface PlanContext {
  timeline: Timeline;
  selected_clip_ids?: string[];
  playhead_ms?: number;
  brand?: BrandContext;
}

export type LocalPlanResult = { ok: true; ops: EditOp[]; rationale: string; warnings: string[] } | { ok: false; message: string };

/** Commands the local planner understands (shown when a prompt is not recognised). */
export const LOCAL_EXAMPLES = [
  'hook "Diskon 50% hari ini!" 2 detik',
  'tambah teks "Cek keranjang kuning" detik 3-6',
  'subtitle "Halo semua" 0:01-0:04',
  'CTA "Join live jam 7" di akhir',
  'ubah rasio ke 1:1',
  'potong di detik 3',
  'geser klip terpilih ke detik 5',
  'ganti teks jadi "Promo terbatas"',
  'durasi klip terpilih 4 detik',
  'hapus klip terpilih',
  'hapus semua teks',
  'sale "DISKON 70%" detik 1-3',
  'usp "Bahan adem" detik 3-6',
  'warna teks merah (klip teks terpilih)',
  'kotak kuning (klip teks terpilih)',
  'pakai preset cta (klip teks terpilih)',
  'posisi teks bawah, lebih besar (klip teks terpilih)',
  'volume 40% (klip video/audio terpilih)',
  'bisukan track video',
  'pakai brand / warna brand / font brand (klip teks terpilih)',
  'tampilkan logo / sembunyikan logo',
];

/**
 * Style words in a command (X03): preset, tone, text colour, box colour / no box, position,
 * bigger/smaller. Returns null when the command mentions no style at all.
 */
export function parseStyleWords(low: string, base?: Partial<TextStyle>, brand?: BrandContext): Partial<TextStyle> | null {
  let style: Partial<TextStyle> = {};
  let hit = false;
  // X06: brand words — "pakai brand"/"gaya brand" (font + main colour box + text colour),
  // "warna brand", "kotak brand", "font brand", "font bawaan".
  if (/\bbrand\b/.test(low) || /\bfont\s+(?:bawaan|default|biasa)\b/.test(low)) {
    const needColors = () => (brand?.colors.length ? brand.colors : bad('Brand Kit belum punya warna. Isi dulu di menu Brand Kit.'));
    if (/\b(?:pakai|gaya|style|tema|ala)\s+brand\b|\bbrand\s*kit\b/.test(low)) {
      const [main] = needColors();
      style = { ...style, bg: main!, bg_opacity: 1, color: brand!.text_color, ...(brand!.has_font ? { font: 'brand' as const } : {}) };
      hit = true;
    }
    if (/\b(?:warna|color)\s+(?:teks\s+)?brand\b/.test(low)) {
      style.color = needColors()[0]!;
      hit = true;
    }
    if (/\b(?:kotak|latar|background|bg)\s+brand\b/.test(low)) {
      style.bg = needColors()[0]!;
      style.bg_opacity = 1;
      hit = true;
    }
    if (/\bfont\s+brand\b/.test(low)) {
      if (!brand?.has_font) bad('Brand Kit belum punya font. Unggah file .ttf/.otf lalu pilih di Brand Kit.');
      style.font = 'brand';
      hit = true;
    } else if (/\bfont\s+(?:bawaan|default|biasa)\b/.test(low)) {
      style.font = 'default';
      hit = true;
    }
  }
  const colorOf = (w: string) => (/^#[0-9a-f]{6}$/.test(w) ? w : Object.hasOwn(COLOR_WORDS, w) ? COLOR_WORDS[w] : undefined); // G-4: no inherited keys
  const preset = /\b(?:preset|jadikan|gaya|style)\s+(hook|usp|cta|sale|subtitle)\b/.exec(low);
  if (preset) {
    style = { ...presetById(preset[1] as PresetId)!.style };
    hit = true;
  }
  for (const [word, tweak] of Object.entries(TONES)) {
    if (new RegExp(`\\b(?:tone|nuansa|gaya|style)?\\s*${word}\\b`).test(low) && new RegExp(`\\b${word}\\b`).test(low)) {
      style = { ...style, ...tweak };
      hit = true;
    }
  }
  const color = /\b(?:warna|color|colour)\s+(?:teks\s+|tulisan\s+|huruf\s+)?(?:jadi\s+|ke\s+|menjadi\s+)?(#[0-9a-f]{6}|[a-z]+)\b/.exec(low) ?? /\b(?:teks|tulisan|huruf)\s+(?:warna\s+)?(#[0-9a-f]{6}|[a-z]+)\b/.exec(low);
  if (color && colorOf(color[1]!)) {
    style.color = colorOf(color[1]!)!;
    hit = true;
  }
  if (/\b(?:tanpa|hapus|hilangkan|no)\s+(?:kotak|latar|background|bg)\b/.test(low)) {
    style.bg = null;
    hit = true;
  } else {
    const bg = /\b(?:kotak|latar|background|bg)\s+(?:warna\s+)?(?:jadi\s+|ke\s+|menjadi\s+)?(#[0-9a-f]{6}|[a-z]+)\b/.exec(low);
    if (bg && colorOf(bg[1]!)) {
      style.bg = colorOf(bg[1]!)!;
      style.bg_opacity = style.bg_opacity ?? 1;
      hit = true;
    }
  }
  const pos = /\b(?:posisi|taruh|letakkan|pindah(?:kan)?)\b[^.;]*?\b(atas|tengah|bawah)\b/.exec(low) ?? /\b(?:di|ke)\s+(atas|tengah|bawah)\b/.exec(low);
  if (pos) {
    style.y = pos[1] === 'atas' ? 0.2 : pos[1] === 'tengah' ? 0.5 : 0.75;
    hit = true;
  }
  const size = base?.size ?? style.size ?? 6.2;
  if (/\b(?:lebih\s+besar|perbesar|besarkan|bigger)\b/.test(low)) {
    style.size = Math.min(20, Math.round(size * 1.25 * 10) / 10);
    hit = true;
  } else if (/\b(?:lebih\s+kecil|perkecil|kecilkan|smaller)\b/.test(low)) {
    style.size = Math.max(2, Math.round(size * 0.8 * 10) / 10);
    hit = true;
  }
  return hit ? style : null;
}

const QUOTE_RE = /"([^"]{1,500})"|“([^”]{1,500})”|'([^']{1,500})'/;
const NUM = String.raw`(\d{1,2}:\d{2}(?:[.,]\d)?|\d+(?:[.,]\d+)?)`;

/** "3", "2.5", "2,5", "0:04", "1:05.5" → ms. */
export function parseTime(raw: string): number {
  const s = raw.replace(',', '.');
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    return Math.round((Number(m) * 60 + Number(sec)) * 1000);
  }
  return Math.round(Number(s) * 1000);
}

function timeRange(text: string): { start: number; end: number } | null {
  const re = new RegExp(String.raw`${NUM}\s*(?:s|dtk|detik)?\s*(?:-|–|sampai|sd|s\.d\.|hingga|to|until)\s*${NUM}`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const start = parseTime(m[1]!);
  const end = parseTime(m[2]!);
  return end > start ? { start, end } : null;
}

function atTime(text: string): number | null {
  const m = new RegExp(String.raw`(?:detik(?:\s+ke)?|di|pada|at|ke|to)\s*${NUM}\s*(?:s|dtk|detik)?`, 'i').exec(text) ?? new RegExp(String.raw`${NUM}\s*(?:s|dtk|detik)\b`, 'i').exec(text);
  return m ? parseTime(m[1]!) : null;
}

function lengthOf(text: string): number | null {
  const m = new RegExp(String.raw`${NUM}\s*(?:s|dtk|detik|second|seconds)\b`, 'i').exec(text);
  return m ? parseTime(m[1]!) : null;
}

const RATIO_WORDS: [RegExp, CanvasRatio][] = [
  [/\b(9:16|vertikal|vertical|portrait|tiktok|reels|shorts)\b/i, '9:16'],
  [/\b(1:1|persegi|kotak|square)\b/i, '1:1'],
  [/\b(16:9|landscape|horizontal|youtube)\b/i, '16:9'],
  [/\b(3:4)\b/i, '3:4'],
];

const DEFAULT_TEXT_SIZE = (kind: TrackKind): Partial<TextStyle> => ({ size: kind === 'subtitle' ? 4.5 : 6.2 });

export const timelineEndMs = (t: Timeline) => Math.max(0, ...t.tracks.flatMap((tr) => tr.clips.map((c) => c.end_ms)));

/** Overlap check on one track, so the planner can explain the clash instead of failing later. */
function clash(t: Timeline, kind: TrackKind, start: number, end: number) {
  const tr = t.tracks.find((x) => x.kind === kind);
  return tr?.clips.find((c) => c.start_ms < end && start < c.end_ms) ?? null;
}

/** Split a prompt into commands: ";", new lines, " lalu ", " kemudian ", " then ". Quotes are kept intact. */
function splitCommands(prompt: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let q: string | null = null;
  const closers: Record<string, string> = { '"': '"', '“': '”', "'": "'" };
  for (let i = 0; i < prompt.length; i++) {
    const ch = prompt[i]!;
    if (q) {
      if (ch === q) q = null;
      buf += ch;
      continue;
    }
    if (ch in closers && (ch !== "'" || /[\s:=]/.test(prompt[i - 1] ?? ' '))) {
      q = closers[ch]!;
      buf += ch;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      parts.push(buf);
      buf = '';
      continue;
    }
    const rest = prompt.slice(i).toLowerCase();
    const sep = [' lalu ', ' kemudian ', ' then '].find((s) => rest.startsWith(s));
    if (sep) {
      parts.push(buf);
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Zero-LLM planner (PRD "Local mode": no external call, documented subset of instructions).
 * Indonesian + English patterns. Unknown commands are reported, never guessed.
 */
export function planLocal(prompt: string, ctx: PlanContext): LocalPlanResult {
  const text = prompt.trim();
  if (!text) return { ok: false, message: 'Perintah kosong.' };
  if (text.length > MAX_PROMPT_LEN) return { ok: false, message: `Perintah maksimal ${MAX_PROMPT_LEN} karakter.` };
  let t = ctx.timeline;
  const ops: EditOp[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];
  const selected = (ctx.selected_clip_ids ?? []).map((id) => findClip(t, id)).filter((x): x is NonNullable<typeof x> => !!x);
  let n = 0;
  const push = (op: EditOp, why: string) => {
    t = applyOps(t, [op], () => `plan_new_${++n}`); // throws EDIT_INVALID with a clear message
    ops.push(op);
    reasons.push(why);
  };

  for (const cmd of splitCommands(text)) {
    const qm = QUOTE_RE.exec(cmd);
    const quoted = qm ? (qm[1] ?? qm[2] ?? qm[3] ?? '').trim() : null;
    if (quoted !== null && (!quoted || quoted.length > MAX_TEXT_LEN)) return { ok: false, message: `Teks dalam tanda kutip wajib 1–${MAX_TEXT_LEN} karakter.` };
    const bare = qm ? cmd.replace(qm[0], ' ') : cmd; // numbers inside the quoted text are not times
    const lowBare = bare.toLowerCase();

    try {
      // ---- ratio
      if (/\b(rasio|ratio|aspect|format|ukuran canvas|kanvas)\b/i.test(lowBare)) {
        const hit = RATIO_WORDS.find(([re]) => re.test(lowBare));
        if (!hit) return { ok: false, message: `Rasio tidak dikenali. Pilihan: ${CANVAS_RATIOS.join(', ')}.` };
        push({ op: 'set_canvas', ratio: hit[1] }, `rasio ${hit[1]}`);
        continue;
      }

      // ---- delete all text / subtitles
      const all = /\b(hapus|delete|remove|bersihkan)\b.*\b(semua|all)\b.*\b(teks|text|subtitle|caption|takarir)\b/i.exec(lowBare);
      if (all) {
        const kind: TrackKind = /subtitle|caption|takarir/.test(all[3]!) ? 'subtitle' : 'text';
        const clips = t.tracks.find((x) => x.kind === kind)?.clips ?? [];
        if (!clips.length) return { ok: false, message: `Tidak ada klip ${TRACK_NAME[kind]} untuk dihapus.` };
        for (const c of [...clips]) push({ op: 'delete_clip', clip_id: c.clip_id }, `hapus ${TRACK_NAME[kind]}`);
        warnings.push(`Menghapus ${clips.length} klip ${TRACK_NAME[kind]} sekaligus (bisa di-undo).`);
        continue;
      }

      const needOneSelected = (what: string) => {
        if (selected.length !== 1) throw new StorageError('EDIT_INVALID', `Pilih satu klip di linimasa dulu untuk "${what}".`);
        const f = findClip(t, selected[0]!.clip.clip_id);
        if (!f) throw new StorageError('EDIT_INVALID', 'Klip terpilih sudah tidak ada di rencana ini.');
        return f;
      };

      // ---- delete selected
      if (/\b(hapus|delete|remove|buang)\b/.test(lowBare) && /\b(klip|clip|ini|this|terpilih|selected|yang dipilih)\b/.test(lowBare) && quoted === null) {
        const f = needOneSelected('hapus klip');
        push({ op: 'delete_clip', clip_id: f.clip.clip_id }, 'hapus klip terpilih');
        continue;
      }

      // ---- replace text of the selected clip
      if (/\b(ganti|ubah|edit|change|replace)\b/.test(lowBare) && /\b(teks|text|tulisan|subtitle|caption)\b/.test(lowBare) && quoted !== null && !/\b(tambah|add|buat)\b/.test(lowBare)) {
        const f = needOneSelected('ganti teks');
        if (f.track.kind !== 'text' && f.track.kind !== 'subtitle') throw new StorageError('EDIT_INVALID', 'Klip terpilih bukan klip teks/subtitle.');
        push({ op: 'set_text', clip_id: f.clip.clip_id, text: quoted }, 'ganti teks');
        continue;
      }

      // ---- brand logo (X06): "tampilkan logo" / "sembunyikan logo"
      const logo = /\b(tampilkan|pasang|munculkan|show|sembunyikan|hilangkan|hapus|lepas|hide)\b[^.;]*\blogo\b/.exec(lowBare);
      if (logo) {
        const on = /tampilkan|pasang|munculkan|show/.test(logo[1]!);
        if (on && !ctx.brand?.has_logo) return { ok: false, message: 'Brand Kit belum punya logo. Unggah gambar logo lalu pilih di Brand Kit.' };
        push({ op: 'set_brand_logo', on }, on ? 'tampilkan logo' : 'sembunyikan logo');
        continue;
      }

      // ---- sound (X04): "bisukan track musik/audio/video/b-roll", "volume 40%", "bisukan klip"
      const trackMute = /\b(bisukan|mute|matikan suara|nyalakan suara|unmute)\b.*\btrack\s+(video|b-?roll|audio|musik|music|sfx)\b/.exec(lowBare);
      if (trackMute) {
        const kind = trackMute[2] === 'video' ? 'video' : trackMute[2]!.startsWith('b') ? 'broll' : trackMute[2]!.startsWith('mus') ? 'music' : trackMute[2] === 'sfx' ? 'sfx' : 'audio';
        push({ op: 'set_track_mute', track_kind: kind, muted: !/nyalakan suara|unmute/.test(trackMute[1]!) }, 'mute track');
        continue;
      }
      const vol = /\bvolume\b[^0-9]*(\d{1,3})\s*%/.exec(lowBare);
      if (vol || /\b(bisukan|mute)\b/.test(lowBare)) {
        const f = needOneSelected('ubah volume');
        if (!f.clip.media) throw new StorageError('EDIT_INVALID', 'Volume hanya untuk klip video/audio. Pilih klipnya dulu.');
        const v = vol ? Math.min(100, Number(vol[1])) / 100 : 0;
        push({ op: 'set_volume', clip_id: f.clip.clip_id, volume: v }, 'volume');
        continue;
      }

      // ---- style of the selected text (X03): colour, box, preset, tone, position, size
      if (quoted === null && /\b(warna|color|colour|kotak|latar|background|preset|jadikan|tone|nuansa|gaya|style|posisi|taruh|letakkan|besar|kecil|perbesar|perkecil|besarkan|kecilkan|minimalis|minimal|elegan|elegant|tegas|tanpa|brand|font)\b/.test(lowBare) && !/\b(potong|split|geser|pindahkan klip|hapus klip|durasi|rasio|ratio)\b/.test(lowBare)) {
        const f = needOneSelected('ubah gaya teks');
        if (f.track.kind !== 'text' && f.track.kind !== 'subtitle') throw new StorageError('EDIT_INVALID', 'Klip terpilih bukan klip teks/subtitle.');
        const style = parseStyleWords(lowBare, { ...DEFAULT_TEXT_SIZE(f.track.kind), ...(f.clip.style ?? {}) }, ctx.brand);
        if (!style) return { ok: false, message: 'Gaya apa yang mau diubah? Contoh: "warna teks merah", "kotak kuning", "pakai preset cta", "posisi bawah", "lebih besar".' };
        push({ op: 'set_style', clip_id: f.clip.clip_id, style }, 'ubah gaya');
        continue;
      }

      // ---- split
      if (/\b(potong|split|belah|cut)\b/.test(lowBare) && !/\b(sampai|hingga|-|–)\b/.test(lowBare.replace(/\b(potong|split|belah|cut)\b/, ''))) {
        const at = /\b(di sini|disini|playhead|here)\b/.test(lowBare) ? (ctx.playhead_ms ?? null) : atTime(lowBare);
        if (at === null) return { ok: false, message: 'Sebutkan waktunya, mis. "potong di detik 3".' };
        let target = selected.length === 1 ? findClip(t, selected[0]!.clip.clip_id) : null;
        if (!target) {
          for (const kind of ['video', 'broll', 'audio', 'text', 'subtitle'] as TrackKind[]) {
            const tr = t.tracks.find((x) => x.kind === kind);
            const c = tr?.clips.find((x) => x.start_ms < at && at < x.end_ms);
            if (tr && c) {
              target = { track: tr, clip: c };
              break;
            }
          }
        }
        if (!target || !(target.clip.start_ms < at && at < target.clip.end_ms)) return { ok: false, message: `Tidak ada klip yang bisa dipotong di ${fmtTime(at)}.` };
        push({ op: 'split_clip', clip_id: target.clip.clip_id, at_ms: at }, `potong di ${fmtTime(at)}`);
        continue;
      }

      // ---- move selected
      if (/\b(geser|pindah|pindahkan|move)\b/.test(lowBare)) {
        const f = needOneSelected('geser klip');
        const to = atTime(lowBare);
        if (to === null) return { ok: false, message: 'Sebutkan tujuan, mis. "geser klip terpilih ke detik 5".' };
        push({ op: 'move_clip', clip_id: f.clip.clip_id, start_ms: to }, `geser ke ${fmtTime(to)}`);
        continue;
      }

      // ---- duration of selected
      if (/\b(durasi|panjang|duration|perpanjang|perpendek|pendekkan|length)\b/.test(lowBare) && quoted === null) {
        const f = needOneSelected('ubah durasi');
        const len = lengthOf(lowBare);
        if (!len || len < MIN_CLIP_MS) return { ok: false, message: 'Sebutkan durasinya, mis. "durasi klip terpilih 4 detik".' };
        push({ op: 'trim_clip', clip_id: f.clip.clip_id, edge: 'end', to_ms: f.clip.start_ms + len }, `durasi ${len / 1000} dtk`);
        continue;
      }

      // ---- add text / hook / CTA / subtitle
      const isSub = /\b(subtitle|caption|takarir)\b/.test(lowBare);
      const isHook = /\bhook\b/.test(lowBare);
      const isCta = /\b(cta|call to action|ajakan)\b/.test(lowBare);
      const isText = /\b(teks|text|tulisan|judul|title|headline|tambah|tambahkan|add)\b/.test(lowBare);
      const isUsp = /\b(usp|keunggulan)\b/.test(lowBare);
      const isSale = /\bsale\b/.test(lowBare);
      if (quoted !== null && (isSub || isHook || isCta || isText || isUsp || isSale)) {
        const kind: TrackKind = isSub ? 'subtitle' : 'text';
        let start: number;
        let end: number;
        const range = timeRange(lowBare);
        const len = lengthOf(lowBare);
        if (range) {
          ({ start, end } = range);
        } else if (isHook) {
          start = 0;
          end = len ?? 2000;
        } else if ((isUsp || isSale) && atTime(lowBare) === null) {
          start = ctx.playhead_ms ?? 0;
          end = start + (len ?? presetById(isSale ? 'sale' : 'usp')!.duration_ms);
        } else if (isCta || /\b(di akhir|akhir video|at the end|ending|penutup)\b/.test(lowBare)) {
          const endAll = timelineEndMs(t);
          if (endAll <= 0) return { ok: false, message: 'Linimasa masih kosong, jadi "di akhir" belum ada. Sebutkan waktunya, mis. detik 5-8.' };
          const d = Math.min(len ?? 3000, endAll);
          start = endAll - d;
          end = endAll;
        } else {
          const at = atTime(lowBare);
          start = at ?? ctx.playhead_ms ?? 0;
          end = start + (len ?? 3000);
          if (at === null) warnings.push(`Waktu tidak disebut: ${TRACK_NAME[kind]} ditaruh di ${fmtTime(start)} (posisi playhead).`);
        }
        const c = clash(t, kind, start, end);
        if (c) return { ok: false, message: `Bentrok dengan ${TRACK_NAME[kind]} yang sudah ada di ${fmtTime(c.start_ms)}–${fmtTime(c.end_ms)}. Pilih waktu lain atau hapus dulu.` };
        // X03: the preset look of the kind of text asked for, plus any colour/tone/position words.
        const presetId: PresetId | null = isHook ? 'hook' : isCta ? 'cta' : isSale ? 'sale' : isUsp ? 'usp' : null;
        const base = presetId ? { ...presetById(presetId)!.style } : {};
        const extra = parseStyleWords(lowBare, base, ctx.brand) ?? {};
        const style = { ...base, ...extra };
        push({ op: 'add_clip', track_kind: kind, text: quoted, ...(Object.keys(style).length ? { style } : {}), start_ms: start, duration_ms: end - start }, presetId ?? kind);
        continue;
      }
    } catch (e) {
      if (e instanceof StorageError && e.code === 'EDIT_INVALID') return { ok: false, message: e.message };
      throw e;
    }
    return { ok: false, message: `Perintah "${cmd.length > 60 ? `${cmd.slice(0, 59)}…` : cmd}" belum dikenali planner lokal (tanpa AI).` };
  }
  const original = new Set(ctx.timeline.tracks.flatMap((tr) => tr.clips.map((c) => c.clip_id)));
  if (ops.some((o) => 'clip_id' in o && !original.has(o.clip_id))) {
    return { ok: false, message: 'Perintah ini mengubah klip yang baru dibuat oleh perintah sebelumnya dalam satu rencana. Jalankan perintah pertama dulu, lalu ketik perintah berikutnya.' };
  }
  return { ok: true, ops, rationale: `Planner lokal (tanpa AI): ${reasons.join(', ')}.`, warnings };
}
