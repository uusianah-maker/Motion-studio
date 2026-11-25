import { useRef, useState } from 'react';
import type { Api, BrandAsset, EditOp, Media, Project } from '../api';
import { useSoundPreview } from '../audioPreview';
import { formatDuration } from '../lib';
import { Modal } from '../ui';
import { freeOn } from './LibraryPanel';

/**
 * 25 Nov (owner: "pada timeline editing di tambahkan tools penambahan sound effect"): "＋ SFX" on
 * the timeline toolbar. Pick a sound from the brand's SFX library (search / tag / ▶ listen) or
 * upload one from the computer (kept in this project's Media); it lands on the SFX track at the
 * playhead (next free spot). One pick = one edit = one undo; the clip can then be moved/trimmed.
 */
export function SfxPicker({ api, project, media, sfx, playhead, onAdd, onClose }: { api: Api; project: Project; media: readonly Media[]; sfx: readonly BrandAsset[]; playhead: number; onAdd: (ops: EditOp[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sound = useSoundPreview(api);
  const needle = q.trim().toLowerCase();
  const tags = [...new Set(sfx.flatMap((a) => a.tag))].sort();
  const shown = sfx.filter((a) => !needle || a.tag.some((t) => t.includes(needle)) || a.id.includes(needle) || (a.nama || '').toLowerCase().includes(needle));
  const durOf = (vid: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === vid)?.probe?.duration_ms;
  const add = (ref: { media_id: string; version_id: string }, known?: number) => {
    const len = Math.max(100, Math.min(known ?? durOf(ref.version_id) ?? 1000, 30_000));
    onAdd([{ op: 'add_clip', track_kind: 'sfx', media: ref, start_ms: freeOn(project, 'sfx', playhead, len), duration_ms: len }]);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setBusy(`Upload ${f.name}…`);
    try {
      const r = await api.importFile(f, { kind: 'project', project_id: project.project_id }, (x) => setBusy(`Upload ${f.name} · ${Math.round(x * 100)}%`));
      if (!r.version.probe?.audio_codec) throw new Error('File ini tidak berisi suara. Pilih file audio (mp3, wav, m4a).');
      add({ media_id: r.media_id, version_id: r.version.version_id }, r.version.probe.duration_ms);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };
  return (
    <Modal title="Tambah sound effect" onClose={onClose} busy={!!busy}>
      <p className="muted small">Masuk ke track SFX di playhead {formatDuration(playhead)} (atau tempat kosong berikutnya). Setelah itu bisa digeser, dipotong, dan diatur volumenya.</p>
      <input aria-label="Cari SFX" placeholder="Cari tag / nama (mis. teks-muncul, transisi)" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {tags.length > 0 && (
        <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
          {tags.map((t) => (
            <button key={t} className={`chip tiny${needle === t ? ' on' : ''}`} aria-label={`Saring tag ${t}`} onClick={() => setQ(needle === t ? '' : t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
      <div className="libList sfxPickList" role="list" aria-label="Daftar SFX">
        {!sfx.length && <div className="muted small">Belum ada SFX di Aset brand. Upload file sendiri di bawah, atau tambah di Brand → Aset (jenis SFX).</div>}
        {sfx.length > 0 && !shown.length && <div className="muted small">Tidak ada SFX dengan tag/nama itu.</div>}
        {shown.map((a) => (
          <div key={a.id} className="libRow" role="listitem" aria-label={`SFX ${a.id}`}>
            <button className="tiny" aria-label={`${sound.playing === a.ref.version_id ? 'Hentikan' : 'Dengar'} ${a.id}`} aria-pressed={sound.playing === a.ref.version_id} onClick={() => sound.toggle(a.ref.version_id)}>
              {sound.playing === a.ref.version_id ? '■' : '▶'}
            </button>
            <span className="libName" title={a.tag.map((t) => `#${t}`).join(' ')}>
              {a.nama || a.id}
              {a.tag.length > 0 && <span className="muted small"> · {a.tag.join(', ')}</span>}
            </span>
            {durOf(a.ref.version_id) !== undefined && <span className="muted small">{formatDuration(durOf(a.ref.version_id)!)}</span>}
            <button className="btn small" disabled={!!busy} aria-label={`Tambah ${a.id} di playhead`} onClick={() => add(a.ref)}>
              ＋ Pakai
            </button>
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button className="btn small" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          ⇪ Upload SFX dari komputer
        </button>
        <input ref={fileRef} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.ogg" aria-label="File SFX baru" onChange={(e) => void upload(e.target.files?.[0])} />
        {busy && <span className="muted small" role="status">{busy}</span>}
      </div>
      {error && <div className="notice warn small">{error}</div>}
    </Modal>
  );
}
