import { useEffect, useRef, useState } from 'react';
import type { Api, BrandAsset, BrandKit } from '../api';
import { Modal } from '../ui';
import { kitInput } from './OverlayPicker';

/** `default` = the Brand Kit outro, `none` = no end card, else a media version id. */
export type PenutupValue = 'default' | 'none' | string;
export interface PenutupOption {
  value: string;
  ref: { media_id: string; version_id: string };
  label: string;
}

const VIDEO_RE = /\.(mp4|mov|webm)$/i;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'penutup';

/** End-card files of a kit: its library "Penutup" assets (+ the Brand Kit outro if not among them). */
export function penutupOptions(kit: BrandKit | null): PenutupOption[] {
  if (!kit) return [];
  const out = kit.aset.filter((a) => a.jenis === 'penutup').map((a) => ({ value: a.ref.version_id, ref: a.ref, label: a.nama || a.id }));
  if (kit.outro.ref && !out.some((o) => o.value === kit.outro.ref!.version_id)) out.unshift({ value: kit.outro.ref.version_id, ref: kit.outro.ref, label: 'Penutup default brand' });
  return out;
}

/** Small looping preview of the chosen end card (muted). */
export function PenutupPreview({ api, versionId }: { api: Api; versionId: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (versionId)
      api
        .streamUrl(versionId)
        .then((r) => live && setUrl(r.url))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, versionId]);
  if (!versionId) return null;
  return <span className="assetThumb penutupThumb">{url ? <video src={url} muted loop autoPlay playsInline aria-label="Pratinjau penutup" /> : null}</span>;
}

/**
 * R28 "Video penutup": choose the end card — the brand default, one from the library (Brand →
 * Aset, kategori Penutup), a new upload (kept in that library), or none.
 */
export function PenutupPicker({ api, kit, value, onChange, onKitSaved, allowDefault = true, allowNone = true }: { api: Api; kit: BrandKit | null; value: PenutupValue; onChange: (v: PenutupValue, opt: PenutupOption | null) => void; onKitSaved?: (k: BrandKit) => void; allowDefault?: boolean; allowNone?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const opts = penutupOptions(kit);
  const def = kit?.outro.ref ?? null;
  const shownId = value === 'default' ? (def?.version_id ?? null) : value === 'none' ? null : value;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importFile(file, { kind: 'shared' });
      const ref = { media_id: r.media_id, version_id: r.version.version_id };
      const label = file.name.replace(/\.[a-z0-9]+$/i, '');
      if (kit?.brand_id) {
        const fresh = await api.brandById(kit.brand_id);
        const taken = new Set(fresh.aset.map((a) => a.id));
        let id = slug(file.name);
        for (let n = 2; taken.has(id); n++) id = `${slug(file.name)}-${n}`;
        const asset: BrandAsset = { id, ref, jenis: 'penutup', nama: label, tag: ['penutup'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true }, mood: '', bpm: null, instrumental: null, produk: '', varian: '', ada_teks_bawaan: false, catatan: '' };
        onKitSaved?.(await api.saveBrandById(fresh.brand_id, fresh.revision, { ...kitInput(fresh), aset: [...fresh.aset, asset] }));
      }
      onChange(ref.version_id, { value: ref.version_id, ref, label });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <div className="penutupPick" role="group" aria-label="Video penutup">
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <select
          aria-label="Pilih video penutup"
          value={value}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v, opts.find((o) => o.value === v) ?? null);
          }}
        >
          {allowDefault && <option value="default">{def ? 'Penutup default brand' : 'Default brand (belum ada penutup)'}</option>}
          {opts
            .filter((o) => !allowDefault || o.value !== def?.version_id)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          {allowNone && <option value="none">Tanpa penutup</option>}
        </select>
        <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Mengunggah…' : '⇪ Unggah penutup baru'}
        </button>
        <input ref={fileRef} type="file" hidden accept="video/mp4,video/quicktime,video/webm" aria-label="File penutup baru" onChange={(e) => void upload(e.target.files?.[0])} />
        <PenutupPreview api={api} versionId={shownId} />
      </div>
      {kit?.brand_id && <span className="muted small">Unggahan baru disimpan di Brand → Aset (kategori Penutup).</span>}
      {error && <div className="notice err small">{error}</div>}
    </div>
  );
}

export const isVideoName = (name: string) => VIDEO_RE.test(name);

/** R28 Editor "＋ Penutup": pick an end card, then it goes right after the last video clip. */
export function PenutupDialog({ api, kit, onPick, onClose, onKitSaved }: { api: Api; kit: BrandKit | null; onPick: (o: PenutupOption) => void; onClose: () => void; onKitSaved?: (k: BrandKit) => void }) {
  const first = kit?.outro.ref ? kit.outro.ref.version_id : (penutupOptions(kit)[0]?.value ?? 'none');
  const [value, setValue] = useState<PenutupValue>(first);
  const [opt, setOpt] = useState<PenutupOption | null>(penutupOptions(kit).find((o) => o.value === first) ?? null);
  return (
    <Modal title="Tambah video penutup" onClose={onClose}>
      <PenutupPicker
        api={api}
        kit={kit}
        value={value}
        allowDefault={false}
        allowNone={false}
        onChange={(v, o) => {
          setValue(v);
          setOpt(o);
        }}
        {...(onKitSaved ? { onKitSaved } : {})}
      />
      {!opt && <div className="muted small">Belum ada video penutup di Aset brand. Unggah dulu (tersimpan di Brand → Aset, kategori Penutup).</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={!opt} onClick={() => opt && onPick(opt)}>
          Taruh di akhir video
        </button>
        <button className="btn" onClick={onClose}>
          Batal
        </button>
      </div>
    </Modal>
  );
}
