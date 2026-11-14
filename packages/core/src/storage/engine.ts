/**
 * Engine runner (U6, KONTRAK-ENGINE v0.3/v0.3.1). Motion Studio prepares a job folder, runs the
 * engine CLI (`D:\VIBECODING\remotion`, Python) as a child process and reads its plan back. The
 * engine never renders and never writes outside its job folder; Motion Studio never runs the
 * plan without the team's approval (it becomes a normal Copilot plan, source `engine`).
 *
 *  PROJECTS/<p>/06_ENGINE/<job_id>/        new non-media area: not scanned by GC, deleted with the
 *    job.json  brand_kit.json  status.json  project, never a source of media
 *    refs.json   placeholder → MediaRef decided by Motion Studio (sources, brand assets, imports)
 *    engine.log  stderr of the engine (tail)
 *    out/rencana.json + ops.json (+ batch.json, varian-NNN/ for Batch Remix)
 *
 * Exit codes: 0 done · 2 refused (reason in rencana.json) · 1 technical failure (may retry).
 * While the engine runs, a lease pins the source versions so Auto Trash never moves them.
 */
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type BrandKit, brandReferences, exportBrandKit, readBrandFor } from './brand.js';
import { localDate } from './brandGuard.js';
import { createLease, releaseLease, setLeaseStatus } from './deps.js';
import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import { isInside } from './paths.js';
import { MEDIA_AREAS } from './permissions.js';
import type { MediaRef, Timeline, VariantInfo } from './project.js';
import { MAX_PROJECT_NAME, createWithTimeline } from './projectAdmin.js';
import { MAX_SERVER_OPS, applyOps, validateOps } from './timeline.js';
import { listVariants, setVariantApproval, variantState } from './variants.js';
import { newId } from './ids.js';
import { importMedia, loadRegistry } from './registry.js';
import { type Workspace, projectRel, readProject } from './workspace.js';
import { writeJsonAtomic } from './jsonStore.js';
import { audit } from './audit.js';

export const ENGINE_DIR = '06_ENGINE';
export const MAX_ENGINE_LOG = 64 * 1024;

export interface EngineConfig {
  /** Engine repository (cwd of the CLI). */
  root: string;
  /** Interpreter (default `<root>/.venv/Scripts/python.exe`). */
  command: string;
  /** CLI script (default `<root>/pipeline/engine.py`). */
  script: string;
  /** Kill the engine after this long (default 30 min). */
  timeout_ms: number;
}

/** From env: MOTION_ENGINE_ROOT (+ optional MOTION_ENGINE_PYTHON / _SCRIPT / _TIMEOUT_MS). Null = not installed. */
export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig | null {
  const root = env.MOTION_ENGINE_ROOT?.trim();
  if (!root) return null;
  const win = process.platform === 'win32';
  return {
    root: path.resolve(root),
    command: env.MOTION_ENGINE_PYTHON?.trim() || path.join(root, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    script: env.MOTION_ENGINE_SCRIPT?.trim() || path.join(root, 'pipeline', 'engine.py'),
    timeout_ms: Number(env.MOTION_ENGINE_TIMEOUT_MS) > 0 ? Number(env.MOTION_ENGINE_TIMEOUT_MS) : 30 * 60_000,
  };
}

export type EngineMode = 'generate' | 'batch' | 'ulang';
export type EngineState = 'menunggu' | 'berjalan' | 'siap' | 'ditolak' | 'gagal';

export interface EngineStatus {
  schema: 'engine-status/1';
  job_id: string;
  project_id: string;
  mode: EngineMode;
  state: EngineState;
  tahap: string;
  persen: number;
  pesan: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  /** Refusal (2) or failure (1) reason shown to the team. */
  alasan: string | null;
  lease_id: string | null;
}

export interface EngineBrief {
  produk: string;
  varian: string;
  harga: string;
  placement: 'tiktok' | 'instagram' | 'shopee' | 'youtube';
  catatan: string;
  area_produk?: 'bawah' | 'atas' | 'penuh';
}

export interface EngineJobInput {
  project_id: string;
  mode: 'generate' | 'batch';
  /** `$sumber` (one video) or `$sumber:<id>` (several). */
  sources: { kunci: string; ref: MediaRef }[];
  preset: string;
  brief: EngineBrief;
  ai: boolean;
  mode_ops?: 'kompat' | 'u3';
  /** Batch Remix extras (contract §3 + v0.3.1), passed through after validation. */
  batch?: { batch: string; jumlah: number; tujuan: string; seed?: number; izinkan_musik_tanpa_lisensi?: boolean; akun_sendiri?: string[]; hak_pakai_jelas?: boolean; shot_tiktok?: boolean; vo_batch?: string; buang_otomatis?: string[]; batas_durasi?: [number, number] | null };
}

const bad = (msg: string, details: Record<string, unknown> = {}): never => {
  throw new StorageError('EDIT_INVALID', msg, details);
};
const str = (v: unknown, what: string, max: number, allowEmpty = true): string => {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) bad(`${what} harus teks${allowEmpty ? '' : ' (wajib)'} maks ${max} karakter`);
  return (v as string).trim();
};
const KUNCI = /^\$sumber(?::[A-Za-z0-9_-]{1,40})?$/;
const PLACEMENTS = ['tiktok', 'instagram', 'shopee', 'youtube'] as const;

/** Validate the browser's request (untrusted). */
export function validateEngineJob(x: unknown): EngineJobInput {
  const o = (x ?? {}) as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'preset', 'brief', 'ai', 'mode_ops', 'batch'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  if (o.mode !== 'generate' && o.mode !== 'batch') bad('mode harus generate | batch');
  if (!Array.isArray(o.sources) || o.sources.length > 50 || (o.mode === 'generate' && o.sources.length !== 1)) bad(o.mode === 'generate' ? 'Generate Otomatis butuh tepat satu video sumber' : 'sumber maksimal 50');
  const sources = (o.sources as unknown[]).map((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const r = (so.ref ?? {}) as Record<string, unknown>;
    if (typeof so.kunci !== 'string' || !KUNCI.test(so.kunci)) bad(`sources[${i}].kunci harus $sumber atau $sumber:<id>`);
    if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`sources[${i}].ref tidak valid`);
    return { kunci: so.kunci as string, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
  });
  if (new Set(sources.map((s) => s.kunci)).size !== sources.length) bad('kunci sumber harus unik');
  if (o.mode === 'generate' && sources[0]!.kunci !== '$sumber') bad('Generate Otomatis: kunci sumber harus $sumber');
  const preset = str(o.preset, 'preset', 60, false);
  if (!/^[a-z0-9-]+$/.test(preset)) bad('preset hanya huruf kecil, angka, tanda minus');
  const b = (o.brief ?? {}) as Record<string, unknown>;
  const bExtra = Object.keys(b).filter((k) => !['produk', 'varian', 'harga', 'placement', 'catatan', 'area_produk'].includes(k));
  if (bExtra.length) bad(`brief: field tidak dikenal ${bExtra.join(', ')}`);
  const placement = b.placement ?? 'tiktok';
  if (!PLACEMENTS.includes(placement as (typeof PLACEMENTS)[number])) bad(`placement harus ${PLACEMENTS.join(' | ')}`);
  if (b.area_produk !== undefined && !['bawah', 'atas', 'penuh'].includes(b.area_produk as string)) bad('area_produk harus bawah | atas | penuh');
  const brief: EngineBrief = {
    produk: str(b.produk ?? '', 'produk', 80),
    varian: str(b.varian ?? '', 'varian', 80),
    harga: str(b.harga ?? '', 'harga', 40),
    placement: placement as EngineBrief['placement'],
    catatan: str(b.catatan ?? '', 'catatan', 500),
    ...(b.area_produk ? { area_produk: b.area_produk as 'bawah' | 'atas' | 'penuh' } : {}),
  };
  if (typeof (o.ai ?? false) !== 'boolean') bad('ai harus true/false');
  if (o.mode_ops !== undefined && o.mode_ops !== 'kompat' && o.mode_ops !== 'u3') bad('mode_ops harus kompat | u3');
  let batch: EngineJobInput['batch'];
  if (o.mode === 'batch') {
    const bo = (o.batch ?? {}) as Record<string, unknown>;
    const ok = ['batch', 'jumlah', 'tujuan', 'seed', 'izinkan_musik_tanpa_lisensi', 'akun_sendiri', 'hak_pakai_jelas', 'shot_tiktok', 'vo_batch', 'buang_otomatis', 'batas_durasi'];
    const be = Object.keys(bo).filter((k) => !ok.includes(k));
    if (be.length) bad(`batch: field tidak dikenal ${be.join(', ')}`);
    const name = str(bo.batch, 'nama batch', 80, false);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) bad('nama batch hanya huruf, angka, _ . -');
    const jumlah = bo.jumlah;
    if (typeof jumlah !== 'number' || !Number.isInteger(jumlah) || jumlah < 1 || jumlah > 50) bad('jumlah varian 1–50');
    const tujuan = str(bo.tujuan ?? 'konversi', 'tujuan', 30, false);
    const bool = (k: string) => (bo[k] === undefined ? undefined : typeof bo[k] === 'boolean' ? (bo[k] as boolean) : bad(`batch.${k} harus true/false`));
    const akun = bo.akun_sendiri;
    if (akun !== undefined && (!Array.isArray(akun) || akun.length > 20 || !akun.every((a) => typeof a === 'string' && /^@?[A-Za-z0-9_.]{1,40}$/.test(a)))) bad('akun_sendiri harus daftar @akun');
    // Contract §8: VO taken from another batch (pictures stay from `batch`).
    const voBatch = bo.vo_batch === undefined || bo.vo_batch === '' ? undefined : str(bo.vo_batch, 'vo_batch', 80, false);
    if (voBatch !== undefined && (!/^[A-Za-z0-9_.-]+$/.test(voBatch) || voBatch.includes('..'))) bad('vo_batch hanya huruf, angka, _ . -');
    // Kinds of VO sentence the engine may drop by itself (superlatif, urgensi, live, musiman, …). Default [] = none.
    const buang = bo.buang_otomatis;
    if (buang !== undefined && (!Array.isArray(buang) || buang.length > 20 || !buang.every((a) => typeof a === 'string' && a.trim().length > 0 && a.length <= 60))) bad('buang_otomatis harus daftar alasan (maks 20, tiap alasan maks 60 karakter)');
    // [min, maks] seconds, or null = no limit (owner's decision; default).
    const batas = bo.batas_durasi;
    if (batas !== undefined && batas !== null && (!Array.isArray(batas) || batas.length !== 2 || !batas.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 600) || (batas[0] as number) > (batas[1] as number))) bad('batas_durasi harus [min, maks] detik (0–600, min ≤ maks) atau null');
    if (bo.seed !== undefined && (typeof bo.seed !== 'number' || !Number.isInteger(bo.seed) || bo.seed < 0)) bad('seed harus bilangan bulat ≥ 0');
    batch = {
      batch: name,
      jumlah: jumlah as number,
      tujuan,
      ...(bo.seed !== undefined ? { seed: bo.seed as number } : {}),
      ...(bool('izinkan_musik_tanpa_lisensi') !== undefined ? { izinkan_musik_tanpa_lisensi: bool('izinkan_musik_tanpa_lisensi')! } : {}),
      ...(akun !== undefined ? { akun_sendiri: akun as string[] } : {}),
      ...(bool('hak_pakai_jelas') !== undefined ? { hak_pakai_jelas: bool('hak_pakai_jelas')! } : {}),
      ...(bool('shot_tiktok') !== undefined ? { shot_tiktok: bool('shot_tiktok')! } : {}),
      ...(voBatch !== undefined && voBatch !== name ? { vo_batch: voBatch } : {}),
      ...(buang !== undefined ? { buang_otomatis: [...new Set((buang as string[]).map((a) => a.trim()))] } : {}),
      ...(batas !== undefined ? { batas_durasi: batas === null ? null : ([(batas as number[])[0], (batas as number[])[1]] as [number, number]) } : {}),
    };
  } else if (o.batch !== undefined) bad('batch hanya untuk mode batch');
  return { project_id: o.project_id as string, mode: o.mode as 'generate' | 'batch', sources, preset, brief, ai: (o.ai as boolean) ?? false, ...(o.mode_ops ? { mode_ops: o.mode_ops as 'kompat' | 'u3' } : {}), ...(batch ? { batch } : {}) };
}

// ------------------------------------------------------------------ job folder

export const engineRel = (projectId: string, jobId?: string) => `${projectRel(projectId)}/${ENGINE_DIR}${jobId ? `/${jobId}` : ''}`;
const JOB_ID = /^[A-Z0-9]{2,5}-\d{8}-\d{3}$/;
export const isJobId = (x: unknown): x is string => typeof x === 'string' && JOB_ID.test(x);

function jobAbs(ws: Workspace, projectId: string, jobId?: string): string {
  if (!isSafeId(projectId)) bad('project_id tidak valid');
  if (jobId !== undefined && !isJobId(jobId)) throw new StorageError('NOT_FOUND', 'Job mesin tidak ditemukan', { job_id: jobId });
  const abs = path.join(ws.root, ...engineRel(projectId, jobId).split('/'));
  if (!isInside(ws.root, abs)) bad('path job di luar workspace');
  return abs;
}

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('PRECONDITION', `File mesin tidak bisa dibaca: ${path.basename(file)}`, { file: path.basename(file) });
  }
};

export async function readEngineStatus(ws: Workspace, projectId: string, jobId: string): Promise<EngineStatus> {
  const s = await readJson<EngineStatus>(path.join(jobAbs(ws, projectId, jobId), 'status.json'));
  if (!s || s.schema !== 'engine-status/1') throw new StorageError('NOT_FOUND', 'Job mesin tidak ditemukan', { job_id: jobId });
  return s;
}
const writeStatus = (ws: Workspace, s: EngineStatus) => writeJsonAtomic(path.join(jobAbs(ws, s.project_id, s.job_id), 'status.json'), s);

export async function listEngineJobs(ws: Workspace, projectId: string): Promise<EngineStatus[]> {
  const dir = jobAbs(ws, projectId);
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out: EngineStatus[] = [];
  for (const n of names.filter(isJobId).sort().reverse()) out.push(await readEngineStatus(ws, projectId, n).catch(() => null as never));
  return out.filter(Boolean);
}

/** Absolute local path of a media version (read-only for the engine). */
async function localPath(ws: Workspace, ref: MediaRef): Promise<string> {
  const reg = await loadRegistry(ws);
  const v = reg.versions[ref.version_id];
  if (!v || v.media_id !== ref.media_id || v.lifecycle !== 'active') throw new StorageError('PRECONDITION', 'Video sumber tidak aktif (di Trash atau tidak dikenal)', { ...ref });
  return ws.blobs.withLocalFile(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS), async (abs) => abs);
}

/** Brand placeholders in the export (`$logo`, `$sfx:pop-01`, …) → the kit's MediaRefs. */
export function brandPlaceholders(kit: BrandKit): Record<string, MediaRef> {
  const out: Record<string, MediaRef> = {};
  const slot: Record<string, string> = { font: '$font:judul', font_caption: '$font:caption', logo: '$logo', logo_light: '$logo:terang', outro: '$penutup' };
  for (const r of brandReferences(kit)) if (slot[r.slot]) out[slot[r.slot]!] = r.ref;
  for (const a of kit.aset) out[`$${a.jenis}:${a.id}`] = a.ref;
  return out;
}

/**
 * Prepare a job: job folder + job.json + brand_kit.json (with local paths) + refs.json, and a lease
 * on the sources. Nothing runs yet (status `menunggu`).
 */
export async function prepareEngineJob(ws: Workspace, input: EngineJobInput, opts: { now?: number; actor?: 'user' } = {}): Promise<EngineStatus> {
  const project = await readProject(ws, input.project_id);
  const kit = await readBrandFor(ws, project.brand_id);
  if (!kit.kode) throw new StorageError('PRECONDITION', 'Brand proyek belum punya kode (Brand Kit → A)');
  const now = opts.now ?? ws.clock.now();
  const day = localDate(now).replace(/-/g, '');
  const dir = jobAbs(ws, input.project_id);
  await fsp.mkdir(dir, { recursive: true });
  const taken = new Set((await fsp.readdir(dir)).filter(isJobId));
  let n = 1;
  while (taken.has(`${kit.kode}-${day}-${String(n).padStart(3, '0')}`)) n++;
  if (n > 999) throw new StorageError('PRECONDITION', 'Terlalu banyak job hari ini (maks 999)');
  const job_id = `${kit.kode}-${day}-${String(n).padStart(3, '0')}`;
  const jdir = jobAbs(ws, input.project_id, job_id);
  await fsp.mkdir(jdir); // fails if a parallel request took the same id
  let lease: { lease_id: string } | null = null;
  try {
    const sumber = [];
    for (const s of input.sources) sumber.push({ kunci: s.kunci, path: (await localPath(ws, s.ref)).replace(/\\/g, '/') });
    const brandExport = await exportBrandKit(ws, kit.brand_id, { paths: true });
    await writeJsonAtomic(path.join(jdir, 'brand_kit.json'), brandExport);
    const job = {
      schema: 'engine-job/1',
      job_id,
      mode: input.mode,
      sumber,
      brand_kit: 'brand_kit.json',
      preset: input.preset,
      brief: input.brief,
      ai: input.ai,
      ...(input.mode_ops ? { mode_ops: input.mode_ops } : {}),
      ...(input.batch ?? {}),
    };
    await writeJsonAtomic(path.join(jdir, 'job.json'), job);
    const refs: Record<string, MediaRef> = { ...brandPlaceholders(kit) };
    for (const s of input.sources) refs[s.kunci] = s.ref;
    await writeJsonAtomic(path.join(jdir, 'refs.json'), { schema: 'engine-refs/1', brand_id: kit.brand_id, refs });
    lease = await createLease(ws, { job: 'engine', label: `Mesin ${job_id}`, media: input.sources.map((s) => s.ref), actor: opts.actor ?? 'user', worker_pid: process.pid });
    const status: EngineStatus = { schema: 'engine-status/1', job_id, project_id: input.project_id, mode: input.mode, state: 'menunggu', tahap: 'antre', persen: 0, pesan: '', created_at: now, started_at: null, finished_at: null, exit_code: null, alasan: null, lease_id: lease.lease_id };
    await writeStatus(ws, status);
    await audit(ws, { op: 'engine.prepare', actor: opts.actor ?? 'user', outcome: 'ok', project_id: input.project_id, job_id, mode: input.mode, sources: input.sources.length });
    return status;
  } catch (e) {
    // Checkpoint I M4: nothing may stay pinned by a job that does not exist.
    if (lease) await releaseLease(ws, { lease_id: lease.lease_id, outcome: 'failed', actor: opts.actor ?? 'user' }).catch(() => undefined);
    await fsp.rm(jdir, { recursive: true, force: true });
    throw e;
  }
}

/** Stop the engine AND its children (Whisper, FFmpeg): on Windows `kill()` only ends the parent. */
function killTree(child: { pid?: number | undefined; kill: () => boolean }): void {
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
  else child.kill();
}

/**
 * The engine's environment: only what Python / Whisper / FFmpeg need. Never the server's secrets
 * (MOTION_SECRET_KEY, Google client secret, …) — Checkpoint I M3.
 */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|CUDA_VISIBLE_DEVICES|PYTHON[A-Z_]*|VIRTUAL_ENV|HF_HOME|XDG_CACHE_HOME)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) && v !== undefined) out[k] = v;
  return { ...out, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

/** Spawn seam for tests. */
export type Spawner = typeof spawn;

/**
 * Run the engine CLI for a prepared job. Progress lines update status.json; the lease is released
 * whatever happens. Resolves with the final status (never throws for engine failures).
 */
export async function runEngineJob(
  ws: Workspace,
  cfg: EngineConfig,
  projectId: string,
  jobId: string,
  opts: { mode?: EngineMode; signal?: AbortSignal; onProgress?: (s: EngineStatus) => void; spawnImpl?: Spawner } = {},
): Promise<EngineStatus> {
  let s = await readEngineStatus(ws, projectId, jobId);
  const jdir = jobAbs(ws, projectId, jobId);
  const mode = opts.mode ?? s.mode;
  // Checkpoint I H1: only a waiting job (with its lease) may start; a settled one never runs leaseless.
  if (s.state !== 'menunggu' || !s.lease_id) throw new StorageError('PRECONDITION', `Job ${jobId} tidak menunggu (${s.state}); jalankan job baru`);
  if (mode === 'ulang' && !(await fsp.stat(path.join(jdir, 'koreksi.json')).catch(() => null))) bad('koreksi.json belum ada');
  s = { ...s, state: 'berjalan', tahap: 'mulai', persen: 0, pesan: '', started_at: ws.clock.now(), finished_at: null, exit_code: null, alasan: null };
  await writeStatus(ws, s);
  if (s.lease_id) await setLeaseStatus(ws, { lease_id: s.lease_id, status: 'running', actor: 'user' }).catch(() => undefined);
  opts.onProgress?.(s);
  let log = '';
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve(); // progress writes in order, finished before the final one
  let code = await new Promise<number>((resolve) => {
    if (opts.signal?.aborted) {
      log += '[Motion Studio] dibatalkan sebelum mesin mulai';
      resolve(1);
      return;
    }
    let child: ReturnType<Spawner>;
    try {
      child = (opts.spawnImpl ?? spawn)(cfg.command, [cfg.script, mode, jdir], { cwd: cfg.root, windowsHide: true, env: engineEnv() });
    } catch (e) {
      log += `tidak bisa menjalankan mesin: ${String(e)}`;
      resolve(1);
      return;
    }
    const timer = setTimeout(() => {
      log += `\n[Motion Studio] mesin dihentikan setelah ${Math.round(cfg.timeout_ms / 60000)} menit`;
      killTree(child);
    }, cfg.timeout_ms);
    const onAbort = () => {
      log += '\n[Motion Studio] dibatalkan';
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort(); // cancelled between the check above and the listener
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line) as { tahap?: unknown; persen?: unknown; pesan?: unknown };
          if (typeof p.tahap === 'string') s.tahap = p.tahap.slice(0, 40);
          if (typeof p.persen === 'number' && Number.isFinite(p.persen)) s.persen = Math.max(0, Math.min(100, Math.round(p.persen)));
          if (typeof p.pesan === 'string') s.pesan = p.pesan.slice(0, 200);
          opts.onProgress?.({ ...s });
          const t = Date.now();
          if (t - lastWrite > 500) {
            lastWrite = t;
            const snap = { ...s };
            writing = writing.then(() => writeStatus(ws, snap)).catch(() => undefined);
          }
        } catch {
          log = (log + line + '\n').slice(-MAX_ENGINE_LOG); // not JSON: keep as log
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      log = (log + chunk).slice(-MAX_ENGINE_LOG);
    });
    child.on('error', (e) => {
      log += `\n${String(e)}`;
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(typeof c === 'number' ? c : 1);
    });
  });
  await writing;
  await fsp.writeFile(path.join(jdir, 'engine.log'), log, 'utf8').catch(() => undefined);
  const rencana = await readJson<{ status?: string; alasan?: string }>(path.join(jdir, 'out', 'rencana.json')).catch(() => null);
  if (code === 0 && rencana?.status === 'ditolak') code = 2; // contract §5.1: the plan itself says refused
  const tail = log.trim().split('\n').slice(-3).join(' · ').slice(0, 300);
  if (code === 0) {
    const okFiles = mode === 'batch' ? await fsp.stat(path.join(jdir, 'out', 'batch.json')).catch(() => null) : await fsp.stat(path.join(jdir, 'out', 'ops.json')).catch(() => null);
    s = okFiles
      ? { ...s, state: 'siap', tahap: 'selesai', persen: 100, ...(rencana?.status === 'perlu_keputusan' ? { pesan: 'Perlu keputusan tim (lihat kartu rencana)' } : {}) }
      : { ...s, state: 'gagal', alasan: `Mesin selesai tanpa ${mode === 'batch' ? 'batch.json' : 'ops.json'}` };
  } else if (code === 2) s = { ...s, state: 'ditolak', alasan: (typeof rencana?.alasan === 'string' ? rencana.alasan : 'Input ditolak mesin').slice(0, 300) };
  else s = { ...s, state: 'gagal', alasan: tail || `Mesin gagal (kode ${code})` };
  s = { ...s, exit_code: code, finished_at: ws.clock.now() };
  if (s.lease_id) {
    await releaseLease(ws, { lease_id: s.lease_id, outcome: s.state === 'siap' ? 'completed' : 'failed', actor: 'user' }).catch(() => undefined);
    s.lease_id = null;
  }
  await writeStatus(ws, s);
  await audit(ws, { op: 'engine.run', actor: 'user', outcome: s.state === 'siap' ? 'ok' : s.state === 'ditolak' ? 'blocked' : 'error', project_id: projectId, job_id: jobId, mode, exit_code: code });
  opts.onProgress?.(s);
  return s;
}

/** A job left `berjalan` / `menunggu` by a server that stopped: mark it failed, free its lease. */
export async function settleOrphanJob(ws: Workspace, s: EngineStatus): Promise<EngineStatus> {
  if (s.state !== 'berjalan' && s.state !== 'menunggu') return s;
  if (s.lease_id) await releaseLease(ws, { lease_id: s.lease_id, outcome: 'failed', actor: 'user' }).catch(() => undefined);
  const out: EngineStatus = { ...s, state: 'gagal', alasan: 'Terhenti (server dimulai ulang); jalankan lagi', lease_id: null, finished_at: ws.clock.now() };
  await writeStatus(ws, out);
  return out;
}

// ------------------------------------------------------------------ reading the plan back

export interface EnginePlan {
  ops: unknown[];
  rencana: Record<string, unknown>;
  /** `qc_rencana.json` (contract §5.4): the engine's own checks of the plan, shown on the card. */
  qc: { butir: { butir: string; lulus: boolean; nilai?: unknown }[] } | null;
  /** Media imported from the engine's own `aset_lokal` while resolving. */
  imported: string[];
}

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|wav|mp3|m4a|aac|ogg|opus|flac|png|jpe?g|webp)$/i;

/**
 * Paths the engine may hand us to import: real media files inside its own repo, nothing else
 * (no symlink out of it, no `.env` or code — Checkpoint I L1).
 */
async function assertEnginePath(cfg: EngineConfig | null, p: string): Promise<string> {
  if (!cfg) throw new StorageError('PRECONDITION', 'Mesin belum dipasang (MOTION_ENGINE_ROOT); aset_lokal tidak bisa diimpor');
  const abs = path.resolve(cfg.root, p);
  const real = await fsp.realpath(abs).catch(() => null);
  const rootReal = await fsp.realpath(cfg.root).catch(() => cfg.root);
  if (!real || !isInside(rootReal, real)) throw new StorageError('PRECONDITION', 'aset_lokal di luar folder mesin ditolak', { path: path.basename(abs) });
  if (!MEDIA_EXT.test(real)) throw new StorageError('PRECONDITION', 'aset_lokal harus file media (video/audio/gambar)', { path: path.basename(abs) });
  return real;
}

/**
 * Read `out/[varian-NNN/]ops.json` and replace placeholders with MediaRefs (sources, brand assets,
 * `aset_lokal` imported as project media; Batch Remix footage from `batch.json` as shared media).
 * Unknown placeholders are refused — no guessing.
 */
export async function loadEnginePlan(ws: Workspace, cfg: EngineConfig | null, projectId: string, jobId: string, variant?: string): Promise<EnginePlan> {
  const jdir = jobAbs(ws, projectId, jobId);
  if (variant !== undefined && !/^varian-\d{3}$/.test(variant)) bad('varian tidak valid');
  const outDir = variant ? path.join(jdir, 'out', variant) : path.join(jdir, 'out');
  const opsFile = await readJson<{ schema?: string; ops?: unknown; aset_lokal?: unknown }>(path.join(outDir, 'ops.json'));
  if (!opsFile) throw new StorageError('NOT_FOUND', 'ops.json belum ada (mesin belum selesai)');
  if (opsFile.schema !== 'ms-ops/1' || !Array.isArray(opsFile.ops)) throw new StorageError('PRECONDITION', 'ops.json harus schema ms-ops/1 dengan daftar ops');
  const rencana = (await readJson<Record<string, unknown>>(path.join(outDir, 'rencana.json'))) ?? {};
  const qcRaw = await readJson<{ butir?: unknown }>(path.join(outDir, 'qc_rencana.json'));
  const qc = qcRaw && Array.isArray(qcRaw.butir)
    ? { butir: (qcRaw.butir as Record<string, unknown>[]).filter((b) => b && typeof b.butir === 'string').slice(0, 50).map((b) => ({ butir: String(b.butir).slice(0, 200), lulus: b.lulus === true, ...(b.nilai !== undefined ? { nilai: b.nilai } : {}) })) }
    : null;
  const refsFile = (await readJson<{ refs: Record<string, MediaRef> }>(path.join(jdir, 'refs.json'))) ?? { refs: {} };
  const refs = { ...refsFile.refs };
  const imported: string[] = [];
  // Batch Remix: the footage lives in the engine's own folder (`batch.json` → media) and is used by
  // several variant projects, so everything a batch plan brings in is imported as SHARED media.
  const status = await readEngineStatus(ws, projectId, jobId);
  const shared = status.mode === 'batch';
  const scope = shared ? ({ kind: 'shared' } as const) : ({ kind: 'project', project_id: projectId } as const);
  const found: { kunci: string; path: string }[] = [];
  const lokal = opsFile.aset_lokal === undefined ? [] : Array.isArray(opsFile.aset_lokal) ? opsFile.aset_lokal : bad('aset_lokal harus daftar');
  if (lokal.length > 200) bad('aset_lokal maksimal 200');
  for (const [i, a] of lokal.entries()) {
    const ao = (a ?? {}) as Record<string, unknown>;
    if (typeof ao.kunci !== 'string' || !/^\$[a-z]+:[A-Za-z0-9_.-]{1,60}$/.test(ao.kunci) || typeof ao.path !== 'string') bad(`aset_lokal[${i}] harus { kunci: "$jenis:id", path }`);
    found.push({ kunci: ao.kunci as string, path: ao.path as string });
  }
  if (shared) {
    const media = ((await readJson<{ media?: unknown }>(path.join(jdir, 'out', 'batch.json')))?.media ?? {}) as Record<string, unknown>;
    for (const op of opsFile.ops as Record<string, unknown>[]) {
      const k = op?.media;
      if (typeof k === 'string' && !refs[k] && typeof media[k] === 'string' && !found.some((f) => f.kunci === k)) found.push({ kunci: k, path: media[k] as string });
    }
  }
  // Import once (deduplicated by content), remembered in refs.json.
  for (const f of found) {
    if (refs[f.kunci]) continue;
    const abs = await assertEnginePath(cfg, f.path);
    const r = await importMedia(ws, { sourcePath: abs, scope, display_name: `${f.kunci.slice(1).replace(/:/g, '-')}${path.extname(abs)}`, actor: 'user' });
    refs[f.kunci] = { media_id: r.media.media_id, version_id: r.version.version_id };
    imported.push(f.kunci);
  }
  if (imported.length) await writeJsonAtomic(path.join(jdir, 'refs.json'), { ...refsFile, schema: 'engine-refs/1', refs });
  const unknown = new Set<string>();
  const ops = opsFile.ops.map((op) => {
    const o = op as Record<string, unknown>;
    if (o && typeof o === 'object' && typeof o.media === 'string') {
      const r = refs[o.media];
      if (!r) unknown.add(o.media);
      return { ...o, media: r ?? null };
    }
    return op;
  });
  if (unknown.size) throw new StorageError('PRECONDITION', `Placeholder tidak dikenal: ${[...unknown].slice(0, 10).join(', ')}`, { unknown: [...unknown].slice(0, 50) });
  return { ops, rencana, qc, imported };
}

/** Batch Remix table (`out/batch.json`) as written by the engine. */
export async function readEngineBatch(ws: Workspace, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const b = await readJson<Record<string, unknown>>(path.join(jobAbs(ws, projectId, jobId), 'out', 'batch.json'));
  if (!b) throw new StorageError('NOT_FOUND', 'batch.json belum ada');
  return b;
}

/** Engine log tail for the "gagal" card. */
export async function readEngineLog(ws: Workspace, projectId: string, jobId: string, cfg: EngineConfig | null = null): Promise<string> {
  let log = (await fsp.readFile(path.join(jobAbs(ws, projectId, jobId), 'engine.log'), 'utf8').catch(() => '')).slice(-4000);
  // Checkpoint I L2: no local paths in what the browser sees.
  const swap = (from: string, to: string) => {
    for (const v of [from, from.replace(/\\/g, '/')]) if (v) log = log.split(v).join(to);
  };
  if (cfg) swap(cfg.root, '<mesin>');
  swap(ws.root, '<workspace>');
  return log.replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>');
}

// ------------------------------------------------------------------ Batch Remix decisions (U5)

export type BatchRowStatus = 'usul' | 'disetujui' | 'dicoret';
export interface BatchDecision {
  status: BatchRowStatus;
  /** Variant project made when the row was approved (kept if the row is struck later). */
  project_id: string | null;
}

const decisionsFile = (ws: Workspace, projectId: string, jobId: string) => path.join(jobAbs(ws, projectId, jobId), 'keputusan.json');

export async function readBatchDecisions(ws: Workspace, projectId: string, jobId: string): Promise<Record<string, BatchDecision>> {
  return ((await readJson<{ rows?: Record<string, BatchDecision> }>(decisionsFile(ws, projectId, jobId)))?.rows ?? {}) as Record<string, BatchDecision>;
}

/**
 * The team approves / strikes rows of the batch table (contract §5.3a). Approving a row makes a
 * variant project of the batch's master project with that row's plan, already approved, so
 * "Render varian disetujui" renders exactly the approved rows. Striking a row withdraws the
 * approval (the project stays, nothing is deleted). Rows are decided once per call, all checked
 * before any project is made.
 */
export async function decideBatch(
  ws: Workspace,
  cfg: EngineConfig | null,
  input: { project_id: string; job_id: string; rows: unknown; actor: 'user'; newId: () => string; plans?: ReadonlyMap<string, EnginePlan> },
): Promise<Record<string, BatchDecision>> {
  const s = await readEngineStatus(ws, input.project_id, input.job_id);
  if (s.mode !== 'batch') bad('Job ini bukan Batch Remix');
  if (s.state !== 'siap') bad('Batch belum siap');
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 50) bad('rows harus daftar 1–50');
  const batch = await readEngineBatch(ws, input.project_id, input.job_id);
  const table = (Array.isArray(batch.varian) ? batch.varian : []) as { id?: unknown; hook?: unknown; bukan_iklan?: unknown }[];
  const byId = new Map(table.filter((r) => typeof r.id === 'string').map((r) => [r.id as string, r]));
  const wanted = (input.rows as unknown[]).map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.varian !== 'string' || !byId.has(o.varian)) bad(`rows[${i}].varian tidak ada di tabel batch`);
    if (o.status !== 'usul' && o.status !== 'disetujui' && o.status !== 'dicoret') bad(`rows[${i}].status harus usul | disetujui | dicoret`);
    return { varian: o.varian as string, status: o.status as BatchRowStatus };
  });
  // Checkpoint I H2: one decision per row per request.
  if (new Set(wanted.map((w) => w.varian)).size !== wanted.length) bad('Satu varian hanya boleh muncul sekali per keputusan');
  const master = await readProject(ws, input.project_id);
  if (master.variant) bad('Proyek batch tidak boleh varian');
  const decisions = await readBatchDecisions(ws, input.project_id, input.job_id);
  // Dry run: every newly approved row must be a valid timeline before any project is made.
  const reg = await loadRegistry(ws);
  const dur = (ref: MediaRef) => reg.versions[ref.version_id]?.probe?.duration_ms;
  const toCreate: { varian: string; timeline: Timeline; label: string; hook: string | null; test: boolean }[] = [];
  for (const w of wanted) {
    if (w.status !== 'disetujui' || decisions[w.varian]?.project_id) continue;
    const p = input.plans?.get(w.varian) ?? (await loadEnginePlan(ws, cfg, input.project_id, input.job_id, w.varian));
    let timeline: Timeline;
    try {
      timeline = applyOps({ tracks: [] }, validateOps(p.ops, MAX_SERVER_OPS), () => newId('c'), dur);
    } catch (e) {
      throw new StorageError('EDIT_INVALID', `${w.varian}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const row = byId.get(w.varian)!;
    const hook = typeof row.hook === 'string' && row.hook.trim() ? row.hook.trim().slice(0, 200) : null;
    const test = row.bukan_iklan === true;
    toCreate.push({ varian: w.varian, timeline, hook, test, label: `${test ? 'UJI · ' : ''}${w.varian}${hook ? ` · ${hook}` : ''}`.slice(0, 60) });
  }
  let number = Math.max(0, ...(await listVariants(ws, master.project_id)).map((p) => p.variant!.number));
  for (const c of toCreate) {
    const variant: VariantInfo = { master_id: master.project_id, number: ++number, label: c.label, brief: c.hook ? { hook: c.hook } : {}, approved_revision: null, ...(c.test ? { bukan_iklan: true as const } : {}) };
    const made = await createWithTimeline(ws, { project_id: input.newId(), name: `${master.name} · ${c.label}`.slice(0, MAX_PROJECT_NAME), timeline: c.timeline, actor: input.actor, variant, ...(master.brand_id ? { brand_id: master.brand_id } : {}) });
    await setVariantApproval(ws, { project_id: made.project_id, expected_revision: made.revision, approved: true, actor: input.actor });
    decisions[c.varian] = { status: 'disetujui', project_id: made.project_id };
    // Recorded right away: a failure on a later row never leaves this project unknown (no duplicate on retry).
    await writeJsonAtomic(decisionsFile(ws, input.project_id, input.job_id), { schema: 'batch-keputusan/1', rows: decisions });
  }
  for (const w of wanted) {
    const d = decisions[w.varian] ?? { status: 'usul', project_id: null };
    if (w.status === 'disetujui' && d.project_id) {
      // Re-approving a struck row: approve the variant again at its current content.
      const p = await readProject(ws, d.project_id).catch(() => null);
      if (p?.variant && variantState(p) !== 'approved') await setVariantApproval(ws, { project_id: p.project_id, expected_revision: p.revision, approved: true, actor: input.actor });
    }
    if (w.status !== 'disetujui' && d.project_id) {
      const p = await readProject(ws, d.project_id).catch(() => null);
      if (p?.variant && p.variant.approved_revision !== null) await setVariantApproval(ws, { project_id: p.project_id, expected_revision: p.revision, approved: false, actor: input.actor });
    }
    decisions[w.varian] = { ...d, status: w.status };
  }
  await writeJsonAtomic(decisionsFile(ws, input.project_id, input.job_id), { schema: 'batch-keputusan/1', rows: decisions });
  await audit(ws, { op: 'engine.batch_decide', actor: input.actor, outcome: 'ok', project_id: input.project_id, job_id: input.job_id, approved: wanted.filter((w) => w.status === 'disetujui').length, struck: wanted.filter((w) => w.status === 'dicoret').length, created: toCreate.length });
  return decisions;
}

/**
 * Checkpoint I M2: read (and import the media of) the plans of rows that will become variants,
 * OUTSIDE the workspace lock — imports hash and copy footage and may take minutes.
 */
export async function loadBatchPlans(ws: Workspace, cfg: EngineConfig | null, projectId: string, jobId: string, rows: unknown): Promise<Map<string, EnginePlan>> {
  const out = new Map<string, EnginePlan>();
  if (!Array.isArray(rows) || rows.length > 50) return out;
  const decisions = await readBatchDecisions(ws, projectId, jobId);
  for (const r of rows as Record<string, unknown>[]) {
    const v = r?.varian;
    if (r?.status !== 'disetujui' || typeof v !== 'string' || !/^varian-\d{3}$/.test(v) || out.has(v) || decisions[v]?.project_id) continue;
    out.set(v, await loadEnginePlan(ws, cfg, projectId, jobId, v));
  }
  return out;
}
