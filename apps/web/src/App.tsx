import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { Api, Project, ProjectSummary, Role, VariantTag } from './api';
import { AiView } from './views/AiView';
import { BatchView } from './views/BatchView';
import { ShotLibraryView } from './views/BatchLibrary';
import { BrandView } from './views/BrandView';
import { EditorView } from './views/EditorView';
import { GenerateView } from './views/GenerateView';
import { HasilView } from './views/HasilView';
import { BeatSpotView } from './views/BeatSpotView';
import { type BuatFitur, BuatTabs, BuatVideoView } from './views/BuatVideoView';
import { MotionTransferView } from './views/MotionTransferView';
import { PersetujuanView } from './views/PersetujuanView';
import { MediaView } from './views/MediaView';
import { StorageView } from './views/StorageView';
import { TeamView } from './views/TeamView';
import { TrashView } from './views/TrashView';
import { ErrorNotice, ProjectList, useMediaQuery } from './ui';
import { Logo } from './Logo';

export type View = 'buat' | 'generate' | 'batch' | 'shots' | 'transfer' | 'beatspot' | 'editor' | 'hasil' | 'persetujuan' | 'media' | 'brand' | 'trash' | 'storage' | 'ai' | 'team';

/** The four ways of "Buat video" (shown inside it, no menu items of their own). */
const BUAT: readonly View[] = ['generate', 'batch', 'beatspot', 'transfer'];

// R17 (owner: "Ya, rapikan"): the work flow in order, then materials, then settings.
const NAV: { group: string; items: { id: View; sym: string; label: string }[] }[] = [
  {
    group: 'Alur kerja',
    items: [
      { id: 'buat', sym: '✚', label: '1. Buat video' },
      { id: 'editor', sym: '▤', label: '2. Edit' },
      { id: 'persetujuan', sym: '✓', label: '3. Setujui' },
      { id: 'hasil', sym: '⤓', label: '4. Hasil' },
    ],
  },
  {
    group: 'Bahan',
    items: [
      { id: 'media', sym: '◇', label: 'Media' },
      { id: 'shots', sym: '▣', label: 'Shot' },
      { id: 'brand', sym: '◆', label: 'Brand' },
    ],
  },
  {
    group: 'Pengaturan',
    items: [
      { id: 'ai', sym: '✦', label: 'AI' },
      { id: 'team', sym: '☺', label: 'Tim' },
      { id: 'storage', sym: '▥', label: 'Storage' },
      { id: 'trash', sym: '♲', label: 'Trash' },
    ],
  },
];

/** Address-bar routes (`#/buat/beat-spot`); old names still work and are rewritten. */
const ROUTE: Record<View, string> = {
  buat: 'buat',
  generate: 'buat/video-iklan',
  batch: 'buat/batch-remix',
  beatspot: 'buat/beat-spot',
  transfer: 'buat/motion-transfer',
  editor: 'edit',
  persetujuan: 'setujui',
  hasil: 'hasil',
  media: 'media',
  shots: 'shot',
  brand: 'brand',
  ai: 'ai',
  team: 'tim',
  storage: 'storage',
  trash: 'trash',
};
const OLD_ROUTE: Record<string, View> = { generate: 'generate', batch: 'batch', beatspot: 'beatspot', 'beat-spot': 'beatspot', transfer: 'transfer', 'motion-transfer': 'transfer', editor: 'editor', persetujuan: 'persetujuan', shots: 'shots', team: 'team' };
export function viewFromHash(hash: string): View | null {
  const slug = hash.replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  if (!slug) return null;
  const hit = (Object.keys(ROUTE) as View[]).find((v) => ROUTE[v] === slug);
  return hit ?? OLD_ROUTE[slug] ?? null;
}

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
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash) ?? 'editor');
  // The page is in the address bar (bookmark / reload / old links land on the right page).
  useEffect(() => {
    const want = `#/${ROUTE[view]}`;
    if (window.location.hash !== want) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${want}`);
  }, [view]);
  useEffect(() => {
    const onHash = () => {
      const v = viewFromHash(window.location.hash);
      if (!v) return;
      setView(v);
      // An old name for the page already shown: still rewrite it to the current address.
      const want = `#/${ROUTE[v]}`;
      if (window.location.hash !== want) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${want}`);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [leaving, setLeaving] = useState(false);
  // Halaman kerja panjang (upload, job mesin, tabel batch) tidak dibongkar saat pindah menu: cukup disembunyikan,
  // supaya antrean upload, pilihan file, dan job yang sedang dipantau tidak hilang (bug owner 14 Nov).
  const [visited, setVisited] = useState<ReadonlySet<View>>(() => new Set<View>(['editor']));
  useEffect(() => {
    setVisited((v) => (v.has(view) ? v : new Set([...v, view])));
  }, [view]);
  const keep = (id: View, node: ReactNode) => (visited.has(id) || view === id ? <div style={view === id ? undefined : { display: 'none' }} aria-hidden={view !== id}>{node}</div> : null);

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
        {NAV.map((g) => {
          const items = g.items.filter((n) => (n.id !== 'ai' || role === 'owner') && (n.id !== 'team' || (role === 'owner' && account !== null)));
          return (
            <div key={g.group} className="navGroup" role="group" aria-label={g.group}>
              <div className="navGroupLabel" aria-hidden="true">
                {g.group}
              </div>
              {items.map((n) => {
                const on = view === n.id || (n.id === 'buat' && BUAT.includes(view));
                return (
                  <button key={n.id} className={`nav${on ? ' sel' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => setView(n.id)}>
                    <span className="sym" aria-hidden="true">{n.sym}</span>
                    {n.label}
                  </button>
                );
              })}
            </div>
          );
        })}
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
        {view === 'buat' && <BuatVideoView onOpen={(f: BuatFitur) => setView(f)} />}
        {BUAT.includes(view) && <BuatTabs current={view as BuatFitur} onOpen={(f) => setView(f)} onHub={() => setView('buat')} />}
        {keep('generate', <GenerateView api={api} role={role} projects={projects ?? []} onOpenProject={(id) => void openNew(id)} />)}
        {keep('batch', <BatchView api={api} role={role} projects={projects ?? []} onOpenProject={(id) => void openNew(id)} onProjectsChanged={() => void loadProjects()} active={view === 'batch'} />)}
        {keep('beatspot', <BeatSpotView api={api} role={role} projects={projects ?? []} active={view === 'beatspot'} onOpenProject={(id) => void openNew(id)} />)}
        {keep('transfer', <MotionTransferView api={api} role={role} projects={projects ?? []} active={view === 'transfer'} />)}
        {keep('shots', <ShotLibraryView api={api} role={role} active={view === 'shots'} />)}
        {keep('persetujuan', <PersetujuanView api={api} role={role} active={view === 'persetujuan'} onOpenProject={(id) => void openNew(id)} />)}
        {keep('hasil', <HasilView api={api} active={view === 'hasil'} onOpenProject={(id) => void openNew(id)} />)}
        {keep('media', <MediaView api={api} role={role} projects={projects ?? []} selectedProject={selected} />)}
        {view === 'brand' && <BrandView api={api} readOnly={role !== 'owner'} />}
        {view === 'trash' && <TrashView api={api} role={role} />}
        {view === 'storage' && <StorageView api={api} role={role} />}
        {view === 'ai' && <AiView api={api} />}
        {view === 'team' && role === 'owner' && account && <TeamView api={api} />}
      </div>
    </div>
  );
}
