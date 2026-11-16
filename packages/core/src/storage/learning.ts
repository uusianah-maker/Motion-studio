/**
 * R9: learning notes per brand (hybrid principle — every human override is recorded so the engine
 * can learn later; nothing reads them yet). One JSON line per note in
 * `.motionstudio/brands/<brand_id>/belajar.jsonl`:
 *   - `revisi_pic`  the PIC's Revisi note on a project;
 *   - `koreksi`     an editor's change to a draft the ENGINE made (Generate plan applied, or a Batch
 *                   Remix variant): words (`kata`), cuts (`potongan`) or the hook (`hook`).
 * A project made by the engine carries `03_PROJECT/asal-mesin.json`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readBrandFor } from './brand.js';
import type { Clip, Timeline } from './project.js';
import { LAYOUT, type Workspace, projectRel, readProject } from './workspace.js';

export const LEARN_FILE = 'belajar.jsonl';
const MAX_TEXT = 500;

export interface EngineOrigin {
  /** `generate` = an engine plan applied through Copilot; `batch` = a Batch Remix variant. */
  kind: 'generate' | 'batch';
  job_id?: string;
  varian?: string;
  at: number;
}

const originFile = (ws: Workspace, projectId: string) => path.join(ws.root, ...projectRel(projectId, '03_PROJECT').split('/'), 'asal-mesin.json');
export const learnFile = (ws: Workspace, brandId: string) => path.join(ws.root, LAYOUT.meta, 'brands', brandId, LEARN_FILE);

export async function markEngineOrigin(ws: Workspace, projectId: string, origin: Omit<EngineOrigin, 'at'>): Promise<void> {
  await fsp.writeFile(originFile(ws, projectId), JSON.stringify({ ...origin, at: ws.clock.now() }), 'utf8');
}

export async function engineOrigin(ws: Workspace, projectId: string): Promise<EngineOrigin | null> {
  try {
    const o = JSON.parse(await fsp.readFile(originFile(ws, projectId), 'utf8')) as EngineOrigin;
    return o && (o.kind === 'generate' || o.kind === 'batch') ? o : null;
  } catch {
    return null;
  }
}

export type LearningNote =
  | { jenis: 'revisi_pic'; revision: number; note: string; by: string | null }
  | { jenis: 'koreksi'; bagian: Bagian; op: string; clip_id: string; track: string; sebelum: unknown; sesudah: unknown; asal: EngineOrigin }
  /** Motion Transfer: the team deleted / merged the engine's scenes (or went back to them). */
  | { jenis: 'transfer_tim'; job_id: string; aksi: 'hapus' | 'gabung' | 'pulihkan'; adegan: string | null; sisa: number; dari_mesin: number; by: string | null };

/** What part of the draft an editor changed (PC-R6, owner 15 Nov: "catat semua koreksi"). */
export type Bagian = 'kata' | 'hook' | 'teks' | 'potongan' | 'posisi' | 'gaya' | 'audio' | 'gambar' | 'tambah' | 'lainnya';

/** Append one note to the project's brand log (never throws: learning must not break editing). */
export async function appendLearning(ws: Workspace, projectId: string, note: LearningNote): Promise<string | null> {
  try {
    const p = await readProject(ws, projectId);
    const kit = await readBrandFor(ws, p.brand_id);
    if (!kit.brand_id) return null;
    const file = learnFile(ws, kit.brand_id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify({ schema: 'belajar/1', at: ws.clock.now(), brand_id: kit.brand_id, project_id: projectId, ...note })}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

export async function readLearning(ws: Workspace, brandId: string): Promise<Record<string, unknown>[]> {
  const raw = await fsp.readFile(learnFile(ws, brandId), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);
}

type Op = { op?: unknown; clip_id?: unknown } & Record<string, unknown>;
const CUT_OPS = new Set(['trim_clip', 'split_clip', 'split_at', 'remove_range', 'delete_clip', 'move_clip']);
const clipIn = (t: Timeline, id: string): { track: string; clip: Clip } | null => {
  for (const tr of t.tracks) for (const c of tr.clips) if (c.clip_id === id) return { track: tr.kind, clip: c };
  return null;
};
const cutView = (c: Clip | undefined) => (c ? { start_ms: c.start_ms, end_ms: c.end_ms, in_ms: c.in_ms ?? 0 } : null);
const text = (s: string | undefined) => (s ?? '').slice(0, MAX_TEXT);

const MEDIA_TRACKS = new Set(['video', 'broll', 'audio']);
const CLIP_GROUP: Record<string, Bagian> = { set_style: 'gaya', set_volume: 'audio', set_audio: 'audio', set_framing: 'gambar', set_picture: 'gambar', set_keyframes: 'gambar', set_motion: 'gambar', freeze_frame: 'gambar', set_style_many: 'gaya' };
const TRACK_GROUP: Record<string, Bagian> = { set_ducking: 'audio', set_loudness: 'audio', set_track_mute: 'audio', set_canvas: 'gambar', set_brand_logo: 'gambar' };
/** A clip as recorded: everything but the per-word timings (long, and kept by `kata` anyway). */
const snap = (c: Clip | undefined) => {
  if (!c) return null;
  const { words: _w, ...rest } = c as Clip & { words?: unknown };
  void _w;
  return rest;
};
const opParams = (raw: Op) => {
  const { op: _o, ...rest } = raw;
  void _o;
  return rest;
};

/**
 * Every change an editor made to an engine draft in one edit (PC-R6: "catat semua koreksi"):
 * words (`kata`), the hook (text in the first 3 s), other text (`teks`), cuts of video / b-roll /
 * audio (`potongan`), timing of other clips (`posisi`), look (`gaya`), sound (`audio`), picture
 * (`gambar`), added clips (`tambah`) — with the value before and after.
 */
export function correctionsFrom(before: Timeline, ops: unknown[], after: Timeline, asal: EngineOrigin): LearningNote[] {
  const out: LearningNote[] = [];
  // Before / after are the whole edit's: one note per clip and kind of change is enough.
  const seen = new Set<string>();
  const note = (bagian: Bagian, op: string, clip_id: string, track: string, sebelum: unknown, sesudah: unknown) => {
    if (clip_id) {
      if (seen.has(`${op}:${clip_id}`)) return;
      seen.add(`${op}:${clip_id}`);
    }
    out.push({ jenis: 'koreksi', bagian, op, clip_id, track, sebelum, sesudah, asal });
  };
  for (const raw of ops as Op[]) {
    const op = typeof raw?.op === 'string' ? raw.op : '';
    const id = typeof raw?.clip_id === 'string' ? raw.clip_id : null;
    const b = id ? clipIn(before, id) : null;
    const a = id ? clipIn(after, id) : null;
    if (op === 'set_text' && id) {
      if (!b || b.clip.text === a?.clip.text) continue;
      const bagian: Bagian = b.track === 'subtitle' ? 'kata' : b.track === 'text' && b.clip.start_ms < 3000 ? 'hook' : 'teks';
      note(bagian, op, id, b.track, text(b.clip.text), text(a?.clip.text));
    } else if (CUT_OPS.has(op)) {
      if (id && !b) continue;
      const media = !b || MEDIA_TRACKS.has(b.track);
      const track = b?.track ?? (typeof raw.track_kind === 'string' ? raw.track_kind : '');
      note(media ? 'potongan' : 'posisi', op, id ?? '', track, id ? cutView(b?.clip) : { from_ms: raw.from_ms ?? raw.at_ms ?? null, to_ms: raw.to_ms ?? null }, id ? cutView(a?.clip) : null);
    } else if (CLIP_GROUP[op] && id) {
      if (!b) continue;
      note(CLIP_GROUP[op]!, op, id, b.track, snap(b.clip), snap(a?.clip));
    } else if (TRACK_GROUP[op]) {
      note(TRACK_GROUP[op]!, op, id ?? '', typeof raw.track_kind === 'string' ? raw.track_kind : '', null, opParams(raw));
    } else if (op === 'add_clip') {
      note('tambah', op, '', typeof raw.track_kind === 'string' ? raw.track_kind : '', null, opParams(raw));
    } else if (op) {
      note('lainnya', op, id ?? '', b?.track ?? '', b ? snap(b.clip) : null, a ? snap(a.clip) : opParams(raw));
    }
  }
  return out;
}
