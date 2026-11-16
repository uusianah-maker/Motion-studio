import { useRef, useState } from 'react';
import type { Api, BrandAsset, BrandKit, BrandKitInput } from '../api';
import { Modal } from '../ui';
import { AssetThumb, KIND_LABEL, OVERLAY_KINDS } from './AssetLibrary';

export type OverlayPick = { ref: { media_id: string; version_id: string }; jenis: BrandAsset['jenis']; nama: string; sepanjang: boolean };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'gambar';

/** The editable part of a stored kit (what the save endpoint takes). */
export function kitInput(k: BrandKit): BrandKitInput {
  const stored = new Set(['schema_version', 'brand_id', 'revision', 'updated_at']);
  return Object.fromEntries(Object.entries(k).filter(([key]) => !stored.has(key))) as unknown as BrandKitInput;
}

/** Overlay pictures of a kit: its library logos / watermarks / stickers / frames (+ the default logo). */
export function overlayAssets(kit: BrandKit | null): { ref: { media_id: string; version_id: string }; jenis: BrandAsset['jenis']; nama: string; utama: boolean }[] {
  if (!kit) return [];
  const out = kit.aset.filter((a) => OVERLAY_KINDS.includes(a.jenis)).map((a) => ({ ref: a.ref, jenis: a.jenis, nama: a.nama || a.id, utama: kit.logo?.ref.version_id === a.ref.version_id }));
  if (kit.logo && !out.some((a) => a.utama)) out.unshift({ ref: kit.logo.ref, jenis: 'logo', nama: 'Logo default', utama: true });
  return out;
}

/**
 * R26: pick an overlay picture — from the brand's asset library (Brand → Aset) or a new upload,
 * which is kept permanently in that library (chosen category) so it can be reused in every video.
 */
export function OverlayPicker({ api, kit, onPick, onClose, onKitSaved }: { api: Api; kit: BrandKit | null; onPick: (p: OverlayPick) => void; onClose: () => void; onKitSaved?: (k: BrandKit) => void }) {
  const [jenis, setJenis] = useState<BrandAsset['jenis']>('stiker');
  const [sepanjang, setSepanjang] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const list = overlayAssets(kit);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importFile(file, { kind: 'shared' });
      const ref = { media_id: r.media_id, version_id: r.version.version_id };
      const nama = file.name.replace(/\.[a-z0-9]+$/i, '');
      if (kit?.brand_id) {
        // Keep it in the library (merged into the kit as stored now).
        const fresh = await api.brandById(kit.brand_id);
        const taken = new Set(fresh.aset.map((a) => a.id));
        let id = slug(file.name);
        for (let n = 2; taken.has(id); n++) id = `${slug(file.name)}-${n}`;
        const asset: BrandAsset = { id, ref, jenis, nama, tag: [], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true }, mood: '', bpm: null, instrumental: null, produk: '', varian: '', ada_teks_bawaan: false, catatan: '' };
        const saved = await api.saveBrandById(fresh.brand_id, fresh.revision, { ...kitInput(fresh), aset: [...fresh.aset, asset] });
        onKitSaved?.(saved);
      }
      onPick({ ref, jenis, nama, sepanjang });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Modal title="Tambah overlay" onClose={onClose} busy={busy}>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="inline">
          <input type="radio" name="ovdur" aria-label="Overlay sepanjang video" checked={sepanjang} onChange={() => setSepanjang(true)} /> Sepanjang video
        </label>
        <label className="inline">
          <input type="radio" name="ovdur" aria-label="Overlay detik tertentu" checked={!sepanjang} onChange={() => setSepanjang(false)} /> Mulai di playhead (3 dtk, bisa ditarik)
        </label>
      </div>
      <b className="small">Dari Aset brand{kit ? ` · ${kit.name}` : ''}</b>
      {list.length ? (
        <div className="overlayPick" role="group" aria-label="Gambar overlay brand">
          {list.map((a) => (
            <button key={a.ref.version_id} className="btn small" disabled={busy} aria-label={`Pakai ${a.nama}`} onClick={() => onPick({ ref: a.ref, jenis: a.jenis, nama: a.nama, sepanjang })}>
              <AssetThumb api={api} versionId={a.ref.version_id} label={a.nama} size={64} />
              <span className="small">{a.nama}</span>
              <span className="muted small">{a.utama ? '★ default' : KIND_LABEL(a.jenis)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="muted small">Belum ada logo/watermark/stiker/frame di Aset brand. Unggah di bawah (tersimpan permanen di Brand → Aset).</div>
      )}
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <select aria-label="Kategori gambar baru" value={jenis} onChange={(e) => setJenis(e.target.value as BrandAsset['jenis'])}>
          {OVERLAY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL(k)}
            </option>
          ))}
        </select>
        <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Mengunggah…' : '⇪ Unggah gambar baru'}
        </button>
        <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="File overlay baru" onChange={(e) => void upload(e.target.files?.[0])} />
        <span className="muted small">PNG transparan disarankan{kit?.brand_id ? '; disimpan ke Aset brand' : ''}</span>
      </div>
      {error && <div className="notice err small">{error}</div>}
    </Modal>
  );
}
