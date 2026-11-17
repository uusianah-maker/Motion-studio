/**
 * "Suara owner" (owner 16 Nov; KONTRAK-ENGINE §23, engine side by yuki). The app side:
 *  - keeps the list of voice samples the owner picked (`.motionstudio/suara-owner.json`; the media
 *    themselves stay ordinary Media, shared, so they can be played and reused);
 *  - validates a `suara_profil` engine job (one `$media:<media_id>` source per sample; `latih`
 *    false = check the samples only, true = train);
 *  - reads the finished job's report and imports the example takes into Media (first read only),
 *    so the team can play them.
 * The engine writes only inside its job folder; nothing here trusts a path from it.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type EngineJobInput, engineJobDir, readEngineStatus } from './engine.js';
import { StorageError } from './errors.js';
import { isSafeId } from './ids.js';
import { writeJsonAtomic } from './jsonStore.js';
import type { MediaRef } from './project.js';
import { importMedia, loadRegistry } from './registry.js';
import { LAYOUT, type Workspace } from './workspace.js';

/** Contract §23: target 10–15 min of clean speech, at least 5 min to train. */
export const SUARA_OWNER = { profil: 'owner', nama: 'Suara owner', target_dtk: [600, 900] as const, minimal_dtk: 300, maks_contoh: 200, maks_kalimat: 3 };

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const KUNCI = /^\$media:([A-Za-z0-9_-]{1,64})$/;
export const sampleKey = (mediaId: string) => `$media:${mediaId}`;

// ------------------------------------------------------------------ the sample list

export interface SuaraOwnerList {
  schema: 'suara-owner/1';
  contoh: MediaRef[];
  /** Keys taken off the list since the last job: sent once as `hapus_contoh`, then cleared. */
  dihapus: string[];
}
const listFile = (ws: Workspace) => path.join(ws.root, LAYOUT.meta, 'suara-owner.json');
const isRef = (r: unknown): r is MediaRef => !!r && typeof r === 'object' && isSafeId((r as MediaRef).media_id) && isSafeId((r as MediaRef).version_id);

export async function readSuaraOwner(ws: Workspace): Promise<SuaraOwnerList> {
  const raw = JSON.parse(await fsp.readFile(listFile(ws), 'utf8').catch(() => 'null')) as Partial<SuaraOwnerList> | null;
  return {
    schema: 'suara-owner/1',
    contoh: Array.isArray(raw?.contoh) ? raw.contoh.filter(isRef).slice(0, SUARA_OWNER.maks_contoh) : [],
    dihapus: Array.isArray(raw?.dihapus) ? raw.dihapus.filter((k): k is string => typeof k === 'string' && KUNCI.test(k)).slice(0, SUARA_OWNER.maks_contoh) : [],
  };
}

/** Add samples (active media versions only; the same media twice is kept once). */
export async function addSuaraOwner(ws: Workspace, refs: unknown): Promise<SuaraOwnerList> {
  if (!Array.isArray(refs) || !refs.length || refs.length > 50) bad('contoh: 1–50 media');
  const reg = await loadRegistry(ws);
  const list = await readSuaraOwner(ws);
  for (const r of refs as unknown[]) {
    if (!isRef(r)) bad('contoh tidak valid');
    const v = reg.versions[(r as MediaRef).version_id];
    if (!v || v.media_id !== (r as MediaRef).media_id || v.lifecycle !== 'active') bad('Media contoh tidak aktif (di Trash atau tidak dikenal)');
    // Owner 17 Nov: "pakai audio aja, jangan pakai video" — samples are sound files only.
    if (v!.probe?.video_codec) bad(`${v!.original_name}: ini video. Contoh Suara owner harus file suara (rekaman HP: m4a/mp3/wav)`);
    if (!v!.probe?.audio_codec) bad(`${v!.original_name}: tidak ada suaranya`);
    const ref = { media_id: (r as MediaRef).media_id, version_id: (r as MediaRef).version_id };
    list.contoh = [...list.contoh.filter((c) => c.media_id !== ref.media_id), ref];
    list.dihapus = list.dihapus.filter((k) => k !== sampleKey(ref.media_id));
  }
  if (list.contoh.length > SUARA_OWNER.maks_contoh) bad(`Maksimal ${SUARA_OWNER.maks_contoh} contoh`);
  await fsp.mkdir(path.dirname(listFile(ws)), { recursive: true });
  await writeJsonAtomic(listFile(ws), list);
  return list;
}

/** Take a sample off the list (the media stays in Media); the engine forgets it on the next job. */
export async function removeSuaraOwner(ws: Workspace, mediaId: string): Promise<SuaraOwnerList> {
  if (!isSafeId(mediaId)) bad('media tidak valid');
  const list = await readSuaraOwner(ws);
  if (!list.contoh.some((c) => c.media_id === mediaId)) return list;
  list.contoh = list.contoh.filter((c) => c.media_id !== mediaId);
  list.dihapus = [...new Set([...list.dihapus, sampleKey(mediaId)])];
  await writeJsonAtomic(listFile(ws), list);
  return list;
}

/** After a job was prepared: the removals it carried are delivered. */
export async function clearSuaraOwnerRemovals(ws: Workspace, sent: readonly string[]): Promise<void> {
  const list = await readSuaraOwner(ws);
  if (!list.dihapus.length) return;
  list.dihapus = list.dihapus.filter((k) => !sent.includes(k));
  await writeJsonAtomic(listFile(ws), list);
}

// ------------------------------------------------------------------ the job

export interface SuaraProfilSettings {
  profil: 'owner';
  nama: string;
  tambah_contoh: string[];
  hapus_contoh?: string[];
  latih: boolean;
  contoh_kalimat?: string[];
}

/** Browser request → engine input (untrusted): `{project_id, mode, sources, suara_profil:{latih, hapus_contoh?, contoh_kalimat?}}`. */
export function validateSuaraProfilJob(o: Record<string, unknown>): EngineJobInput {
  const extra = Object.keys(o).filter((k) => !['project_id', 'mode', 'sources', 'suara_profil'].includes(k));
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!isSafeId(o.project_id)) bad('project_id tidak valid');
  const s = (o.suara_profil ?? {}) as Record<string, unknown>;
  const se = Object.keys(s).filter((k) => !['latih', 'hapus_contoh', 'contoh_kalimat'].includes(k));
  if (se.length) bad(`suara_profil: field tidak dikenal ${se.join(', ')}`);
  if (typeof s.latih !== 'boolean') bad('suara_profil.latih harus true/false');
  if (!Array.isArray(o.sources) || o.sources.length > SUARA_OWNER.maks_contoh) bad(`contoh maksimal ${SUARA_OWNER.maks_contoh}`);
  const sources = (o.sources as unknown[]).map((x, i) => {
    const so = (x ?? {}) as Record<string, unknown>;
    const m = typeof so.kunci === 'string' ? KUNCI.exec(so.kunci) : null;
    if (!m || !isRef(so.ref) || (so.ref as MediaRef).media_id !== m[1]) bad(`sources[${i}]: kunci harus $media:<media_id> dari ref`);
    return { kunci: so.kunci as string, ref: { media_id: (so.ref as MediaRef).media_id, version_id: (so.ref as MediaRef).version_id } };
  });
  if (new Set(sources.map((x) => x.kunci)).size !== sources.length) bad('contoh ganda');
  const hapus = s.hapus_contoh === undefined ? [] : Array.isArray(s.hapus_contoh) && s.hapus_contoh.length <= SUARA_OWNER.maks_contoh && s.hapus_contoh.every((k) => typeof k === 'string' && KUNCI.test(k)) ? (s.hapus_contoh as string[]) : bad('hapus_contoh harus daftar $media:<id>');
  if (!sources.length && !hapus.length) bad('Tambahkan contoh suara dulu');
  if (s.latih && !sources.length) bad('Melatih butuh contoh suara');
  const kalimat = s.contoh_kalimat === undefined ? undefined : Array.isArray(s.contoh_kalimat) && s.contoh_kalimat.length <= SUARA_OWNER.maks_kalimat && s.contoh_kalimat.every((k) => typeof k === 'string' && k.trim() && k.length <= 300) ? (s.contoh_kalimat as string[]).map((k) => k.trim()) : bad(`contoh_kalimat: maks ${SUARA_OWNER.maks_kalimat} kalimat, 300 huruf`);
  return {
    project_id: o.project_id as string,
    mode: 'suara_profil',
    sources,
    preset: 'suara_profil',
    brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' },
    ai: false,
    suara_profil: {
      profil: 'owner',
      nama: SUARA_OWNER.nama,
      tambah_contoh: sources.map((x) => x.kunci),
      ...(hapus.length ? { hapus_contoh: [...new Set(hapus)] } : {}),
      latih: s.latih as boolean,
      ...(kalimat?.length ? { contoh_kalimat: kalimat } : {}),
    },
  };
}

// ------------------------------------------------------------------ the report

export interface SuaraContohView {
  kunci: string | null;
  media_id: string | null;
  durasi: number;
  durasi_bersih: number;
  snr_db: number | null;
  musik: boolean;
  clipping: boolean;
  dipakai: boolean;
  alasan: string;
}
export interface SuaraProfilView {
  job_id: string;
  /** `perlu_latih_ulang`: samples were removed after training (§23); train again. */
  status: 'siap' | 'kurang_contoh' | 'perlu_latih_ulang' | 'ditolak' | 'lain';
  alasan: string;
  contoh: SuaraContohView[];
  durasi_bersih_total: number;
  target_dtk: [number, number];
  minimal_dtk: number;
  backend: string;
  dilatih_pada: string | null;
  contoh_hasil: { teks: string; ref: MediaRef | null }[];
}
const sec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100 * 3600 ? Math.round(v * 10) / 10 : 0);
const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>').slice(0, max) : '');

/** The finished job's report; the example takes are imported into Media on the first read. */
export async function readSuaraProfilResult(ws: Workspace, projectId: string, jobId: string): Promise<SuaraProfilView> {
  const st = await readEngineStatus(ws, projectId, jobId);
  if (st.mode !== 'suara_profil') bad('Job ini bukan Suara owner');
  if (st.state !== 'siap' && st.state !== 'ditolak') throw new StorageError('PRECONDITION', 'Hasil mesin belum ada');
  const out = path.join(engineJobDir(ws, projectId, jobId), 'out');
  const raw = JSON.parse(await fsp.readFile(path.join(out, 'suara_profil.json'), 'utf8').catch(() => 'null')) as Record<string, unknown> | null;
  if (!raw) bad('suara_profil.json belum ada');
  const r = raw as Record<string, unknown>;
  const examples = (Array.isArray(r.contoh_hasil) ? (r.contoh_hasil as Record<string, unknown>[]) : []).slice(0, 5);
  const importedFile = path.join(out, 'impor.json');
  let imp = JSON.parse(await fsp.readFile(importedFile, 'utf8').catch(() => 'null')) as (MediaRef | null)[] | null;
  if (!imp) {
    imp = [];
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-suara-'));
    try {
      for (const [i, e] of examples.entries()) {
        // Only plain file names inside out/contoh/ (never a path from the engine).
        const name = typeof e.file === 'string' ? path.basename(e.file.replace(/\\/g, '/')) : '';
        const abs = /^[A-Za-z0-9_-]{1,40}\.(wav|mp3|m4a)$/.test(name) ? path.join(out, 'contoh', name) : null;
        if (!abs || !(await fsp.stat(abs).catch(() => null))?.isFile()) {
          imp.push(null);
          continue;
        }
        const copy = path.join(tmp, name);
        await fsp.copyFile(abs, copy);
        const m = await importMedia(ws, { sourcePath: copy, scope: { kind: 'shared' }, display_name: `Suara owner ${jobId} contoh ${String(i + 1).padStart(2, '0')}${path.extname(name)}`, actor: 'user' });
        imp.push({ media_id: m.media.media_id, version_id: m.version.version_id });
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    await writeJsonAtomic(importedFile, imp);
  }
  const status = r.status === 'siap' || r.status === 'kurang_contoh' || r.status === 'perlu_latih_ulang' || r.status === 'ditolak' ? r.status : 'lain';
  const target = Array.isArray(r.target_dtk) && r.target_dtk.length === 2 ? ([sec(r.target_dtk[0]), sec(r.target_dtk[1])] as [number, number]) : ([...SUARA_OWNER.target_dtk] as [number, number]);
  return {
    job_id: jobId,
    status,
    alasan: txt(r.alasan, 300),
    contoh: (Array.isArray(r.contoh) ? (r.contoh as Record<string, unknown>[]) : []).slice(0, SUARA_OWNER.maks_contoh).map((c) => {
      const k = typeof c.kunci === 'string' && KUNCI.test(c.kunci) ? c.kunci : null;
      return {
        kunci: k,
        media_id: k ? KUNCI.exec(k)![1]! : null,
        durasi: sec(c.durasi),
        durasi_bersih: sec(c.durasi_bersih),
        snr_db: typeof c.snr_db === 'number' && Number.isFinite(c.snr_db) ? Math.round(c.snr_db * 10) / 10 : null,
        musik: c.musik === true,
        clipping: c.clipping === true,
        dipakai: c.dipakai !== false,
        alasan: txt(c.alasan, 200),
      };
    }),
    durasi_bersih_total: sec(r.durasi_bersih_total),
    target_dtk: target,
    minimal_dtk: sec(r.minimal_dtk) || SUARA_OWNER.minimal_dtk,
    backend: txt(r.backend, 40),
    dilatih_pada: typeof r.dilatih_pada === 'string' ? r.dilatih_pada.slice(0, 40) : null,
    contoh_hasil: examples.map((e, i) => ({ teks: txt(e.teks, 300), ref: imp![i] ?? null })),
  };
}
