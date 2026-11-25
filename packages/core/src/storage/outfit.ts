/**
 * §29 Beat Spot "Ganti Outfit", app side (KONTRAK-ENGINE §29, owner 24–25 Nov 2026).
 *
 * One run = a **siapkan** engine job (walk clips, freeze frames, looks, prompts) → the APP makes one
 * AI picture per footage (the key never reaches the engine) → a **rakit** engine job (QC, end card,
 * ops on the beat). The team reviews before/after per footage, may make one picture again (max
 * `ULANG_MAKS` per look) or change a look (a new siapkan job; unchanged pictures are reused), and
 * opens the draft in the editor like any engine plan (approval, one undo step; render held).
 *
 * The app's own state for a run lives next to the siapkan job: `<job>/outfit_app.json`.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type EngineJobInput, type EngineStatus, type OutfitSettings, engineJobDir, readEngineStatus, scrubPaths, validateEngineJob, validateOutfitSettings } from './engine.js';
import { StorageError } from './errors.js';
import { writeJsonAtomic } from './jsonStore.js';
import type { MediaRef } from './project.js';
import { loadRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

/** Pictures the team may make again per footage and look (cost guard; the first one is not counted). */
export const ULANG_MAKS = 2;

export type GambarStatus = 'menunggu' | 'membuat' | 'siap' | 'gagal';
export interface OutfitAppState {
  schema: 'outfit-app/1';
  gambar: Record<string, { status: GambarStatus; ulang: number; alasan: string | null; model: string | null; at: number; dipakai_ulang?: boolean }>;
  /** The rakit job made from these pictures (the newest one). */
  rakit_job: string | null;
  /** A look change: pictures of an earlier siapkan job that may be reused (same frame + prompt). */
  salin_dari: string | null;
  /** `null` = automatic; the team pressed "berhenti" (nothing more is made for this run). */
  berhenti: boolean;
}

export interface OutfitItem {
  footage: string;
  nama: string;
  orang: number;
  target: 'utama' | 'semua';
  jalan: { ketukan: number; mulai: number };
  look: {
    atasan: { id: string; produk: string; nama_produk: string; warna: string } | null;
    bawahan: { id: string; produk: string; nama_produk: string; warna: string } | null;
    dipilih: 'tim' | 'otomatis';
  };
  gambar: { status: GambarStatus; ulang: number; ulang_sisa: number; alasan: string | null; dipakai_ulang: boolean };
  qc: { lulus: boolean; cek: { cek: string; lulus: boolean; ket: string }[] } | null;
}
export interface OutfitView {
  job_id: string;
  siapkan: EngineStatus;
  rakit: EngineStatus | null;
  bpm: number | null;
  durasi: number | null;
  teks_atas: string | null;
  peringatan: string[];
  items: OutfitItem[];
  /** `menyiapkan` → `membuat_gambar` → `merakit` → `siap` (or `ditolak` / `gagal` / `berhenti`). */
  tahap: 'menyiapkan' | 'membuat_gambar' | 'merakit' | 'siap' | 'ditolak' | 'gagal' | 'berhenti';
  pengaturan: OutfitSettings | null;
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const FID = /^[A-Za-z0-9_-]{1,40}$/;

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('PRECONDITION', `File Ganti Outfit tidak bisa dibaca: ${path.basename(file)}`);
  }
}

interface SiapkanDoc {
  schema: string;
  tahap: string;
  bpm: number;
  durasi: number;
  teks_atas: string | null;
  peringatan?: { teks?: string }[];
  items: { footage: string; nama: string; jalan: { ketukan: number; mulai: number; orang: number; kotak: unknown }; target: 'utama' | 'semua'; look: Record<string, unknown>; prompt: string; api: { gambar: string; ukuran: string }; acuan_katalog: string[]; frame: string; hasil: string }[];
}

export async function readSiapkanDoc(ws: Workspace, projectId: string, jobId: string): Promise<SiapkanDoc | null> {
  const d = await readJsonFile<SiapkanDoc>(path.join(engineJobDir(ws, projectId, jobId), 'out', 'outfit.json'));
  return d && d.schema === 'beatspot-outfit/1' && d.tahap === 'siapkan' && Array.isArray(d.items) ? d : null;
}

const stateFile = (ws: Workspace, projectId: string, jobId: string) => path.join(engineJobDir(ws, projectId, jobId), 'outfit_app.json');
export async function readOutfitState(ws: Workspace, projectId: string, jobId: string): Promise<OutfitAppState> {
  const s = await readJsonFile<OutfitAppState>(stateFile(ws, projectId, jobId));
  return s && s.schema === 'outfit-app/1' ? { ...s, berhenti: s.berhenti ?? false, salin_dari: s.salin_dari ?? null } : { schema: 'outfit-app/1', gambar: {}, rakit_job: null, salin_dari: null, berhenti: false };
}
/** Serialised per job: the generator and the routes both update the state file. */
const chains = new Map<string, Promise<unknown>>();
export async function updateOutfitState(ws: Workspace, projectId: string, jobId: string, fn: (s: OutfitAppState) => void): Promise<OutfitAppState> {
  const k = `${projectId}/${jobId}`;
  const run = (chains.get(k) ?? Promise.resolve()).then(async () => {
    const s = await readOutfitState(ws, projectId, jobId);
    fn(s);
    await writeJsonAtomic(stateFile(ws, projectId, jobId), s);
    return s;
  });
  chains.set(k, run.catch(() => undefined));
  return run;
}

const lookOf = (v: unknown) => {
  const o = v as Record<string, unknown> | null;
  return o && typeof o.id === 'string' ? { id: o.id, produk: String(o.produk ?? ''), nama_produk: scrubPaths(String(o.nama_produk ?? '')).slice(0, 80), warna: scrubPaths(String(o.warna ?? '')).slice(0, 80) } : null;
};

export async function readOutfitView(ws: Workspace, projectId: string, jobId: string): Promise<OutfitView> {
  const siapkan = await readEngineStatus(ws, projectId, jobId);
  if (siapkan.mode !== 'outfit') bad('Job ini bukan Ganti Outfit');
  const dir = engineJobDir(ws, projectId, jobId);
  const job = await readJsonFile<{ outfit?: Record<string, unknown>; sumber?: { kunci?: string }[] }>(path.join(dir, 'job.json'));
  if (job?.outfit?.tahap !== 'siapkan') bad('Buka Ganti Outfit dari job tahap siapkan');
  let pengaturan: OutfitSettings | null = null;
  try {
    const keys = (job?.sumber ?? []).map((s) => s.kunci).filter((k): k is string => typeof k === 'string');
    pengaturan = validateOutfitSettings(job?.outfit ?? {}, keys);
  } catch {
    pengaturan = null;
  }
  const st = await readOutfitState(ws, projectId, jobId);
  const doc = siapkan.state === 'siap' ? await readSiapkanDoc(ws, projectId, jobId) : null;
  const rakit = st.rakit_job ? await readEngineStatus(ws, projectId, st.rakit_job).catch(() => null) : null;
  const rakitDoc = rakit?.state === 'siap' ? await readJsonFile<{ items?: { footage?: string; qc?: OutfitItem['qc'] }[] }>(path.join(engineJobDir(ws, projectId, rakit.job_id), 'out', 'outfit.json')) : null;
  const qcOf = (fid: string) => {
    const q = rakitDoc?.items?.find((i) => i.footage === fid)?.qc;
    return q ? { lulus: q.lulus === true, cek: (q.cek ?? []).slice(0, 10).map((c) => ({ cek: String(c.cek).slice(0, 40), lulus: c.lulus === true, ket: scrubPaths(String(c.ket ?? '')).slice(0, 120) })) } : null;
  };
  // The names the team uploaded (job.json only has the stored copies' names).
  const refs = (await readJsonFile<{ refs?: Record<string, MediaRef> }>(path.join(dir, 'refs.json')))?.refs ?? {};
  const reg = await loadRegistry(ws);
  const namaAsli = (fid: string, cadangan: string) => {
    const r = refs[`$sumber:${fid}`];
    const n = r ? reg.versions[r.version_id]?.original_name : undefined;
    return scrubPaths(path.basename(n ?? cadangan)).slice(0, 120);
  };
  const items: OutfitItem[] = (doc?.items ?? []).map((it) => {
    const g = st.gambar[it.footage];
    return {
      footage: it.footage,
      nama: namaAsli(it.footage, it.nama),
      orang: it.jalan.orang,
      target: it.target === 'semua' ? 'semua' : 'utama',
      jalan: { ketukan: it.jalan.ketukan, mulai: it.jalan.mulai },
      look: { atasan: lookOf(it.look.atasan), bawahan: lookOf(it.look.bawahan), dipilih: it.look.dipilih === 'tim' ? 'tim' : 'otomatis' },
      gambar: { status: g?.status ?? 'menunggu', ulang: g?.ulang ?? 0, ulang_sisa: Math.max(0, ULANG_MAKS - (g?.ulang ?? 0)), alasan: g?.alasan ? scrubPaths(g.alasan).slice(0, 300) : null, dipakai_ulang: g?.dipakai_ulang === true },
      qc: qcOf(it.footage),
    };
  });
  const semuaSiap = items.length > 0 && items.every((i) => i.gambar.status === 'siap');
  const tahap: OutfitView['tahap'] =
    siapkan.state === 'ditolak' ? 'ditolak'
    : siapkan.state === 'gagal' ? 'gagal'
    : siapkan.state !== 'siap' ? 'menyiapkan'
    : st.berhenti && !semuaSiap ? 'berhenti'
    : items.some((i) => i.gambar.status === 'gagal') && !items.some((i) => i.gambar.status === 'menunggu' || i.gambar.status === 'membuat') ? 'gagal'
    : !semuaSiap ? 'membuat_gambar'
    : !rakit || rakit.state === 'menunggu' || rakit.state === 'berjalan' ? 'merakit'
    : rakit.state === 'siap' ? 'siap'
    : rakit.state === 'ditolak' ? 'ditolak'
    : 'gagal';
  return {
    job_id: jobId,
    siapkan,
    rakit,
    bpm: doc?.bpm ?? null,
    durasi: doc?.durasi ?? null,
    teks_atas: doc?.teks_atas ?? null,
    peringatan: (doc?.peringatan ?? []).map((p) => scrubPaths(String(p.teks ?? '')).slice(0, 200)).filter(Boolean),
    items,
    tahap,
    pengaturan,
  };
}

/** One picture of a run: the freeze frame, the AI result, the result fitted to 9:16, or the end card. */
export async function readOutfitImage(ws: Workspace, projectId: string, jobId: string, fid: string, jenis: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!FID.test(fid) && jenis !== 'end') bad('footage tidak valid');
  const doc = await readSiapkanDoc(ws, projectId, jobId);
  if (!doc) throw new StorageError('NOT_FOUND', 'Tahap siapkan belum selesai');
  const st = await readOutfitState(ws, projectId, jobId);
  const it = doc.items.find((i) => i.footage === fid);
  let file: string;
  if (jenis === 'frame' || jenis === 'hasil') {
    if (!it) throw new StorageError('NOT_FOUND', 'Footage tidak ada di job ini');
    file = path.join(engineJobDir(ws, projectId, jobId), 'out', jenis === 'frame' ? it.frame : it.hasil);
  } else if (jenis === 'diam' || jenis === 'end') {
    if (!st.rakit_job) throw new StorageError('NOT_FOUND', 'Belum dirakit');
    file = path.join(engineJobDir(ws, projectId, st.rakit_job), 'out', 'outfit', jenis === 'end' ? 'end_card.png' : `${fid}_diam.png`);
  } else return bad('jenis gambar: frame | hasil | diam | end');
  const bytes = await fsp.readFile(file).catch(() => null);
  if (!bytes) throw new StorageError('NOT_FOUND', 'Gambar belum ada');
  return { bytes, mime: 'image/png' };
}

/** What the generator needs for one footage: prompt + pictures (image 1 = the padded frame). */
export async function outfitRequest(ws: Workspace, projectId: string, jobId: string, fid: string) {
  const doc = await readSiapkanDoc(ws, projectId, jobId);
  const it = doc?.items.find((i) => i.footage === fid);
  if (!doc || !it) throw new StorageError('NOT_FOUND', 'Footage tidak ada di job ini');
  const out = path.join(engineJobDir(ws, projectId, jobId), 'out');
  const files = [path.join(out, it.api.gambar), ...it.acuan_katalog];
  const images = [];
  for (const [i, f] of files.entries()) {
    const ext = path.extname(f).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null;
    if (!mime) bad(`Foto katalog harus png / jpg / webp (${path.basename(f)})`);
    images.push({ name: i === 0 ? 'foto.png' : `acuan-${i}${ext}`, bytes: await fsp.readFile(f), mime: mime! });
  }
  return { prompt: it.prompt, size: it.api.ukuran, images, hasil: path.join(out, it.hasil), frame: path.join(out, it.frame) };
}

/** Same frame + same prompt + same catalog photos → the earlier picture can be reused (look change). */
export async function outfitFingerprint(ws: Workspace, projectId: string, jobId: string, fid: string): Promise<string | null> {
  const r = await outfitRequest(ws, projectId, jobId, fid).catch(() => null);
  if (!r) return null;
  const h = createHash('sha256');
  h.update(r.prompt);
  for (const im of r.images) h.update(im.bytes);
  return h.digest('hex');
}

/** Engine input of the rakit job for a siapkan job (same files, same settings). */
export async function outfitRakitInput(ws: Workspace, projectId: string, jobId: string): Promise<EngineJobInput> {
  const dir = engineJobDir(ws, projectId, jobId);
  const job = await readJsonFile<{ outfit?: Record<string, unknown>; sumber?: { kunci?: string }[] }>(path.join(dir, 'job.json'));
  const refs = (await readJsonFile<{ refs?: Record<string, MediaRef> }>(path.join(dir, 'refs.json')))?.refs ?? {};
  const keys = (job?.sumber ?? []).map((s) => s.kunci).filter((k): k is string => typeof k === 'string' && k.startsWith('$sumber:') && !!refs[k]);
  const { siapkan: _s, ...outfit } = (job?.outfit ?? {}) as Record<string, unknown>;
  void _s;
  return validateEngineJob({ project_id: projectId, mode: 'outfit', sources: keys.map((k) => ({ kunci: k, ref: refs[k] })), outfit: { ...outfit, tahap: 'rakit', siapkan_job: jobId } });
}

/** A new siapkan job for the same files with the team's look / target changes (pictures reused where unchanged). */
export async function outfitChangeInput(ws: Workspace, projectId: string, jobId: string, change: { look?: unknown; target?: unknown; teks_atas?: unknown; judul_akhir?: unknown; sub_akhir?: unknown }): Promise<EngineJobInput> {
  const dir = engineJobDir(ws, projectId, jobId);
  const job = await readJsonFile<{ outfit?: Record<string, unknown>; sumber?: { kunci?: string }[] }>(path.join(dir, 'job.json'));
  const refs = (await readJsonFile<{ refs?: Record<string, MediaRef> }>(path.join(dir, 'refs.json')))?.refs ?? {};
  const keys = (job?.sumber ?? []).map((s) => s.kunci).filter((k): k is string => typeof k === 'string' && k.startsWith('$sumber:') && !!refs[k]);
  if (!keys.length) throw new StorageError('PRECONDITION', 'Job lama tidak lengkap; mulai Ganti Outfit baru');
  const reg = await loadRegistry(ws);
  for (const k of keys) if (reg.versions[refs[k]!.version_id]?.lifecycle !== 'active') throw new StorageError('PRECONDITION', 'File job lama sudah di Trash; mulai Ganti Outfit baru');
  const old = (job?.outfit ?? {}) as Record<string, unknown>;
  const merge = (a: unknown, b: unknown) => ({ ...((a as object) ?? {}), ...((b as object) ?? {}) });
  const outfit = {
    ...Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'siapkan')),
    tahap: 'siapkan',
    look: merge(old.look, change.look),
    target: merge(old.target, change.target),
    ...(change.teks_atas !== undefined ? { teks_atas: change.teks_atas } : {}),
    ...(change.judul_akhir !== undefined ? { judul_akhir: change.judul_akhir } : {}),
    ...(change.sub_akhir !== undefined ? { sub_akhir: change.sub_akhir } : {}),
  };
  return validateEngineJob({ project_id: projectId, mode: 'outfit', sources: keys.map((k) => ({ kunci: k, ref: refs[k] })), outfit });
}

export async function isOutfitSiapkan(ws: Workspace, projectId: string, jobId: string): Promise<boolean> {
  const job = await readJsonFile<{ mode?: string; outfit?: { tahap?: string } }>(path.join(engineJobDir(ws, projectId, jobId), 'job.json')).catch(() => null);
  return job?.mode === 'outfit' && job.outfit?.tahap === 'siapkan';
}
