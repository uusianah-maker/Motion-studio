/**
 * Motion Transfer tahap 1 (R11, KONTRAK-ENGINE §15), app side.
 *
 *   <job>/out/transfer.json      the engine's scenes (never changed by the app)
 *   <job>/out/adegan/NN.jpg      best frame per scene
 *   <job>/transfer-tim.json      the team's edits: which engine scenes are kept, merged, in order
 *
 * Hybrid (owner): everything the engine decided stays editable — the team deletes or merges scenes
 * and can always go back to the engine's split. Each edit is a lesson for the brand (R9 log).
 * Nothing here calls an AI API: the prompts are copied by hand into the team's own tools.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { engineJobDir, readEngineStatus, scrubPaths } from './engine.js';
import { StorageError } from './errors.js';
import { writeJsonAtomic } from './jsonStore.js';
import { appendLearning } from './learning.js';
import { loadRegistry } from './registry.js';
import { isInside } from './paths.js';
import { type Workspace, withWorkspaceLock } from './workspace.js';

export const MAX_TRANSFER_SCENES = 300;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface TransferScene {
  /** Engine scene numbers in this scene ("3" or "3+4"): stable id for edits. */
  id: string;
  nos: number[];
  dari: number;
  sampai: number;
  durasi: number;
  /** Engine scene number whose frame is shown / downloaded. */
  gambar_no: number;
  prompt_gambar: string;
  prompt_gerak: string;
  /** 'mesin' = as the engine made it; 'tim' = merged by the team. */
  sumber: 'mesin' | 'tim';
}

export interface TransferView {
  job_id: string;
  referensi: string;
  durasi: number;
  produk: string;
  catatan: string;
  adegan: TransferScene[];
  /** Number of scenes the engine made. */
  jumlah_mesin: number;
  /** The team changed the engine's split (delete / merge). */
  diubah: boolean;
  /** Edit counter (optimistic concurrency for two people editing at once). */
  versi: number;
}

interface EngineScene {
  no: number;
  dari: number;
  sampai: number;
  durasi: number;
  gambar: string;
  prompt_gambar: string;
  prompt_gerak: string;
}
interface TeamFile {
  schema: 'transfer-tim/1';
  versi: number;
  /** Groups of engine scene numbers, in order; a scene not listed was deleted. */
  grup: number[][];
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' ? scrubPaths(v).slice(0, max) : '');
const round2 = (n: number) => Math.round(n * 100) / 100;
const sec = (n: number) => n.toFixed(1);

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('PRECONDITION', `File mesin tidak bisa dibaca: ${path.basename(file)}`);
  }
}

async function loadEngine(ws: Workspace, projectId: string, jobId: string) {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'transfer') bad('Job ini bukan Motion Transfer');
  if (s.state !== 'siap') throw new StorageError('PRECONDITION', 'Hasil Motion Transfer belum siap');
  const dir = engineJobDir(ws, projectId, jobId);
  const raw = (await readJsonFile(path.join(dir, 'out', 'transfer.json'))) as Record<string, unknown> | null;
  if (!raw || raw.schema !== 'engine-transfer/1' || !Array.isArray(raw.adegan)) throw new StorageError('PRECONDITION', 'transfer.json dari mesin tidak dikenali');
  const scenes: EngineScene[] = [];
  for (const a of (raw.adegan as unknown[]).slice(0, MAX_TRANSFER_SCENES)) {
    const o = (a ?? {}) as Record<string, unknown>;
    const no = num(o.no);
    const dari = num(o.dari);
    const sampai = num(o.sampai);
    if (!no || !Number.isInteger(no) || dari === null || sampai === null || sampai < dari || scenes.some((x) => x.no === no)) continue;
    scenes.push({ no, dari, sampai, durasi: num(o.durasi) ?? round2(sampai - dari), gambar: typeof o.gambar === 'string' ? o.gambar : '', prompt_gambar: text(o.prompt_gambar, 4000), prompt_gerak: text(o.prompt_gerak, 4000) });
  }
  scenes.sort((x, y) => x.no - y.no);
  return {
    dir,
    scenes,
    meta: { referensi: path.basename(text(raw.referensi, 200)), durasi: num(raw.durasi) ?? 0, produk: text(raw.produk, 200), catatan: text(raw.catatan, 1000) },
  };
}

const teamPath = (dir: string) => path.join(dir, 'transfer-tim.json');

async function loadTeam(dir: string, scenes: EngineScene[]): Promise<TeamFile | null> {
  const t = (await readJsonFile(teamPath(dir))) as TeamFile | null;
  if (!t || t.schema !== 'transfer-tim/1' || !Array.isArray(t.grup)) return null;
  // Only numbers the engine still has, each once (a hand-edited / stale file never breaks the page).
  const known = new Set(scenes.map((s) => s.no));
  const seen = new Set<number>();
  const grup = t.grup
    .map((g) => (Array.isArray(g) ? g.filter((n): n is number => typeof n === 'number' && known.has(n) && !seen.has(n) && !!seen.add(n)) : []))
    .filter((g) => g.length > 0);
  return { schema: 'transfer-tim/1', versi: Number.isInteger(t.versi) && t.versi >= 0 ? t.versi : 0, grup };
}

function mergedMotionPrompt(parts: EngineScene[], total: number): string {
  const d = parts.reduce((n, p) => n + p.durasi, 0);
  const nomor = parts.length > 1 ? `${parts[0]!.no}–${parts[parts.length - 1]!.no}` : String(parts[0]!.no);
  return `Gerakkan gambar ini selama ${sec(d)} detik meniru gerakan adegan ${nomor}/${total} video referensi (gerakan kamera dan gerakan orang sama dengan referensi). Produk harus tetap sama persis bentuk, warna, dan motifnya. Tanpa teks.`;
}

function buildScenes(scenes: EngineScene[], grup: number[][]): TransferScene[] {
  const byNo = new Map(scenes.map((s) => [s.no, s]));
  return grup.map((g) => {
    const parts = g.map((n) => byNo.get(n)!);
    const first = parts[0]!;
    const single = parts.length === 1;
    return {
      id: g.join('+'),
      nos: g,
      dari: first.dari,
      sampai: parts[parts.length - 1]!.sampai,
      durasi: round2(parts.reduce((n, p) => n + p.durasi, 0)),
      gambar_no: first.no,
      prompt_gambar: first.prompt_gambar,
      prompt_gerak: single ? first.prompt_gerak : mergedMotionPrompt(parts, scenes.length),
      sumber: single ? 'mesin' : 'tim',
    };
  });
}

/** The reference video's name as the team uploaded it (the engine only sees the stored file). */
async function uploadedName(ws: Workspace, dir: string): Promise<string | null> {
  const refs = (await readJsonFile(path.join(dir, 'refs.json')).catch(() => null)) as { refs?: Record<string, { version_id?: unknown }> } | null;
  const vid = refs?.refs?.$sumber?.version_id;
  if (typeof vid !== 'string') return null;
  const v = (await loadRegistry(ws)).versions[vid];
  return v ? path.basename(v.original_name).slice(0, 200) : null;
}

export async function readTransferView(ws: Workspace, projectId: string, jobId: string): Promise<TransferView> {
  const { dir, scenes, meta } = await loadEngine(ws, projectId, jobId);
  meta.referensi = (await uploadedName(ws, dir)) ?? meta.referensi;
  const team = await loadTeam(dir, scenes);
  const original = scenes.map((s) => [s.no]);
  const grup = team?.grup ?? original;
  return {
    job_id: jobId,
    ...meta,
    adegan: buildScenes(scenes, grup),
    jumlah_mesin: scenes.length,
    diubah: JSON.stringify(grup) !== JSON.stringify(original),
    versi: team?.versi ?? 0,
  };
}

/**
 * The team's edit of the scene list: `hapus` (delete one), `gabung` (merge with the NEXT scene,
 * which must follow it directly in the reference), `pulihkan` (back to the engine's split).
 */
export async function editTransfer(ws: Workspace, input: { project_id: string; job_id: string; aksi: unknown; id?: unknown; expected_versi: unknown; by?: string | null }): Promise<TransferView> {
  if (input.aksi !== 'hapus' && input.aksi !== 'gabung' && input.aksi !== 'pulihkan') bad('aksi harus hapus | gabung | pulihkan');
  if (input.aksi !== 'pulihkan' && (typeof input.id !== 'string' || !/^\d{1,4}(\+\d{1,4}){0,299}$/.test(input.id))) bad('id adegan tidak valid');
  const view = await withWorkspaceLock(ws, 'transfer.edit', async () => {
    const { dir, scenes } = await loadEngine(ws, input.project_id, input.job_id);
    const team = await loadTeam(dir, scenes);
    const versi = team?.versi ?? 0;
    if (input.expected_versi !== versi) throw new StorageError('CONFLICT', 'Daftar adegan sudah diubah orang lain; muat ulang dulu', { expected: input.expected_versi, actual: versi });
    let grup = (team?.grup ?? scenes.map((s) => [s.no])).map((g) => [...g]);
    const at = grup.findIndex((g) => g.join('+') === input.id);
    if (input.aksi === 'pulihkan') grup = scenes.map((s) => [s.no]);
    else if (at < 0) throw new StorageError('NOT_FOUND', 'Adegan tidak ada (mungkin sudah dihapus/digabung)');
    else if (input.aksi === 'hapus') {
      if (grup.length === 1) bad('Sisakan minimal satu adegan');
      grup.splice(at, 1);
    } else {
      const next = grup[at + 1];
      if (!next) bad('Adegan terakhir tidak punya adegan berikutnya untuk digabung');
      const nos = scenes.map((s) => s.no);
      // Only scenes that follow each other in the reference (a deleted one in between = a jump).
      if (nos.indexOf(next![0]!) !== nos.indexOf(grup[at]![grup[at]!.length - 1]!) + 1) bad('Hanya adegan yang bersambung di video referensi yang bisa digabung');
      grup.splice(at, 2, [...grup[at]!, ...next!]);
    }
    await writeJsonAtomic(teamPath(dir), { schema: 'transfer-tim/1', versi: versi + 1, grup } satisfies TeamFile);
    return readTransferView(ws, input.project_id, input.job_id);
  });
  // R9 (PC-R6 "catat semua koreksi"): how the team corrected the engine's scene split.
  await appendLearning(ws, input.project_id, { jenis: 'transfer_tim', job_id: input.job_id, aksi: input.aksi as 'hapus' | 'gabung' | 'pulihkan', adegan: typeof input.id === 'string' ? input.id : null, sisa: view.adegan.length, dari_mesin: view.jumlah_mesin, by: input.by ?? null });
  return view;
}

/** One scene frame (JPEG/PNG) the engine wrote under out/adegan/ — nothing else is served. */
export async function readTransferImage(ws: Workspace, projectId: string, jobId: string, no: unknown): Promise<{ bytes: Buffer; mime: string }> {
  if (typeof no !== 'number' || !Number.isInteger(no) || no < 1 || no > 9999) throw new StorageError('NOT_FOUND', 'Gambar adegan tidak ada');
  const { dir, scenes } = await loadEngine(ws, projectId, jobId);
  const s = scenes.find((x) => x.no === no);
  const base = path.join(dir, 'out', 'adegan');
  const abs = s?.gambar ? path.resolve(dir, 'out', s.gambar) : null;
  const real = abs ? await fsp.realpath(abs).catch(() => null) : null;
  const baseReal = await fsp.realpath(base).catch(() => null);
  const mime = real ? ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' } as Record<string, string>)[path.extname(real).toLowerCase()] : undefined;
  if (!real || !baseReal || !mime || !isInside(baseReal, real)) throw new StorageError('NOT_FOUND', 'Gambar adegan tidak ada');
  const st = await fsp.stat(real);
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new StorageError('NOT_FOUND', 'Gambar adegan tidak ada');
  return { bytes: await fsp.readFile(real), mime };
}
