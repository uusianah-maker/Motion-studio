import { useEffect, useRef, useState } from 'react';
import type { Api, Project } from '../api';
import { ErrorNotice } from '../ui';

/** File name for an exported project: readable, safe on Windows/macOS/phones. */
export const exportFileName = (name: string) => `${name.normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'proyek'}.motion.json`;

/**
 * Project menu (X05, PRD §6 project manager): rename, duplicate, archive/activate, export.
 * Export holds the timeline and which media it uses — never the video files (they stay on the PC).
 */
export function ProjectMenu({
  api,
  project,
  busy,
  run,
  onDuplicated,
}: {
  api: Api;
  project: Project;
  busy: boolean;
  run: (fn: (p: Project) => Promise<Project>) => Promise<void>;
  onDuplicated: (projectId: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => setName(project.name), [project.project_id, project.name]);
  const archived = project.status === 'archived';
  const close = () => ref.current?.removeAttribute('open');

  const side = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      close();
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <details className="projMenu" ref={ref}>
      <summary className="btn" aria-label="Kelola proyek" title="Ganti nama, duplikat, arsip, ekspor">
        ⋯ Proyek
      </summary>
      <div className="projMenuBody" role="group" aria-label="Kelola proyek">
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || name.trim() === project.name) return;
            void run((p) => api.updateProject(p.project_id, p.revision, { name: name.trim() })).then(close);
          }}
        >
          <input aria-label="Nama proyek" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn small" type="submit" disabled={busy || !name.trim() || name.trim() === project.name}>
            Simpan nama
          </button>
        </form>
        <button className="btn small" disabled={busy || working} onClick={() => void side(async () => onDuplicated((await api.duplicateProject(project.project_id)).project_id))}>
          ⧉ Duplikat
        </button>
        <button className="btn small" disabled={busy || working} onClick={() => void run((p) => api.updateProject(p.project_id, p.revision, { status: archived ? 'active' : 'archived' })).then(close)}>
          {archived ? '↺ Aktifkan lagi' : '🗄 Arsipkan'}
        </button>
        <button
          className="btn small"
          disabled={working}
          onClick={() =>
            void side(async () => {
              const data = await api.exportProject(project.project_id);
              const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = exportFileName(project.name);
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          ⇩ Ekspor .json
        </button>
        <div className="muted small">Ekspor hanya berisi linimasa, tanpa file video (media tetap di PC). Proyek arsip hanya-baca, medianya tetap dilindungi.</div>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </details>
  );
}
