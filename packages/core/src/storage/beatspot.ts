/**
 * Beat Spot tahap 1 (R16, KONTRAK-ENGINE §16), app side: the engine's report (`out/beatspot.json`)
 * for the page, and a re-run with the team's choices (hybrid: shot order, exclusions, creator /
 * public per footage or shot). The edit plan itself (`out/ops.json`) goes the normal Generate way:
 * plan card → the team approves → one undo step on the timeline.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type BeatspotSettings, type EngineStatus, engineJobDir, prepareEngineJob, readEngineStatus, scrubPaths, validateBeatspotSettings, validateEngineJob } from './engine.js';
import { StorageError } from './errors.js';
import type { MediaRef } from './project.js';
import { loadRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

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
  /** null while the engine has not written its report (refused / failed job). */
  laporan: {
    bpm: number;
    sumber_ketukan: string;
    ketukan_per_potong: number;
    durasi: number;
    end_card_dtk: number;
    potongan: BeatspotCut[];
    kandidat: BeatspotCandidate[];
    dibuang: { id: string; alasan: string }[];
  } | null;
  /** The settings the job ran with (pre-fills the re-run form). */
  pengaturan: BeatspotSettings | null;
  /** The job's files: footage id / sound, with the names the team uploaded. */
  sumber: { kunci: string; id: string; nama: string; sound: boolean }[];
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const txt = (v: unknown, max = 200) => (typeof v === 'string' ? scrubPaths(v).slice(0, max) : '');
const orang = (v: unknown): 'kreator' | 'umum' => (v === 'kreator' ? 'kreator' : 'umum');

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('PRECONDITION', `File mesin tidak bisa dibaca: ${path.basename(file)}`);
  }
}

async function jobFiles(ws: Workspace, projectId: string, jobId: string) {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'beatspot') bad('Job ini bukan Beat Spot');
  const dir = engineJobDir(ws, projectId, jobId);
  const job = await readJsonFile<{ beatspot?: unknown; sumber?: { kunci?: unknown }[]; preset?: unknown; audio_pilihan?: unknown }>(path.join(dir, 'job.json'));
  const refs = (await readJsonFile<{ refs?: Record<string, MediaRef> }>(path.join(dir, 'refs.json')))?.refs ?? {};
  const keys = (job?.sumber ?? []).map((x) => x?.kunci).filter((k): k is string => typeof k === 'string' && k.startsWith('$sumber:') && !!refs[k]);
  return { s, dir, job, refs, keys };
}

export async function readBeatspotView(ws: Workspace, projectId: string, jobId: string): Promise<BeatspotView> {
  const { s, dir, job, refs, keys } = await jobFiles(ws, projectId, jobId);
  let pengaturan: BeatspotSettings | null = null;
  try {
    pengaturan = validateBeatspotSettings(job?.beatspot ?? {}, keys);
  } catch {
    pengaturan = null; // an old / hand-edited job.json: the page offers defaults instead
  }
  const reg = await loadRegistry(ws);
  const sumber = keys.map((k) => ({ kunci: k, id: k.slice(8), nama: path.basename(reg.versions[refs[k]!.version_id]?.original_name ?? k.slice(8)).slice(0, 200), sound: pengaturan?.sound === k }));
  const raw = s.state === 'siap' ? await readJsonFile<Record<string, unknown>>(path.join(dir, 'out', 'beatspot.json')) : null;
  if (!raw || raw.schema !== 'beatspot/1') return { job_id: jobId, laporan: null, pengaturan, sumber };
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []) as Record<string, unknown>[];
  const potongan = list(raw.potongan, 500)
    .filter((p) => p && typeof p.shot === 'string')
    .map((p, i) => ({ no: num(p.no) ?? i + 1, mulai: num(p.mulai) ?? 0, durasi: num(p.durasi) ?? 0, shot: txt(p.shot, 60), footage: txt(p.footage, 60), in: num(p.in) ?? 0, skor: num(p.skor), alasan: txt(p.alasan), sumber_orang: orang(p.sumber_orang) }));
  const kandidat = list(raw.kandidat, 2000)
    .filter((k) => k && typeof k.id === 'string')
    .map((k) => ({ id: txt(k.id, 60), footage: txt(k.footage, 60), dari: num(k.dari) ?? 0, sampai: num(k.sampai) ?? 0, orang: num(k.orang), framing: txt(k.framing, 40), skor: num(k.skor), dipakai: k.dipakai === true, sumber_orang: orang(k.sumber_orang) }));
  const dibuang = list(raw.dibuang, 2000)
    .filter((d) => d && typeof d.id === 'string')
    .map((d) => ({ id: txt(d.id, 60), alasan: txt(d.alasan) }));
  return {
    job_id: jobId,
    laporan: { bpm: num(raw.bpm) ?? 0, sumber_ketukan: txt(raw.sumber_ketukan, 20), ketukan_per_potong: num(raw.ketukan_per_potong) ?? 0, durasi: num(raw.durasi) ?? 0, end_card_dtk: num(raw.end_card_dtk) ?? 0, potongan, kandidat, dibuang },
    pengaturan,
    sumber,
  };
}

/** Run Beat Spot again on the same files with the team's settings (a new job; the old one stays). */
export async function rerunBeatspot(ws: Workspace, projectId: string, jobId: string, beatspot: unknown, opts: { now?: number; actor?: 'user' } = {}): Promise<EngineStatus> {
  const { refs, keys, job } = await jobFiles(ws, projectId, jobId);
  if (!keys.length) throw new StorageError('PRECONDITION', 'Job lama tidak lengkap; jalankan Beat Spot baru dari awal');
  // Same files, same preset and audio choice (R18) — only the team's Beat Spot settings change.
  const input = validateEngineJob({
    project_id: projectId,
    mode: 'beatspot',
    sources: keys.map((k) => ({ kunci: k, ref: refs[k] })),
    beatspot,
    ...(typeof job?.preset === 'string' && job.preset !== 'beatspot' ? { preset: job.preset } : {}),
    ...(typeof job?.audio_pilihan === 'string' ? { audio_pilihan: job.audio_pilihan } : {}),
  });
  return prepareEngineJob(ws, input, opts);
}
