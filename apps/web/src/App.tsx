import { useCallback, useEffect, useState } from 'react';
import type { Api, Project, ProjectSummary, Role, VariantTag } from './api';
import { AiView } from './views/AiView';
import { BatchView } from './views/BatchView';
import { ShotLibraryView } from './views/BatchLibrary';
import { BrandView } from './views/BrandView';
import { EditorView } from './views/EditorView';
import { GenerateView } from './views/GenerateView';
import { MediaView } from './views/MediaView';
import { StorageView } from './views/StorageView';
import { TeamView } from './views/TeamView';
import { TrashView } from './views/TrashView';
import { ErrorNotice, ProjectList, useMediaQuery } from './ui';
import { Logo } from './Logo';

export type View = 'generate' | 'batch' | 'shots' | 'editor' | 'media' | 'brand' | 'trash' | 'storage' | 'ai' | 'team';

// PC-16: one app — Generate Otomatis, Batch Remix, Editor (+ library / admin pages).
const NAV: { id: View; sym: string; label: string }[] = [
  { id: 'generate', sym: '⚡', label: 'Generate' },
  { id: 'batch', sym: '▦', label: 'Batch' },
  { id: 'shots', sym: '▣', label: 'Shot' },
  { id: 'editor', sym: '▤', label: 'Editor' },
  { id: 'media', sym: '◇', label: 'Media' },
  { id: 'brand', sym: '◆', label: 'Brand' },
  { id: 'trash', sym: '♲', label: 'Trash' },
  { id: 'storage', sym: '▥', label: 'Storage' },
  { id: 'ai', sym: '✦', label: 'AI' },
  { id: 'team', sym: '☺', label: 'Tim' },
];

export interface Account {
  email: string;
  name: string;
  onLogout: () => Promise<void>;
}

/** X09: a saved variant's list badge follows its approval (an edit after approval = "changed"). */
const variantTag = (p: Project): VariantTag => ({
  master_id: p.variant!.master_id,
  number: p.variant!.number,
  state: p.variant!.approved_revision === null || p.variant!.approved_revision === undefined ? 'draft' : p.variant!.approved_revision === p.revision ? 'approved' : 'changed',
});

export function App({ api, workspaceId, account = null, role = 'owner' }: { api: Api; workspaceId: string; account?: Account | null; role?: Role }) {
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
        <div className="brand" aria-hidden="true">
          <Logo size={38} />
        </div>
        {NAV.filter((n) => (n.id !== 'ai' || role === 'owner') && (n.id !== 'team' || (role === 'owner' && account !== null))).map((n) => (
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
        {view === 'editor' && <EditorView api={api} role={role} projectId={selected} mobileProjects={narrow ? sideList : null} onSaved={(p) => setProjects((list) => list?.map((x) => (x.project_id === p.project_id ? { ...x, name: p.name, status: p.status, revision: p.revision, updated_at: p.updated_at, ...(p.variant ? { variant: variantTag(p) } : {}) } : x)) ?? list)} onProjectCreated={openNew} onProjectsChanged={() => void loadProjects()} />}
        {view === 'generate' && <GenerateView api={api} role={role} projects={projects ?? []} onOpenProject={(id) => void openNew(id)} />}
        {view === 'batch' && <BatchView api={api} role={role} projects={projects ?? []} onOpenProject={(id) => void openNew(id)} onProjectsChanged={() => void loadProjects()} />}
        {view === 'shots' && <ShotLibraryView api={api} role={role} />}
        {view === 'media' && <MediaView api={api} projects={projects ?? []} selectedProject={selected} />}
        {view === 'brand' && <BrandView api={api} readOnly={role !== 'owner'} />}
        {view === 'trash' && <TrashView api={api} />}
        {view === 'storage' && <StorageView api={api} />}
        {view === 'ai' && <AiView api={api} />}
        {view === 'team' && role === 'owner' && account && <TeamView api={api} />}
      </div>
    </div>
  );
}
