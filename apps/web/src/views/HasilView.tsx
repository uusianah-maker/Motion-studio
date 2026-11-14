import { useCallback, useEffect, useRef, useState } from 'react';
import { type Api, type OutputItem } from '../api';
import { formatBytes, formatDate } from '../lib';
import { ErrorNotice } from '../ui';

/**
 * Halaman Hasil (owner 14 Nov): semua video hasil render dari semua proyek di satu tempat.
 * Aplikasi = pintu input/output; tim mengunduh hasilnya untuk dikerjakan lanjut di PC masing-masing.
 * Read-only untuk semua peran; unduh memakai link bertanda tangan yang sama dengan jendela Render.
 */
const key = (o: OutputItem) => `${o.project_id}/${o.name}`;
const HALAMAN = 100;

export function HasilView({ api, active = true, onOpenProject }: { api: Api; active?: boolean; onOpenProject: (id: string) => void }) {
  const [items, setItems] = useState<OutputItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(HALAMAN);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.allOutputs({ q: q.trim() || undefined, limit });
      setItems(r.outputs);
      setTotal(r.total);
      setSelected((s) => new Set([...s].filter((k) => r.outputs.some((o) => key(o) === k))));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, q, limit]);

  // Muat ulang saat dibuka lagi (halaman ini tetap hidup saat pindah menu) dan saat pencarian berubah.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void load();
    wasActive.current = active;
  }, [active, load]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const unduh = async (o: OutputItem) => {
    const { url } = await api.outputUrl(o.project_id, o.name, true);
    const a = document.createElement('a');
    a.href = url;
    a.download = o.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const unduhSatu = async (o: OutputItem) => {
    setBusy(key(o));
    setError(null);
    try {
      await unduh(o);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const unduhPilihan = async () => {
    const list = (items ?? []).filter((o) => selected.has(key(o)));
    setBusy('pilihan');
    setError(null);
    setNote(null);
    try {
      for (const [i, o] of list.entries()) {
        setNote(`Mengunduh ${i + 1}/${list.length}: ${o.name}`);
        await unduh(o);
        await new Promise((r) => setTimeout(r, 800)); // browser butuh jeda antar unduhan
      }
      setNote(`${list.length} file dikirim ke folder Unduhan di komputer ini.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const semua = (items ?? []).length > 0 && (items ?? []).every((o) => selected.has(key(o)));

  return (
    <>
      <header className="top">
        <h1>Hasil</h1>
        <span className="muted">{items ? `${total} video` : '…'}</span>
        <div className="spacer" />
        <button className="btn primary" disabled={selected.size === 0 || busy !== null} onClick={() => void unduhPilihan()}>
          ⤓ Unduh yang dipilih {selected.size > 0 ? `(${selected.size})` : ''}
        </button>
      </header>
      <div className="body">
        <div className="notice info">
          Semua video hasil render dari semua proyek, terbaru di atas. File tersimpan di PC kantor; tombol Unduh menyalinnya ke komputer
          kamu untuk dikerjakan lanjut. Video berlabel <b>UJI</b> memakai musik tanpa lisensi iklan — jangan dipakai untuk iklan.
        </div>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <input
            aria-label="Cari hasil"
            placeholder="Cari nama video atau proyek, mis. varian-003 atau KORSET"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(HALAMAN);
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
        </div>
        <ErrorNotice error={error} />
        {note && (
          <div className="notice ok" role="status">
            {note}
          </div>
        )}
        {items && items.length === 0 ? (
          <div className="empty">{q ? 'Tidak ada hasil yang cocok.' : 'Belum ada video hasil render.'}</div>
        ) : (
          <div className="card">
            <table className="list" aria-label="Daftar hasil render">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      aria-label="Pilih semua"
                      checked={semua}
                      onChange={() => setSelected(semua ? new Set() : new Set((items ?? []).map(key)))}
                    />
                  </th>
                  <th>VIDEO</th>
                  <th className="hideNarrow">PROYEK</th>
                  <th>UKURAN</th>
                  <th className="hideNarrow">SELESAI</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((o) => (
                  <tr key={key(o)}>
                    <td>
                      <input type="checkbox" aria-label={`Pilih ${o.name}`} checked={selected.has(key(o))} onChange={() => toggle(key(o))} />
                    </td>
                    <td className="cellName">
                      <b>
                        {o.name}
                        {o.variant?.uji && (
                          <span className="badge bad" style={{ marginLeft: 6 }} title="Musik tanpa lisensi iklan: hanya untuk uji">
                            UJI
                          </span>
                        )}
                      </b>
                      <small className="muted">{o.project_name}</small>
                    </td>
                    <td className="hideNarrow">
                      <button className="linkBtn" onClick={() => onOpenProject(o.project_id)} title="Buka proyek di Editor">
                        {o.project_name}
                      </button>
                    </td>
                    <td>{formatBytes(o.size)}</td>
                    <td className="hideNarrow">{formatDate(o.mtime_ms)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small" disabled={busy !== null} onClick={() => void unduhSatu(o)} aria-label={`Unduh ${o.name}`}>
                        {busy === key(o) ? 'Menyiapkan…' : '⤓ Unduh'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items && total > items.length && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button className="btn" onClick={() => setLimit((l) => l + HALAMAN)}>
              Tampilkan lebih banyak ({items.length} dari {total})
            </button>
          </div>
        )}
      </div>
    </>
  );
}
