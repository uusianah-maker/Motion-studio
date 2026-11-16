/**
 * R34 "Suara dari Teks" (owner 16 Nov; KONTRAK-ENGINE §21, engine side by yuki). The app side:
 *  - validates a `tts` engine job (sentences, voice, speed, pause; pronunciation from the Brand Kit);
 *  - on the first read of a finished job, imports the voice over into Media (shared, reusable by every
 *    feature) — the whole take (`gabungan.wav`) as a Brand Kit asset of kind `vo`, every sentence as
 *    its own media — and keeps the sentence/word timings next to it (`.motionstudio/vo/<version>.json`),
 *    so subtitles come from the known text, without Whisper;
 *  - lists the engine's voices.
 * The engine writes only inside its job folder; nothing here trusts a path from it.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrandAsset, readBrandFor, setBrandKit } from './brand.js';
import { type EngineConfig, type EngineJobInput, engineEnv, engineJobDir, killTree, readEngineStatus } from './engine.js';
import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import { writeJsonAtomic } from './jsonStore.js';
import { lowerPriority } from './priority.js';
import type { MediaRef } from './project.js';
import { importMedia } from './registry.js';
import { type VoIndex, type VoWord, splitKalimat } from './voText.js';
export { type VoIndex, type VoWord, splitKalimat, voSubtitleOps } from './voText.js';
import { LAYOUT, type Workspace, readProject } from './workspace.js';

export interface TtsSettings {
  kalimat: string[];
  /** `<backend>:<name>`, e.g. `windows:Andika`. */
  suara: string;
  kecepatan: number;
  jeda_ms: number;
}
export const TTS_LIMITS = { kalimat: 60, huruf: 1000, kecepatan: [0.5, 2] as const, jeda_ms: [0, 3000] as const };
export const DEFAULT_VOICE = 'windows:Andika';

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

/** Browser request → engine input (untrusted). Either `teks` (split here) or `kalimat`. */
export function validateTtsJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'tts'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  const t = (o.tts ?? {}) as Record<string, unknown>;
  const te = Object.keys(t).filter((k) => !['teks', 'kalimat', 'suara', 'kecepatan', 'jeda_ms'].includes(k));
  if (te.length) bad(`tts: field tidak dikenal ${te.join(', ')}`);
  const kalimat = Array.isArray(t.kalimat) ? (t.kalimat as unknown[]).map((k) => (typeof k === 'string' ? k.replace(/\s+/g, ' ').trim() : bad('kalimat harus teks'))).filter(Boolean) : typeof t.teks === 'string' ? splitKalimat(t.teks) : bad('Isi teks yang mau diucapkan');
  if (!kalimat.length) bad('Isi teks yang mau diucapkan');
  if (kalimat.length > TTS_LIMITS.kalimat) bad(`Maksimal ${TTS_LIMITS.kalimat} kalimat per job (sekarang ${kalimat.length})`);
  const long = kalimat.findIndex((k) => k.length > TTS_LIMITS.huruf);
  if (long >= 0) bad(`Kalimat ${long + 1} terlalu panjang (maks ${TTS_LIMITS.huruf} huruf)`);
  const suara = t.suara === undefined || t.suara === '' ? DEFAULT_VOICE : typeof t.suara === 'string' && /^[a-z0-9_-]{1,20}:[\p{L}\p{N} ._()-]{1,60}$/u.test(t.suara) ? t.suara : bad('suara tidak valid');
  const num = (v: unknown, what: string, [lo, hi]: readonly [number, number], dflt: number) => (v === undefined ? dflt : typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${what} harus ${lo}–${hi}`));
  return {
    project_id: o.project_id as string,
    mode: 'tts',
    sources: [],
    preset: 'tts',
    brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' },
    ai: false,
    tts: { kalimat, suara, kecepatan: Math.round(num(t.kecepatan, 'kecepatan', TTS_LIMITS.kecepatan, 1) * 100) / 100, jeda_ms: Math.round(num(t.jeda_ms, 'jeda antar kalimat (ms)', TTS_LIMITS.jeda_ms, 300)) },
  };
}

// ------------------------------------------------------------------ result → Media + Brand Kit

export interface VoSentence {
  no: number;
  teks: string;
  /** Position in the whole take (seconds). */
  mulai: number;
  akhir: number;
  durasi: number;
  /** Relative to the sentence file (seconds). */
  kata: VoWord[];
  ref: MediaRef | null;
}
export interface TtsView {
  job_id: string;
  suara: string;
  kecepatan: number;
  jeda_ms: number;
  total_durasi: number;
  gabungan: MediaRef | null;
  /** Brand Kit asset id of the whole take (`$vo:<id>` for the engine). */
  aset_id: string | null;
  kalimat: VoSentence[];
}
const voIndexPath = (ws: Workspace, versionId: string) => {
  if (!isSafeId(versionId)) throw new StorageError('NOT_FOUND', 'Versi media tidak ditemukan');
  return path.join(ws.root, LAYOUT.meta, 'vo', `${versionId}.json`);
};
export async function readVoIndex(ws: Workspace, versionId: string): Promise<VoIndex | null> {
  try {
    return JSON.parse(await fsp.readFile(voIndexPath(ws, versionId), 'utf8')) as VoIndex;
  } catch {
    return null;
  }
}

const sec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 24 * 3600 ? Math.round(v * 1000) / 1000 : 0);
const words = (x: unknown): VoWord[] =>
  (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
    .slice(0, 2000)
    .filter((w) => w && typeof w.teks === 'string' && w.teks.trim())
    .map((w) => ({ teks: String(w.teks).slice(0, 60), mulai: sec(w.mulai), akhir: Math.max(sec(w.mulai), sec(w.akhir)) }));

/**
 * The finished job's voice over. First call imports it (idempotent: `out/impor.json` remembers
 * what was imported), so the team can play it right away and every feature can pick it.
 */
export async function readTtsResult(ws: Workspace, projectId: string, jobId: string): Promise<TtsView> {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'tts') bad('Job ini bukan Suara dari Teks');
  if (s.state !== 'siap') throw new StorageError('PRECONDITION', 'Suara belum siap');
  const jdir = engineJobDir(ws, projectId, jobId);
  const out = path.join(jdir, 'out');
  const raw = JSON.parse(await fsp.readFile(path.join(out, 'tts.json'), 'utf8').catch(() => bad('tts.json belum ada'))) as Record<string, unknown>;
  const files = (Array.isArray(raw.file) ? (raw.file as Record<string, unknown>[]) : []).slice(0, TTS_LIMITS.kalimat);
  /** Only plain file names inside out/vo/ are used (never a path from the engine). */
  const local = async (rel: unknown): Promise<string | null> => {
    const name = typeof rel === 'string' ? path.basename(rel.replace(/\\/g, '/')) : '';
    if (!/^[A-Za-z0-9_-]{1,40}\.wav$/.test(name)) return null;
    const abs = path.join(out, 'vo', name);
    return (await fsp.stat(abs).catch(() => null))?.isFile() ? abs : null;
  };
  const importedFile = path.join(out, 'impor.json');
  type Imported = { gabungan: MediaRef | null; aset_id: string | null; kalimat: (MediaRef | null)[] };
  let imp = JSON.parse(await fsp.readFile(importedFile, 'utf8').catch(() => 'null')) as Imported | null;
  const sentences = files.map((f, i) => ({
    no: typeof f.no === 'number' ? f.no : i + 1,
    teks: typeof f.teks === 'string' ? f.teks.slice(0, 1000) : '',
    mulai: sec(f.mulai),
    akhir: sec(f.akhir),
    durasi: sec(f.durasi),
    kata: words(f.kata),
  }));
  const fullText = sentences.map((k) => k.teks).join(' ');
  if (!imp) {
    const project = await readProject(ws, projectId);
    const kit = await readBrandFor(ws, project.brand_id);
    const tag = jobId.toLowerCase();
    // The job folder is inside the workspace and an import must come from outside it: via a temp copy.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-vo-'));
    await fsp.mkdir(path.join(ws.root, LAYOUT.meta, 'vo'), { recursive: true });
    const one = async (abs: string | null, name: string) => {
      if (!abs) return null;
      const copy = path.join(tmp, path.basename(abs));
      await fsp.copyFile(abs, copy);
      try {
        return await importMedia(ws, { sourcePath: copy, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
      } finally {
        await fsp.rm(copy, { force: true }).catch(() => undefined);
      }
    };
    const g = await one(await local((raw.gabungan as Record<string, unknown> | undefined)?.file), `VO ${jobId}.wav`);
    const per: (MediaRef | null)[] = [];
    for (const [i, f] of files.entries()) {
      const r = await one(await local(f.file), `VO ${jobId} kalimat ${String(i + 1).padStart(2, '0')}.wav`);
      per.push(r ? { media_id: r.media.media_id, version_id: r.version.version_id } : null);
      // Each sentence file carries its own text + word times (subtitle without Whisper).
      if (r) await writeJsonAtomic(voIndexPath(ws, r.version.version_id), { schema: 'vo-index/1', job_id: jobId, teks: sentences[i]!.teks, kalimat: [{ teks: sentences[i]!.teks, mulai: 0, akhir: sentences[i]!.durasi, kata: sentences[i]!.kata }] } satisfies VoIndex);
    }
    const gref = g ? { media_id: g.media.media_id, version_id: g.version.version_id } : null;
    let asetId: string | null = null;
    if (gref) {
      await writeJsonAtomic(voIndexPath(ws, gref.version_id), { schema: 'vo-index/1', job_id: jobId, teks: fullText, kalimat: sentences.map((k) => ({ teks: k.teks, mulai: k.mulai, akhir: k.akhir, kata: k.kata })) } satisfies VoIndex);
      // The whole take joins the brand's library as kind "vo" (own voice → usable in ads).
      asetId = `vo-${tag}`.slice(0, 40);
      if (!kit.aset.some((a) => a.id === asetId)) {
        const asset: BrandAsset = { id: asetId, ref: gref, jenis: 'vo', nama: `VO: ${fullText.slice(0, 70)}`, tag: ['vo', 'tts'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true }, mood: '', bpm: null, instrumental: null, produk: '', varian: '', ada_teks_bawaan: false, catatan: fullText.slice(0, 200) };
        const { schema_version: _s, brand_id: _b, revision: _r, updated_at: _u, ...input } = kit;
        void _s;
        void _b;
        void _r;
        void _u;
        await setBrandKit(ws, { brand_id: kit.brand_id, expected_revision: kit.revision, kit: { ...input, aset: [...kit.aset, asset] }, actor: 'user' }).catch(() => (asetId = null)); // full library: the media stays usable
      }
    }
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    imp = { gabungan: gref, aset_id: asetId, kalimat: per };
    await writeJsonAtomic(importedFile, imp);
  }
  return {
    job_id: jobId,
    suara: typeof raw.suara === 'string' ? raw.suara.slice(0, 80) : '',
    kecepatan: typeof raw.kecepatan === 'number' ? raw.kecepatan : 1,
    jeda_ms: typeof raw.jeda_ms === 'number' ? raw.jeda_ms : 300,
    total_durasi: sec(raw.total_durasi),
    gabungan: imp.gabungan,
    aset_id: imp.aset_id,
    kalimat: sentences.map((k, i) => ({ ...k, ref: imp!.kalimat[i] ?? null })),
  };
}

// ------------------------------------------------------------------ voices

export interface TtsVoice {
  id: string;
  nama: string;
  bahasa: string;
  gender: string;
  backend: string;
}

/** `engine tts` with `{"tts":{"daftar_suara":true}}` in a temporary job folder (a few seconds). */
export async function listTtsVoices(cfg: EngineConfig, opts: { timeoutMs?: number } = {}): Promise<TtsVoice[]> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-suara-'));
  try {
    await writeJsonAtomic(path.join(dir, 'job.json'), { schema: 'engine-job/1', job_id: 'SUARA', mode: 'tts', tts: { daftar_suara: true } });
    await new Promise<void>((resolve) => {
      const child = spawn(cfg.command, [cfg.script, 'tts', dir], { cwd: cfg.root, windowsHide: true, env: engineEnv(process.env, cfg), stdio: 'ignore' });
      lowerPriority(child);
      const t = setTimeout(() => killTree(child), opts.timeoutMs ?? 60_000);
      child.on('close', () => (clearTimeout(t), resolve()));
      child.on('error', () => (clearTimeout(t), resolve()));
    });
    const r = JSON.parse(await fsp.readFile(path.join(dir, 'out', 'tts.json'), 'utf8').catch(() => '{}')) as { suara?: unknown };
    const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
    return (Array.isArray(r.suara) ? (r.suara as Record<string, unknown>[]) : [])
      .slice(0, 100)
      .filter((v) => v && typeof v.id === 'string')
      .map((v) => ({ id: s(v.id, 80), nama: s(v.nama, 80), bahasa: s(v.bahasa, 20), gender: s(v.gender, 20), backend: s(v.backend, 20) }));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
