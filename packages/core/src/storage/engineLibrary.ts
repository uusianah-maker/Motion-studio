/**
 * Batch Remix library (audit yuki 14 Nov, fitur 2 + 4 + 5). Read-only views of the engine's own
 * `konten/` folder, and the team's shot exclusions (kept on the APP side, sent to the engine as
 * `kecualikan_shot` in job.json — the app never writes into the engine's folder).
 *
 *  - `engine daftar_batch`  → stdout `{schema: 'daftar-batch/1', batch: [...]}` (pipeline/batch/daftar.py)
 *  - `konten/2-dipisah/<batch>/shots.json` → Shot Library (labels per shot, engine-made thumbnails)
 *  - `<ws>/.motionstudio/engine-batch/<batch>.json` → shots the team excluded
 *
 * Nothing here returns a local path to the browser.
 */
import fsp from 'node:fs/promises';
import { lowerPriority } from './priority.js';
import path from 'node:path';
import { audit } from './audit.js';
import { type EngineConfig, type Spawner, engineEnv, isBatchName, killTree, scrubPaths } from './engine.js';
import { StorageError } from './errors.js';
import { writeJsonAtomic } from './jsonStore.js';
import { isInside } from './paths.js';
import { type Workspace, LAYOUT } from './workspace.js';
import { spawn } from 'node:child_process';

export { isBatchName };
const SHOT = /^[A-Za-z0-9_.#:@-]{1,80}$/;
export const isShotId = (x: unknown): x is string => typeof x === 'string' && SHOT.test(x);
export const MAX_SHOTS = 5000;
/** Contract §9: `kecualikan_shot` holds at most 500 ids. */
export const MAX_EXCLUDED = 500;

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

// ------------------------------------------------------------------ engine daftar_batch

export interface EngineBatchInfo {
  batch: string;
  /** Videos uploaded (konten/1-upload/<batch>). */
  upload: number;
  /** Silent videos after Pisah Audio. */
  footage: number;
  vo: number;
  musik: number;
  dipisah: boolean;
  dipisah_pada: number | null;
  shot_library: boolean;
  jumlah_shot: number;
  /** Usable as the picture batch (footage + Shot Library). */
  siap_batch: boolean;
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Parse the engine's `daftar_batch` output (untrusted). */
export function parseBatchList(stdout: string): EngineBatchInfo[] {
  const text = stdout.trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const last = text.split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('[')).pop();
    try {
      data = last ? JSON.parse(last) : null;
    } catch {
      data = null;
    }
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { batch?: unknown })?.batch) ? (data as { batch: unknown[] }).batch : null;
  if (!list) throw new StorageError('PRECONDITION', 'Jawaban daftar_batch dari mesin tidak bisa dibaca');
  const out: EngineBatchInfo[] = [];
  for (const r of list.slice(0, 500) as Record<string, unknown>[]) {
    if (!r || !isBatchName(r.batch)) continue;
    const footage = int(r.footage);
    const lib = r.shot_library === true;
    out.push({
      batch: r.batch,
      upload: int(r.upload),
      footage,
      vo: int(r.vo),
      musik: int(r.musik),
      dipisah: typeof r.dipisah === 'boolean' ? r.dipisah : footage > 0,
      dipisah_pada: typeof r.dipisah_pada === 'number' && Number.isFinite(r.dipisah_pada) ? r.dipisah_pada : null,
      shot_library: lib,
      jumlah_shot: int(r.jumlah_shot),
      siap_batch: typeof r.siap_batch === 'boolean' ? r.siap_batch : footage > 0 && lib,
    });
  }
  return out;
}

/**
 * Run a short read-only engine command (`engine daftar_batch`) and return its stdout. Same
 * interpreter, cwd and env allowlist as a job; killed after `timeout_ms`.
 */
export async function runEngineQuery(cfg: EngineConfig, command: 'daftar_batch', opts: { spawnImpl?: Spawner; timeout_ms?: number } = {}): Promise<string> {
  const MAX = 2 * 1024 * 1024;
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    let child: ReturnType<Spawner>;
    try {
      child = (opts.spawnImpl ?? spawn)(cfg.command, [cfg.script, command], { cwd: cfg.root, windowsHide: true, env: engineEnv() });
      lowerPriority(child);
    } catch (e) {
      reject(new StorageError('PRECONDITION', `Mesin tidak bisa dijalankan: ${scrubPaths(String(e)).slice(0, 200)}`));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeout_ms ?? 60_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (out.length < MAX) out += c;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      err = (err + c).slice(-2000);
    });
    child.on('error', (e) => {
      err += String(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new StorageError('PRECONDITION', `Mesin tidak menjawab ${command} (waktu habis)`));
      else if (code !== 0) {
        const tail = scrubPaths(err.trim().split('\n').slice(-1)[0] ?? '').slice(0, 200);
        reject(new StorageError('PRECONDITION', `Mesin belum mendukung ${command}${tail ? ` (${tail})` : ''}`));
      } else resolve(out);
    });
  });
}

export async function listEngineBatches(cfg: EngineConfig, opts: { spawnImpl?: Spawner; timeout_ms?: number } = {}): Promise<EngineBatchInfo[]> {
  return parseBatchList(await runEngineQuery(cfg, 'daftar_batch', opts));
}

// ------------------------------------------------------------------ Shot Library (read-only)

export type ShotLabel = string | number | boolean;
export interface LibraryShot {
  id: string;
  footage: string;
  dari: number;
  sampai: number;
  /** Labels as the engine wrote them, with the team's engine-side `koreksi` applied. */
  label: Record<string, ShotLabel>;
  tag: string[];
  /** Words spoken in the shot (Whisper), if any. */
  ucapan: string | null;
  /** Text burnt into the picture (OCR). */
  teks: string[];
  thumb: boolean;
  koreksi: boolean;
}
export interface ShotLibrary {
  batch: string;
  footage: { id: string; durasi: number | null }[];
  shots: LibraryShot[];
}

const NOT_LABEL = new Set(['id', 'footage', 'dari', 'sampai', 'thumb', 'koreksi', 'teks', 'wajah', 'ucapan', 'tag', 'video', 'path']);
const labelOf = (v: unknown): ShotLabel | undefined =>
  typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : typeof v === 'string' && v.length <= 40 && !/[\\/]/.test(v) ? v : undefined;

/** `<root>/konten/2-dipisah/<batch>`, real path, inside the engine folder. */
async function batchDir(cfg: EngineConfig, batch: string): Promise<string> {
  if (!isBatchName(batch)) bad('nama batch tidak valid');
  const rootReal = await fsp.realpath(cfg.root).catch(() => cfg.root);
  const real = await fsp.realpath(path.join(cfg.root, 'konten', '2-dipisah', batch)).catch(() => null);
  if (!real || !isInside(rootReal, real)) throw new StorageError('NOT_FOUND', `Batch ${batch} belum dipisah (tidak ada di mesin)`);
  return real;
}

async function readShotsFile(cfg: EngineConfig, batch: string): Promise<{ dir: string; data: Record<string, unknown> }> {
  const dir = await batchDir(cfg, batch);
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, 'shots.json'), 'utf8');
  } catch {
    throw new StorageError('NOT_FOUND', `Shot Library batch ${batch} belum dibuat (jalankan Pisah Audio dulu)`);
  }
  try {
    return { dir, data: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new StorageError('PRECONDITION', 'shots.json dari mesin rusak');
  }
}

export async function readShotLibrary(cfg: EngineConfig, batch: string): Promise<ShotLibrary> {
  const { data } = await readShotsFile(cfg, batch);
  const rawShots = Array.isArray(data.shots) ? (data.shots as Record<string, unknown>[]) : [];
  const shots: LibraryShot[] = [];
  for (const s of rawShots.slice(0, MAX_SHOTS)) {
    if (!s || !isShotId(s.id) || typeof s.footage !== 'string' || typeof s.dari !== 'number' || typeof s.sampai !== 'number') continue;
    const label: Record<string, ShotLabel> = {};
    for (const [k, v] of Object.entries(s)) {
      if (NOT_LABEL.has(k) || !/^[a-z_]{1,40}$/.test(k)) continue;
      const l = labelOf(v);
      if (l !== undefined) label[k] = l;
    }
    const koreksi = s.koreksi && typeof s.koreksi === 'object' ? (s.koreksi as Record<string, unknown>) : null;
    if (koreksi)
      for (const [k, v] of Object.entries(koreksi)) {
        const l = labelOf(v);
        if (l !== undefined && /^[a-z_]{1,40}$/.test(k)) label[k] = l;
      }
    const teks = Array.isArray(s.teks) ? (s.teks as unknown[]).map((t) => (typeof t === 'string' ? t : (t as { teks?: unknown })?.teks)).filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 80)).slice(0, 10) : [];
    shots.push({
      id: s.id,
      footage: s.footage.slice(0, 40),
      dari: s.dari,
      sampai: s.sampai,
      label,
      tag: Array.isArray(s.tag) ? (s.tag as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 40)).slice(0, 20) : [],
      ucapan: typeof s.ucapan === 'string' && s.ucapan.trim() ? s.ucapan.trim().slice(0, 300) : null,
      teks,
      thumb: typeof s.thumb === 'string' && s.thumb.length > 0,
      koreksi: !!koreksi && Object.keys(koreksi).length > 0,
    });
  }
  const fm = data.footage && typeof data.footage === 'object' ? (data.footage as Record<string, Record<string, unknown>>) : {};
  const footage = Object.entries(fm)
    .filter(([id]) => /^[A-Za-z0-9_.-]{1,40}$/.test(id))
    .slice(0, 1000)
    .map(([id, f]) => ({ id, durasi: typeof f?.durasi === 'number' && Number.isFinite(f.durasi) ? f.durasi : null }));
  return { batch, footage, shots };
}

const THUMB_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** Engine-made thumbnails of some shots, as data URLs (≤ 60 per call; each file ≤ 1 MB). */
export async function readShotThumbs(cfg: EngineConfig, batch: string, ids: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(ids) || ids.length > 60 || !ids.every(isShotId)) bad('ids harus daftar 1–60 id shot');
  const { dir, data } = await readShotsFile(cfg, batch);
  const want = new Set(ids as string[]);
  const out: Record<string, string> = {};
  for (const s of (Array.isArray(data.shots) ? data.shots : []) as Record<string, unknown>[]) {
    if (!s || !want.has(s.id as string) || typeof s.thumb !== 'string') continue;
    const abs = path.isAbsolute(s.thumb) ? s.thumb : path.join(cfg.root, s.thumb);
    const real = await fsp.realpath(abs).catch(() => null);
    // Only an image file inside this batch's folder: never anything else the engine might point at.
    const mime = real ? THUMB_EXT[path.extname(real).toLowerCase()] : undefined;
    if (!real || !mime || !isInside(dir, real)) continue;
    const st = await fsp.stat(real).catch(() => null);
    if (!st?.isFile() || st.size > 1024 * 1024) continue;
    out[s.id as string] = `data:${mime};base64,${(await fsp.readFile(real)).toString('base64')}`;
  }
  return out;
}

// ------------------------------------------------------------------ shot exclusions (app side)

const exclFile = (ws: Workspace, batch: string) => {
  if (!isBatchName(batch)) bad('nama batch tidak valid');
  return path.join(ws.root, LAYOUT.meta, 'engine-batch', `${batch}.json`);
};

export async function readShotExclusions(ws: Workspace, batch: string): Promise<string[]> {
  try {
    const d = JSON.parse(await fsp.readFile(exclFile(ws, batch), 'utf8')) as { shots?: unknown };
    return Array.isArray(d.shots) ? d.shots.filter(isShotId).slice(0, MAX_EXCLUDED) : [];
  } catch (e) {
    if (e instanceof StorageError) throw e;
    return [];
  }
}

/** Replace the batch's excluded shots (ids are not checked against shots.json: a re-run may renumber). */
export async function setShotExclusions(ws: Workspace, input: { batch: string; shots: unknown; actor: 'user' }): Promise<string[]> {
  const file = exclFile(ws, input.batch);
  if (!Array.isArray(input.shots) || !input.shots.every(isShotId)) bad('shots harus daftar id shot');
  const shots = [...new Set(input.shots as string[])].sort();
  if (shots.length > MAX_EXCLUDED) bad(`Maksimal ${MAX_EXCLUDED} shot dikecualikan per batch`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, { schema: 'shot-kecuali/1', batch: input.batch, shots, updated_at: ws.clock.now() });
  await audit(ws, { op: 'engine.shot_exclude', actor: input.actor, outcome: 'ok', batch: input.batch, shots: shots.length });
  return shots;
}
