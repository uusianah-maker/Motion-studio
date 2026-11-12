import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, BrandKit, BrandKitInput, Media } from '../api';
import { BRAND_FONT_FAMILY, useBrand } from '../brand';
import { ErrorNotice } from '../ui';

const FONT_RE = /\.(ttf|otf)$/i;
const LOGO_RE = /\.(png|jpe?g|webp)$/i;
const MAX_COLORS = 6;
const CORNERS: { id: 'tl' | 'tr' | 'bl' | 'br'; label: string }[] = [
  { id: 'tl', label: 'Kiri atas' },
  { id: 'tr', label: 'Kanan atas' },
  { id: 'bl', label: 'Kiri bawah' },
  { id: 'br', label: 'Kanan bawah' },
];
const current = (m: Media) => m.versions.find((v) => v.version_id === m.current_version_id);
const usable = (m: Media, re: RegExp) => {
  const v = current(m);
  return !!v && v.lifecycle === 'active' && v.integrity === 'ok' && re.test(v.original_name);
};
const toInput = (k: BrandKit): BrandKitInput => ({
  name: k.name,
  colors: [...k.colors],
  text_color: k.text_color,
  font: k.font,
  logo: k.logo ? { ...k.logo } : null,
  guard: { prices: (k.guard?.prices ?? []).map((p) => ({ ...p })), banned: [...(k.guard?.banned ?? [])], banned_level: k.guard?.banned_level ?? 'block' },
});
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Brand Kit (X06, PRD §7): brand colours, text colour, font file and logo for the whole workspace.
 * Files are uploaded like any media (they stay on this PC) and are protected from Auto Trash
 * while the kit uses them. Presets, the inspector and Copilot read these values.
 */
export function BrandView({ api }: { api: Api }) {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [draft, setDraft] = useState<BrandKitInput | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const loaded = useBrand(api, reload);
  const fontInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [k, m] = await Promise.all([api.brand(), api.media({ scope: 'shared' })]);
      setKit(k);
      setDraft(toInput(k));
      setMedia(m);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  if (!draft || !kit) return <div className="body">{error ? <ErrorNotice error={error} /> : <div className="sectionNote">Memuat Brand Kit…</div>}</div>;

  const fonts = media.filter((m) => usable(m, FONT_RE));
  const logos = media.filter((m) => usable(m, LOGO_RE));
  const set = (patch: Partial<BrandKitInput>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };
  const refOf = (m: Media) => ({ media_id: m.media_id, version_id: m.current_version_id });

  const upload = async (file: File | undefined, kind: 'font' | 'logo') => {
    if (!file) return;
    setUploading(kind);
    setError(null);
    try {
      if (!(kind === 'font' ? FONT_RE : LOGO_RE).test(file.name)) throw new Error(kind === 'font' ? 'Pilih file font .ttf atau .otf.' : 'Pilih gambar PNG, JPG atau WebP.');
      const r = await api.importFile(file, { kind: 'shared' });
      const ref = { media_id: r.media_id, version_id: r.version.version_id };
      setMedia(await api.media({ scope: 'shared' }));
      if (kind === 'font') set({ font: ref });
      else set({ logo: { ref, corner: draft.logo?.corner ?? 'tr', size: draft.logo?.size ?? 18, opacity: draft.logo?.opacity ?? 1 } });
    } catch (e) {
      setError(e);
    } finally {
      setUploading(null);
      if (fontInput.current) fontInput.current.value = '';
      if (logoInput.current) logoInput.current.value = '';
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Empty lines in the banned list are just spacing.
      const k = await api.saveBrand(kit.revision, { ...draft, guard: { ...draft.guard, banned: draft.guard.banned.map((b) => b.trim()).filter(Boolean) } });
      setKit(k);
      setDraft(toInput(k));
      setSaved(true);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const main = draft.colors[0] ?? '#2a2f42';
  const corner = draft.logo?.corner ?? 'tr';
  const logoUrl = loaded?.kit.logo && draft.logo && loaded.kit.logo.ref.version_id === draft.logo.ref.version_id ? loaded.logoUrl : null;
  const fontLive = loaded?.fontReady && draft.font && loaded.kit.font?.version_id === draft.font.version_id;

  return (
    <>
      <header className="top">
        <h1>Brand Kit</h1>
        <span className="muted hideNarrow">Warna, font, dan logo untuk semua proyek. File tetap di PC ini.</span>
      </header>
      <div className="body brandPage">
      {error ? <ErrorNotice error={error} /> : null}
      <div className="brandGrid">
        <section className="card brandForm" aria-label="Pengaturan Brand Kit">
          <label>
            Nama brand
            <input aria-label="Nama brand" maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </label>

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
          <label>
            Warna teks di atas warna utama
            <input type="color" aria-label="Warna teks brand" value={draft.text_color} onChange={(e) => set({ text_color: e.target.value })} />
          </label>

          <div>
            <b>Font brand</b>
            <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
              <select aria-label="Font brand" value={draft.font?.version_id ?? ''} onChange={(e) => set({ font: e.target.value ? refOf(fonts.find((m) => m.current_version_id === e.target.value)!) : null })}>
                <option value="">— Font bawaan —</option>
                {fonts.map((m) => (
                  <option key={m.media_id} value={m.current_version_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
              <button className="btn small" disabled={!!uploading} onClick={() => fontInput.current?.click()}>
                {uploading === 'font' ? 'Mengunggah…' : '⇪ Unggah .ttf/.otf'}
              </button>
              <input ref={fontInput} type="file" hidden accept=".ttf,.otf,font/ttf,font/otf" aria-label="File font brand" onChange={(e) => void upload(e.target.files?.[0], 'font')} />
            </div>
          </div>

          <div>
            <b>Logo</b>
            <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
              <select
                aria-label="Logo brand"
                value={draft.logo?.ref.version_id ?? ''}
                onChange={(e) => {
                  const m = logos.find((x) => x.current_version_id === e.target.value);
                  set({ logo: m ? { ref: refOf(m), corner, size: draft.logo?.size ?? 18, opacity: draft.logo?.opacity ?? 1 } : null });
                }}
              >
                <option value="">— Tanpa logo —</option>
                {logos.map((m) => (
                  <option key={m.media_id} value={m.current_version_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
              <button className="btn small" disabled={!!uploading} onClick={() => logoInput.current?.click()}>
                {uploading === 'logo' ? 'Mengunggah…' : '⇪ Unggah logo'}
              </button>
              <input ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="File logo brand" onChange={(e) => void upload(e.target.files?.[0], 'logo')} />
            </div>
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
              </div>
            )}
          </div>

          <div className="guardBox" role="group" aria-label="Brand guard">
            <b>Brand guard</b> <span className="muted small">dicek sebelum setiap render</span>
            <div className="muted small" style={{ marginTop: 6 }}>
              Harga promo + tanggal terakhir berlaku. Setelah tanggal itu, video yang masih menulis harga ini tidak bisa dirender.
            </div>
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
              <textarea
                aria-label="Klaim terlarang"
                rows={4}
                placeholder={'paling murah\n100% menyembuhkan\ndijamin'}
                value={draft.guard.banned.join('\n')}
                onChange={(e) => set({ guard: { ...draft.guard, banned: e.target.value.split('\n') } })}
              />
            </label>
            <label>
              Kalau klaim terlarang ditemukan
              <select aria-label="Tingkat klaim terlarang" value={draft.guard.banned_level} onChange={(e) => set({ guard: { ...draft.guard, banned_level: e.target.value as 'block' | 'warn' } })}>
                <option value="block">Blokir render (disarankan)</option>
                <option value="warn">Peringatkan saja (bisa render tetap, tercatat)</option>
              </select>
            </label>
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn primary" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
              {saving ? 'Menyimpan…' : 'Simpan Brand Kit'}
            </button>
            {saved && (
              <span className="badge ok" role="status">
                Tersimpan (revisi {kit.revision})
              </span>
            )}
          </div>
          <div className="muted small">Logo tampil di proyek yang menyalakan "Logo brand" (di pratinjau). Teks memakai font brand bila gayanya "Font: Brand". Copilot paham "pakai brand", "warna brand", "tampilkan logo".</div>
        </section>

        <section className="card" aria-label="Contoh tampilan brand">
          <b>Contoh</b>
          <div className="brandSample" style={{ aspectRatio: '9 / 16' }}>
            <span className="brandSampleText" style={{ background: main, color: draft.text_color, fontFamily: fontLive ? `'${BRAND_FONT_FAMILY}', sans-serif` : undefined }}>
              {draft.name || 'Brand'} — Promo hari ini
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
        </section>
      </div>
      </div>
    </>
  );
}
