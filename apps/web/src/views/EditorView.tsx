import { CopilotPanel } from './CopilotPanel';
import { ReviewPanel } from './ReviewPanel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Api, ApiError, type Clip, type EditOp, type Media, type Project, type Role, type Track } from '../api';
import { type CanvasRatio, DEFAULT_CLIP_MS, type DragMode, dragSpan, ellipsize, formatBytes, formatDate, formatDuration, rulerTicks, snap, visibleDuration } from '../lib';
import { ErrorNotice } from '../ui';
import { Preview } from './Preview';
import type { TextStyle } from '../../../../packages/core/dist/storage/textStyle.js';
import { InspectorPanel } from './InspectorPanel';
import { ProjectMenu } from './ProjectMenu';
import { CutReviewDialog } from './CutReviewDialog';
import { VariantsDialog } from './VariantsDialog';
import { useBrand } from '../brand';
import { PresetPanel } from './PresetPanel';
import { RenderDialog } from './RenderDialog';
import { TranscriptDialog } from './TranscriptDialog';

const TEXT_CLIP_MS = 3000;

const TRACKS: { kind: Track['kind']; label: string }[] = [
  { kind: 'video', label: '▤  Video' },
  { kind: 'broll', label: '◈  B-roll' },
  { kind: 'text', label: 'T  Teks & CTA' },
  { kind: 'subtitle', label: '☷  Subtitle' },
  { kind: 'audio', label: '♫  Audio' },
  { kind: 'music', label: '♬  Musik' },
  { kind: 'sfx', label: '♪  SFX' },
  { kind: 'effects', label: '✧  Efek' },
];

interface Drag {
  clip: Clip;
  mode: DragMode;
  startX: number;
  deltaMs: number;
  pointerId: number;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Editor (W06): manual timeline editing — select, move, trim, split, delete, undo/redo.
 * Every change is one server request (authoritative project, optimistic revision check);
 * the server keeps the undo history. Video preview (W07), render (W08) and Copilot (W11)
 * are not built yet and are labelled as such, never faked.
 */
export function EditorView({
  api,
  role = 'owner',
  projectId,
  mobileProjects,
  onSaved,
  onProjectCreated,
  onProjectsChanged,
}: {
  api: Api;
  /** U7: reviewers see everything read-only (comment + Lulus/Revisi only); editors cannot approve. */
  role?: Role;
  projectId: string | null;
  mobileProjects: ReactNode;
  onSaved?: (p: Project) => void;
  onProjectCreated?: (id: string) => Promise<void> | void;
  /** X09: variants were created/approved — refresh the project list. */
  onProjectsChanged?: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [sttMedia, setSttMedia] = useState<Media | null>(null);
  const [styleDraft, setStyleDraft] = useState<{ clip_id: string; style: Partial<TextStyle> } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** X07: media clip whose pauses/scenes are being reviewed. */
  const [cutClip, setCutClip] = useState<Clip | null>(null);
  const [variantsOpen, setVariantsOpen] = useState(false);
  /** X06: Brand Kit (logo + font) for preview, inspector swatches and the Brand preset. */
  const brand = useBrand(api, { brandId: project?.brand_id ?? null });
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [playing, setPlaying] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Parent callback kept in a ref: it is a new function each render and must not retrigger loads.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const load = useCallback(async () => {
    if (!projectId) return;
    const [p, m] = await Promise.all([api.project(projectId), api.media({ scope: 'all' })]);
    setProject(p);
    setMedia(m);
    onSavedRef.current?.(p);
  }, [api, projectId]);

  useEffect(() => {
    setProject(null);
    setSelected(null);
    setPlayhead(0);
    setPlaying(false);
    setError(null);
    setNotice(null);
    load().catch(setError);
  }, [load]);

  /** Run one server change; on a stale revision reload and tell the user instead of guessing. */
  const run = useCallback(
    async (fn: (p: Project) => Promise<Project>) => {
      if (!project || busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await fn(project);
        setProject(next);
        onSavedRef.current?.(next);
        setSelected((sel) => (sel && next.timeline.tracks.some((t) => t.clips.some((c) => c.clip_id === sel)) ? sel : null));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          setNotice('Proyek berubah di tempat lain. Data terbaru sudah dimuat ulang; ulangi perubahan lo.');
          await load().catch(setError);
        } else setError(e);
      } finally {
        setBusy(false);
      }
    },
    [project, busy, load],
  );

  const edit = useCallback((ops: EditOp[]) => run((p) => api.editProject(p.project_id, p.revision, ops)), [run, api]);
  const step = useCallback((dir: 'undo' | 'redo') => run((p) => api.stepHistory(p.project_id, p.revision, dir)), [run, api]);
  /** X05: an archived project is read-only — every edit control is off (the server refuses too). */
  const reviewer = role === 'reviewer';
  const locked = busy || project?.status === 'archived' || reviewer;

  const tracks = project?.timeline.tracks ?? [];
  const allClips = tracks.flatMap((t) => t.clips.map((c) => ({ ...c, kind: t.kind })));
  const lastEnd = Math.max(0, ...allClips.map((c) => c.end_ms));
  const duration = visibleDuration(lastEnd);
  const sel = allClips.find((c) => c.clip_id === selected) ?? null;
  const canSplit = !!sel && playhead > sel.start_ms && playhead < sel.end_ms;

  const msPerPx = () => duration / Math.max(1, surfaceRef.current?.getBoundingClientRect().width ?? 1);
  const pct = (ms: number) => `${(ms / duration) * 100}%`;

  // Keyboard: S split · Del delete · ←/→ nudge (Shift = 1 s) · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog (render, …) owns the keyboard: Delete/Space must not edit the timeline behind it.
      if (isTyping(e.target) || !project || document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      }
      if (project.status === 'archived' || reviewer) return; // read-only: play/pause only
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey ? project.history.redo : project.history.undo) void step(e.shiftKey ? 'redo' : 'undo');
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        if (project.history.redo) void step('redo');
      } else if (!sel) {
        return;
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        void edit([{ op: 'delete_clip', clip_id: sel.clip_id }]);
      } else if (k === 's' && canSplit) {
        e.preventDefault();
        void edit([{ op: 'split_clip', clip_id: sel.clip_id, at_ms: playhead }]);
      } else if (k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault();
        const d = (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1000 : 100);
        void edit([{ op: 'move_clip', clip_id: sel.clip_id, start_ms: Math.max(0, sel.start_ms + d) }]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, sel, canSplit, playhead, edit, step]);

  const beginDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(clip.clip_id);
    setDrag({ clip, mode, startX: e.clientX, deltaMs: 0, pointerId: e.pointerId });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag({ ...drag, deltaMs: (e.clientX - drag.startX) * msPerPx() });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    const span = dragSpan(d.mode, { ...d.clip, hasMedia: !!d.clip.media, sourceMs: sourceMs(d.clip) }, d.deltaMs);
    if (span.start_ms === d.clip.start_ms && span.end_ms === d.clip.end_ms) return; // a click, not a drag
    const op: EditOp =
      d.mode === 'move'
        ? { op: 'move_clip', clip_id: d.clip.clip_id, start_ms: span.start_ms }
        : d.mode === 'trim-start'
          ? { op: 'trim_clip', clip_id: d.clip.clip_id, edge: 'start', to_ms: span.start_ms }
          : { op: 'trim_clip', clip_id: d.clip.clip_id, edge: 'end', to_ms: span.end_ms };
    void edit([op]);
  };

  const seek = (e: React.MouseEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlaying(false); // seeking stops playback; press play again from the new position
    setPlayhead(snap(Math.min(duration, Math.max(0, (e.clientX - rect.left) * msPerPx()))));
    setSelected(null);
  };

  const versionOf = (versionId: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === versionId);
  /** Source length from the import probe (W07); undefined = unknown (not probed / no ffprobe). */
  const sourceMs = (c: Clip) => (c.media ? versionOf(c.media.version_id)?.probe?.duration_ms : undefined);

  const addToTimeline = (m: Media, kind: 'video' | 'audio' | 'music' | 'sfx') => {
    const trackEnd = Math.max(0, ...(tracks.find((t) => t.kind === kind)?.clips.map((c) => c.end_ms) ?? [0]));
    const probe = versionOf(m.current_version_id)?.probe;
    void edit([{ op: 'add_clip', track_kind: kind, media: { media_id: m.media_id, version_id: m.current_version_id }, start_ms: trackEnd, duration_ms: probe?.duration_ms ?? DEFAULT_CLIP_MS }]);
  };

  const addText = (kind: 'text' | 'subtitle') =>
    void edit([{ op: 'add_clip', track_kind: kind, text: kind === 'text' ? 'Teks baru' : 'Subtitle baru', start_ms: playhead, duration_ms: TEXT_CLIP_MS }]);

  useEffect(() => setTextDraft(sel?.text ?? ''), [sel?.clip_id, sel?.text]);
  const saveText = () => {
    if (sel && sel.text !== undefined && textDraft.trim() && textDraft !== sel.text) void edit([{ op: 'set_text', clip_id: sel.clip_id, text: textDraft }]);
  };

  if (!projectId) {
    return (
      <div className="body">
        {mobileProjects && <div className="card">{mobileProjects}</div>}
        <div className="empty">Pilih atau buat proyek di panel kiri untuk membuka editor.</div>
      </div>
    );
  }

  const names = new Map(media.map((m) => [m.media_id, m.display_name]));
  const usable = media.filter((m) => (m.scope.kind === 'shared' || m.scope.project_id === projectId) && m.versions.some((v) => v.version_id === m.current_version_id && v.lifecycle === 'active' && v.integrity === 'ok'));
  const clipName = (c: Clip) => (c.media ? names.get(c.media.media_id) ?? c.media.media_id : c.effect ? (c.effect.type === 'zoom' ? `Zoom ${c.effect.scale.toFixed(1)}×` : 'Zoom-through') : c.text ?? 'Klip');

  return (
    <div className="editorGrid">
      <header className="top">
        <h1>{project?.name ?? '…'}</h1>
        {project && <span className="badge vio">Revisi {project.revision}</span>}
        {busy ? <span className="badge">Menyimpan…</span> : project && <span className="badge ok">Tersimpan</span>}
        <div className="spacer" />
        <span className="muted hideNarrow">Diperbarui {formatDate(project?.updated_at)}</span>
        {project && !project.variant && (
          <button className="btn" onClick={() => setVariantsOpen(true)} title="Buat varian rasio / hook / CTA dari proyek ini, setujui, lalu render">
            ◫ Varian
          </button>
        )}
        {project && <ProjectMenu api={api} project={project} busy={busy} run={run} onDuplicated={(id) => onProjectCreated?.(id)} brandName={brand?.kit.brand_id ? `${brand.kit.kode} · ${brand.kit.name}` : null} />}
        <button className="btn primary" disabled={!project} onClick={() => setRenderOpen(true)} title="Render proyek ke MP4 (metadata dibersihkan)">
          ↧ Render
        </button>
      </header>
      {variantsOpen && project && (
        <VariantsDialog
          api={api}
          project={project}
          onClose={() => setVariantsOpen(false)}
          onCreated={() => onProjectsChanged?.()}
          onOpen={(id) => {
            setVariantsOpen(false);
            void onProjectCreated?.(id);
          }}
        />
      )}
      {cutClip && project && (
        <CutReviewDialog
          api={api}
          project={project}
          clip={cutClip}
          name={clipName(cutClip)}
          onClose={() => setCutClip(null)}
          onSeek={(ms) => setPlayhead(ms)}
          onApplied={(p) => {
            setProject(p);
            setSelected(null);
            onSavedRef.current?.(p);
          }}
        />
      )}
      {renderOpen && project && <RenderDialog api={api} project={project} onClose={() => setRenderOpen(false)} />}
      {sttMedia && project && (
        <TranscriptDialog
          api={api}
          project={project}
          media={sttMedia}
          onClose={() => setSttMedia(null)}
          onApplied={(p) => {
            setProject(p);
            onSavedRef.current?.(p);
          }}
        />
      )}

      <main className="editor">
        {mobileProjects && (
          <div style={{ padding: 12 }}>
            <details>
              <summary className="muted">Ganti proyek</summary>
              {mobileProjects}
            </details>
          </div>
        )}
        {error ? <div style={{ padding: '12px 16px 0' }}><ErrorNotice error={error} /></div> : null}
        {notice && <div style={{ padding: '12px 16px 0' }}><div className="notice warn" role="status">{notice}</div></div>}
        {project?.variant && (
          <div style={{ padding: '12px 16px 0' }}>
            <div className={`notice ${project.variant.approved_revision === project.revision ? 'ok' : 'info'}`} role="status" aria-label="Status varian">
              Varian V{project.variant.number} ({project.variant.label}) ·{' '}
              {project.variant.approved_revision === project.revision ? 'disetujui' : project.variant.approved_revision ? 'diubah setelah disetujui — perlu disetujui ulang' : 'belum disetujui'}{' '}
              <button
                className="btn small"
                disabled={busy || project.status === 'archived' || role === 'editor'}
                title={role === 'editor' ? 'Persetujuan oleh Owner / Reviewer' : undefined}
                onClick={() =>
                  void run((p) => api.setVariantApproval(p.project_id, p.revision, p.variant!.approved_revision !== p.revision)).then(() => onProjectsChanged?.())
                }
              >
                {project.variant.approved_revision === project.revision ? 'Batalkan persetujuan' : 'Setujui varian ini'}
              </button>{' '}
              <button className="btn small" onClick={() => void onProjectCreated?.(project.variant!.master_id)}>
                Buka master
              </button>
            </div>
          </div>
        )}
        {project?.status === 'archived' && (
          <div style={{ padding: '12px 16px 0' }}>
            <div className="notice warn" role="status">
              Proyek ini diarsipkan (hanya-baca). Medianya tetap dilindungi dari Auto Trash.{' '}
              <button className="btn small" disabled={busy} onClick={() => void run((p) => api.updateProject(p.project_id, p.revision, { status: 'active' }))}>
                Aktifkan lagi
              </button>
            </div>
          </div>
        )}
        {project && (
          <Preview
            api={api}
            project={project}
            media={media}
            playhead={playhead}
            setPlayhead={setPlayhead}
            playing={playing}
            setPlaying={setPlaying}
            busy={locked}
            onRatio={(ratio: CanvasRatio) => void edit([{ op: 'set_canvas', ratio }])}
            selectedClipId={selected}
            onSelectClip={(id) => setSelected(id)}
            styleDraft={styleDraft}
            brand={brand}
            onBrandLogo={(on) => void edit([{ op: 'set_brand_logo', on }])}
            onMoveText={(id, x, y) => {
              setSelected(id);
              void edit([{ op: 'set_style', clip_id: id, style: { x, y } }]);
            }}
          />
        )}
      </main>

      <aside className="sidePanel" aria-label="Media untuk proyek">
        <div className="panelHead">
          <b>Media</b>
          <span className="spacer" />
          <span className="muted">{usable.length}</span>
        </div>
        <div className="panelBody">
          {sel && project && (
            <InspectorPanel
              clip={sel}
              name={clipName(sel)}
              sourceMs={sourceMs(sel)}
              sourceSize={(() => {
                const p = sel.media ? versionOf(sel.media.version_id)?.probe : null;
                return p?.width && p.height ? { w: p.width, h: p.height } : null;
              })()}
              canvasRatio={(() => {
                const [a, b] = (project.timeline.canvas?.ratio ?? '9:16').split(':').map(Number);
                return a! / b!;
              })()}
              busy={busy}
              readOnly={project.status === 'archived' || reviewer}
              brand={brand?.kit ?? null}
              {...(project.status !== 'archived' && !reviewer ? { onCutReview: () => setCutClip(sel) } : {})}
              onEdit={(ops) => edit(ops)}
              onDraft={setStyleDraft}
            />
          )}
          {project && (
            <PresetPanel
              brand={brand?.kit ?? null}
              project={project}
              playhead={playhead}
              busy={locked}
              onAdd={(op) =>
                void run(async (p) => {
                  const next = await api.editProject(p.project_id, p.revision, [op]);
                  // Select the new preset clip so its words can be typed in the inspector right away.
                  const added = next.timeline.tracks.flatMap((t) => t.clips).find((c) => !p.timeline.tracks.some((t) => t.clips.some((o) => o.clip_id === c.clip_id)));
                  if (added) setTimeout(() => setSelected(added.clip_id), 0);
                  return next;
                })
              }
            />
          )}
          {usable.length === 0 ? (
            <div className="muted" style={{ lineHeight: 1.6 }}>Belum ada media. Import lewat menu <b>Media</b>.</div>
          ) : (
            usable.map((m) => {
              const cur = m.versions.find((v) => v.version_id === m.current_version_id);
              return (
                <div className="assetRow" key={m.media_id}>
                  <span title={m.display_name}>
                    {m.display_name}
                    <small className="muted" style={{ display: 'block' }}>
                      {m.scope.kind === 'shared' ? 'Bersama' : 'Proyek ini'} · {cur ? formatBytes(cur.size) : '–'}
                      {cur?.probe ? ` · ${formatDuration(cur.probe.duration_ms)}` : cur?.probe === null ? ' · bukan video/audio' : ''}
                    </small>
                  </span>
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button className="btn small" disabled={locked || !project || cur?.probe === null} onClick={() => addToTimeline(m, 'video')} aria-label={`Tambah ${m.display_name} ke linimasa`}>
                      ＋ Video
                    </button>
                    <button className="btn small" disabled={locked || !project || cur?.probe === null || (!!cur?.probe && !cur.probe.audio_codec)} onClick={() => addToTimeline(m, 'audio')} aria-label={`Tambah audio ${m.display_name}`}>
                      ＋ Audio
                    </button>
                    <button className="btn small" disabled={locked || !project || cur?.probe === null || (!!cur?.probe && !cur.probe.audio_codec)} onClick={() => addToTimeline(m, 'sfx')} aria-label={`Tambah SFX ${m.display_name}`} title="Tambah sebagai efek suara (track SFX, bisa bersamaan dengan musik)">
                      ＋ SFX
                    </button>
                    <button className="btn small" disabled={locked || !project || cur?.probe === null || (!!cur?.probe && !cur.probe.audio_codec)} onClick={() => addToTimeline(m, 'music')} aria-label={`Tambah musik ${m.display_name}`} title="Tambah sebagai musik latar (track Musik, di bawah suara)">
                      ＋ Musik
                    </button>
                    <button className="btn small" disabled={locked || !project || !cur?.probe?.audio_codec} onClick={() => setSttMedia(m)} aria-label={`Transkrip ${m.display_name}`} title="Transkrip & subtitle dari suara media ini">
                      CC
                    </button>
                  </span>
                </div>
              );
            })
          )}
          {usable.some((m) => versionOf(m.current_version_id)?.probe === undefined) && (
            <p className="muted" style={{ fontSize: 11, lineHeight: 1.6, margin: 0 }}>
              Sebagian media belum terbaca durasinya (ffprobe belum jalan untuk file itu). Klip dari media tersebut masuk 5 detik dan trim-nya belum dibatasi panjang sumber.
            </p>
          )}
          {project && <ReviewPanel api={api} project={project} role={role} playheadMs={playhead} onSeek={(ms) => setPlayhead(ms)} />}
          {project && !reviewer && (
            <CopilotPanel
              api={api}
              project={project}
              selectedClipId={selected}
              playheadMs={playhead}
              busy={locked}
              onApplied={(p) => {
                setProject(p);
                onSavedRef.current?.(p);
                setSelected((s) => (s && p.timeline.tracks.some((t) => t.clips.some((c) => c.clip_id === s)) ? s : null));
              }}
              onUndo={() => void step('undo')}
            />
          )}
        </div>
      </aside>

      <section className="timeline" aria-label="Linimasa">
        <div className="timelineTop">
          <b>Linimasa</b>
          <small className="muted hideNarrow">{allClips.length} klip</small>
          <div className="spacer" />
          <button className="smallbtn" disabled={locked || !project} onClick={() => addText('text')} title="Tambah teks di playhead">
            ＋ Teks
          </button>
          <button className="smallbtn" disabled={locked || !project} onClick={() => addText('subtitle')} title="Tambah subtitle di playhead">
            ＋ Subtitle
          </button>
          <button
            className="smallbtn"
            disabled={locked || !project}
            title="Tambah zoom (punch-in) 1 detik di playhead"
            onClick={() => {
              const taken = tracks.find((x) => x.kind === 'effects')?.clips ?? [];
              let start = Math.round(playhead / 100) * 100;
              for (const c of [...taken].sort((a, b) => a.start_ms - b.start_ms)) if (c.start_ms < start + 1000 && start < c.end_ms) start = c.end_ms;
              void edit([{ op: 'add_clip', track_kind: 'effects', start_ms: start, duration_ms: 1000, effect: { type: 'zoom', scale: 1.2, mode: 'smooth', x: 0.5, y: 0.5 } }]);
            }}
          >
            ＋ Zoom
          </button>
          <button className="smallbtn" disabled={locked || !project?.history.undo} onClick={() => step('undo')} title={project?.history.undo_label ? `Undo: ${project.history.undo_label} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}>
            ↶ Undo
          </button>
          <button className="smallbtn" disabled={locked || !project?.history.redo} onClick={() => step('redo')} title={project?.history.redo_label ? `Redo: ${project.history.redo_label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}>
            ↷ Redo
          </button>
          <button className="smallbtn" disabled={locked || !canSplit} onClick={() => sel && edit([{ op: 'split_clip', clip_id: sel.clip_id, at_ms: playhead }])} title="Split klip terpilih di playhead (S)">
            ✂ Split
          </button>
          <button className="smallbtn" disabled={locked || !sel} onClick={() => sel && edit([{ op: 'delete_clip', clip_id: sel.clip_id }])} title="Hapus klip terpilih (Del)">
            🗑 Hapus
          </button>
        </div>
        {sel?.text !== undefined && (
          <div className="textEdit">
            <label htmlFor="clipText" className="muted">
              Teks klip
            </label>
            <input
              id="clipText"
              value={textDraft}
              maxLength={500}
              onChange={(e) => setTextDraft(e.target.value)}
              onBlur={saveText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        )}
        <div className="tracks">
          <div className="track rulerRow">
            <div className="trackLabel muted">{formatDuration(playhead)}</div>
            <div className="trackSurface ruler" ref={surfaceRef} onClick={seek} role="slider" aria-label="Posisi playhead" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={playhead} tabIndex={-1}>
              {rulerTicks(duration).map((t) => (
                <span key={t} className="tick" style={{ left: pct(t) }}>
                  {formatDuration(t)}
                </span>
              ))}
              <div className="playhead" style={{ left: pct(playhead) }} />
            </div>
          </div>
          {TRACKS.map((t) => {
            const clips = tracks.filter((x) => x.kind === t.kind).flatMap((x) => x.clips);
            return (
              <div className="track" key={t.kind}>
                <div className="trackLabel">
                  {t.label}
                  {(t.kind === 'video' || t.kind === 'broll' || t.kind === 'audio' || t.kind === 'music' || t.kind === 'sfx') && (
                    <button
                      className={`trackMute${tracks.some((x) => x.kind === t.kind && x.muted) ? ' on' : ''}`}
                      disabled={locked || !project}
                      aria-pressed={tracks.some((x) => x.kind === t.kind && x.muted)}
                      aria-label={`${tracks.some((x) => x.kind === t.kind && x.muted) ? 'Nyalakan suara' : 'Bisukan'} track ${t.label.replace(/^\S+\s+/, '')}`}
                      title="Bisukan/nyalakan suara track ini (pratinjau & render)"
                      onClick={() => void edit([{ op: 'set_track_mute', track_kind: t.kind as 'video' | 'broll' | 'audio' | 'music' | 'sfx', muted: !tracks.some((x) => x.kind === t.kind && x.muted) }])}
                    >
                      {tracks.some((x) => x.kind === t.kind && x.muted) ? '🔇' : '🔊'}
                    </button>
                  )}
                </div>
                <div className="trackSurface" onClick={seek}>
                  <div className="playhead" style={{ left: pct(playhead) }} />
                  {clips.map((c) => {
                    const live = drag && drag.clip.clip_id === c.clip_id ? dragSpan(drag.mode, { ...c, hasMedia: !!c.media, sourceMs: sourceMs(c) }, drag.deltaMs) : c;
                    const isSel = c.clip_id === selected;
                    return (
                      <div
                        key={c.clip_id}
                        className={`clip ${t.kind}${isSel ? ' selected' : ''}${drag?.clip.clip_id === c.clip_id ? ' dragging' : ''}`}
                        style={{ left: pct(live.start_ms), width: pct(Math.max(1, live.end_ms - live.start_ms)) }}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSel}
                        aria-label={`${clipName(c)}, ${formatDuration(c.start_ms)} sampai ${formatDuration(c.end_ms)}`}
                        title={`${clipName(c)} · ${formatDuration(live.start_ms)}–${formatDuration(live.end_ms)}${c.in_ms ? ` · mulai dari detik ${(c.in_ms / 1000).toFixed(1)} sumber` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(c.clip_id);
                        }}
                        onFocus={() => setSelected(c.clip_id)}
                        onPointerDown={(e) => beginDrag(e, c, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={() => setDrag(null)}
                      >
                        <span className="handle start" aria-hidden="true" onPointerDown={(e) => beginDrag(e, c, 'trim-start')} onPointerMove={moveDrag} onPointerUp={endDrag} />
                        <span className="clipLabel">{ellipsize(clipName(c), 28)}</span>
                        <span className="handle end" aria-hidden="true" onPointerDown={(e) => beginDrag(e, c, 'trim-end')} onPointerMove={moveDrag} onPointerUp={endDrag} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="footerNote">
          {allClips.length === 0
            ? 'Linimasa kosong. Tambahkan media dari panel kanan (＋ Video).'
            : 'Spasi putar/jeda · klik klip untuk memilih · seret untuk geser · seret pinggirnya untuk trim · klik linimasa untuk memindah playhead · S split · Del hapus · ←/→ geser 0,1 dtk (Shift 1 dtk) · Ctrl+Z / Ctrl+Shift+Z.'}
        </div>
      </section>
    </div>
  );
}
