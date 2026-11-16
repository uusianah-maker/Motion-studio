import { useEffect, useRef, useState } from 'react';
import type { Api, BrandAsset, BrandKitInput, Media } from '../api';
import { useSoundPreview } from '../audioPreview';
import { FontSample } from './LibraryPanel';
import { LutSwatch } from './LutSwatch';
import { parseCube } from '../../../../packages/core/dist/storage/lut.js';

const KINDS: { id: BrandAsset['jenis']; label: string }[] = [
  { id: 'sfx', label: 'SFX' },
  { id: 'musik', label: 'Musik' },
  { id: 'broll', label: 'B-roll' },
  { id: 'logo', label: 'Logo' },
  { id: 'watermark', label: 'Watermark' },
  { id: 'stiker', label: 'Stiker' },
  { id: 'frame', label: 'Frame' },
  { id: 'penutup', label: 'Penutup' },
  { id: 'vo', label: 'VO (suara)' },
  { id: 'video_efek', label: 'Video efek' },
  { id: 'transisi', label: 'Transisi (stinger)' },
  { id: 'lut', label: 'Filter warna (LUT)' },
  { id: 'font', label: 'Font' },
  { id: 'lainnya', label: 'Lainnya' },
];
/** R38a: kinds with a video preview (▶ under the row). */
const VIDEO_KINDS: readonly BrandAsset['jenis'][] = ['video_efek', 'transisi', 'broll', 'penutup'];
/** R38a: what each kind accepts — checked here before uploading (the server checks again on save). */
const FILE_RULE: Partial<Record<BrandAsset['jenis'], { re: RegExp; msg: string }>> = {
  sfx: { re: /\.(wav|mp3|m4a|aac|ogg|flac|mp4|mov|webm)$/i, msg: 'file suara' },
  musik: { re: /\.(wav|mp3|m4a|aac|ogg|flac|mp4|mov|webm)$/i, msg: 'file suara' },
  vo: { re: /\.(wav|mp3|m4a|aac|ogg|flac|mp4|mov|webm)$/i, msg: 'file suara' },
  logo: { re: /\.(png|jpe?g|webp)$/i, msg: 'gambar PNG/JPG/WebP' },
  watermark: { re: /\.(png|jpe?g|webp)$/i, msg: 'gambar PNG/JPG/WebP' },
  stiker: { re: /\.(png|jpe?g|webp)$/i, msg: 'gambar PNG/JPG/WebP' },
  frame: { re: /\.(png|jpe?g|webp)$/i, msg: 'gambar PNG/JPG/WebP' },
  video_efek: { re: /\.(mp4|webm|mov)$/i, msg: 'video MP4/WebM/MOV' },
  transisi: { re: /\.(mp4|webm|mov)$/i, msg: 'video MP4/WebM/MOV' },
  broll: { re: /\.(mp4|mov|webm|png|jpe?g|webp)$/i, msg: 'video atau gambar' },
  penutup: { re: /\.(mp4|mov|webm|png|jpe?g|webp)$/i, msg: 'video atau gambar' },
  lut: { re: /\.cube$/i, msg: 'file LUT .cube' },
  font: { re: /\.(ttf|otf)$/i, msg: 'font .ttf / .otf' },
};
const STATUS: { id: BrandAsset['lisensi']['status']; label: string }[] = [
  { id: 'milik_sendiri', label: 'Milik sendiri' },
  { id: 'berlisensi', label: 'Berlisensi' },
  { id: 'tanpa_lisensi', label: 'Tanpa lisensi' },
  { id: 'belum_dicek', label: 'Belum dicek' },
];
/** Event tags the automation engine looks for (KONTRAK-ENGINE / U2). */
const SUGGESTED: Record<string, string[]> = { sfx: ['teks-muncul', 'kata-kunci', 'transisi', 'penutup'], musik: ['ceria', 'santai', 'energik', 'elegan'], broll: ['detail-bahan', 'try-on', 'packing', 'lifestyle'] };
const ACCEPT: Record<string, string> = { sfx: 'audio/*,.wav,.mp3,.m4a', musik: 'audio/*,.wav,.mp3,.m4a', broll: 'video/*,image/*', logo: 'image/png,image/jpeg,image/webp', watermark: 'image/png,image/jpeg,image/webp', stiker: 'image/png,image/jpeg,image/webp', frame: 'image/png,image/jpeg,image/webp', video_efek: 'video/mp4,video/webm,video/quicktime,.mov', transisi: 'video/mp4,video/webm,video/quicktime,.mov', lut: '.cube', font: '.ttf,.otf,font/ttf,font/otf', penutup: 'video/*,image/*', vo: 'audio/*,.wav,.mp3,.m4a', lainnya: '*/*' };
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'aset';
const canAds = (s: BrandAsset['lisensi']['status']) => s === 'milik_sendiri' || s === 'berlisensi';
/** R26: pictures that go on the overlay track (Editor + Buat video). */
export const OVERLAY_KINDS: readonly BrandAsset['jenis'][] = ['logo', 'watermark', 'stiker', 'frame'];
export const KIND_LABEL = (k: BrandAsset['jenis']) => KINDS.find((x) => x.id === k)?.label ?? k;

/** R26: small preview of a picture on a checkerboard (shows PNG transparency). */
export function AssetThumb({ api, versionId, label, size = 56 }: { api: Api; versionId: string; label: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .streamUrl(versionId)
      .then((r) => live && setUrl(r.url))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [api, versionId]);
  return <span className="assetThumb" style={{ width: size, height: size }}>{url ? <img src={url} alt={label} /> : null}</span>;
}

/**
 * Brand asset library (U2, Brand Kit sheet E): SFX, music, b-roll… with tags and licence status, so
 * the automation engine can pick files by tag and never puts an unlicensed file in an ad.
 * Files are uploaded like any media (they stay on this PC); the kit holds them (never trashed).
 */
export function AssetLibrary({
  api,
  draft,
  set,
  later,
  media,
  onMedia,
}: {
  api: Api;
  draft: BrandKitInput;
  set: (patch: Partial<BrandKitInput>) => void;
  /** Applier bound to the brand shown now; it merges into the draft as it is when called. */
  later: () => (fn: (d: BrandKitInput) => Partial<BrandKitInput>) => boolean;
  media: Media[];
  onMedia: (m: Media[]) => void;
}) {
  const [kind, setKind] = useState<'' | BrandAsset['jenis']>('');
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** R27: ▶ listen to SFX / music / VO before using them. */
  const sound = useSoundPreview(api);
  /** R38a: the video asset shown under its row. */
  const [peek, setPeek] = useState<string | null>(null);
  const names = new Map(media.map((m) => [m.current_version_id, m.display_name]));
  const shown = draft.aset.map((a, i) => ({ a, i })).filter(({ a }) => (!kind || a.jenis === kind) && (!q.trim() || a.tag.some((t) => t.includes(q.trim().toLowerCase())) || a.id.includes(q.trim().toLowerCase())));
  const setAsset = (i: number, patch: Partial<BrandAsset>) => set({ aset: draft.aset.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const uniqueId = (base: string, taken: Set<string>) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };

  const upload = (files: FileList | null) => uploadAs(files, { jenis: (kind as BrandAsset['jenis']) || 'sfx', tag: [], iklan: false, semua: false });
  // R38a "＋ Tambah aset": kind + tags + licence + scope chosen once for every file of the upload.
  const [add, setAdd] = useState<{ open: boolean; jenis: BrandAsset['jenis']; tag: string; iklan: boolean; semua: boolean }>({ open: false, jenis: 'sfx', tag: '', iklan: true, semua: false });
  const addRef = useRef<HTMLInputElement>(null);
  const uploadAs = async (files: FileList | null, o: { jenis: BrandAsset['jenis']; tag: string[]; iklan: boolean; semua: boolean }) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    const jenis = o.jenis;
    const apply = later();
    const added: BrandAsset[] = [];
    try {
      const rule = FILE_RULE[jenis];
      const wrong = Array.from(files).filter((f) => rule && !rule.re.test(f.name));
      if (wrong.length) throw new Error(`${wrong.map((f) => f.name).join(', ')}: ${KINDS.find((k) => k.id === jenis)?.label} harus ${rule!.msg}`);
      // A LUT is read here first so a broken .cube never joins the library.
      if (jenis === 'lut') for (const f of Array.from(files)) {
        try {
          parseCube(await f.text());
        } catch (e) {
          throw new Error(`${f.name}: ${e instanceof Error ? e.message : 'LUT tidak valid'}`);
        }
      }
      for (const f of Array.from(files)) {
        const r = await api.importFile(f, { kind: 'shared' });
        added.push({
          id: slug(f.name),
          ref: { media_id: r.media_id, version_id: r.version.version_id },
          jenis,
          nama: f.name.replace(/\.[a-z0-9]+$/i, ''),
          tag: o.tag,
          lisensi: o.iklan ? { status: 'milik_sendiri', bukti: '', iklan: true } : { status: 'belum_dicek', bukti: '', iklan: false },
          ...(o.semua ? { semua_brand: true as const } : {}),
          mood: '',
          bpm: null,
          instrumental: jenis === 'musik' ? true : null,
          produk: '',
          varian: '',
          ada_teks_bawaan: false,
          catatan: '',
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Merged into the draft as it is NOW (edits made during the upload stay), ids unique there.
      apply((d) => {
        const taken = new Set(d.aset.map((a) => a.id));
        return { aset: [...d.aset, ...added.map((a) => ({ ...a, id: uniqueId(a.id, taken) }))] };
      });
      // File names of what did get uploaded, also after a partial failure.
      if (added.length) onMedia(await api.media({ scope: 'shared' }).catch(() => media));
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      if (addRef.current) addRef.current.value = '';
    }
  };
  const presetTeks = draft.preset_teks ?? [];

  return (
    <div className="assetLib" role="group" aria-label="Library aset brand">
      <div className="row wrap" style={{ gap: 8 }}>
        <select aria-label="Saring jenis aset" value={kind} onChange={(e) => setKind(e.target.value as BrandAsset['jenis'])}>
          <option value="">Semua jenis ({draft.aset.length})</option>
          <option value="preset_teks">Preset teks ({presetTeks.length})</option>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label} ({draft.aset.filter((a) => a.jenis === k.id).length})
            </option>
          ))}
        </select>
        <input aria-label="Cari tag aset" placeholder="Cari tag / id" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Mengunggah…' : `⇪ Unggah ${KINDS.find((k) => k.id === (kind || 'sfx'))!.label} (bisa banyak)`}
        </button>
        <input ref={fileRef} type="file" hidden multiple accept={ACCEPT[kind || 'sfx']} aria-label="File aset brand" onChange={(e) => void upload(e.target.files)} />
        <button className="btn small primary" aria-expanded={add.open} onClick={() => setAdd({ ...add, open: !add.open })}>
          ＋ Tambah aset
        </button>
      </div>
      {add.open && (
        <div className="assetAdd" role="group" aria-label="Tambah aset">
          <div className="inspGrid">
            <label>
              Jenis
              <select aria-label="Jenis aset baru" value={add.jenis} onChange={(e) => setAdd({ ...add, jenis: e.target.value as BrandAsset['jenis'] })}>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tag (pisah koma)
              <input aria-label="Tag aset baru" placeholder="mis. light-leak, hangat" value={add.tag} onChange={(e) => setAdd({ ...add, tag: e.target.value })} />
            </label>
            <label className="inline">
              <input type="checkbox" aria-label="Aset baru boleh untuk iklan" checked={add.iklan} onChange={(e) => setAdd({ ...add, iklan: e.target.checked })} /> Boleh untuk iklan (milik sendiri / berlisensi)
            </label>
            <label className="inline">
              <input type="checkbox" aria-label="Aset baru untuk semua brand" checked={add.semua} onChange={(e) => setAdd({ ...add, semua: e.target.checked })} /> Untuk semua brand
            </label>
          </div>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn small" disabled={uploading} onClick={() => addRef.current?.click()}>
              {uploading ? 'Mengunggah…' : `⇪ Pilih file ${KINDS.find((k) => k.id === add.jenis)!.label} (bisa banyak)`}
            </button>
            <span className="muted small">{FILE_RULE[add.jenis]?.msg ?? 'file apa saja'}{add.jenis === 'transisi' || add.jenis === 'video_efek' ? ' · WebM / MOV boleh beralpha (transparan)' : ''}</span>
            <input
              ref={addRef}
              type="file"
              hidden
              multiple
              accept={ACCEPT[add.jenis] ?? '*/*'}
              aria-label="File aset baru"
              onChange={(e) => void uploadAs(e.target.files, { jenis: add.jenis, tag: add.tag.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), iklan: add.iklan, semua: add.semua })}
            />
          </div>
          <div className="muted small">Preset teks dibuat dari Editor: pilih klip teks → Inspector → "☆ Simpan sebagai preset". Perubahan tersimpan setelah Simpan Brand Kit.</div>
        </div>
      )}
      {error && <div className="notice err small">{error}</div>}
      {draft.aset.length === 0 && <div className="muted small">Belum ada aset. Pilih jenis lalu unggah (mis. SFX pop + whoosh, musik berlisensi, b-roll produk, logo/stiker PNG transparan).</div>}
      {OVERLAY_KINDS.includes(kind as BrandAsset['jenis']) && <div className="muted small">Gambar overlay: pakai PNG transparan supaya latarnya tidak menutupi video. Dipakai di Editor (＋ Overlay) dan di Buat video.</div>}
      {shown.map(({ a, i }) => (
        <div key={i} className="assetRow" role="group" aria-label={`Aset ${a.id}`}>
          <div className="row wrap" style={{ gap: 6 }}>
            {OVERLAY_KINDS.includes(a.jenis) && <AssetThumb api={api} versionId={a.ref.version_id} label={`Gambar ${a.id}`} />}
            {VIDEO_KINDS.includes(a.jenis) && (
              <button className="tiny" aria-label={`${peek === a.ref.version_id ? 'Tutup' : 'Lihat'} video ${a.id}`} aria-pressed={peek === a.ref.version_id} onClick={() => setPeek(peek === a.ref.version_id ? null : a.ref.version_id)}>
                {peek === a.ref.version_id ? '■' : '▶'}
              </button>
            )}
            {(a.jenis === 'sfx' || a.jenis === 'musik' || a.jenis === 'vo') && (
              <button className="tiny" aria-label={`${sound.playing === a.ref.version_id ? 'Hentikan' : 'Dengar'} aset ${a.id}`} aria-pressed={sound.playing === a.ref.version_id} onClick={() => sound.toggle(a.ref.version_id)}>
                {sound.playing === a.ref.version_id ? '■' : '▶'}
              </button>
            )}
            <span className="badge vio">{KINDS.find((k) => k.id === a.jenis)?.label}</span>
            {a.jenis === 'penutup' &&
              (draft.outro.ref?.version_id === a.ref.version_id ? (
                <span className="badge ok" aria-label={`${a.id} penutup default`}>★ Penutup default</span>
              ) : (
                <button className="tiny" aria-label={`Jadikan ${a.id} penutup default`} title="Penutup default = slot Penutup Brand Kit (bagian B): dipakai mesin kalau Buat video tidak memilih yang lain" onClick={() => set({ outro: { ...draft.outro, ref: { ...a.ref } } })}>
                  ☆ Jadikan penutup default
                </button>
              ))}
            {a.jenis === 'logo' &&
              (draft.logo?.ref.version_id === a.ref.version_id ? (
                <span className="badge ok" aria-label={`${a.id} logo default`}>★ Logo default</span>
              ) : (
                <button
                  className="tiny"
                  aria-label={`Jadikan ${a.id} logo default`}
                  title="Logo default = logo Brand Kit (bagian B): dipakai tombol Logo di Editor dan pasang logo otomatis"
                  onClick={() => set({ logo: { ref: { ...a.ref }, corner: draft.logo?.corner ?? 'tr', size: draft.logo?.size ?? 18, opacity: draft.logo?.opacity ?? 1, show: draft.logo?.show ?? 'sepanjang' } })}
                >
                  ☆ Jadikan logo default
                </button>
              ))}
            <input aria-label={`ID aset ${i + 1}`} maxLength={40} value={a.id} onChange={(e) => setAsset(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} style={{ width: 130 }} />
            <span className="muted small ellipsis" title={names.get(a.ref.version_id) ?? a.ref.version_id}>
              {names.get(a.ref.version_id) ?? 'file'} · ${a.jenis}:{a.id}
            </span>
            <select aria-label={`Jenis aset ${i + 1}`} value={a.jenis} onChange={(e) => setAsset(i, { jenis: e.target.value as BrandAsset['jenis'] })}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <label className="inline small" title="Juga tampil di brand lain (filenya tetap milik brand ini)">
              <input type="checkbox" aria-label={`Semua brand ${a.id}`} checked={!!a.semua_brand} onChange={(e) => setAsset(i, e.target.checked ? { semua_brand: true } : { semua_brand: undefined })} /> semua brand
            </label>
            <button className="tiny" aria-label={`Hapus aset ${a.id}`} onClick={() => set({ aset: draft.aset.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
          {peek === a.ref.version_id && <VideoPeekRow api={api} versionId={a.ref.version_id} />}
          {a.jenis === 'font' && <FontSample api={api} versionId={a.ref.version_id} text={`${a.nama || a.id} — Aa Bb 123 Diskon 50%!`} />}
          {a.jenis === 'lut' && <LutSwatch api={api} versionId={a.ref.version_id} />}
          <div className="inspGrid">
            <label>
              Tag (pisah koma)
              <input aria-label={`Tag aset ${i + 1}`} value={a.tag.join(', ')} onChange={(e) => setAsset(i, { tag: e.target.value.split(',').map((t) => t.trimStart().toLowerCase()) })} />
              {SUGGESTED[a.jenis] && (
                <span className="row wrap" style={{ gap: 4 }}>
                  {SUGGESTED[a.jenis]!.filter((t) => !a.tag.includes(t)).map((t) => (
                    <button key={t} className="chip tiny" aria-label={`Tambah tag ${t} ke ${a.id}`} onClick={() => setAsset(i, { tag: [...a.tag.filter(Boolean), t] })}>
                      + {t}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <label>
              Status lisensi
              <select
                aria-label={`Status lisensi ${i + 1}`}
                value={a.lisensi.status}
                onChange={(e) => {
                  const status = e.target.value as BrandAsset['lisensi']['status'];
                  setAsset(i, { lisensi: { ...a.lisensi, status, iklan: canAds(status) ? a.lisensi.iklan : false } });
                }}
              >
                {STATUS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bukti / sumber lisensi
              <input aria-label={`Bukti lisensi ${i + 1}`} maxLength={300} placeholder="link / no. invoice" value={a.lisensi.bukti} onChange={(e) => setAsset(i, { lisensi: { ...a.lisensi, bukti: e.target.value } })} />
            </label>
            <label className="inline">
              <input type="checkbox" aria-label={`Boleh untuk iklan ${i + 1}`} disabled={!canAds(a.lisensi.status)} checked={a.lisensi.iklan} onChange={(e) => setAsset(i, { lisensi: { ...a.lisensi, iklan: e.target.checked } })} /> Boleh untuk iklan
            </label>
            {a.jenis === 'musik' && (
              <>
                <label>
                  Mood
                  <input aria-label={`Mood ${i + 1}`} maxLength={40} value={a.mood} onChange={(e) => setAsset(i, { mood: e.target.value })} />
                </label>
                <label>
                  BPM
                  <input type="number" aria-label={`BPM ${i + 1}`} min={20} max={300} value={a.bpm ?? ''} onChange={(e) => setAsset(i, { bpm: e.target.value ? Number(e.target.value) : null })} />
                </label>
                <label className="inline">
                  <input type="checkbox" aria-label={`Instrumental ${i + 1}`} checked={a.instrumental !== false} onChange={(e) => setAsset(i, { instrumental: e.target.checked })} /> Instrumental (tanpa lirik)
                </label>
              </>
            )}
            {a.jenis === 'broll' && (
              <>
                <label>
                  Produk
                  <select aria-label={`Produk b-roll ${i + 1}`} value={a.produk} onChange={(e) => setAsset(i, { produk: e.target.value, varian: '' })}>
                    <option value="">—</option>
                    {draft.produk
                      .filter((p) => p.nama.trim())
                      .map((p) => (
                        <option key={p.nama} value={p.nama.trim()}>
                          {p.nama}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Varian
                  <select aria-label={`Varian b-roll ${i + 1}`} value={a.varian} onChange={(e) => setAsset(i, { varian: e.target.value })}>
                    <option value="">—</option>
                    {(draft.produk.find((p) => p.nama.trim() === a.produk)?.varian ?? []).filter(Boolean).map((v) => (
                      <option key={v} value={v.trim()}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline">
                  <input type="checkbox" aria-label={`Ada teks bawaan ${i + 1}`} checked={a.ada_teks_bawaan} onChange={(e) => setAsset(i, { ada_teks_bawaan: e.target.checked })} /> Ada teks bawaan di video
                </label>
              </>
            )}
          </div>
        </div>
      ))}
      {(kind === '' || (kind as string) === 'preset_teks') && presetTeks.length > 0 && (
        <div className="assetRow" role="group" aria-label="Preset teks brand">
          <b className="small">Preset teks ({presetTeks.length})</b>
          {presetTeks.map((p, i) => (
            <div key={p.id} className="row wrap" role="group" aria-label={`Preset teks ${p.id}`} style={{ gap: 6, alignItems: 'center' }}>
              <span className="presetSwatch" style={{ color: p.style.color ?? '#fff', background: p.style.bg ?? '#2a2f42', fontWeight: p.style.bold === false ? 400 : 800 }} aria-hidden="true">
                Aa
              </span>
              <input aria-label={`Nama preset ${p.id}`} maxLength={60} value={p.nama} onChange={(e) => set({ preset_teks: presetTeks.map((x, j) => (j === i ? { ...x, nama: e.target.value } : x)) })} />
              <span className="muted small ellipsis" title={p.teks}>
                {p.track === 'subtitle' ? 'Subtitle' : 'Teks'} · “{p.teks}”
              </span>
              <label className="inline small">
                <input type="checkbox" aria-label={`Semua brand preset ${p.id}`} checked={!!p.semua_brand} onChange={(e) => set({ preset_teks: presetTeks.map((x, j) => (j === i ? (e.target.checked ? { ...x, semua_brand: true as const } : (({ semua_brand: _s, ...rest }) => rest)(x)) : x)) })} /> semua brand
              </label>
              <button className="tiny" aria-label={`Hapus preset ${p.id}`} onClick={() => set({ preset_teks: presetTeks.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** R38a: ▶ of a video asset — small looping muted preview. */
function VideoPeekRow({ api, versionId }: { api: Api; versionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.streamUrl(versionId).then((r) => live && setUrl(r.url), () => undefined);
    return () => {
      live = false;
    };
  }, [api, versionId]);
  return <span className="libPeek">{url && <video src={url} muted autoPlay loop playsInline aria-label="Pratinjau video aset" />}</span>;
}
