/**
 * R35 Visual Tools (owner 16 Nov; KONTRAK-ENGINE §18.10 `engine visual <job_dir>`, engine side by
 * yuki). App side: validate a visual job for ONE media (the selected clip's), and read its result.
 *  - hapus_latar → `<nama>-alpha.webm` (video) / `<nama>.png` (image) + its mask, imported into Media;
 *  - perjelas    → `<nama>-hd.mp4` / `<nama>-hd.png`, imported into Media;
 *  - deteksi / reframe / lacak → position paths (jalur-posisi/1, reframe/1), returned as data (the
 *    editor turns them into keyframes — R35b/c).
 * Everything the engine returns is a SUGGESTION (`usulan`): the team keeps, swaps back or deletes it.
 * Only plain file names inside the job's out/ folder are used, never a path from the engine.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type EngineJobInput, engineJobDir, readEngineStatus } from './engine.js';
import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import { writeJsonAtomic } from './jsonStore.js';
import type { MediaRef } from './project.js';
import { importMedia } from './registry.js';
import type { Workspace } from './workspace.js';
import { BG_MODELS, VISUAL_RESULT, VISUAL_TOOLS, type VisualTool } from './visualCalc.js';
export { BG_MODELS, SECONDS_PER_FRAME, VISUAL_MAX_VIDEO_S, VISUAL_RESULT, VISUAL_TOOLS, type VisualTool, visualEstimate } from './visualCalc.js';

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const num = (v: unknown, what: string, lo: number, hi: number, dflt: number) => (v === undefined ? dflt : typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${what} harus ${lo}–${hi}`));

/** Browser request (untrusted) → engine input. `ref` = the media version the tool works on. */
export function validateVisualJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'ref', 'visual'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  const r = (o.ref ?? {}) as Record<string, unknown>;
  if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad('ref media tidak valid');
  const v = (o.visual ?? {}) as Record<string, unknown>;
  const alat = VISUAL_TOOLS.includes(v.alat as VisualTool) ? (v.alat as VisualTool) : bad(`alat harus ${VISUAL_TOOLS.join(' | ')}`);
  const allow: Record<VisualTool, string[]> = { hapus_latar: ['kualitas', 'fps'], perjelas: ['mode', 'skala'], deteksi: ['jenis', 'hz'], reframe: ['jalur_job', 'rasio', 'kanvas', 'fit', 'awal_ms', 'subjek'], lacak: ['kotak', 'mulai', 'sampai', 'metode', 'hz'] };
  const ve = Object.keys(v).filter((k) => k !== 'alat' && !allow[alat].includes(k));
  if (ve.length) bad(`visual: field tidak dikenal ${ve.join(', ')}`);
  let p: Record<string, unknown> = {};
  if (alat === 'hapus_latar') {
    const k = v.kualitas === undefined ? 'cepat' : v.kualitas === 'cepat' || v.kualitas === 'tinggi' ? v.kualitas : bad('kualitas harus cepat | tinggi');
    p = { model: BG_MODELS[k], fps: Math.round(num(v.fps, 'fps', 1, 30, 10)) };
  } else if (alat === 'perjelas') {
    const mode = v.mode === undefined ? 'cepat' : v.mode === 'cepat' || v.mode === 'kualitas' ? v.mode : bad('mode harus cepat | kualitas');
    const skala = v.skala === undefined ? (mode === 'kualitas' ? 4 : 2) : [2, 3, 4].includes(v.skala as number) ? v.skala : bad('skala harus 2 | 3 | 4');
    if (mode === 'kualitas' && skala !== 4) bad('mode kualitas hanya x4');
    p = { mode, skala };
  } else if (alat === 'deteksi') {
    const jenis = v.jenis === undefined ? ['wajah', 'objek'] : Array.isArray(v.jenis) && v.jenis.length && v.jenis.every((j) => j === 'wajah' || j === 'objek') ? [...new Set(v.jenis as string[])] : bad('jenis harus wajah / objek');
    p = { jenis, hz: Math.round(num(v.hz, 'hz', 1, 30, 10)) };
  } else if (alat === 'reframe') {
    if (typeof v.jalur_job !== 'string' || !/^[A-Z0-9]{2,5}-\d{8}-\d{3}$/.test(v.jalur_job)) bad('jalur_job: job deteksi wajib');
    const k = Array.isArray(v.kanvas) && v.kanvas.length === 2 && v.kanvas.every((n) => Number.isInteger(n) && (n as number) >= 2 && (n as number) <= 8192) ? v.kanvas : bad('kanvas harus [lebar, tinggi]');
    p = { jalur_job: v.jalur_job, rasio: typeof v.rasio === 'string' && /^\d{1,2}:\d{1,2}$/.test(v.rasio) ? v.rasio : '9:16', kanvas: k, fit: v.fit === 'isi' ? 'isi' : 'pas', awal_ms: Math.round(num(v.awal_ms, 'awal_ms', 0, 24 * 3_600_000, 0)), ...(typeof v.subjek === 'string' && /^[a-z0-9-]{1,40}$/.test(v.subjek) ? { subjek: v.subjek } : {}) };
  } else {
    const k = Array.isArray(v.kotak) && v.kotak.length === 4 && v.kotak.every((n) => typeof n === 'number' && n >= 0 && n <= 1) ? (v.kotak as number[]) : bad('kotak harus [x, y, w, h] pecahan 0–1');
    if (k[2]! <= 0.005 || k[3]! <= 0.005 || k[0]! + k[2]! > 1.0001 || k[1]! + k[3]! > 1.0001) bad('kotak lacak di luar gambar / terlalu kecil');
    p = { kotak: k, mulai: num(v.mulai, 'mulai', 0, 24 * 3600, 0), ...(v.sampai !== undefined ? { sampai: num(v.sampai, 'sampai', 0, 24 * 3600, 0) } : {}), metode: v.metode === 'kcf' ? 'kcf' : 'csrt', hz: Math.round(num(v.hz, 'hz', 1, 30, 15)) };
  }
  return { project_id: o.project_id as string, mode: 'visual', sources: [{ kunci: '$sumber', ref: { media_id: r.media_id as string, version_id: r.version_id as string } }], preset: 'visual', brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' }, ai: false, visual: { alat, ...p } };
}

export interface VisualView {
  job_id: string;
  alat: VisualTool;
  /** Media made by the tool (hapus_latar / perjelas). */
  hasil: MediaRef | null;
  /** hapus_latar: the grey mask (white = subject) for the render's alphamerge. */
  masker: MediaRef | null;
  info: Record<string, unknown>;
  /** deteksi / lacak: jalur-posisi/1; reframe: reframe/1 (incl. keyframe_app). Paths dropped. */
  data: Record<string, unknown> | null;
}

/** Drop any string that looks like a local path from engine JSON shown to the browser. */
function scrub(x: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof x === 'string') return /[\\/]|^[A-Za-z]:/.test(x) && x.length > 3 ? path.basename(x.replace(/\\/g, '/')).slice(0, 120) : x.slice(0, 200);
  if (Array.isArray(x)) return x.slice(0, 2000).map((v) => scrub(v, depth + 1));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).slice(0, 60).map(([k, v]) => [k, scrub(v, depth + 1)]));
  return x;
}

export async function readVisualResult(ws: Workspace, projectId: string, jobId: string): Promise<VisualView> {
  const s = await readEngineStatus(ws, projectId, jobId);
  if (s.mode !== 'visual') bad('Job ini bukan alat visual');
  if (s.state !== 'siap') throw new StorageError('PRECONDITION', 'Hasil belum siap');
  const jdir = engineJobDir(ws, projectId, jobId);
  const job = JSON.parse(await fsp.readFile(path.join(jdir, 'job.json'), 'utf8')) as { visual?: { alat?: VisualTool } };
  const alat = job.visual?.alat;
  if (!alat || !VISUAL_TOOLS.includes(alat)) bad('job visual rusak');
  const out = path.join(jdir, 'out');
  const report = JSON.parse(await fsp.readFile(path.join(out, VISUAL_RESULT[alat!]), 'utf8').catch(() => '{}')) as Record<string, unknown>;
  if (alat === 'deteksi' || alat === 'lacak' || alat === 'reframe') return { job_id: jobId, alat: alat!, hasil: null, masker: null, info: {}, data: scrub(report) as Record<string, unknown> };
  // hapus_latar / perjelas: import the made file(s) once (`out/impor.json` remembers).
  const folder = path.join(out, alat === 'hapus_latar' ? 'hapus_latar' : 'perjelas');
  const memo = path.join(out, 'impor.json');
  let imp = JSON.parse(await fsp.readFile(memo, 'utf8').catch(() => 'null')) as { hasil: MediaRef | null; masker: MediaRef | null } | null;
  if (!imp) {
    const pick = async (v: unknown): Promise<string | null> => {
      const name = typeof v === 'string' ? path.basename(v.replace(/\\/g, '/')) : '';
      if (!/^[\w.() -]{1,120}\.(webm|png|mp4|mov)$/i.test(name)) return null;
      const abs = path.join(folder, name);
      return (await fsp.stat(abs).catch(() => null))?.isFile() ? abs : null;
    };
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-visual-'));
    const one = async (abs: string | null, label: string): Promise<MediaRef | null> => {
      if (!abs) return null;
      const copy = path.join(tmp, path.basename(abs));
      await fsp.copyFile(abs, copy);
      const r = await importMedia(ws, { sourcePath: copy, scope: { kind: 'shared' }, display_name: `${label} ${path.basename(abs)}`.slice(0, 200), actor: 'user' });
      return { media_id: r.media.media_id, version_id: r.version.version_id };
    };
    try {
      const label = alat === 'hapus_latar' ? 'Tanpa latar' : 'Diperjelas';
      imp = { hasil: await one(await pick(report.file), label), masker: alat === 'hapus_latar' ? await one(await pick(report.masker), 'Masker') : null };
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!imp.hasil) throw new StorageError('PRECONDITION', 'Mesin selesai tanpa file hasil');
    await writeJsonAtomic(memo, imp);
  }
  const keep = ['status', 'model', 'lisensi', 'jenis', 'mode', 'skala', 'dari', 'jadi', 'fps', 'durasi', 'perkiraan_dtk'];
  return { job_id: jobId, alat: alat!, hasil: imp.hasil, masker: imp.masker, info: Object.fromEntries(keep.filter((k) => report[k] !== undefined).map((k) => [k, scrub(report[k])])), data: null };
}
