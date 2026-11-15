import { useCallback, useEffect, useState } from 'react';
import type { Api, BackupInfo, Role } from '../api';
import { formatDate } from '../lib';
import { ErrorNotice } from '../ui';

/**
 * Footage backup (PRD §G) in Storage. The app never copies footage: the owner names a backup
 * folder (another drive) and "Verifikasi backup" checks it READ-ONLY by content hash in the
 * background; only proven copies count as backed up.
 */
export function BackupCard({ api, role, onVerified }: { api: Api; role: Role; onVerified?: () => void }) {
  const owner = role === 'owner';
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.backup());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a verification runs, look again every 2 s; tell the page when it ends (its stats change).
  const running = info?.verifikasi.state === 'berjalan';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void api.backup().then((b) => {
        setInfo(b);
        if (b.verifikasi.state !== 'berjalan') onVerified?.();
      }, setError);
    }, 2000);
    return () => clearInterval(t);
  }, [api, running, onVerified]);

  const act = async (fn: () => Promise<BackupInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await fn());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const v = info?.verifikasi;
  const nameOf = (id: string | null) => info?.lokasi.find((l) => l.location_id === id)?.nama ?? 'folder';

  return (
    <section className="card" aria-label="Backup footage">
      <h2>Backup footage</h2>
      <p className="muted small">App tidak menyalin footage. Salin sendiri ke drive lain, lalu daftarkan foldernya dan klik Verifikasi: file dicocokkan isinya (hash), tanpa diubah.</p>
      <ErrorNotice error={error} />
      {v && v.state !== 'idle' && (
        <div className={`notice small ${v.state === 'gagal' ? 'err' : ''}`} role="status" aria-label="Status verifikasi backup">
          {v.state === 'berjalan' && <>Memverifikasi {nameOf(v.location_id)}… (bisa lama untuk footage besar; boleh tinggalkan halaman ini)</>}
          {v.state === 'selesai' && v.hasil && (
            <>
              Verifikasi {nameOf(v.location_id)} selesai: {v.hasil.scanned} file diperiksa, {v.hasil.matched} versi media terbukti ada di backup.
            </>
          )}
          {v.state === 'gagal' && <>Verifikasi {nameOf(v.location_id)} gagal: {v.alasan}</>}
        </div>
      )}
      {info && info.lokasi.length === 0 && <div className="empty small">Belum ada folder backup terdaftar.</div>}
      {info && info.lokasi.length > 0 && (
        <table className="list" aria-label="Folder backup">
          <thead>
            <tr>
              <th>Folder</th>
              <th>Terbukti</th>
              <th>Terakhir diverifikasi</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {info.lokasi.map((l) => (
              <tr key={l.location_id}>
                <td title={l.path}>
                  <b>{l.nama}</b>
                  {l.path && <div className="muted small mono">{l.path}</div>}
                </td>
                <td>{l.terverifikasi} versi</td>
                <td>{l.terakhir ? formatDate(l.terakhir) : 'belum pernah'}</td>
                <td>
                  {owner && (
                    <button className="btn small" disabled={busy || running} aria-label={`Verifikasi backup ${l.nama}`} onClick={() => void act(() => api.backupVerify(l.location_id))}>
                      ✓ Verifikasi backup
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {owner ? (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <input aria-label="Path folder backup" className="grow" placeholder="mis. E:\\Backup-Footage" value={folder} maxLength={500} onChange={(e) => setFolder(e.target.value)} />
          <button
            className="btn"
            disabled={busy || !folder.trim()}
            onClick={() =>
              void act(async () => {
                const r = await api.backupAdd(folder.trim());
                setFolder('');
                return r;
              })
            }
          >
            ＋ Daftarkan folder backup
          </button>
        </div>
      ) : (
        <div className="muted small">Mendaftarkan dan memverifikasi folder backup dilakukan Owner.</div>
      )}
    </section>
  );
}
