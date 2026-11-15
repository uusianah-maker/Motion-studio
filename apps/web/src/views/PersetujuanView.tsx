import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, ApprovalItem, BrandKit, Role } from '../api';
import { formatDate } from '../lib';
import { ErrorNotice } from '../ui';

/**
 * R10: the PIC's approval screen. Every rendered video waiting for a decision (all projects of one
 * brand, or all brands), played right here, decided with the existing review: Setujui (Lulus) or
 * Revisi + note. Keyboard: J / ↓ next, K / ↑ previous, A Setujui, R write a revision note,
 * Ctrl+Enter sends it, Space play / pause.
 */
const STATE: Record<ApprovalItem['state'], string> = { belum: 'Baru', berubah: 'Diubah sejak keputusan', lulus: 'Lulus', revisi: 'Revisi' };

export function PersetujuanView({ api, role = 'owner', active = true, onOpenProject }: { api: Api; role?: Role; active?: boolean; onOpenProject: (id: string) => void }) {
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [pick, setPick] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const canDecide = role === 'owner' || role === 'reviewer';

  useEffect(() => {
    void api.brands().then((r) => setBrands(r.brands), setError);
  }, [api]);
  const load = useCallback(async () => {
    try {
      const r = await api.approvalQueue(brandId || undefined);
      setItems(r);
      setPick((p) => Math.min(p, Math.max(0, r.length - 1)));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, brandId]);
  // Reload when the page is shown again (it stays mounted) and when the brand filter changes.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const item = items?.[pick] ?? null;
  // The video shown is named by this key; `item` itself is a new object on every reload.
  const itemKey = item ? `${item.project_id}/${item.output.name}/${item.revision}` : '';
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    setUrl(null);
    setNote('');
    const it = itemRef.current;
    if (!it) return;
    let stale = false;
    void api.outputUrl(it.project_id, it.output.name).then(
      (r) => !stale && setUrl(r.url),
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, itemKey]);

  const decide = async (status: 'lulus' | 'revisi') => {
    if (!item || !canDecide || busy) return;
    if (status === 'revisi' && !note.trim()) {
      noteRef.current?.focus();
      return setError(new Error('Tulis dulu apa yang perlu direvisi.'));
    }
    setBusy(true);
    setError(null);
    try {
      await api.decideReview(item.project_id, item.revision, status, status === 'revisi' ? note.trim() : undefined);
      setDone(`${item.name}: ${status === 'lulus' ? 'disetujui' : 'dikembalikan untuk revisi'}.`);
      await load(); // the decided video leaves the list; the next one is shown
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcuts (not while typing in a field).
  const latest = useRef({ items, pick, decide });
  latest.current = { items, pick, decide };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
      const { items: list, pick: at, decide: go } = latest.current;
      if (typing) {
        if (t?.getAttribute('aria-label') === 'Catatan revisi' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void go('revisi');
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || !list?.length) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || e.key === 'ArrowDown') setPick(Math.min(at + 1, list.length - 1));
      else if (k === 'k' || e.key === 'ArrowUp') setPick(Math.max(at - 1, 0));
      else if (k === 'a') void go('lulus');
      else if (k === 'r') noteRef.current?.focus();
      else if (e.key === ' ' && videoRef.current) {
        if (videoRef.current.paused) void videoRef.current.play().catch(() => undefined);
        else videoRef.current.pause();
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return (
    <>
      <header className="top">
        <h1>Persetujuan</h1>
        <span className="muted">{items ? `${items.length} video menunggu` : '…'}</span>
        <div className="spacer" />
        <select aria-label="Brand persetujuan" className="smallbtn" value={brandId} onChange={(e) => (setBrandId(e.target.value), setPick(0))}>
          <option value="">Semua brand</option>
          {brands.map((b) => (
            <option key={b.brand_id} value={b.brand_id}>
              {b.name} ({b.kode})
            </option>
          ))}
        </select>
      </header>
      <div className="body approvals">
        <ErrorNotice error={error} />
        {done && (
          <div className="notice ok small" role="status">
            {done}
          </div>
        )}
        {!canDecide && <div className="notice info small">Peran Editor: bisa melihat antrean; Setujui / Revisi oleh Owner atau Reviewer (PIC).</div>}
        {items && items.length === 0 && <div className="empty">Tidak ada video yang menunggu persetujuan.</div>}
        {items && items.length > 0 && (
          <div className="approvalGrid">
            <ul className="approvalList" role="listbox" aria-label="Video menunggu persetujuan">
              {items.map((it, i) => (
                <li key={`${it.project_id}/${it.output.name}`} role="option" aria-selected={i === pick} className={i === pick ? 'sel' : ''} onClick={() => setPick(i)}>
                  <b>{it.name}</b>
                  <small className="muted">
                    {it.brand_name ?? 'Brand bawaan'} · {formatDate(it.output.mtime_ms)}
                  </small>
                  <span className="row wrap" style={{ gap: 4 }}>
                    <span className={`badge ${it.state === 'berubah' ? 'warn' : ''}`}>{STATE[it.state]}</span>
                    {it.variant && <span className="badge">V{it.variant.number}</span>}
                    {it.variant?.uji && <span className="badge bad">UJI</span>}
                    {it.open_comments > 0 && <span className="badge warn">{it.open_comments} komentar terbuka</span>}
                  </span>
                </li>
              ))}
            </ul>
            {item && (
              <section className="card approvalPlayer" aria-label="Video yang dinilai">
                <h2 style={{ margin: 0 }}>{item.name}</h2>
                <p className="muted small" style={{ margin: 0 }}>
                  {item.output.name} · revisi proyek {item.revision}
                  {item.outputs > 1 ? ` · ${item.outputs} file render (yang terbaru diputar)` : ''}
                </p>
                {url ? <video ref={videoRef} key={url} src={url} controls playsInline aria-label="Video hasil render" className="approvalVideo" /> : <div className="muted">Memuat video…</div>}
                {item.last && (
                  <div className="notice small">
                    Keputusan sebelumnya: <b>{item.last.status === 'lulus' ? 'Lulus' : 'Revisi'}</b>
                    {item.last.by ? ` oleh ${item.last.by}` : ''}
                    {item.last.note ? ` — “${item.last.note}”` : ''}
                  </div>
                )}
                {item.open_comments > 0 && <div className="notice warn small">Masih ada {item.open_comments} komentar terbuka di Editor; Setujui bisa ditolak sampai komentar diselesaikan.</div>}
                <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <button className="btn primary" disabled={!canDecide || busy} onClick={() => void decide('lulus')} title="Setujui (A)">
                    ✓ Setujui <kbd>A</kbd>
                  </button>
                  <button className="linkBtn small" onClick={() => onOpenProject(item.project_id)}>
                    buka di Editor
                  </button>
                </div>
                <label className="small" style={{ display: 'grid', gap: 4 }}>
                  Catatan revisi (wajib untuk Revisi)
                  <textarea ref={noteRef} aria-label="Catatan revisi" rows={3} maxLength={1000} value={note} disabled={!canDecide} onChange={(e) => setNote(e.target.value)} placeholder="mis. hook kurang jelas di detik 0–2; logo menutupi produk" />
                </label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button className="btn" disabled={!canDecide || busy} onClick={() => void decide('revisi')} title="Revisi (R untuk menulis catatan, Ctrl+Enter untuk kirim)">
                    ↺ Revisi <kbd>Ctrl+Enter</kbd>
                  </button>
                  <span className="muted small">Pintasan: J/K atau ↓/↑ pindah video · A setujui · R tulis catatan · Spasi putar/jeda</span>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
