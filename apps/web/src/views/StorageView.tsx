import { useCallback, useEffect, useState } from 'react';
import type { Api, Dashboard, Role } from '../api';
import { AREA_LABEL, formatBytes, formatDate, relativeDays } from '../lib';
import { ErrorNotice } from '../ui';
import { BackupCard } from './BackupCard';

export function StorageView({ api, role = 'owner' }: { api: Api; role?: Role }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setD(await api.dashboard());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const disk = d?.stats.disk;
  const usedPct = disk ? Math.round(((disk.total_bytes - disk.free_bytes) / Math.max(1, disk.total_bytes)) * 100) : 0;
  const now = Date.now();

  return (
    <>
      <header className="top">
        <h1>Storage</h1>
        <div className="spacer" />
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'Memuat…' : '↻ Muat ulang'}
        </button>
      </header>
      <div className="body">
        <ErrorNotice error={error} />
        {!d && !error && <div className="empty">Memuat dashboard…</div>}
        {d && (
          <>
            {d.stats.warnings.map((w) => (
              <div key={w.code} className="notice warn">
                {w.advice}
              </div>
            ))}
            {d.corrupt_journal > 0 && <div className="notice err">Ada {d.corrupt_journal} catatan operasi yang tidak terbaca. Auto Trash dan hapus permanen ditahan sampai diperiksa.</div>}
            {!d.gc.ok && <div className="notice err">Pemeriksaan GC dihentikan demi aman: {d.gc.errors.join('; ')}</div>}

            <div className="statGrid">
              <div className="stat">
                <small>Disk kosong</small>
                <b>{disk ? formatBytes(disk.free_bytes) : 'tidak terbaca'}</b>
                {disk && (
                  <div className="bar" aria-label={`Terpakai ${usedPct}%`}>
                    <span style={{ width: `${usedPct}%` }} />
                  </div>
                )}
              </div>
              <div className="stat">
                <small>Media asli</small>
                <b>{formatBytes(d.stats.media_bytes)}</b>
              </div>
              <div className="stat">
                <small>Trash</small>
                <b>{formatBytes(d.stats.usage.trash ?? 0)}</b>
                <small>{d.trash.length} item</small>
              </div>
              <div className="stat">
                <small>Kandidat Auto Trash</small>
                <b>{d.gc.candidates}</b>
                <small>sudah 30 hari tidak dipakai</small>
              </div>
              <div className="stat">
                <small>Backup terverifikasi</small>
                <b>
                  {d.backup.verified}/{d.backup.active_versions}
                </b>
              </div>
            </div>

            <BackupCard api={api} role={role} onVerified={() => void load()} />

            <div className="card">
              <h2>Pemakaian per area</h2>
              <table className="list">
                <tbody>
                  {Object.entries(d.stats.usage).map(([k, v]) => (
                    <tr key={k}>
                      <td>{AREA_LABEL[k] ?? k}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h2>Akan masuk Trash</h2>
              {d.gc.next_eligible.length === 0 ? (
                <div className="muted">Tidak ada media yang sedang menunggu 30 hari.</div>
              ) : (
                <table className="list">
                  <tbody>
                    {d.gc.next_eligible.map((n) => (
                      <tr key={n.version_id}>
                        <td>
                          {n.filename ?? n.version_id}
                          {n.filename && <small className="mono muted" style={{ display: 'block' }}>{n.version_id}</small>}
                        </td>
                        <td>{formatDate(n.eligible_at)}</td>
                        <td className="muted">{relativeDays(n.eligible_at, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
                Media yang belum pernah dipakai, versi current, dan yang ditandai Keep/Pin tidak pernah masuk Trash otomatis.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}
