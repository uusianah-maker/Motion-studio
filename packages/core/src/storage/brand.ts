import { promises as fsp } from 'node:fs';
import { audit } from './audit.js';
import { StorageError } from './errors.js';
import { guard } from './guard.js';
import { isSafeId } from './ids.js';
import { type BrandGuard, EMPTY_GUARD, validateGuard } from './brandGuard.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { probeImage } from './probe.js';
import { type Actor, MEDIA_AREAS } from './permissions.js';
import type { MediaRef, Timeline } from './project.js';
import { type Registry, type VersionRecord, loadRegistry, saveRegistry } from './registry.js';
import { META_FILES, type Workspace, metaPath, withWorkspaceLock } from './workspace.js';

/**
 * Brand Kit (X06, PRD §7 "Brand kit with fonts/colors/logo"): one per workspace. Colours feed the
 * presets, inspector swatches and Copilot ("pakai warna brand"); the font is used by text clips
 * whose style says `font: 'brand'`; the logo is burned in on projects that switch it on.
 * Font and logo are ordinary imported media versions: the Brand Kit holds them (dependency
 * index), so they are never moved to Trash while in use, and renders lease + re-verify them.
 */

export const LOGO_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export type LogoCorner = (typeof LOGO_CORNERS)[number];
export const LOGO_LIMITS = { size: [5, 40] as const, opacity: [0.1, 1] as const };
export const MAX_BRAND_COLORS = 6;
const LOGO_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const FONT_EXT = ['.ttf', '.otf'];

export interface BrandLogo {
  ref: MediaRef;
  corner: LogoCorner;
  /** Logo width as % of the canvas width. */
  size: number;
  opacity: number;
}

export interface BrandKit {
  schema_version: 1;
  revision: number;
  updated_at: number;
  name: string;
  /** Brand colours, most important first (`colors[0]` = main colour). */
  colors: string[];
  /** Text colour that reads well on the main colour. */
  text_color: string;
  font: MediaRef | null;
  logo: BrandLogo | null;
  /** X08: promo prices with an end date + banned claims, checked before every render. */
  guard: BrandGuard;
}

export type BrandKitInput = Pick<BrandKit, 'name' | 'colors' | 'text_color' | 'font' | 'logo' | 'guard'>;

export const EMPTY_BRAND: BrandKit = { schema_version: 1, revision: 0, updated_at: 0, name: 'Brand', colors: [], text_color: '#ffffff', font: null, logo: null, guard: EMPTY_GUARD };

const HEX = /^#[0-9a-f]{6}$/;
const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', `Brand Kit: ${msg}`);
};
const ext = (name: string) => (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '').toLowerCase();

function ref(x: unknown, where: string): MediaRef {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad(`${where} harus referensi media`);
  const extra = Object.keys(o).filter((k) => k !== 'media_id' && k !== 'version_id');
  if (extra.length || !isSafeId(o.media_id) || !isSafeId(o.version_id)) bad(`${where} tidak valid`);
  return { media_id: o.media_id as string, version_id: o.version_id as string };
}

/** Shape check for the editable part (HTTP body or stored file). */
export function validateBrandInput(raw: unknown): BrandKitInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('harus objek');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['name', 'colors', 'text_color', 'font', 'logo', 'guard'].includes(k));
  if (extra.length) bad(`field tidak dikenal ${extra.join(', ')}`);
  const name = typeof o.name === 'string' ? [...o.name].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').trim() : '';
  if (!name || name.length > 60) bad('nama 1–60 karakter');
  if (!Array.isArray(o.colors) || o.colors.length > MAX_BRAND_COLORS) bad(`warna maksimal ${MAX_BRAND_COLORS}`);
  const colors = (o.colors as unknown[]).map((c, i) => (typeof c === 'string' && HEX.test(c.toLowerCase()) ? c.toLowerCase() : bad(`warna ${i + 1} harus #rrggbb`)));
  if (new Set(colors).size !== colors.length) bad('warna tidak boleh dobel');
  if (typeof o.text_color !== 'string' || !HEX.test(o.text_color.toLowerCase())) bad('warna teks harus #rrggbb');
  const font = o.font === null || o.font === undefined ? null : ref(o.font, 'font');
  let logo: BrandLogo | null = null;
  if (o.logo !== null && o.logo !== undefined) {
    const l = o.logo as Record<string, unknown>;
    if (typeof l !== 'object' || Array.isArray(l)) bad('logo harus objek');
    const lx = Object.keys(l).filter((k) => !['ref', 'corner', 'size', 'opacity'].includes(k));
    if (lx.length) bad(`logo: field tidak dikenal ${lx.join(', ')}`);
    if (!LOGO_CORNERS.includes(l.corner as LogoCorner)) bad('posisi logo harus tl | tr | bl | br');
    const num = (v: unknown, [min, max]: readonly [number, number], what: string) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : bad(`${what} harus ${min}–${max}`));
    logo = { ref: ref(l.ref, 'logo'), corner: l.corner as LogoCorner, size: num(l.size, LOGO_LIMITS.size, 'ukuran logo'), opacity: num(l.opacity, LOGO_LIMITS.opacity, 'opasitas logo') };
  }
  // A kit saved before X08 has no guard: same as an empty one.
  return { name, colors, text_color: (o.text_color as string).toLowerCase(), font, logo, guard: validateGuard(o.guard) };
}

function validateStored(x: unknown): BrandKit {
  const o = x as Record<string, unknown>;
  if (!o || o.schema_version !== 1 || !Number.isSafeInteger(o.revision) || typeof o.updated_at !== 'number') throw new StorageError('WORKSPACE_INVALID', 'brand_kit.json tidak valid');
  try {
    const { schema_version: _s, revision, updated_at, ...rest } = o;
    void _s;
    return { schema_version: 1, revision: revision as number, updated_at: updated_at as number, ...validateBrandInput(rest) };
  } catch (e) {
    throw new StorageError('WORKSPACE_INVALID', `brand_kit.json tidak valid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The workspace Brand Kit; an empty kit (revision 0) when none was saved yet. */
export async function readBrandKit(ws: Workspace): Promise<BrandKit> {
  const file = metaPath(ws, META_FILES.brand);
  try {
    await fsp.access(file);
  } catch {
    return { ...EMPTY_BRAND };
  }
  return readJson(file, validateStored);
}

/** Media versions the kit holds (for the dependency index). */
export const brandReferences = (k: BrandKit): { slot: 'font' | 'logo'; ref: MediaRef }[] => [
  ...(k.font ? [{ slot: 'font' as const, ref: k.font }] : []),
  ...(k.logo ? [{ slot: 'logo' as const, ref: k.logo.ref }] : []),
];

function usable(reg: Registry, r: MediaRef, what: string): VersionRecord {
  const v = reg.versions[r.version_id];
  if (!v || v.media_id !== r.media_id) throw new StorageError('PRECONDITION', `${what}: media tidak dikenal`);
  if (v.lifecycle !== 'active') throw new StorageError('PRECONDITION', `${what}: media sedang ${v.lifecycle}; pulihkan dulu`);
  if (v.integrity !== 'ok') throw new StorageError('INTEGRITY', `${what}: media ${v.integrity}, perlu verifikasi`);
  return v;
}

/** TrueType / OpenType magic: 00 01 00 00, "OTTO" or "true". */
const isFontMagic = (b: Buffer) => b.length >= 4 && (b.readUInt32BE(0) === 0x00010000 || b.toString('latin1', 0, 4) === 'OTTO' || b.toString('latin1', 0, 4) === 'true');

async function head(ws: Workspace, v: VersionRecord): Promise<Buffer> {
  const rel = await ws.blobs.resolve(v.rel_path, MEDIA_AREAS);
  const s = await ws.blobs.readStream(rel, { start: 0, end: 3 });
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Save the kit (user only, optimistic revision). Font/logo must be usable files of the right kind. */
export async function setBrandKit(ws: Workspace, input: { expected_revision: number; kit: unknown; actor: Actor }): Promise<BrandKit> {
  await guard(ws, input.actor, 'commit_project', { step: 'brand_kit' });
  const kit = validateBrandInput(input.kit);
  return withWorkspaceLock(ws, 'setBrandKit', async () => {
    const current = await readBrandKit(ws);
    if (current.revision !== input.expected_revision) throw new StorageError('CONFLICT', 'Brand Kit sudah berubah; muat ulang dulu', { expected: input.expected_revision, actual: current.revision });
    const reg = await loadRegistry(ws);
    if (kit.font) {
      const v = usable(reg, kit.font, 'Font brand');
      if (!FONT_EXT.includes(ext(v.original_name)) || !isFontMagic(await head(ws, v))) bad('font harus file .ttf atau .otf');
    }
    if (kit.logo) {
      const v = usable(reg, kit.logo.ref, 'Logo');
      const img = LOGO_EXT.includes(ext(v.original_name)) ? await ws.blobs.withLocalFile(await ws.blobs.resolve(v.rel_path, MEDIA_AREAS), probeImage) : null;
      if (!img) bad('logo harus gambar PNG/JPG/WebP yang bisa dibaca (maks 8192 px)');
    }
    const saved: BrandKit = { schema_version: 1, revision: current.revision + 1, updated_at: ws.clock.now(), ...kit };
    await writeJsonAtomic(metaPath(ws, META_FILES.brand), saved);
    for (const { ref: r } of brandReferences(saved)) {
      const v = reg.versions[r.version_id]!;
      v.ever_referenced = true;
      v.unreferenced_since = null;
    }
    await saveRegistry(ws, reg);
    await audit(ws, { op: 'brand.save', actor: input.actor, outcome: 'ok', revision: saved.revision, colors: saved.colors.length, font: saved.font?.version_id ?? null, logo: saved.logo?.ref.version_id ?? null });
    return saved;
  });
}

/** Media a render of `t` needs from the kit: the logo when switched on, the font when a text uses it. */
export function brandRenderRefs(t: Timeline, k: BrandKit): { font: MediaRef | null; logo: BrandLogo | null } {
  const usesFont = t.tracks.some((tr) => (tr.kind === 'text' || tr.kind === 'subtitle') && tr.clips.some((c) => c.text?.trim() && c.style?.font === 'brand'));
  return { font: usesFont ? k.font : null, logo: t.brand_logo && k.logo ? k.logo : null };
}
