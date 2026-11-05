import { type ReactNode, useEffect, useState } from 'react';
import type { Api, Media, Project, Track } from '../api';
import { ellipsize, formatBytes, formatDate, formatDuration } from '../lib';
import { ErrorNotice } from '../ui';

const TRACKS: { kind: Track['kind']; label: string }[] = [
  { kind: 'video', label: '▤  Video' },
  { kind: 'broll', label: '◈  B-roll' },
  { kind: 'text', label: 'T  Teks & CTA' },
  { kind: 'subtitle', label: '☷  Subtitle' },
  { kind: 'audio', label: '♫  Audio' },
  { kind: 'effects', label: '✧  Efek' },
];

/**
 * Editor layout (W05): real project data, read-only. Editing (W06), video preview (W07),
 * render (W08) and Copilot (W11) are not built yet and are labelled as such, never faked.
 */
export function EditorView({ api, projectId, mobileProjects }: { api: Api; projectId: string | null; mobileProjects: ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setProject(null);
    setError(null);
    if (!projectId) return;
    Promise.all([api.project(projectId), api.media({ scope: 'all' })])
      .then(([p, m]) => {
        if (!live) return;
        setProject(p);
        setMedia(m);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  if (!projectId) {
    return (
      <div className="body">
        {mobileProjects && <div className="card">{mobileProjects}</div>}
        <div className="empty">Pilih atau buat proyek di panel kiri untuk membuka editor.</div>
      </div>
    );
  }

  const names = new Map(media.map((m) => [m.media_id, m.display_name]));
  const projectMedia = media.filter((m) => m.scope.kind === 'project' && m.scope.project_id === projectId);
  const tracks = project?.timeline.tracks ?? [];
  const duration = Math.max(30_000, ...tracks.flatMap((t) => t.clips.map((c) => c.end_ms)));
  const clipCount = tracks.reduce((a, t) => a + t.clips.length, 0);

  return (
    <div className="editorGrid">
      <header className="top">
        <h1>{project?.name ?? '…'}</h1>
        {project && <span className="badge vio">Revisi {project.revision}</span>}
        <div className="spacer" />
        <span className="muted hideNarrow">Diperbarui {formatDate(project?.updated_at)}</span>
        <button className="btn primary" disabled title="Render MP4 belum tersedia (tahap W08)">
          ↧ Render
        </button>
      </header>

      <main className="editor">
        {mobileProjects && (
          <div style={{ padding: 12 }}>
            <details>
              <summary className="muted">Ganti proyek</summary>
              {mobileProjects}
            </details>
          </div>
        )}
        {error ? <div style={{ padding: 16 }}><ErrorNotice error={error} /></div> : null}
        <div className="editorHeader">
          <span>PRATINJAU 9:16 · {formatDuration(duration)}</span>
          <span className="badge">Hanya baca</span>
        </div>
        <div className="canvasArea">
          <div className="canvas" aria-label="Area pratinjau">
            <span className="canvasTag">● PREVIEW</span>
            <h3>Pratinjau belum tersedia</h3>
            <span>Pemutaran video dengan playhead dibangun di tahap W07. Linimasa di bawah sudah memakai data proyek asli.</span>
          </div>
        </div>
      </main>

      <aside className="sidePanel" aria-label="Media proyek">
        <div className="panelHead">
          <b>Media proyek</b>
          <span className="spacer" />
          <span className="muted">{projectMedia.length}</span>
        </div>
        <div className="panelBody">
          {projectMedia.length === 0 ? (
            <div className="muted" style={{ lineHeight: 1.6 }}>Belum ada media khusus proyek ini. Import lewat menu <b>Media</b> dan pilih proyek ini sebagai tujuan.</div>
          ) : (
            projectMedia.map((m) => {
              const cur = m.versions.find((v) => v.version_id === m.current_version_id);
              return (
                <div className="assetRow" key={m.media_id}>
                  <span title={m.display_name}>{m.display_name}</span>
                  <span className="muted">{cur ? formatBytes(cur.size) : '–'}</span>
                </div>
              );
            })
          )}
          <div className="notice info">
            <b>Motion Copilot</b> belum aktif. Asisten AI yang menyusun rencana edit (dengan persetujuan lo) dibangun di tahap W11.
          </div>
        </div>
      </aside>

      <section className="timeline" aria-label="Linimasa">
        <div className="timelineTop">
          <b>Linimasa</b>
          <small className="muted">
            {clipCount} klip · {formatDuration(duration)}
          </small>
        </div>
        <div className="tracks">
          {TRACKS.map((t) => {
            const clips = tracks.filter((x) => x.kind === t.kind).flatMap((x) => x.clips);
            return (
              <div className="track" key={t.kind}>
                <div className="trackLabel">{t.label}</div>
                <div className="trackSurface">
                  {clips.map((c) => (
                    <div
                      key={c.clip_id}
                      className={`clip ${t.kind}`}
                      style={{ left: `${(c.start_ms / duration) * 100}%`, width: `${(Math.max(1, c.end_ms - c.start_ms) / duration) * 100}%` }}
                      title={`${c.media ? names.get(c.media.media_id) ?? c.media.media_id : c.clip_id} · ${formatDuration(c.start_ms)}–${formatDuration(c.end_ms)}`}
                    >
                      {ellipsize(c.media ? names.get(c.media.media_id) ?? c.clip_id : c.clip_id, 28)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="footerNote">{clipCount === 0 ? 'Linimasa masih kosong. Edit klip (geser, trim, split, undo) dibangun di tahap W06.' : 'Tampilan hanya baca. Edit klip dibangun di tahap W06.'}</div>
      </section>
    </div>
  );
}
