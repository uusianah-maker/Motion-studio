import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, type ProjectSummary } from './api';
import { INTEGRITY_LABEL, LIFECYCLE_LABEL, formatDate } from './lib';

/** Live media query (one layout rendered at a time, so no duplicated controls in the DOM). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? `${error.message}${error.code && error.code !== 'UNKNOWN' ? ` (${error.code})` : ''}` : 'Terjadi kesalahan yang tidak dikenal.';
  return (
    <div className="notice err" role="alert">
      {msg}
    </div>
  );
}

export function StatusBadges({ lifecycle, integrity }: { lifecycle: string; integrity: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <span className={`badge ${lifecycle === 'active' ? 'ok' : lifecycle === 'trashed' ? 'warn' : 'bad'}`}>{LIFECYCLE_LABEL[lifecycle] ?? lifecycle}</span>
      {integrity !== 'ok' && <span className="badge bad">{INTEGRITY_LABEL[integrity] ?? integrity}</span>}
    </span>
  );
}

/** Accessible modal: focus moves in, Escape closes (unless busy), focus returns on close. */
export function Modal({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose, busy]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ProjectList({
  projects,
  selected,
  onSelect,
  onCreate,
}: {
  projects: ProjectSummary[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const shown = (projects ?? []).filter((p) => !q || (p.name ?? p.project_id).toLowerCase().includes(q.toLowerCase()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sideTitle">
        <b>Proyek</b>
        <span className="muted">{projects ? projects.length : '…'}</span>
      </div>
      <input className="search" aria-label="Cari proyek" placeholder="⌕  Cari proyek..." value={q} onChange={(e) => setQ(e.target.value)} />
      <form className="newProject" onSubmit={submit}>
        <input aria-label="Nama proyek baru" placeholder="Nama proyek baru" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="smallbtn" type="submit" disabled={busy || !name.trim()} title="Buat proyek">
          ＋
        </button>
      </form>
      {error ? <div style={{ padding: '0 15px 10px' }}><ErrorNotice error={error} /></div> : null}
      <div className="sideh">SEMUA PROYEK</div>
      {projects === null && <div className="sectionNote">Memuat…</div>}
      {projects?.length === 0 && <div className="sectionNote">Belum ada proyek. Ketik nama di atas lalu tekan ＋.</div>}
      {shown.map((p) => (
        <button key={p.project_id} className={`project${p.project_id === selected ? ' active' : ''}`} onClick={() => onSelect(p.project_id)} disabled={!!p.error}>
          <span className="thumb" aria-hidden="true">🎬</span>
          <span>
            <b>{p.name ?? p.project_id}</b>
            <small>{p.error ? 'Manifest rusak — tidak bisa dibuka' : `Revisi ${p.revision} · ${formatDate(p.updated_at)}`}</small>
          </span>
        </button>
      ))}
    </>
  );
}
