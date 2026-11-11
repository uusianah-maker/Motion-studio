import { useCallback, useEffect, useState } from 'react';
import type { Api, ProjectSummary } from './api';
import { AiView } from './views/AiView';
import { EditorView } from './views/EditorView';
import { MediaView } from './views/MediaView';
import { StorageView } from './views/StorageView';
import { TrashView } from './views/TrashView';
import { ErrorNotice, ProjectList, useMediaQuery } from './ui';

export type View = 'editor' | 'media' | 'trash' | 'storage' | 'ai';

const NAV: { id: View; sym: string; label: string }[] = [
  { id: 'editor', sym: '▤', label: 'Editor' },
  { id: 'media', sym: '◇', label: 'Media' },
  { id: 'trash', sym: '♲', label: 'Trash' },
  { id: 'storage', sym: '▥', label: 'Storage' },
  { id: 'ai', sym: '✦', label: 'AI' },
];

export interface Account {
  email: string;
  name: string;
  onLogout: () => Promise<void>;
}

export function App({ api, workspaceId, account = null }: { api: Api; workspaceId: string; account?: Account | null }) {
  const [view, setView] = useState<View>('editor');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [leaving, setLeaving] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      list.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
      setProjects(list);
      setSelected((cur) => cur ?? list.find((p) => !p.error)?.project_id ?? null);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const createProject = async (name: string) => {
    const p = await api.createProject(name);
    await loadProjects();
    setSelected(p.project_id);
    setView('editor');
  };

  /** X05: a duplicated/imported project appears in the list and opens in the editor. */
  const openNew = async (id: string) => {
    await loadProjects();
    setSelected(id);
    setView('editor');
  };
  const importProject = async (file: File) => {
    if (file.size > 900 * 1024) throw new Error('File proyek terlalu besar (maks ±900 KB).');
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('File ini bukan JSON proyek Motion Studio.');
    }
    const r = await api.importProject(data);
    await openNew(r.project.project_id);
  };

  const sideList = (
    <ProjectList projects={projects} selected={selected} onSelect={(id) => { setSelected(id); setView('editor'); }} onCreate={createProject} onImport={importProject} />
  );

  return (
    <div className={`app${view === 'editor' ? '' : ' noSide'}`}>
      <nav className="rail" aria-label="Navigasi utama">
        <div className="brand" aria-hidden="true">▶</div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav${view === n.id ? ' sel' : ''}`} aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>
            <span className="sym" aria-hidden="true">{n.sym}</span>
            {n.label}
          </button>
        ))}
        <div className="grow" />
        {account && (
          <button
            className="nav account"
            title={`Masuk sebagai ${account.email}. Klik untuk keluar.`}
            aria-label={`Keluar (${account.email})`}
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void account.onLogout();
            }}
          >
            <span className="avatar" aria-hidden="true">
              {(account.name || account.email).slice(0, 1).toUpperCase()}
            </span>
            Keluar
          </button>
        )}
        <span className="mono muted" title={`Workspace ${workspaceId}`}>●</span>
      </nav>
      {view === 'editor' && !narrow && <aside className="side" aria-label="Proyek">{sideList}</aside>}
      <div className="page">
        {error ? <div className="body"><ErrorNotice error={error} /></div> : null}
        {view === 'editor' && <EditorView api={api} projectId={selected} mobileProjects={narrow ? sideList : null} onSaved={(p) => setProjects((list) => list?.map((x) => (x.project_id === p.project_id ? { ...x, name: p.name, status: p.status, revision: p.revision, updated_at: p.updated_at } : x)) ?? list)} onProjectCreated={openNew} />}
        {view === 'media' && <MediaView api={api} projects={projects ?? []} selectedProject={selected} />}
        {view === 'trash' && <TrashView api={api} />}
        {view === 'storage' && <StorageView api={api} />}
        {view === 'ai' && <AiView api={api} />}
      </div>
    </div>
  );
}
