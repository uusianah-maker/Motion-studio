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
  | { jenis: 'koreksi'; bagian: 'kata' | 'hook' | 'potongan'; op: string; clip_id: string; track: string; sebelum: unknown; sesudah: unknown; asal: EngineOrigin };

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

/**
 * What an editor changed in an engine draft, from one edit: words of subtitles (`kata`), the hook
 * (a text clip in the first 3 s), or cuts of video / audio clips (`potongan`).
 */
export function correctionsFrom(before: Timeline, ops: unknown[], after: Timeline, asal: EngineOrigin): LearningNote[] {
  const out: LearningNote[] = [];
  for (const raw of ops as Op[]) {
    const op = typeof raw?.op === 'string' ? raw.op : '';
    if (op === 'set_text' && typeof raw.clip_id === 'string') {
      const b = clipIn(before, raw.clip_id);
      const a = clipIn(after, raw.clip_id);
      if (!b || b.clip.text === a?.clip.text) continue;
      const bagian = b.track === 'subtitle' ? 'kata' : b.track === 'text' && b.clip.start_ms < 3000 ? 'hook' : null;
      if (bagian) out.push({ jenis: 'koreksi', bagian, op, clip_id: raw.clip_id, track: b.track, sebelum: text(b.clip.text), sesudah: text(a?.clip.text), asal });
    } else if (CUT_OPS.has(op)) {
      const id = typeof raw.clip_id === 'string' ? raw.clip_id : null;
      const b = id ? clipIn(before, id) : null;
      if (id && b && b.track !== 'video' && b.track !== 'broll' && b.track !== 'audio') continue;
      out.push({
        jenis: 'koreksi',
        bagian: 'potongan',
        op,
        clip_id: id ?? '',
        track: b?.track ?? (typeof raw.track_kind === 'string' ? raw.track_kind : ''),
        sebelum: id ? cutView(b?.clip) : { from_ms: raw.from_ms ?? raw.at_ms ?? null, to_ms: raw.to_ms ?? null },
        sesudah: id ? cutView(clipIn(after, id)?.clip) : null,
        asal,
      });
    }
  }
  return out;
}
