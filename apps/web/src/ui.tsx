import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectFitur, ProjectSummary } from './api';
import { FITUR_LABEL, fiturOf } from './fitur';
import { INTEGRITY_LABEL, LIFECYCLE_LABEL, errorText, formatDate } from './lib';

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

/**
 * useState kept for this browser tab (sessionStorage): a form survives switching menus (audit
 * 14 Nov, sukma: "Susun batch" went back to defaults). Never fails: no storage = plain state.
 */
export function useSessionState<T>(key: string, init: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(`ms:${key}`);
      return raw === null ? init : (JSON.parse(raw) as T);
    } catch {
      return init;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`ms:${key}`, JSON.stringify(value));
    } catch {
      /* private mode / full: the form still works for this visit */
    }
  }, [key, value]);
  return [value, setValue];
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  // Audit 14 Nov: our own `new Error('Pilih file font …')` used to show as "kesalahan tidak dikenal".
  const msg = errorText(error);
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
  // Audit 14 Nov: callers pass a new `onClose` on every render (and the editor re-renders every
  // frame while playing), so focus moved on each keystroke. Focus in once, back once; the key
  // handler reads the latest props through a ref.
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !latest.current.busy) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const FITUR_CHIPS: [ProjectFitur | 'semua', string][] = [['semua', 'Semua'], ['iklan', FITUR_LABEL.iklan], ['batch', FITUR_LABEL.batch], ['beatspot', FITUR_LABEL.beatspot], ['transfer', FITUR_LABEL.transfer]];

export function ProjectList({
  projects,
  selected,
  onSelect,
  onCreate,
  onImport,
}: {
  projects: ProjectSummary[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  /** X05: import an exported project file (JSON). */
  onImport?: (file: File) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // R22 hybrid: Edit still lists every project; chips narrow it down to one feature's projects.
  const [fitur, setFitur] = useState<ProjectFitur | 'semua'>('semua');
  const matching = (projects ?? []).filter((p) => (!q || (p.name ?? p.project_id).toLowerCase().includes(q.toLowerCase())) && (fitur === 'semua' || (!p.error && fiturOf(p) === fitur)));
  const shown = matching.filter((p) => p.status !== 'archived');
  const archived = matching.filter((p) => p.status === 'archived');
  const fileRef = useRef<HTMLInputElement>(null);
  const importFile = async (f: File | undefined) => {
    if (!f || !onImport) return;
    setBusy(true);
    setError(null);
    try {
      await onImport(f);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const row = (p: ProjectSummary) => (
    <button key={p.project_id} className={`project${p.project_id === selected ? ' active' : ''}`} onClick={() => onSelect(p.project_id)} disabled={!!p.error}>
      <span className="thumb" aria-hidden="true">{p.status === 'archived' ? '🗄' : '🎬'}</span>
      <span>
        <b>{p.name ?? p.project_id}</b>
        <small>
          {p.error
            ? 'Manifest rusak — tidak bisa dibuka'
            : `${FITUR_LABEL[fiturOf(p)]} · ${p.variant ? `V${p.variant.number}${p.variant.state === 'approved' ? ' ✓' : ''} · ` : ''}${p.status === 'archived' ? 'Arsip · ' : ''}Revisi ${p.revision} · ${formatDate(p.updated_at)}`}
        </small>
      </span>
    </button>
  );

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
      {onImport && (
        <div className="importRow">
          <button className="linkbtn" disabled={busy} onClick={() => fileRef.current?.click()} title="Impor proyek dari file .json hasil Ekspor (media harus sudah ada di workspace ini)">
            ⇪ Impor proyek (.json)
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" aria-label="File proyek untuk diimpor" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
        </div>
      )}
      {error ? <div style={{ padding: '0 15px 10px' }}><ErrorNotice error={error} /></div> : null}
      <div className="fiturChips" role="group" aria-label="Saring fitur">
        {FITUR_CHIPS.map(([id, label]) => (
          <button key={id} className={`chip${fitur === id ? ' on' : ''}`} aria-pressed={fitur === id} onClick={() => setFitur(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="sideh">{fitur === 'semua' ? 'SEMUA PROYEK' : `PROYEK ${FITUR_LABEL[fitur].toUpperCase()}`}</div>
      {projects === null && <div className="sectionNote">Memuat…</div>}
      {projects?.length === 0 && <div className="sectionNote">Belum ada proyek. Ketik nama di atas lalu tekan ＋.</div>}
      {!!projects?.length && fitur !== 'semua' && !matching.length && <div className="sectionNote">Belum ada proyek {FITUR_LABEL[fitur]}.</div>}
      {shown.map(row)}
      {archived.length > 0 && (
        <details className="archived" open={archived.some((p) => p.project_id === selected) || undefined}>
          <summary className="sideh">ARSIP ({archived.length})</summary>
          {archived.map(row)}
        </details>
      )}
    </>
  );
}
