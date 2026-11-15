import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Api, BrandKit, BrandKitInput, BrandPreset, Media, Platform, Ref } from '../api';
import { BRAND_CAPTION_FAMILY, BRAND_FONT_FAMILY, emptyKit, toInput, useBrand } from '../brand';
import { PresetGaya } from './PresetGaya';
import { nextPresetId } from '../lib';
import { ErrorNotice } from '../ui';
import { LOOKS, LOOK_IDS } from '../../../../packages/core/dist/storage/clipLook.js';
import { AssetLibrary } from './AssetLibrary';

const FONT_RE = /\.(ttf|otf)$/i;
const LOGO_RE = /\.(png|jpe?g|webp)$/i;
const OUTRO_RE = /\.(mp4|mov|webm|png|jpe?g|webp)$/i;
const MAX_COLORS = 6;
const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'shopee', label: 'Shopee' },
  { id: 'youtube', label: 'YouTube' },
];
const CORNERS = [
  { id: 'tl', label: 'Kiri atas' },
  { id: 'tr', label: 'Kanan atas' },
  { id: 'bl', label: 'Kiri bawah' },
  { id: 'br', label: 'Kanan bawah' },
] as const;
const AREAS = [
  { id: 'wajah', label: 'Wajah' },
  { id: 'produk', label: 'Produk' },
  { id: 'bawah_15', label: '15% bawah' },
  { id: 'atas_10', label: '10% atas' },
  { id: 'kanan_tombol', label: 'Sisi kanan (tombol)' },
] as const;
const RATIOS = ['9:16', '3:4', '1:1', '16:9', 'cover'];
const current = (m: Media) => m.versions.find((v) => v.version_id === m.current_version_id);
const usable = (m: Media, re: RegExp) => {
  const v = current(m);
  return !!v && v.lifecycle === 'active' && v.integrity === 'ok' && re.test(v.original_name);
};
const refOf = (m: Media): Ref => ({ media_id: m.media_id, version_id: m.current_version_id });
const csv = (a: string[]) => a.join(', ');
const fromCsv = (s: string) => s.split(',').map((x) => x.trimStart());
const lines = (a: string[]) => a.join('\n');
const fromLines = (s: string) => s.split('\n');
const clean = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const newPreset = (id: string): BrandPreset => ({
  id,
  nama: 'Konversi',
  tujuan: '',
  placement: ['tiktok'],
  durasi: { min: 15, target: 20, max: 30 },
  turunan: ['9:16'],
  babak: [],
  ritme: '',
  caption: { mode: 'per_kata', maks_kata: 3, pop_ms: 100 },
  hook: { teks: true, maks_kata: 6, dari_ucapan: true },
  efek: { wajib: [], boleh: [], jangan: [], maks: 3, jarak_dtk: 4 },
  audio: { suara_asli: true, sfx: '', musik: '', lufs: -14 },
  qc: [],
});

/** Trim lists, drop empty rows: what the server receives. */
function cleaned(d: BrandKitInput): BrandKitInput {
  return {
    ...d,
    kode: d.kode.trim().toUpperCase(),
    nada: clean(d.nada),
    produk: d.produk.filter((p) => p.nama.trim()).map((p) => ({ ...p, varian: clean(p.varian) })),
    warna_dilarang: clean(d.warna_dilarang),
    kosakata: clean(d.kosakata),
    kamus: d.kamus.filter((k) => k.salah.trim() && k.benar.trim()),
    kata_kunci: clean(d.kata_kunci),
    disclaimer: d.disclaimer && d.disclaimer.teks.trim() ? d.disclaimer : null,
    tagline: d.tagline.trim(),
    watermark: d.watermark && d.watermark.teks.trim() ? d.watermark : null,
    guard: { ...d.guard, banned: clean(d.guard.banned) },
    klaim_boleh: clean(d.klaim_boleh),
    visual_dilarang: clean(d.visual_dilarang),
    aset: d.aset.map((a) => ({ ...a, tag: clean(a.tag) })),
    sfx_dilarang: clean(d.sfx_dilarang),
    referensi: d.referensi.filter((r) => r.link.trim()),
    presets: d.presets.map((p) => ({ ...p, babak: p.babak.filter((b) => b.isi.trim()), efek: { ...p.efek, wajib: clean(p.efek.wajib), boleh: clean(p.efek.boleh), jangan: clean(p.efek.jangan) }, qc: clean(p.qc) })),
  };
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="brandSection" id={`brand-${id}`}>
      <legend>
        <b>{title}</b> {hint && <span className="muted small">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * Brand Kits (X06 → U1, PC-16): one kit per brand, chosen per project. The sheet follows the team's
 * Brand Kit A–F (identity, visual, text, rules, assets → U2, presets). Files (fonts, logo, outro)
 * are uploaded like any media and stay on this PC. "Ekspor JSON" shows what the automation engine
 * receives (`brand-kit-export/1`, without local paths).
 */
/** U7: only the owner changes Brand Kits (`readOnly` for editors & reviewers; the server refuses too). */
export function BrandView({ api, readOnly = false }: { api: Api; readOnly?: boolean }) {
  const [brands, setBrands] = useState<BrandKit[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [draft, setDraft] = useState<BrandKitInput>(emptyKit());
  const [contoh, setContoh] = useState<string | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** R13: the "Duplikat brand" form (new name + optional code). */
  const [dup, setDup] = useState<{ name: string; kode: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const loaded = useBrand(api, { brandId: kit?.brand_id ?? null, reload });
  const fileRefs = { font: useRef<HTMLInputElement>(null), font_caption: useRef<HTMLInputElement>(null), logo: useRef<HTMLInputElement>(null), logo_light: useRef<HTMLInputElement>(null), outro: useRef<HTMLInputElement>(null) };

  const load = useCallback(
    async (pick?: string | 'new') => {
      try {
        const [r, m] = await Promise.all([api.brands(), api.media({ scope: 'shared' })]);
        setBrands(r.brands);
        setDefaultId(r.default_id);
        setMedia(m);
        const target = pick ?? (r.brands.length ? (r.default_id ?? r.brands[0]!.brand_id) : 'new');
        setSelected(target);
        const k = target === 'new' ? null : (r.brands.find((b) => b.brand_id === target) ?? null);
        setKit(k);
        setDraft(k ? toInput(k) : emptyKit());
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [api],
  );
  useEffect(() => void load(), [load]);
  // Audit 14 Nov: an upload finishing later must merge into the CURRENT draft of the SAME brand —
  // not overwrite edits made meanwhile, and never land in another brand picked meanwhile.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const later = useCallback(() => {
    const owner = selectedRef.current;
    return (fn: (d: BrandKitInput) => Partial<BrandKitInput>) => {
      if (selectedRef.current !== owner) return false;
      setDraft((d) => ({ ...d, ...fn(d) }));
      setSaved(false);
      return true;
    };
  }, []);

  if (!brands) return <div className="body">{error ? <ErrorNotice error={error} /> : <div className="sectionNote">Memuat Brand Kit…</div>}</div>;

  // Audit 14 Nov: switching brand never throws unsaved edits away without asking.
  const dirty = JSON.stringify(draft) !== JSON.stringify(kit ? toInput(kit) : emptyKit());
  const leaveOk = () => !dirty || window.confirm('Ada perubahan Brand Kit yang belum disimpan. Buang perubahan itu?');
  const set = (patch: Partial<BrandKitInput>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };
  const setPreset = (i: number, patch: Partial<BrandPreset>) => set({ presets: draft.presets.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const fonts = media.filter((m) => usable(m, FONT_RE));
  const logos = media.filter((m) => usable(m, LOGO_RE));
  const outros = media.filter((m) => usable(m, OUTRO_RE));

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File | undefined, slot: 'font' | 'font_caption' | 'logo' | 'logo_light' | 'outro') =>
    act(`up-${slot}`, async () => {
      if (!file) return;
      const input = fileRefs[slot].current;
      if (input) input.value = ''; // picking the same file again after a failure works too
      const re = slot.startsWith('font') ? FONT_RE : slot === 'outro' ? OUTRO_RE : LOGO_RE;
      if (!re.test(file.name)) throw new Error(slot.startsWith('font') ? 'Pilih file font .ttf atau .otf.' : slot === 'outro' ? 'Pilih video (MP4/MOV/WebM) atau gambar.' : 'Pilih gambar PNG, JPG atau WebP.');
      const apply = later();
      const r = await api.importFile(file, { kind: 'shared' });
      const ref = { media_id: r.media_id, version_id: r.version.version_id };
      setMedia(await api.media({ scope: 'shared' }));
      apply((d) =>
        slot === 'logo'
          ? { logo: { ref, corner: d.logo?.corner ?? 'tr', size: d.logo?.size ?? 18, opacity: d.logo?.opacity ?? 1, show: d.logo?.show ?? 'sepanjang' } }
          : slot === 'outro'
            ? { outro: { ...d.outro, ref } }
            : ({ [slot]: ref } as Partial<BrandKitInput>),
      );
    });

  const save = () =>
    act('save', async () => {
      const body = cleaned(draft);
      const k = selected === 'new' || !kit ? await api.createBrand(body) : await api.saveBrandById(kit.brand_id, kit.revision, body);
      await load(k.brand_id);
      setSaved(true);
      setReload((n) => n + 1);
    });

  const exportJson = () =>
    act('export', async () => {
      if (!kit) return;
      const data = await api.exportBrand(kit.brand_id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `brand_kit-${kit.kode}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  const fileSelect = (label: string, value: Ref | null, options: Media[], onPick: (r: Ref | null) => void, slot: keyof typeof fileRefs, accept: string, uploadLabel: string, fileLabel: string, none: string) => (
    <div className="row wrap" style={{ gap: 8 }}>
      <select aria-label={label} value={value?.version_id ?? ''} onChange={(e) => onPick(e.target.value ? refOf(options.find((m) => m.current_version_id === e.target.value)!) : null)}>
        <option value="">{none}</option>
        {options.map((m) => (
          <option key={m.media_id} value={m.current_version_id}>
            {m.display_name}
          </option>
        ))}
      </select>
      <button className="btn small" disabled={!!busy} onClick={() => fileRefs[slot].current?.click()}>
        {busy === `up-${slot}` ? 'Mengunggah…' : uploadLabel}
      </button>
      <input ref={fileRefs[slot]} type="file" hidden accept={accept} aria-label={fileLabel} onChange={(e) => void upload(e.target.files?.[0], slot)} />
    </div>
  );

  const main = draft.colors[0] ?? '#2a2f42';
  const corner = draft.logo?.corner ?? 'tr';
  const logoUrl = loaded?.kit.logo && draft.logo && loaded.kit.logo.ref.version_id === draft.logo.ref.version_id ? loaded.logoUrl : null;
  const fontLive = loaded?.fontReady && draft.font && loaded.kit.font?.version_id === draft.font.version_id;
  const capLive = loaded?.captionReady && draft.font_caption && loaded.kit.font_caption?.version_id === draft.font_caption.version_id;

  return (
    <>
      <header className="top">
        <h1>Brand Kit</h1>
        <span className="muted hideNarrow">Satu Brand Kit per brand. Proyek memilih brand-nya di menu ⋯ Proyek. File tetap di PC ini.</span>
      </header>
      <div className="body brandPage">
        {error ? <ErrorNotice error={error} /> : null}
        <nav className="brandList" aria-label="Daftar brand">
          {brands.map((b) => (
            <button key={b.brand_id} className={`chip${selected === b.brand_id ? ' on' : ''}`} aria-pressed={selected === b.brand_id} onClick={() => leaveOk() && void load(b.brand_id)}>
              <span className="swatch" style={{ background: b.colors[0] ?? '#2a2f42' }} aria-hidden="true" /> {b.kode} · {b.name}
              {b.brand_id === defaultId ? ' ★' : ''}
            </button>
          ))}
          {!readOnly && (
            <button className={`chip${selected === 'new' ? ' on' : ''}`} onClick={() => leaveOk() && void load('new')}>
              ＋ Brand baru
            </button>
          )}
        </nav>
        {readOnly && (
          <div className="notice info" role="status">
            Hanya Owner yang bisa mengubah Brand Kit. Anda bisa melihat isinya.
          </div>
        )}

        <fieldset className="plainFieldset" disabled={readOnly}>
        <div className="brandGrid">
          <section className="card brandForm" aria-label="Pengaturan Brand Kit">
            <Section id="a" title="A. Identitas brand">
              <div className="inspGrid">
                <label>
                  Nama brand
                  <input aria-label="Nama brand" maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                </label>
                <label>
                  Kode brand (2–5 huruf)
                  <input aria-label="Kode brand" maxLength={5} placeholder="otomatis dari nama" value={draft.kode} onChange={(e) => set({ kode: e.target.value.toUpperCase() })} />
                </label>
                {PLATFORMS.map((p) => (
                  <label key={p.id}>
                    Handle {p.label}
                    <input aria-label={`Handle ${p.label}`} maxLength={40} placeholder="@akun" value={draft.handles[p.id] ?? ''} onChange={(e) => set({ handles: { ...draft.handles, [p.id]: e.target.value } })} />
                  </label>
                ))}
              </div>
              <label>
                Target penonton
                <input aria-label="Target penonton" maxLength={200} value={draft.target} onChange={(e) => set({ target: e.target.value })} />
              </label>
              <div className="inspGrid">
                <label>
                  Nada bicara (pisah koma)
                  <input aria-label="Nada bicara" value={csv(draft.nada)} onChange={(e) => set({ nada: fromCsv(e.target.value) })} />
                </label>
                <label>
                  Bahasa teks
                  <select aria-label="Bahasa teks" value={draft.bahasa} onChange={(e) => set({ bahasa: e.target.value as BrandKitInput['bahasa'] })}>
                    <option value="id">Indonesia</option>
                    <option value="en">Inggris</option>
                    <option value="campur">Campur</option>
                  </select>
                </label>
              </div>
              <b className="small">Produk</b>
              {draft.produk.map((p, i) => (
                <div key={i} className="row wrap" style={{ gap: 6 }}>
                  <input aria-label={`Produk ${i + 1}`} placeholder="Nama produk" maxLength={60} value={p.nama} onChange={(e) => set({ produk: draft.produk.map((x, j) => (j === i ? { ...x, nama: e.target.value } : x)) })} />
                  <input aria-label={`Varian produk ${i + 1}`} placeholder="Varian (pisah koma)" value={csv(p.varian)} onChange={(e) => set({ produk: draft.produk.map((x, j) => (j === i ? { ...x, varian: fromCsv(e.target.value) } : x)) })} />
                  <input aria-label={`Ukuran produk ${i + 1}`} placeholder="Ukuran" maxLength={40} value={p.ukuran} onChange={(e) => set({ produk: draft.produk.map((x, j) => (j === i ? { ...x, ukuran: e.target.value } : x)) })} />
                  <button className="tiny" aria-label={`Hapus produk ${i + 1}`} onClick={() => set({ produk: draft.produk.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button className="btn small" onClick={() => set({ produk: [...draft.produk, { nama: '', varian: [], ukuran: '' }] })}>
                ＋ Produk
              </button>
            </Section>

            <Section id="b" title="B. Visual">
              <div>
                <b>Warna brand</b> <span className="muted small">(pertama = warna utama)</span>
                <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                  {draft.colors.map((c, i) => (
                    <span key={i} className="swatchEdit">
                      <input type="color" aria-label={`Warna brand ${i + 1}`} value={c} onChange={(e) => set({ colors: draft.colors.map((x, j) => (j === i ? e.target.value : x)) })} />
                      <button className="tiny" aria-label={`Hapus warna ${i + 1}`} onClick={() => set({ colors: draft.colors.filter((_, j) => j !== i) })}>
                        ×
                      </button>
                    </span>
                  ))}
                  {draft.colors.length < MAX_COLORS && (
                    <button className="btn small" onClick={() => set({ colors: [...draft.colors, ['#7a1f5c', '#f4d35e', '#1b998b', '#2e86ab', '#e84855', '#222222'].find((c) => !draft.colors.includes(c)) ?? '#888888'] })}>
                      ＋ Warna
                    </button>
                  )}
                </div>
              </div>
              <div className="inspGrid">
                <label>
                  Warna teks di atas warna utama
                  <input type="color" aria-label="Warna teks brand" value={draft.text_color} onChange={(e) => set({ text_color: e.target.value })} />
                </label>
                <label>
                  Outline teks
                  <span className="row" style={{ gap: 6 }}>
                    <input type="color" aria-label="Warna outline" value={draft.outline.color} onChange={(e) => set({ outline: { ...draft.outline, color: e.target.value } })} />
                    <input type="number" aria-label="Tebal outline (px)" min={0} max={20} value={draft.outline.px} onChange={(e) => set({ outline: { ...draft.outline, px: Number(e.target.value) || 0 } })} style={{ width: 70 }} /> px
                  </span>
                </label>
              </div>
              <label>
                Warna dilarang (pisah koma)
                <input aria-label="Warna dilarang" value={csv(draft.warna_dilarang)} onChange={(e) => set({ warna_dilarang: fromCsv(e.target.value) })} />
              </label>
              <div>
                <b>Font judul</b> <span className="muted small">hook, judul, CTA</span>
                {fileSelect('Font brand', draft.font, fonts, (r) => set({ font: r }), 'font', '.ttf,.otf,font/ttf,font/otf', '⇪ Unggah .ttf/.otf', 'File font brand', '— Font bawaan —')}
              </div>
              <div>
                <b>Font caption</b> <span className="muted small">caption per kata</span>
                {fileSelect('Font caption brand', draft.font_caption, fonts, (r) => set({ font_caption: r }), 'font_caption', '.ttf,.otf,font/ttf,font/otf', '⇪ Unggah .ttf/.otf', 'File font caption', '— Font bawaan —')}
              </div>
              <div>
                <b>Logo</b>
                {fileSelect(
                  'Logo brand',
                  draft.logo?.ref ?? null,
                  logos,
                  (r) => set({ logo: r ? { ref: r, corner, size: draft.logo?.size ?? 18, opacity: draft.logo?.opacity ?? 1, show: draft.logo?.show ?? 'sepanjang' } : null }),
                  'logo',
                  'image/png,image/jpeg,image/webp',
                  '⇪ Unggah logo',
                  'File logo brand',
                  '— Tanpa logo —',
                )}
                {draft.logo && (
                  <div className="inspGrid" style={{ marginTop: 8 }}>
                    <label>
                      Posisi
                      <select aria-label="Posisi logo" value={draft.logo.corner} onChange={(e) => set({ logo: { ...draft.logo!, corner: e.target.value as 'tl' } })}>
                        {CORNERS.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Ukuran {draft.logo.size}%
                      <input type="range" aria-label="Ukuran logo" min={5} max={40} value={draft.logo.size} onChange={(e) => set({ logo: { ...draft.logo!, size: Number(e.target.value) } })} />
                    </label>
                    <label>
                      Opasitas {Math.round(draft.logo.opacity * 100)}%
                      <input type="range" aria-label="Opasitas logo" min={10} max={100} value={Math.round(draft.logo.opacity * 100)} onChange={(e) => set({ logo: { ...draft.logo!, opacity: Number(e.target.value) / 100 } })} />
                    </label>
                    <label>
                      Kapan tampil
                      <select aria-label="Kapan logo tampil" value={draft.logo.show} onChange={(e) => set({ logo: { ...draft.logo!, show: e.target.value as 'sepanjang' } })}>
                        <option value="sepanjang">Sepanjang video</option>
                        <option value="penutup">Hanya penutup</option>
                        <option value="sepanjang+penutup">Sepanjang + penutup</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>
              <div>
                <b>Logo versi terang</b> <span className="muted small">untuk video gelap (opsional)</span>
                {fileSelect('Logo terang', draft.logo_light, logos, (r) => set({ logo_light: r }), 'logo_light', 'image/png,image/jpeg,image/webp', '⇪ Unggah', 'File logo terang', '— Tidak ada —')}
              </div>
              <div>
                <b>Penutup (video/animasi)</b> <span className="muted small">opsional</span>
                {fileSelect('Penutup', draft.outro.ref, outros, (r) => set({ outro: { ...draft.outro, ref: r } }), 'outro', 'video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp', '⇪ Unggah', 'File penutup', '— Tidak ada —')}
                <label className="inline" style={{ marginTop: 6 }}>
                  Durasi penutup
                  <input type="number" aria-label="Durasi penutup (detik)" min={0.5} max={10} step={0.5} value={draft.outro.detik} onChange={(e) => set({ outro: { ...draft.outro, detik: Number(e.target.value) || 2 } })} style={{ width: 70 }} /> dtk
                </label>
              </div>
              <div className="inspGrid">
                <label>
                  Gaya keseluruhan
                  <input aria-label="Gaya keseluruhan" maxLength={120} placeholder="mis. Clean minimalis" value={draft.gaya} onChange={(e) => set({ gaya: e.target.value })} />
                </label>
                <label>
                  Color grading
                  <input aria-label="Color grading" maxLength={120} placeholder="mis. Hangat, natural" value={draft.grading} onChange={(e) => set({ grading: e.target.value })} />
                </label>
                <label title="Dipakai semua klip video/b-roll proyek brand ini, kecuali klip yang memilih filter sendiri (Inspector → Filter warna).">
                  Filter bawaan video
                  <select aria-label="Filter bawaan video" value={draft.filter_bawaan ?? ''} onChange={(e) => set({ filter_bawaan: e.target.value ? (e.target.value as (typeof LOOK_IDS)[number]) : null })}>
                    <option value="">Tanpa filter</option>
                    {LOOK_IDS.map((id) => (
                      <option key={id} value={id}>
                        {LOOKS[id].label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </Section>

            <Section id="c" title="C. Teks & bahasa">
              <div className="inspGrid">
                {PLATFORMS.map((p) => (
                  <label key={p.id}>
                    CTA {p.label}
                    <input aria-label={`CTA ${p.label}`} maxLength={120} value={draft.cta[p.id] ?? ''} onChange={(e) => set({ cta: { ...draft.cta, [p.id]: e.target.value } })} />
                  </label>
                ))}
              </div>
              <label>
                Kalimat CTA wajib (opsional)
                <input aria-label="CTA wajib" maxLength={200} value={draft.cta_wajib} onChange={(e) => set({ cta_wajib: e.target.value })} />
              </label>
              <div className="inspGrid">
                <label>
                  Disclaimer
                  <input aria-label="Disclaimer" maxLength={160} value={draft.disclaimer?.teks ?? ''} onChange={(e) => set({ disclaimer: { teks: e.target.value, kapan: draft.disclaimer?.kapan ?? 'selalu' } })} />
                </label>
                <label>
                  Kapan disclaimer tampil
                  <select aria-label="Kapan disclaimer tampil" value={draft.disclaimer?.kapan ?? 'selalu'} onChange={(e) => set({ disclaimer: { teks: draft.disclaimer?.teks ?? '', kapan: e.target.value as 'selalu' } })}>
                    <option value="selalu">Selalu</option>
                    <option value="varian_warna">Saat memperlihatkan varian warna</option>
                    <option value="harga">Saat menyebut harga</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
              </div>
              <div className="inspGrid">
                <label>
                  Tagline (end card &amp; Beat Spot)
                  <input aria-label="Tagline" maxLength={120} placeholder="mis. CUCI · JEMUR · LANGSUNG PAKAI" value={draft.tagline} onChange={(e) => set({ tagline: e.target.value })} />
                </label>
                <label>
                  Watermark teks (opsional)
                  <input aria-label="Watermark teks" maxLength={60} placeholder="mis. @aysilla.factory" value={draft.watermark?.teks ?? ''} onChange={(e) => set({ watermark: { teks: e.target.value, y: draft.watermark?.y ?? 0.92, lebar: draft.watermark?.lebar ?? 0.4, opasitas: draft.watermark?.opasitas ?? 0.6 } })} />
                </label>
                {draft.watermark && draft.watermark.teks.trim() !== '' && (
                  <label>
                    Posisi watermark (0 atas – 1 bawah)
                    <input type="number" aria-label="Posisi watermark" min={0} max={1} step={0.01} value={draft.watermark.y} onChange={(e) => set({ watermark: { ...draft.watermark!, y: Math.min(1, Math.max(0, Number(e.target.value) || 0)) } })} />
                  </label>
                )}
              </div>
              <div className="muted small">Watermark teks mengisi sela di antara hook / CTA / disclaimer. Untuk tanda yang selalu tampil, pakai logo (bagian B).</div>
              <label>
                Kosakata Whisper (satu per baris)
                <textarea aria-label="Kosakata Whisper" rows={3} value={lines(draft.kosakata)} onChange={(e) => set({ kosakata: fromLines(e.target.value) })} />
              </label>
              <b className="small">Kamus (salah dengar → benar)</b>
              {draft.kamus.map((k, i) => (
                <div key={i} className="row" style={{ gap: 6 }}>
                  <input aria-label={`Kamus salah ${i + 1}`} placeholder="salah" maxLength={60} value={k.salah} onChange={(e) => set({ kamus: draft.kamus.map((x, j) => (j === i ? { ...x, salah: e.target.value } : x)) })} />→
                  <input aria-label={`Kamus benar ${i + 1}`} placeholder="benar" maxLength={60} value={k.benar} onChange={(e) => set({ kamus: draft.kamus.map((x, j) => (j === i ? { ...x, benar: e.target.value } : x)) })} />
                  <button className="tiny" aria-label={`Hapus kamus ${i + 1}`} onClick={() => set({ kamus: draft.kamus.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button className="btn small" onClick={() => set({ kamus: [...draft.kamus, { salah: '', benar: '' }] })}>
                ＋ Pasangan kamus
              </button>
              <label>
                Kata kunci yang diperbesar (pisah koma)
                <input aria-label="Kata kunci" value={csv(draft.kata_kunci)} onChange={(e) => set({ kata_kunci: fromCsv(e.target.value) })} />
              </label>
              <div className="inspGrid">
                <label>
                  Huruf kapital
                  <select aria-label="Aturan kapital" value={draft.kapital} onChange={(e) => set({ kapital: e.target.value as 'normal' })}>
                    <option value="normal">Normal</option>
                    <option value="kata_kunci">Kata kunci KAPITAL</option>
                    <option value="semua">SEMUA KAPITAL</option>
                  </select>
                </label>
                <label className="inline">
                  <input type="checkbox" aria-label="Emoji di teks" checked={draft.emoji} onChange={(e) => set({ emoji: e.target.checked })} /> Emoji di teks
                </label>
              </div>
            </Section>

            <Section id="d" title="D. Aturan" hint="harga promo, klaim, area teks — dicek sebelum setiap render">
              <div className="guardBox" role="group" aria-label="Brand guard">
                <div className="muted small">Harga promo + tanggal terakhir berlaku. Setelah tanggal itu, video yang masih menulis harga ini tidak bisa dirender.</div>
                {draft.guard.prices.map((p, i) => (
                  <div key={i} className="row" style={{ gap: 6, marginTop: 6 }}>
                    <input aria-label={`Harga promo ${i + 1}`} placeholder="mis. Rp99.000 atau DISKON 50%" maxLength={60} value={p.text} onChange={(e) => set({ guard: { ...draft.guard, prices: draft.guard.prices.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) } })} />
                    <input type="date" aria-label={`Berlaku sampai ${i + 1}`} value={p.valid_until} onChange={(e) => set({ guard: { ...draft.guard, prices: draft.guard.prices.map((x, j) => (j === i ? { ...x, valid_until: e.target.value } : x)) } })} />
                    <button className="tiny" aria-label={`Hapus harga ${i + 1}`} onClick={() => set({ guard: { ...draft.guard, prices: draft.guard.prices.filter((_, j) => j !== i) } })}>
                      ×
                    </button>
                  </div>
                ))}
                <button className="btn small" style={{ marginTop: 6 }} disabled={draft.guard.prices.length >= 50} onClick={() => set({ guard: { ...draft.guard, prices: [...draft.guard.prices, { text: '', valid_until: todayStr() }] } })}>
                  ＋ Harga promo
                </button>
                <label style={{ marginTop: 10 }}>
                  Klaim terlarang (satu per baris)
                  <textarea aria-label="Klaim terlarang" rows={4} placeholder={'paling murah\n100% menyembuhkan\ndijamin'} value={lines(draft.guard.banned)} onChange={(e) => set({ guard: { ...draft.guard, banned: fromLines(e.target.value) } })} />
                </label>
                <label>
                  Kalau klaim terlarang ditemukan
                  <select aria-label="Tingkat klaim terlarang" value={draft.guard.banned_level} onChange={(e) => set({ guard: { ...draft.guard, banned_level: e.target.value as 'block' | 'warn' } })}>
                    <option value="block">Blokir render (disarankan)</option>
                    <option value="warn">Peringatkan saja (bisa render tetap, tercatat)</option>
                  </select>
                </label>
              </div>
              <label>
                Klaim yang BOLEH (satu per baris)
                <textarea aria-label="Klaim boleh" rows={3} value={lines(draft.klaim_boleh)} onChange={(e) => set({ klaim_boleh: fromLines(e.target.value) })} />
              </label>
              <label>
                Visual dilarang (satu per baris)
                <textarea aria-label="Visual dilarang" rows={2} value={lines(draft.visual_dilarang)} onChange={(e) => set({ visual_dilarang: fromLines(e.target.value) })} />
              </label>
              <div>
                <b className="small">Area yang tidak boleh tertutup teks</b>
                <div className="row wrap" style={{ gap: 10 }}>
                  {AREAS.map((a) => (
                    <label key={a.id} className="inline">
                      <input
                        type="checkbox"
                        aria-label={`Area bebas teks: ${a.label}`}
                        checked={draft.area_bebas_teks.includes(a.id)}
                        onChange={(e) => set({ area_bebas_teks: e.target.checked ? [...draft.area_bebas_teks, a.id] : draft.area_bebas_teks.filter((x) => x !== a.id) })}
                      />{' '}
                      {a.label}
                    </label>
                  ))}
                </div>
              </div>
            </Section>

            <Section id="e" title="E. Aset brand" hint="mesin memilih aset dari tag; tanpa lisensi tidak pernah dipakai di iklan">
              <AssetLibrary api={api} draft={draft} set={set} later={later} media={media} onMedia={setMedia} />
              <label>
                SFX dilarang (pisah koma)
                <input aria-label="SFX dilarang" placeholder="kaget, kartun" value={csv(draft.sfx_dilarang)} onChange={(e) => set({ sfx_dilarang: fromCsv(e.target.value) })} />
              </label>
              <b className="small">Video referensi winning (disarankan minimal 3)</b>
              {draft.referensi.map((r, i) => (
                <div key={i} className="row wrap" style={{ gap: 6 }}>
                  <input aria-label={`Link referensi ${i + 1}`} placeholder="https://…" maxLength={300} value={r.link} onChange={(e) => set({ referensi: draft.referensi.map((x, j) => (j === i ? { ...x, link: e.target.value } : x)) })} />
                  <input aria-label={`Yang ditiru ${i + 1}`} placeholder="yang ditiru" maxLength={200} value={r.tiru} onChange={(e) => set({ referensi: draft.referensi.map((x, j) => (j === i ? { ...x, tiru: e.target.value } : x)) })} />
                  <input aria-label={`Yang tidak ditiru ${i + 1}`} placeholder="yang tidak ditiru" maxLength={200} value={r.jangan} onChange={(e) => set({ referensi: draft.referensi.map((x, j) => (j === i ? { ...x, jangan: e.target.value } : x)) })} />
                  <button className="tiny" aria-label={`Hapus referensi ${i + 1}`} onClick={() => set({ referensi: draft.referensi.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button className="btn small" disabled={draft.referensi.length >= 20} onClick={() => set({ referensi: [...draft.referensi, { link: '', tiru: '', jangan: '' }] })}>
                ＋ Referensi
              </button>
            </Section>

            <Section id="f" title="F. Preset per jenis konten">
              {draft.presets.map((p, i) => (
                <div key={i} className="presetCard" role="group" aria-label={`Preset ${i + 1}`}>
                  <div className="inspGrid">
                    <label>
                      Nama preset
                      <input aria-label={`Nama preset ${i + 1}`} maxLength={60} value={p.nama} onChange={(e) => setPreset(i, { nama: e.target.value })} />
                    </label>
                    <label>
                      ID (huruf kecil)
                      <input aria-label={`ID preset ${i + 1}`} maxLength={40} value={p.id} onChange={(e) => setPreset(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
                    </label>
                  </div>
                  <label>
                    Jenis & tujuan
                    <input aria-label={`Tujuan preset ${i + 1}`} maxLength={120} value={p.tujuan} onChange={(e) => setPreset(i, { tujuan: e.target.value })} />
                  </label>
                  <div className="row wrap" style={{ gap: 10 }}>
                    {PLATFORMS.map((pl) => (
                      <label key={pl.id} className="inline">
                        <input type="checkbox" aria-label={`Preset ${i + 1} placement ${pl.label}`} checked={p.placement.includes(pl.id)} onChange={(e) => setPreset(i, { placement: e.target.checked ? [...p.placement, pl.id] : p.placement.filter((x) => x !== pl.id) })} /> {pl.label}
                      </label>
                    ))}
                  </div>
                  <div className="inspGrid">
                    {(['min', 'target', 'max'] as const).map((k) => (
                      <label key={k}>
                        Durasi {k === 'min' ? 'minimal' : k === 'max' ? 'maksimal' : 'target'} (dtk)
                        <input type="number" aria-label={`Preset ${i + 1} durasi ${k}`} min={1} max={600} value={p.durasi[k]} onChange={(e) => setPreset(i, { durasi: { ...p.durasi, [k]: Number(e.target.value) || 1 } })} />
                      </label>
                    ))}
                  </div>
                  <div className="row wrap" style={{ gap: 10 }}>
                    <span className="small muted">Versi turunan:</span>
                    {RATIOS.map((r) => (
                      <label key={r} className="inline">
                        <input type="checkbox" aria-label={`Preset ${i + 1} turunan ${r}`} checked={p.turunan.includes(r)} onChange={(e) => setPreset(i, { turunan: e.target.checked ? [...p.turunan, r] : p.turunan.filter((x) => x !== r) })} /> {r}
                      </label>
                    ))}
                  </div>
                  <b className="small">Struktur babak</b>
                  {p.babak.map((b, j) => (
                    <div key={j} className="row" style={{ gap: 6 }}>
                      <input type="number" aria-label={`Preset ${i + 1} babak ${j + 1} dari`} min={0} value={b.dari} onChange={(e) => setPreset(i, { babak: p.babak.map((x, k) => (k === j ? { ...x, dari: Number(e.target.value) || 0 } : x)) })} style={{ width: 64 }} />–
                      <input type="number" aria-label={`Preset ${i + 1} babak ${j + 1} sampai`} min={0} value={b.sampai} onChange={(e) => setPreset(i, { babak: p.babak.map((x, k) => (k === j ? { ...x, sampai: Number(e.target.value) || 0 } : x)) })} style={{ width: 64 }} /> dtk
                      <input aria-label={`Preset ${i + 1} babak ${j + 1} isi`} placeholder="Hook / Masalah / Bukti / CTA" maxLength={80} value={b.isi} onChange={(e) => setPreset(i, { babak: p.babak.map((x, k) => (k === j ? { ...x, isi: e.target.value } : x)) })} />
                      <button className="tiny" aria-label={`Hapus babak ${j + 1} preset ${i + 1}`} onClick={() => setPreset(i, { babak: p.babak.filter((_, k) => k !== j) })}>
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="btn small" onClick={() => setPreset(i, { babak: [...p.babak, { dari: p.babak.at(-1)?.sampai ?? 0, sampai: (p.babak.at(-1)?.sampai ?? 0) + 3, isi: '' }] })}>
                    ＋ Babak
                  </button>
                  <label>
                    Ritme
                    <input aria-label={`Preset ${i + 1} ritme`} maxLength={300} placeholder="Ganti shot tiap 2–5 dtk · jeda maks 0,5 dtk" value={p.ritme} onChange={(e) => setPreset(i, { ritme: e.target.value })} />
                  </label>
                  <div className="inspGrid">
                    <label>
                      Caption
                      <select aria-label={`Preset ${i + 1} mode caption`} value={p.caption.mode} onChange={(e) => setPreset(i, { caption: { ...p.caption, mode: e.target.value as 'per_kata' } })}>
                        <option value="per_kata">Per kata</option>
                        <option value="kalimat">Per kalimat</option>
                      </select>
                    </label>
                    <label>
                      Maks kata / caption
                      <input type="number" aria-label={`Preset ${i + 1} maks kata caption`} min={1} max={12} value={p.caption.maks_kata} onChange={(e) => setPreset(i, { caption: { ...p.caption, maks_kata: Number(e.target.value) || 1 } })} />
                    </label>
                    <label>
                      Pop (ms)
                      <input type="number" aria-label={`Preset ${i + 1} pop caption`} min={0} max={1000} value={p.caption.pop_ms} onChange={(e) => setPreset(i, { caption: { ...p.caption, pop_ms: Number(e.target.value) || 0 } })} />
                    </label>
                    <label>
                      Hook maks kata
                      <input type="number" aria-label={`Preset ${i + 1} hook maks kata`} min={1} max={20} value={p.hook.maks_kata} onChange={(e) => setPreset(i, { hook: { ...p.hook, maks_kata: Number(e.target.value) || 1 } })} />
                    </label>
                  </div>
                  <div className="row wrap" style={{ gap: 10 }}>
                    <label className="inline">
                      <input type="checkbox" aria-label={`Preset ${i + 1} teks hook`} checked={p.hook.teks} onChange={(e) => setPreset(i, { hook: { ...p.hook, teks: e.target.checked } })} /> Teks hook
                    </label>
                    <label className="inline">
                      <input type="checkbox" aria-label={`Preset ${i + 1} hook dari ucapan`} checked={p.hook.dari_ucapan} onChange={(e) => setPreset(i, { hook: { ...p.hook, dari_ucapan: e.target.checked } })} /> Hook harus dari ucapan
                    </label>
                    <label className="inline">
                      <input type="checkbox" aria-label={`Preset ${i + 1} suara asli`} checked={p.audio.suara_asli} onChange={(e) => setPreset(i, { audio: { ...p.audio, suara_asli: e.target.checked } })} /> Suara asli
                    </label>
                  </div>
                  <div className="inspGrid">
                    {(['wajib', 'boleh', 'jangan'] as const).map((k) => (
                      <label key={k}>
                        Efek {k} (pisah koma)
                        <input aria-label={`Preset ${i + 1} efek ${k}`} value={csv(p.efek[k])} onChange={(e) => setPreset(i, { efek: { ...p.efek, [k]: fromCsv(e.target.value) } })} />
                      </label>
                    ))}
                    <label>
                      Efek maks / jarak (dtk)
                      <span className="row" style={{ gap: 6 }}>
                        <input type="number" aria-label={`Preset ${i + 1} efek maks`} min={0} max={30} value={p.efek.maks} onChange={(e) => setPreset(i, { efek: { ...p.efek, maks: Number(e.target.value) || 0 } })} style={{ width: 64 }} />
                        <input type="number" aria-label={`Preset ${i + 1} jarak efek`} min={0} max={60} value={p.efek.jarak_dtk} onChange={(e) => setPreset(i, { efek: { ...p.efek, jarak_dtk: Number(e.target.value) || 0 } })} style={{ width: 64 }} />
                      </span>
                    </label>
                    <label>
                      SFX
                      <input aria-label={`Preset ${i + 1} sfx`} maxLength={200} value={p.audio.sfx} onChange={(e) => setPreset(i, { audio: { ...p.audio, sfx: e.target.value } })} />
                    </label>
                    <label>
                      Musik
                      <input aria-label={`Preset ${i + 1} musik`} maxLength={200} value={p.audio.musik} onChange={(e) => setPreset(i, { audio: { ...p.audio, musik: e.target.value } })} />
                    </label>
                    <label>
                      Loudness (LUFS)
                      <input type="number" aria-label={`Preset ${i + 1} LUFS`} min={-30} max={-6} value={p.audio.lufs} onChange={(e) => setPreset(i, { audio: { ...p.audio, lufs: Number(e.target.value) || -14 } })} />
                    </label>
                  </div>
                  <PresetGaya p={p} i={i} onChange={(patch) => setPreset(i, patch)} />
                  <label>
                    Checklist QC (satu per baris)
                    <textarea aria-label={`Preset ${i + 1} QC`} rows={3} value={lines(p.qc)} onChange={(e) => setPreset(i, { qc: fromLines(e.target.value) })} />
                  </label>
                  <button className="btn small" aria-label={`Hapus preset ${i + 1}`} onClick={() => set({ presets: draft.presets.filter((_, j) => j !== i) })}>
                    Hapus preset
                  </button>
                </div>
              ))}
              <button className="btn small" disabled={draft.presets.length >= 12} onClick={() => set({ presets: [...draft.presets, newPreset(nextPresetId(draft.presets.map((p) => p.id)))] })}>
                ＋ Preset
              </button>{' '}
              <button
                className="btn small"
                disabled={!!busy || readOnly}
                onClick={() =>
                  void api.presetContoh().then(
                    (ex) => {
                      const have = new Set(draft.presets.map((p) => p.id));
                      const add = ex.filter((p) => !have.has(p.id)).slice(0, Math.max(0, 12 - draft.presets.length));
                      if (add.length) set({ presets: [...draft.presets, ...add] });
                      setContoh(add.length ? `${add.length} preset contoh ditambahkan (yang sudah ada tidak ditimpa). Klik Simpan Brand Kit.` : 'Semua preset contoh sudah ada — tidak ada yang ditimpa.');
                    },
                    (e) => setContoh(`Gagal memuat preset contoh: ${e instanceof Error ? e.message : String(e)}`),
                  )
                }
              >
                ✦ Isi contoh preset Aysilla
              </button>
              {contoh && (
                <div className="notice small" role="status" aria-label="Preset contoh">
                  {contoh}
                </div>
              )}
            </Section>

            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn primary" disabled={!!busy || !draft.name.trim()} onClick={() => void save()}>
                {busy === 'save' ? 'Menyimpan…' : 'Simpan Brand Kit'}
              </button>
              {saved && kit && (
                <span className="badge ok" role="status">
                  Tersimpan (revisi {kit.revision})
                </span>
              )}
              {kit && !dup && (
                <button className="btn small" disabled={!!busy} onClick={() => setDup({ name: '', kode: '' })} title="Brand baru dari Brand Kit ini (warna, font, teks, aturan, aset, preset)">
                  ⧉ Duplikat brand
                </button>
              )}
              {kit && dup && (
                <span className="row wrap" style={{ gap: 6, alignItems: 'center' }} role="group" aria-label="Duplikat brand">
                  <input aria-label="Nama brand baru" placeholder="Nama brand baru" maxLength={60} value={dup.name} onChange={(e) => setDup({ ...dup, name: e.target.value })} />
                  <input aria-label="Kode brand baru" placeholder="Kode (2–5, boleh kosong)" maxLength={5} style={{ width: 150 }} value={dup.kode} onChange={(e) => setDup({ ...dup, kode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
                  <button
                    className="btn small primary"
                    disabled={!!busy || !dup.name.trim()}
                    onClick={() =>
                      leaveOk() &&
                      void act('duplicate', async () => {
                        const made = await api.duplicateBrand(kit.brand_id, dup.name.trim(), dup.kode || undefined);
                        setDup(null);
                        await load(made.brand_id);
                      })
                    }
                  >
                    Buat
                  </button>
                  <button className="btn small" onClick={() => setDup(null)}>
                    Batal
                  </button>
                  {dirty && <span className="muted small">Yang disalin: Brand Kit yang sudah disimpan.</span>}
                </span>
              )}
              {kit && kit.brand_id !== defaultId && (
                <button className="btn small" disabled={!!busy} onClick={() => void act('default', async () => (await api.setDefaultBrand(kit.brand_id), setDefaultId(kit.brand_id)))}>
                  ★ Jadikan bawaan
                </button>
              )}
              {kit && (
                <button className="btn small" disabled={!!busy} onClick={() => void exportJson()} title="Yang diterima mesin otomatis (tanpa path file)">
                  ⇩ Ekspor JSON
                </button>
              )}
              {kit && (
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm(`Hapus brand "${kit.name}"? File-nya tetap ada di Media.`)) void act('delete', async () => (await api.deleteBrand(kit.brand_id), await load()));
                  }}
                >
                  Hapus brand
                </button>
              )}
            </div>
          </section>

          <section className="card" aria-label="Contoh tampilan brand">
            <b>Contoh</b>
            <div className="brandSample" style={{ aspectRatio: '9 / 16' }}>
              <span className="brandSampleText" style={{ background: main, color: draft.text_color, fontFamily: fontLive ? `'${BRAND_FONT_FAMILY}', sans-serif` : undefined }}>
                {draft.name || 'Brand'} — Promo hari ini
              </span>
              <span className="brandSampleCaption" style={{ color: draft.text_color, WebkitTextStroke: draft.outline.px ? `${Math.min(3, draft.outline.px / 2)}px ${draft.outline.color}` : undefined, fontFamily: capLive ? `'${BRAND_CAPTION_FAMILY}', sans-serif` : undefined }}>
                caption per kata
              </span>
              {logoUrl && draft.logo && (
                <img
                  className="brandLogo"
                  src={logoUrl}
                  alt="Logo brand"
                  style={{ width: `${draft.logo.size}%`, opacity: draft.logo.opacity, [corner.startsWith('t') ? 'top' : 'bottom']: '4%', [corner.endsWith('l') ? 'left' : 'right']: '4%' }}
                />
              )}
              {draft.logo && !logoUrl && <span className="muted small brandSampleNote">Logo tampil setelah disimpan</span>}
            </div>
            <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
              {draft.colors.map((c) => (
                <span key={c} className="swatch" style={{ background: c }} title={c} />
              ))}
            </div>
            <nav className="muted small brandToc" aria-label="Bagian Brand Kit">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((s) => (
                <a key={s} href={`#brand-${s}`}>
                  {s.toUpperCase()}
                </a>
              ))}
            </nav>
          </section>
        </div>
        </fieldset>
      </div>
    </>
  );
}
