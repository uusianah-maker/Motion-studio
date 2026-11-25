/**
 * Katalog Produk per brand (Beat Spot tahap 2 "Ganti Outfit", KONTRAK-ENGINE §29, owner 25 Nov 2026).
 *
 * Satu produk = satu jenis (atasan / bawahan) + daftar warna, tiap warna satu foto katalog (media
 * bersama, sama seperti aset Brand Kit). Foto ini dipakai dua kali: sebagai acuan gambar AI dan,
 * apa adanya, di end card (detail produk 100 % asli). Tim mengimpor folder katalog (1 subfolder =
 * 1 produk, 1 file = 1 warna) dan memberi nama warna di sini, jadi nama file asli tidak harus rapi.
 *
 * File: `.motionstudio/katalog/<brand_id>.json`. Foto yang dirujuk ikut dilindungi dari Auto Trash
 * (indeks dependensi, holder `brand` slot `katalog`).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from './errors.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { isSafeId } from './ids.js';
import type { MediaRef } from './project.js';
import { loadRegistry } from './registry.js';
import { LAYOUT, type Workspace, withWorkspaceLock } from './workspace.js';

export const KATALOG_JENIS = ['atasan', 'bawahan'] as const;
export type KatalogJenis = (typeof KATALOG_JENIS)[number];
export const KATALOG_LIMITS = { produk: 60, warna: 40, nama: 80, deskripsi: 300 } as const;

export interface KatalogWarna {
  id: string;
  nama: string;
  ref: MediaRef;
}
export interface KatalogProduk {
  id: string;
  nama: string;
  jenis: KatalogJenis;
  /** Opsional: bahan / potongan / detail yang membantu AI (mis. "kemeja garis tipis berdasi"). */
  deskripsi: string;
  warna: KatalogWarna[];
}
export interface Katalog {
  schema: 'katalog-produk/1';
  brand_id: string;
  revision: number;
  updated_at: number;
  produk: KatalogProduk[];
}

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const dir = (ws: Workspace) => path.join(ws.root, LAYOUT.meta, 'katalog');
const file = (ws: Workspace, brandId: string) => path.join(dir(ws), `${brandId}.json`);

/** Nama bebas → id aman (huruf kecil, angka, - _), unik di dalam `used`. */
export function katalogId(nama: string, used: Set<string>): string {
  const base = (nama.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item').slice(0, 36);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

const teks = (v: unknown, what: string, max: number, wajib = true): string => {
  if (v === undefined || v === null) return wajib ? bad(`${what} wajib diisi`) : '';
  if (typeof v !== 'string') bad(`${what} harus teks`);
  const s = [...(v as string)].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').trim(); // control characters → space
  if (wajib && !s) bad(`${what} wajib diisi`);
  if (s.length > max) bad(`${what} maksimal ${max} huruf`);
  return s;
};

/** Isi katalog dari browser (tidak dipercaya). */
export function validateKatalogInput(x: unknown): KatalogProduk[] {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('katalog harus objek');
  const extra = Object.keys(o).filter((k) => k !== 'produk');
  if (extra.length) bad(`field tidak dikenal: ${extra.join(', ')}`);
  if (!Array.isArray(o.produk) || o.produk.length > KATALOG_LIMITS.produk) bad(`produk harus daftar (maks ${KATALOG_LIMITS.produk})`);
  const ids = new Set<string>();
  return (o.produk as unknown[]).map((p, i) => {
    const po = (p ?? {}) as Record<string, unknown>;
    const ex = Object.keys(po).filter((k) => !['id', 'nama', 'jenis', 'deskripsi', 'warna'].includes(k));
    if (ex.length) bad(`produk[${i}]: field tidak dikenal ${ex.join(', ')}`);
    const nama = teks(po.nama, `produk[${i}].nama`, KATALOG_LIMITS.nama);
    const id = po.id === undefined || po.id === '' ? katalogId(nama, ids) : typeof po.id === 'string' && ID.test(po.id) && !ids.has(po.id) ? (ids.add(po.id), po.id) : bad(`produk[${i}].id tidak valid atau kembar`);
    if (!KATALOG_JENIS.includes(po.jenis as KatalogJenis)) bad(`produk "${nama}": jenis harus atasan atau bawahan`);
    if (!Array.isArray(po.warna) || po.warna.length < 1 || po.warna.length > KATALOG_LIMITS.warna) bad(`produk "${nama}": 1–${KATALOG_LIMITS.warna} warna`);
    const wid = new Set<string>();
    const warna = (po.warna as unknown[]).map((w, j) => {
      const wo = (w ?? {}) as Record<string, unknown>;
      const wx = Object.keys(wo).filter((k) => !['id', 'nama', 'ref'].includes(k));
      if (wx.length) bad(`produk "${nama}" warna[${j}]: field tidak dikenal ${wx.join(', ')}`);
      const wn = teks(wo.nama, `produk "${nama}" warna[${j}].nama`, KATALOG_LIMITS.nama);
      const r = (wo.ref ?? {}) as Record<string, unknown>;
      if (!isSafeId(r.media_id) || !isSafeId(r.version_id)) bad(`produk "${nama}" warna "${wn}": foto tidak valid`);
      const w_id = wo.id === undefined || wo.id === '' ? katalogId(wn, wid) : typeof wo.id === 'string' && ID.test(wo.id) && !wid.has(wo.id) ? (wid.add(wo.id), wo.id) : bad(`produk "${nama}" warna[${j}].id tidak valid atau kembar`);
      return { id: w_id, nama: wn, ref: { media_id: r.media_id as string, version_id: r.version_id as string } };
    });
    return { id, nama, jenis: po.jenis as KatalogJenis, deskripsi: teks(po.deskripsi, `produk "${nama}".deskripsi`, KATALOG_LIMITS.deskripsi, false), warna };
  });
}

function validateStored(x: unknown): Katalog {
  const o = (x ?? {}) as Record<string, unknown>;
  if (o.schema !== 'katalog-produk/1' || !isSafeId(o.brand_id) || !Number.isSafeInteger(o.revision) || typeof o.updated_at !== 'number') throw new StorageError('WORKSPACE_INVALID', 'file katalog tidak valid');
  return { schema: 'katalog-produk/1', brand_id: o.brand_id as string, revision: o.revision as number, updated_at: o.updated_at as number, produk: validateKatalogInput({ produk: o.produk }) };
}

export async function readKatalog(ws: Workspace, brandId: string): Promise<Katalog> {
  if (!isSafeId(brandId)) bad('brand_id tidak valid');
  try {
    await fsp.stat(file(ws, brandId));
  } catch {
    return { schema: 'katalog-produk/1', brand_id: brandId, revision: 0, updated_at: 0, produk: [] };
  }
  return readJson(file(ws, brandId), validateStored);
}

/** Simpan seluruh katalog satu brand (optimistic lock lewat `expected_revision`). */
export async function saveKatalog(ws: Workspace, brandId: string, input: unknown, expectedRevision: unknown): Promise<Katalog> {
  const produk = validateKatalogInput(input);
  return withWorkspaceLock(ws, 'katalog.save', async () => {
    const cur = await readKatalog(ws, brandId);
    if (expectedRevision !== cur.revision) throw new StorageError('CONFLICT', 'Katalog sudah diubah orang lain; muat ulang dulu', { revision: cur.revision });
    const reg = await loadRegistry(ws);
    for (const p of produk)
      for (const w of p.warna) {
        const v = reg.versions[w.ref.version_id];
        if (!v || v.media_id !== w.ref.media_id || v.lifecycle !== 'active') bad(`Foto ${p.nama} ${w.nama} tidak dikenal atau di Trash`);
        const m = reg.media[w.ref.media_id];
        if (m && m.scope.kind !== 'shared') bad(`Foto ${p.nama} ${w.nama} harus media bersama (unggah lewat Katalog)`);
      }
    const next: Katalog = { schema: 'katalog-produk/1', brand_id: brandId, revision: cur.revision + 1, updated_at: ws.clock.now(), produk };
    await fsp.mkdir(dir(ws), { recursive: true });
    await writeJsonAtomic(file(ws, brandId), next);
    return next;
  });
}

/** Semua file katalog (untuk sidik indeks dependensi). */
export async function katalogFiles(ws: Workspace): Promise<string[]> {
  const names = await fsp.readdir(dir(ws)).catch(() => [] as string[]);
  return names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n)).sort().map((n) => path.join(dir(ws), n));
}

/** Foto yang dirujuk semua katalog (holder Auto Trash). */
export async function katalogReferences(ws: Workspace): Promise<{ brand_id: string; ref: MediaRef; detail: string }[]> {
  const out: { brand_id: string; ref: MediaRef; detail: string }[] = [];
  for (const f of await katalogFiles(ws)) {
    const k = await readJson(f, validateStored);
    for (const p of k.produk) for (const w of p.warna) out.push({ brand_id: k.brand_id, ref: w.ref, detail: `${p.nama} ${w.nama}` });
  }
  return out;
}

/** Katalog untuk mesin (`katalog.json` di folder job, schema katalog-produk/1, dengan path lokal foto). */
export async function katalogUntukMesin(ws: Workspace, brandId: string, localPath: (ref: MediaRef) => Promise<string>) {
  const k = await readKatalog(ws, brandId);
  const produk = [];
  for (const p of k.produk) {
    const warna = [];
    for (const w of p.warna) warna.push({ id: w.id, nama: w.nama, path: (await localPath(w.ref)).replace(/\\/g, '/') });
    produk.push({ id: p.id, nama: p.nama, jenis: p.jenis, deskripsi: p.deskripsi, warna });
  }
  return { schema: 'katalog-produk/1', brand_id: brandId, revision: k.revision, produk };
}
