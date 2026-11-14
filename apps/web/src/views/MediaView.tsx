import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Api, Media, ProjectSummary, Role } from '../api';
import { errorText, formatBytes, formatDate } from '../lib';
import { ErrorNotice, StatusBadges } from '../ui';

interface UploadItem {
  id: number;
  name: string;
  size: number;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'duplicate' | 'error';
  message?: string;
}

let seq = 0;

/**
 * Audit 14 Nov: the upload queue lives outside the page. Leaving Media and coming back shows the
 * uploads still running (they used to vanish from view and keep going), and new files join the
 * SAME one-at-a-time queue instead of starting a second one that the server refuses (BUSY).
 */
const uploadStore = {
  items: [] as UploadItem[],
  /** Uploads finished so far: the page reloads its list when this changes. */
  finished: 0,
  queue: Promise.resolve() as Promise<void>,
  listeners: new Set<() => void>(),
};
const emitUploads = () => uploadStore.listeners.forEach((l) => l());
const setUploadItems = (fn: (list: UploadItem[]) => UploadItem[]) => {
  uploadStore.items = fn(uploadStore.items);
  emitUploads();
};
const subscribeUploads = (l: () => void) => {
  uploadStore.listeners.add(l);
  return () => uploadStore.listeners.delete(l);
};

export function MediaView({ api, projects, selectedProject, role = 'owner' }: { api: Api; projects: ProjectSummary[]; selectedProject: string | null; role?: Role }) {
  const [media, setMedia] = useState<Media[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [target, setTarget] = useState<string>('shared');
  const uploads = useSyncExternalStore(subscribeUploads, () => uploadStore.items);
  const finished = useSyncExternalStore(subscribeUploads, () => uploadStore.finished);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState<'all' | 'shared' | string>('all');
  const input = useRef<HTMLInputElement>(null);
  const usable = projects.filter((p) => !p.error);

  const load = useCallback(async () => {
    try {
      setMedia(await api.media({ scope: 'all' }));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, finished]);

  useEffect(() => {
    if (selectedProject && projects.some((p) => !p.error && p.project_id === selectedProject)) setTarget(`project:${selectedProject}`);
  }, [selectedProject, projects]);

  const patch = (id: number, p: Partial<UploadItem>) => setUploadItems((list) => list.map((u) => (u.id === id ? { ...u, ...p } : u)));

  /** Files upload one after another (large videos would otherwise compete for disk and bandwidth). */
  const addFiles = (files: FileList | File[]) => {
    const scope = target === 'shared' ? ({ kind: 'shared' } as const) : ({ kind: 'project', project_id: target.slice('project:'.length) } as const);
    for (const file of Array.from(files)) {
      const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, state: 'waiting' };
      setUploadItems((list) => [item, ...list].slice(0, 30));
      uploadStore.queue = uploadStore.queue.then(async () => {
        patch(item.id, { state: 'uploading' });
        try {
          const r = await api.importFile(file, scope, (f) => patch(item.id, { progress: f }));
          patch(item.id, { state: r.duplicate ? 'duplicate' : 'done', progress: 1, message: r.duplicate ? 'Sudah ada — memakai versi yang sama' : undefined });
        } catch (e) {
          patch(item.id, { state: 'error', message: errorText(e) });
        }
        uploadStore.finished++;
        emitUploads();
      });
    }
  };

  const shown = (media ?? []).filter((m) => filter === 'all' || (filter === 'shared' ? m.scope.kind === 'shared' : m.scope.kind === 'project' && `project:${m.scope.project_id}` === filter));
  const projectName = (id: string) => projects.find((p) => p.project_id === id)?.name ?? id;

  return (
    <>
      <header className="top">
        <h1>Media</h1>
        <span className="muted">{media ? `${media.length} item` : '…'}</span>
        <div className="spacer" />
        {role !== 'reviewer' && (
          <button className="btn primary" onClick={() => input.current?.click()}>
            ＋ Import Media
          </button>
        )}
      </header>
      <div className="body">
        <ErrorNotice error={error} />
        <div className="card">
          <h2>Import</h2>
          <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            Simpan ke
            <select className="smallbtn" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Tujuan import">
              <option value="shared">Media bersama (semua proyek)</option>
              {usable.map((p) => (
                <option key={p.project_id} value={`project:${p.project_id}`}>
                  Proyek: {p.name}
                </option>
              ))}
            </select>
          </label>
          <div
            className={`drop${over ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
          >
            Tarik file video ke sini, atau{' '}
            <button className="smallbtn" onClick={() => input.current?.click()}>
              pilih file
            </button>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              File asli disalin ke workspace dan dikunci (tidak pernah ditimpa). File yang sama persis tidak diduplikasi.
            </div>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label="Pilih file media"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {uploads.length > 0 && (
            <div className="uploads" aria-live="polite">
              {uploads.map((u) => (
                <div className="uploadRow" key={u.id}>
                  <span className="name" title={u.name}>{u.name}</span>
                  <span className="muted">{formatBytes(u.size)}</span>
                  {u.state === 'uploading' || u.state === 'waiting' ? (
                    <span style={{ width: 120 }}>
                      <div className="bar" aria-label={`Progres ${Math.round(u.progress * 100)}%`}>
                        <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                      </div>
                      {u.state === 'uploading' && u.progress >= 1 && <small className="muted">Memproses di server…</small>}
                    </span>
                  ) : (
                    <span className={`badge ${u.state === 'error' ? 'bad' : u.state === 'duplicate' ? 'warn' : 'ok'}`} title={u.message}>
                      {u.state === 'error' ? `Gagal: ${u.message}` : u.state === 'duplicate' ? 'Duplikat' : 'Selesai'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>Library</h2>
            <div className="spacer" />
            <select className="smallbtn" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter media">
              <option value="all">Semua</option>
              <option value="shared">Media bersama</option>
              {usable.map((p) => (
                <option key={p.project_id} value={`project:${p.project_id}`}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {media && shown.length === 0 ? (
            <div className="empty">Belum ada media di sini.</div>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>NAMA</th>
                  <th className="hideNarrow">LOKASI</th>
                  <th>UKURAN</th>
                  <th>STATUS</th>
                  <th className="hideNarrow">DIIMPORT</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const cur = m.versions.find((v) => v.version_id === m.current_version_id);
                  return (
                    <tr key={m.media_id}>
                      <td className="cellName">
                        <b>{m.display_name}</b>
                        <small>
                          {m.versions.length} versi{cur && cur.original_name !== m.display_name ? ` · file: ${cur.original_name}` : ''}
                        </small>
                      </td>
                      <td className="hideNarrow">{m.scope.kind === 'shared' ? 'Bersama' : `Proyek: ${projectName(m.scope.project_id)}`}</td>
                      <td>{cur ? formatBytes(cur.size) : '–'}</td>
                      <td>{cur ? <StatusBadges lifecycle={cur.lifecycle} integrity={cur.integrity} /> : '–'}</td>
                      <td className="hideNarrow">{formatDate(m.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
