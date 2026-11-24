import { useCallback, useEffect, useState } from 'react';
import { type Api, type PurgePlan, type Role, type TrashItem, type TrashedProject } from '../api';
import { blockerText, formatBytes, formatDate } from '../lib';
import { ErrorNotice, Modal } from '../ui';

export function TrashView({ api, role = 'owner', onProjectsChanged }: { api: Api; role?: Role; onProjectsChanged?: () => void }) {
  const [projects, setProjects] = useState<TrashedProject[] | null>(null);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ item: TrashItem; wanted: string; suggested: string } | null>(null);
  const [purgeFor, setPurgeFor] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, proj] = await Promise.all([api.trash(), api.trashedProjects()]);
      setItems(list);
      setProjects(proj);
      setSelected((s) => new Set([...s].filter((id) => list.some((i) => i.version_id === id))));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (item: TrashItem, onConflict?: 'alternate') => {
    setBusy(item.version_id);
    setNote(null);
    setError(null);
    try {
      const r = await api.restore(item.version_id, onConflict ? { on_conflict: onConflict } : {});
      if (r.status === 'restored') {
        setNote({ kind: 'ok', text: `“${item.display_name}” dipulihkan. Periode 30 hari dimulai dari nol.` });
        setConflict(null);
      } else if (r.status === 'conflict') {
        setConflict({ item, wanted: r.wanted ?? '', suggested: r.suggested ?? '' });
      } else {
        setNote({ kind: 'warn', text: `Gagal memulihkan: ${r.reason ?? 'alasan tidak diketahui'}` });
      }
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const restoreProject = async (p: TrashedProject) => {
    setBusy(p.project_id);
    setNote(null);
    setError(null);
    try {
      await api.restoreProject(p.project_id);
      setNote({ kind: 'ok', text: `Proyek “${p.name}” dipulihkan ke daftar proyek.` });
      onProjectsChanged?.();
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <>
      <header className="top">
        <h1>Trash</h1>
        <span className="muted">{items ? `${items.length} item` : '…'}</span>
        <div className="spacer" />
        {role === 'owner' && (
          <button className="btn danger" disabled={selected.size === 0} onClick={() => setPurgeFor([...selected])}>
            Hapus permanen… {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        )}
      </header>
      <div className="body">
        <div className="notice info">
          Media yang 30 hari tidak dipakai proyek mana pun dipindah ke sini otomatis. <b>Tidak ada yang dihapus otomatis</b> — hapus permanen hanya lewat tombol di atas, dengan konfirmasi ketik frasa.
        </div>
        <ErrorNotice error={error} />
        {projects && projects.length > 0 && (
          <section className="card" aria-label="Proyek terhapus">
            <h2>Proyek terhapus ({projects.length})</h2>
            <p className="small muted">Proyek yang dihapus dari daftar Edit. Isinya utuh dan medianya tetap dilindungi sampai dipulihkan.</p>
            <table className="list">
              <thead>
                <tr>
                  <th>Proyek</th>
                  <th>Dihapus</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.project_id}>
                    <td>{p.name}</td>
                    <td>{formatDate(p.dihapus_at)}</td>
                    <td>
                      {role !== 'reviewer' && (
                        <button className="btn small" disabled={busy !== null} onClick={() => void restoreProject(p)}>
                          ↺ Pulihkan
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {note && <div className={`notice ${note.kind}`} role="status">{note.text}</div>}
        {items && items.length === 0 ? (
          <div className="empty">Trash kosong.</div>
        ) : (
          <div className="card">
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <span className="hideNarrow">PILIH</span>
                  </th>
                  <th>NAMA</th>
                  <th>UKURAN</th>
                  <th className="hideNarrow">MASUK TRASH</th>
                  <th className="hideNarrow">ASAL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((i) => (
                  <tr key={i.version_id}>
                    <td>
                      <input type="checkbox" aria-label={`Pilih ${i.display_name}`} checked={selected.has(i.version_id)} onChange={() => toggle(i.version_id)} />
                    </td>
                    <td className="cellName">
                      <b>{i.display_name}</b>
                      <small className="mono">{i.version_id}</small>
                    </td>
                    <td>{formatBytes(i.size)}</td>
                    <td className="hideNarrow">{formatDate(i.trashed_at)}</td>
                    <td className="hideNarrow mono">{i.original_rel_path}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small" disabled={busy !== null || role === 'reviewer'} title={role === 'reviewer' ? 'Reviewer hanya bisa melihat' : undefined} onClick={() => restore(i)}>
                        {busy === i.version_id ? 'Memulihkan…' : '↺ Pulihkan'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {conflict && (
        <Modal title="Lokasi asal sudah terisi" onClose={() => setConflict(null)} busy={busy !== null}>
          <p>
            Di lokasi asal sudah ada file lain, dan file itu <b>tidak akan ditimpa</b>.
          </p>
          <p className="mono">{conflict.wanted}</p>
          <p>Pulihkan dengan nama lain:</p>
          <p className="mono">{conflict.suggested}</p>
          <div className="modalActions">
            <button className="btn" onClick={() => setConflict(null)}>
              Batal
            </button>
            <button className="btn primary" disabled={busy !== null} onClick={() => restore(conflict.item, 'alternate')}>
              Pulihkan dengan nama lain
            </button>
          </div>
        </Modal>
      )}

      {purgeFor && (
        <PurgeDialog
          api={api}
          versionIds={purgeFor}
          onClose={async (changed) => {
            setPurgeFor(null);
            if (changed) {
              setSelected(new Set());
              await load();
            }
          }}
        />
      )}
    </>
  );
}

/**
 * Manual permanent delete (PRD v0.8 §F): the server prepares a fresh dependency audit and a
 * single-use token; the user must type the exact phrase. A wrong attempt burns the request,
 * so the button stays disabled until the phrase matches exactly.
 */
function PurgeDialog({ api, versionIds, onClose }: { api: Api; versionIds: string[]; onClose: (changed: boolean) => void }) {
  const [plan, setPlan] = useState<PurgePlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ purged: string[]; blocked: { version_id: string; reasons: string[] }[]; freed_bytes: number } | null>(null);

  const prepare = useCallback(() => {
    setPlan(null);
    setPhrase('');
    api.preparePurge(versionIds).then(
      (p) => {
        setError(null);
        setPlan(p);
      },
      setError,
    );
  }, [api, versionIds]);
  useEffect(prepare, [prepare]);
  // Audit 14 Nov: the server burns the request on any attempt (expired, wrong) — then a fresh one is needed.
  const [spent, setSpent] = useState(false);

  const purgeable = plan?.items.filter((i) => i.purgeable) ?? [];
  const canRun = !!plan && purgeable.length > 0 && phrase === plan.required_phrase && !busy && !result && !spent;

  const run = async () => {
    if (!plan || !canRun) return;
    setBusy(true);
    try {
      setResult(await api.executePurge(plan, phrase));
    } catch (e) {
      setError(e);
      setSpent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Hapus permanen" onClose={() => onClose(!!result)} busy={busy}>
      <ErrorNotice error={error} />
      {!plan && !error && <p>Memeriksa ulang dependensi…</p>}
      {(spent || (!plan && !!error)) && !result && (
        <div className="modalActions">
          <button className="btn" onClick={() => onClose(false)} disabled={busy}>
            Tutup
          </button>
          {spent && (
            <button
              className="btn"
              onClick={() => {
                setSpent(false);
                setError(null);
                prepare();
              }}
            >
              Siapkan permintaan baru
            </button>
          )}
        </div>
      )}
      {plan && !result && !spent && (
        <>
          <div className="notice err">
            <b>Tidak bisa dibatalkan.</b> File dihapus dari disk untuk selamanya. Pastikan ada backup bila masih dibutuhkan.
          </div>
          <table className="list" style={{ marginTop: 12 }}>
            <tbody>
              {plan.items.map((i) => (
                <tr key={i.version_id}>
                  <td className="cellName">
                    <b>{i.filename}</b>
                    <small>
                      {formatBytes(i.size)} · <span className="mono">{i.version_id}</span>
                    </small>
                    {i.referenced_by.length > 0 && (
                      <small>
                        Dipakai: {i.referenced_by.map((h) => (h.kind === 'project' ? `proyek ${h.project_id}` : h.kind === 'brand' ? `Brand Kit (${h.slot})` : `job ${h.job}`)).join(', ')}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${i.backup.status === 'verified' ? 'ok' : 'warn'}`}>{i.backup.status === 'verified' ? 'Ada backup' : 'Backup belum terverifikasi'}</span>
                  </td>
                  <td>{i.purgeable ? <span className="badge bad">Akan dihapus</span> : <span className="badge">{i.blockers.map(blockerText).join(', ')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {purgeable.length === 0 ? (
            <p>Tidak ada item yang boleh dihapus (lihat alasan di atas).</p>
          ) : (
            <>
              <p>
                Total {formatBytes(purgeable.reduce((a, i) => a + i.size, 0))}. Ketik <b>{plan.required_phrase}</b> untuk melanjutkan:
              </p>
              <input className="phrase" aria-label="Frasa konfirmasi" autoComplete="off" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
              <p className="muted" style={{ fontSize: 11 }}>Permintaan ini berlaku 10 menit dan hanya bisa dipakai sekali.</p>
            </>
          )}
          <div className="modalActions">
            <button className="btn" onClick={() => onClose(false)} disabled={busy}>
              Batal
            </button>
            <button className="btn danger" disabled={!canRun} onClick={run}>
              {busy ? 'Menghapus…' : 'Hapus permanen'}
            </button>
          </div>
        </>
      )}
      {result && (
        <>
          <div className={`notice ${result.blocked.length ? 'warn' : 'ok'}`} role="status">
            {result.purged.length} item dihapus permanen ({formatBytes(result.freed_bytes)}).
            {result.blocked.length > 0 && ` ${result.blocked.length} item diblokir oleh pemeriksaan terakhir: ${result.blocked.map((b) => b.reasons.map(blockerText).join(', ')).join('; ')}.`}
          </div>
          <div className="modalActions">
            <button className="btn primary" onClick={() => onClose(true)}>
              Tutup
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
