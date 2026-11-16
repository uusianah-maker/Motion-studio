import { useRef, useState } from 'react';
import type { Api, BrandAsset, BrandKitInput, Media } from '../api';

const KINDS: { id: BrandAsset['jenis']; label: string }[] = [
  { id: 'sfx', label: 'SFX' },
  { id: 'musik', label: 'Musik' },
  { id: 'broll', label: 'B-roll' },
  { id: 'logo', label: 'Logo' },
  { id: 'penutup', label: 'Penutup' },
  { id: 'vo', label: 'VO (suara)' },
  { id: 'lainnya', label: 'Lainnya' },
];
const STATUS: { id: BrandAsset['lisensi']['status']; label: string }[] = [
  { id: 'milik_sendiri', label: 'Milik sendiri' },
  { id: 'berlisensi', label: 'Berlisensi' },
  { id: 'tanpa_lisensi', label: 'Tanpa lisensi' },
  { id: 'belum_dicek', label: 'Belum dicek' },
];
/** Event tags the automation engine looks for (KONTRAK-ENGINE / U2). */
const SUGGESTED: Record<string, string[]> = { sfx: ['teks-muncul', 'kata-kunci', 'transisi', 'penutup'], musik: ['ceria', 'santai', 'energik', 'elegan'], broll: ['detail-bahan', 'try-on', 'packing', 'lifestyle'] };
const ACCEPT: Record<string, string> = { sfx: 'audio/*,.wav,.mp3,.m4a', musik: 'audio/*,.wav,.mp3,.m4a', broll: 'video/*,image/*', logo: 'image/png,image/jpeg,image/webp', penutup: 'video/*,image/*', vo: 'audio/*,.wav,.mp3,.m4a', lainnya: '*/*' };
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'aset';
const canAds = (s: BrandAsset['lisensi']['status']) => s === 'milik_sendiri' || s === 'berlisensi';

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
  const names = new Map(media.map((m) => [m.current_version_id, m.display_name]));
  const shown = draft.aset.map((a, i) => ({ a, i })).filter(({ a }) => (!kind || a.jenis === kind) && (!q.trim() || a.tag.some((t) => t.includes(q.trim().toLowerCase())) || a.id.includes(q.trim().toLowerCase())));
  const setAsset = (i: number, patch: Partial<BrandAsset>) => set({ aset: draft.aset.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const uniqueId = (base: string, taken: Set<string>) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    const jenis = kind || 'sfx';
    const apply = later();
    const added: BrandAsset[] = [];
    try {
      for (const f of Array.from(files)) {
        const r = await api.importFile(f, { kind: 'shared' });
        added.push({
          id: slug(f.name),
          ref: { media_id: r.media_id, version_id: r.version.version_id },
          jenis,
          nama: f.name.replace(/\.[a-z0-9]+$/i, ''),
          tag: [],
          lisensi: { status: 'belum_dicek', bukti: '', iklan: false },
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
    }
  };

  return (
    <div className="assetLib" role="group" aria-label="Library aset brand">
      <div className="row wrap" style={{ gap: 8 }}>
        <select aria-label="Saring jenis aset" value={kind} onChange={(e) => setKind(e.target.value as BrandAsset['jenis'])}>
          <option value="">Semua jenis ({draft.aset.length})</option>
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
      </div>
      {error && <div className="notice err small">{error}</div>}
      {draft.aset.length === 0 && <div className="muted small">Belum ada aset. Pilih jenis lalu unggah (mis. SFX pop + whoosh, musik berlisensi, b-roll produk).</div>}
      {shown.map(({ a, i }) => (
        <div key={i} className="assetRow" role="group" aria-label={`Aset ${a.id}`}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="badge vio">{KINDS.find((k) => k.id === a.jenis)?.label}</span>
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
            <button className="tiny" aria-label={`Hapus aset ${a.id}`} onClick={() => set({ aset: draft.aset.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
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
    </div>
  );
}
