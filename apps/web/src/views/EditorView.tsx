import { CopilotPanel } from './CopilotPanel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Api, ApiError, type Clip, type EditOp, type Media, type Project, type Track } from '../api';
import { type CanvasRatio, DEFAULT_CLIP_MS, type DragMode, dragSpan, ellipsize, formatBytes, formatDate, formatDuration, rulerTicks, snap, visibleDuration } from '../lib';
import { ErrorNotice } from '../ui';
import { Preview } from './Preview';
import { RenderDialog } from './RenderDialog';

const TEXT_CLIP_MS = 3000;

const TRACKS: { kind: Track['kind']; label: string }[] = [
  { kind: 'video', label: '▤  Video' },
  { kind: 'broll', label: '◈  B-roll' },
  { kind: 'text', label: 'T  Teks & CTA' },
  { kind: 'subtitle', label: '☷  Subtitle' },
  { kind: 'audio', label: '♫  Audio' },
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
export function EditorView({ api, projectId, mobileProjects, onSaved }: { api: Api; projectId: string | null; mobileProjects: ReactNode; onSaved?: (p: Project) => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    if (busy || e.button !== 0) return;
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

  const addToTimeline = (m: Media, kind: 'video' | 'audio') => {
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
  const clipName = (c: Clip) => (c.media ? names.get(c.media.media_id) ?? c.media.media_id : c.text ?? 'Klip');

  return (
    <div className="editorGrid">
      <header className="top">
        <h1>{project?.name ?? '…'}</h1>
        {project && <span className="badge vio">Revisi {project.revision}</span>}
        {busy ? <span className="badge">Menyimpan…</span> : project && <span className="badge ok">Tersimpan</span>}
        <div className="spacer" />
        <span className="muted hideNarrow">Diperbarui {formatDate(project?.updated_at)}</span>
        <button className="btn primary" disabled={!project} onClick={() => setRenderOpen(true)} title="Render proyek ke MP4 (metadata dibersihkan)">
          ↧ Render
        </button>
      </header>
      {renderOpen && project && <RenderDialog api={api} project={project} onClose={() => setRenderOpen(false)} />}

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
        {project && (
          <Preview
            api={api}
            project={project}
            media={media}
            playhead={playhead}
            setPlayhead={setPlayhead}
            playing={playing}
            setPlaying={setPlaying}
            busy={busy}
            onRatio={(ratio: CanvasRatio) => void edit([{ op: 'set_canvas', ratio }])}
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
                    <button className="btn small" disabled={busy || !project || cur?.probe === null} onClick={() => addToTimeline(m, 'video')} aria-label={`Tambah ${m.display_name} ke linimasa`}>
                      ＋ Video
                    </button>
                    <button className="btn small" disabled={busy || !project || cur?.probe === null || (!!cur?.probe && !cur.probe.audio_codec)} onClick={() => addToTimeline(m, 'audio')} aria-label={`Tambah audio ${m.display_name}`}>
                      ＋ Audio
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
          {project && (
            <CopilotPanel
              api={api}
              project={project}
              selectedClipId={selected}
              playheadMs={playhead}
              busy={busy}
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
          <button className="smallbtn" disabled={busy || !project} onClick={() => addText('text')} title="Tambah teks di playhead">
            ＋ Teks
          </button>
          <button className="smallbtn" disabled={busy || !project} onClick={() => addText('subtitle')} title="Tambah subtitle di playhead">
            ＋ Subtitle
          </button>
          <button className="smallbtn" disabled={busy || !project?.history.undo} onClick={() => step('undo')} title={project?.history.undo_label ? `Undo: ${project.history.undo_label} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}>
            ↶ Undo
          </button>
          <button className="smallbtn" disabled={busy || !project?.history.redo} onClick={() => step('redo')} title={project?.history.redo_label ? `Redo: ${project.history.redo_label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}>
            ↷ Redo
          </button>
          <button className="smallbtn" disabled={busy || !canSplit} onClick={() => sel && edit([{ op: 'split_clip', clip_id: sel.clip_id, at_ms: playhead }])} title="Split klip terpilih di playhead (S)">
            ✂ Split
          </button>
          <button className="smallbtn" disabled={busy || !sel} onClick={() => sel && edit([{ op: 'delete_clip', clip_id: sel.clip_id }])} title="Hapus klip terpilih (Del)">
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
                <div className="trackLabel">{t.label}</div>
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
