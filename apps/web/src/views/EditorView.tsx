import { CopilotPanel } from './CopilotPanel';
import { ReviewPanel } from './ReviewPanel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Api, ApiError, type Clip, type EditOp, type Media, type Project, type Role, type Track } from '../api';
import { type CanvasRatio, DEFAULT_CLIP_MS, type DragMode, TIMELINE_ZOOM, clampScroll, dragSpan, ellipsize, formatBytes, formatDate, formatDuration, rulerTicks, snap, visibleDuration, zoomAround, keepSelection } from '../lib';
import { ClipThumbs, ClipWave, useMediaVisuals } from './TimelineVisuals';
import { ErrorNotice } from '../ui';
import { Preview } from './Preview';
import { OverlayPicker, type OverlayPick } from './OverlayPicker';
import { type Overlay, contentEnd } from '../../../../packages/core/dist/storage/overlay.js';
import { waitingForProxy } from '../proxyWait';
import { fitMove, fitTrim, gapAt } from '../dragFit';
import type { TextStyle } from '../../../../packages/core/dist/storage/textStyle.js';
import { InspectorPanel } from './InspectorPanel';
import { RencanaBanner } from './RencanaBanner';
import { MultiPanel } from './MultiPanel';
import { VisualToolsPanel } from './VisualToolsPanel';
import { voSubtitleOps } from '../../../../packages/core/dist/storage/voText.js';
import type { VoIndex } from '../api';
import { freeSlot } from './PresetPanel';
import { LibraryPanel } from './LibraryPanel';
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
  { kind: 'overlay', label: '◧  Overlay' },
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

/** Tracks that show a thumbnail strip / a waveform inside their clips (paket 1). */
const THUMB_TRACKS = new Set<Track['kind']>(['video', 'broll']);

/** R26: overlays may overlap in time — each gets a row of the lane (greedy packing, max 3 rows). */
function overlayRow(clips: readonly Clip[], c: Clip): { top: string; height: string } {
  const rows: number[] = [];
  const at = new Map<string, number>();
  for (const x of [...clips].sort((a, b) => a.start_ms - b.start_ms)) {
    let r = rows.findIndex((end) => end <= x.start_ms);
    if (r < 0) r = rows.length;
    rows[r] = x.end_ms;
    at.set(x.clip_id, r);
  }
  const n = Math.min(3, Math.max(1, rows.length));
  const r = Math.min(n - 1, at.get(c.clip_id) ?? 0);
  return { top: `${(r * 100) / n}%`, height: `${100 / n}%` };
}
const WAVE_TRACKS: Partial<Record<Track['kind'], string>> = { audio: '#8fe0d2', music: '#9fc4ff', sfx: '#f6d67c' };

/** Waveform or thumbnails for one media clip; renders nothing until the server has made them. */
function ClipVisual({ api, clip, kind, inMs, lenMs }: { api: Api; clip: Clip; kind: Track['kind']; inMs: number; lenMs: number }) {
  const v = useMediaVisuals(api, clip.media?.version_id);
  if (!v) return null;
  if (THUMB_TRACKS.has(kind) && v.thumbs) return <ClipThumbs v={v} inMs={inMs} lenMs={lenMs} />;
  const color = WAVE_TRACKS[kind];
  if (color && v.peaks) return <ClipWave v={v} inMs={inMs} lenMs={lenMs} color={color} />;
  return null;
}

/**
 * Keyboard shortcuts stay off only while the user is really typing text. R32: a checkbox, slider,
 * colour picker or select in the Inspector that still has focus no longer swallows Del / S / arrows
 * (the team changed a CTA's style, pressed Del and nothing happened).
 */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'number', 'tel', 'url', 'password', '']);
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && TEXT_INPUTS.has(t.type)));
/** A select keeps its own arrow keys (choosing an option); Del / S still edit the timeline. */
const ownsArrows = (t: EventTarget | null) => t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'range');

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
  onLihatRencana,
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
  /** R25: open the engine plan of a project on the Video iklan page. */
  onLihatRencana?: (projectId: string, jobId: string) => void;
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
  const [brandReload, setBrandReload] = useState(0);
  const brand = useBrand(api, { brandId: project?.brand_id ?? null, reload: brandReload });
  /** R26: "＋ Overlay" picker and the inspector's live overlay spec. */
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState<{ clip_id: string; overlay: Overlay } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** R33: several clips picked together (empty = the single `selected` clip only). */
  const [picked, setPicked] = useState<string[]>([]);
  /** R33: box-select rectangle on the lanes (px inside `.tracks`). */
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; pointerId: number } | null>(null);
  const boxDone = useRef(false);
  const dragMoved = useRef(false);
  /** R33: right-click menu on a clip (Hapus / Duplikat / Split di playhead). */
  const [menu, setMenu] = useState<{ x: number; y: number; clip_id: string } | null>(null);
  /** Owner 16 Nov: right-click an empty gap on a lane → "Hapus jarak" (pull the clips after it left). */
  const [gapMenu, setGapMenu] = useState<{ x: number; y: number; clip_ids: string[]; delta_ms: number } | null>(null);
  useEffect(() => {
    if (!menu && !gapMenu) return;
    const close = () => {
      setMenu(null);
      setGapMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu, gapMenu]);
  const [playhead, setPlayhead] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [playing, setPlaying] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  /** Paket 1: timeline zoom (1 = whole timeline fits) and horizontal scroll of the zoomed lane, in px. */
  const [zoom, setZoom] = useState(1);
  const [scrollPx, setScrollPx] = useState(0);
  const [viewPx, setViewPx] = useState(0);
  // Parent callback kept in a ref: it is a new function each render and must not retrigger loads.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Audit 14 Nov: an answer for a project left meanwhile (slow tunnel) never lands on the one open now.
  const openId = useRef(projectId);
  openId.current = projectId;
  const load = useCallback(async () => {
    if (!projectId) return;
    const [p, m] = await Promise.all([api.project(projectId), api.media({ scope: 'all' })]);
    if (openId.current !== projectId) return;
    setProject(p);
    setMedia(m);
    onSavedRef.current?.(p);
  }, [api, projectId]);

  useEffect(() => {
    setProject(null);
    setSelected(null);
    setPicked([]);
    setPlayhead(0);
    setPlaying(false);
    setError(null);
    setNotice(null);
    setZoom(1);
    setScrollPx(0);
    load().catch(setError);
  }, [load]);

  // A video the browser cannot play (HEVC) shows once its light copy is made in the background:
  // re-read the media list every 4 s while one is still being made, so no page reload is needed.
  const proxyPending = waitingForProxy(media);
  useEffect(() => {
    if (!projectId || !proxyPending) return;
    const t = setInterval(() => {
      api.media({ scope: 'all' }).then((m) => openId.current === projectId && setMedia(m), () => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [api, projectId, proxyPending]);

  /** Run one server change; on a stale revision reload and tell the user instead of guessing. */
  // Latest project / busy for edits chained right after another one (R5: flush a pending style
  // change, then undo — the undo must see the revision that change made).
  const projectRef = useRef(project);
  projectRef.current = project;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const run = useCallback(
    async (fn: (p: Project) => Promise<Project>) => {
      const before = projectRef.current;
      if (!before || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await fn(before);
        onSavedRef.current?.(next);
        if (openId.current !== next.project_id) return; // saved, but another project is open now
        projectRef.current = next;
        setProject(next);
        setSelected((sel) => keepSelection(before, next, sel));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          setNotice('Proyek berubah di tempat lain. Data terbaru sudah dimuat ulang; ulangi perubahan lo.');
          await load().catch(setError);
        } else setError(e);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  const edit = useCallback((ops: EditOp[]) => run((p) => api.editProject(p.project_id, p.revision, ops)), [run, api]);
  /** R5: a style / volume change still waiting its 0,45 s (Inspector) is saved FIRST, then undo / redo. */
  const inspectorFlush = useRef<(() => Promise<void>) | null>(null);
  const step = useCallback(
    async (dir: 'undo' | 'redo') => {
      await inspectorFlush.current?.();
      return run((p) => api.stepHistory(p.project_id, p.revision, dir));
    },
    [run, api],
  );
  /** X05: an archived project is read-only — every edit control is off (the server refuses too). */
  const reviewer = role === 'reviewer';
  const locked = busy || project?.status === 'archived' || reviewer;
  // R32: why editing (delete, split, …) is off right now, and how to turn it back on.
  const lockReason = reviewer
    ? 'Peran Reviewer hanya bisa melihat & berkomentar. Minta Owner menjadikan Anda Editor.'
    : project?.status === 'archived'
      ? 'Proyek diarsipkan (hanya-baca). Klik "Aktifkan lagi" di atas untuk mengedit.'
      : busy
        ? 'Sedang menyimpan perubahan…'
        : null;

  const tracks = project?.timeline.tracks ?? [];
  const allClips = tracks.flatMap((t) => t.clips.map((c) => ({ ...c, kind: t.kind })));
  const lastEnd = Math.max(0, ...allClips.map((c) => c.end_ms));
  const duration = visibleDuration(lastEnd);
  const sel = allClips.find((c) => c.clip_id === selected) ?? null;
  // R34: a selected VO (from "Suara dari Teks") knows its text → subtitles without Whisper.
  const [vo, setVo] = useState<{ version_id: string; index: VoIndex } | null>(null);
  const selVersion = sel?.media?.version_id ?? null;
  useEffect(() => {
    if (!selVersion) return;
    let stale = false;
    void api.voIndex(selVersion).then((index) => !stale && setVo(index ? { version_id: selVersion, index } : null), () => undefined);
    return () => {
      stale = true;
    };
  }, [api, selVersion]);
  const selVo = sel?.media && vo?.version_id === sel.media.version_id ? vo.index : null;
  // R33: the group (only clips that still exist); 2+ = group mode.
  const group = picked.length > 1 ? allClips.filter((c) => picked.includes(c.clip_id)) : [];
  const groupIds = group.map((c) => c.clip_id);
  /** Click with Shift (range on the lane) / Ctrl·Cmd (add/remove) / plain (one clip). */
  const pick = (c: Clip, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const kindOf = (id: string) => allClips.find((x) => x.clip_id === id)?.kind;
    const current = picked.length ? picked : selected ? [selected] : [];
    if (e.ctrlKey || e.metaKey) {
      const next = current.includes(c.clip_id) ? current.filter((x) => x !== c.clip_id) : [...current, c.clip_id];
      setPicked(next);
      setSelected(next.includes(c.clip_id) ? c.clip_id : (next[next.length - 1] ?? null));
    } else if (e.shiftKey && selected && kindOf(selected) === kindOf(c.clip_id)) {
      const lane = allClips.filter((x) => x.kind === kindOf(c.clip_id)).sort((a, b) => a.start_ms - b.start_ms);
      const [i, j] = [lane.findIndex((x) => x.clip_id === selected), lane.findIndex((x) => x.clip_id === c.clip_id)].sort((a, b) => a - b);
      setPicked(lane.slice(i!, j! + 1).map((x) => x.clip_id));
      setSelected(c.clip_id);
    } else {
      setPicked([]);
      setSelected(c.clip_id);
    }
  };
  const canSplit = !!sel && playhead > sel.start_ms && playhead < sel.end_ms;

  const msPerPx = () => duration / Math.max(1, (surfaceRef.current?.getBoundingClientRect().width ?? 1) * zoom);
  const pct = (ms: number) => `${(ms / duration) * 100}%`;
  /** The zoomed lane inside every track surface: wider than the view, shifted by the scroll. */
  const lane = { width: `${zoom * 100}%`, transform: `translateX(${-scrollPx}px)` };

  // Paket 1: keep the view width current (zoom/scroll limits depend on it).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setViewPx(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [project?.project_id]);
  useEffect(() => setScrollPx((s) => clampScroll(s, viewPx, zoom)), [viewPx, zoom]);

  /** Zoom keeping the time under `anchorPx` still (default: the playhead if visible, else the view centre). */
  const zoomTo = useCallback(
    (next: number, anchorPx?: number) => {
      if (viewPx <= 0) return;
      const headPx = (playhead / duration) * viewPx * zoom - scrollPx;
      const anchor = anchorPx ?? (headPx >= 0 && headPx <= viewPx ? headPx : viewPx / 2);
      const r = zoomAround(zoom, next, scrollPx, anchor, viewPx);
      setZoom(r.zoom);
      setScrollPx(r.scrollPx);
    },
    [viewPx, zoom, scrollPx, playhead, duration],
  );

  // Ctrl/⌘ + wheel zooms into the cursor; plain wheel (or Shift + wheel) scrolls sideways when zoomed.
  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(zoom * Math.exp(-e.deltaY * 0.0025), Math.min(rect.width, Math.max(0, e.clientX - rect.left)));
      } else if (zoom > 1 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setScrollPx((s) => clampScroll(s + d, rect.width, zoom));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, zoomTo, project?.project_id]);

  // While playing, page the view along so the playhead never runs off screen.
  useEffect(() => {
    if (!playing || zoom <= 1 || viewPx <= 0) return;
    const x = (playhead / duration) * viewPx * zoom;
    if (x < scrollPx || x > scrollPx + viewPx * 0.95) setScrollPx(clampScroll(x - viewPx * 0.1, viewPx, zoom));
  }, [playing, playhead, duration, zoom, viewPx, scrollPx]);

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
      } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
        // R33: every clip of the selected clip's lane (subtitles when nothing is selected).
        e.preventDefault();
        const kind = sel?.kind ?? (allClips.some((c) => c.kind === 'subtitle') ? 'subtitle' : 'text');
        const lane = allClips.filter((c) => c.kind === kind);
        if (lane.length) {
          setPicked(lane.map((c) => c.clip_id));
          setSelected(sel && sel.kind === kind ? sel.clip_id : lane[0]!.clip_id);
        }
      } else if (k === 'escape' && picked.length) {
        setPicked([]);
      } else if (groupIds.length > 1 && (k === 'delete' || k === 'backspace')) {
        e.preventDefault();
        void edit([{ op: 'delete_clips', clip_ids: groupIds }]).then(() => setPicked([]));
      } else if (groupIds.length > 1 && (k === 'arrowleft' || k === 'arrowright') && !ownsArrows(e.target)) {
        e.preventDefault();
        void edit([{ op: 'shift_clips', clip_ids: groupIds, delta_ms: (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1000 : 100) }]);
      } else if (!sel) {
        return;
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        void edit([{ op: 'delete_clip', clip_id: sel.clip_id }]);
      } else if (k === 's' && canSplit) {
        e.preventDefault();
        void edit([{ op: 'split_clip', clip_id: sel.clip_id, at_ms: playhead }]);
      } else if ((k === 'arrowleft' || k === 'arrowright') && !ownsArrows(e.target)) {
        e.preventDefault();
        const d = (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1000 : 100);
        void edit([{ op: 'move_clip', clip_id: sel.clip_id, start_ms: Math.max(0, sel.start_ms + d) }]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, sel, canSplit, playhead, edit, step, picked, groupIds.join(',')]);

  const beginDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    dragMoved.current = false;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return; // R33: picking, not dragging
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // R33: dragging a picked clip moves the whole group; any other clip = a single selection.
    if (!(mode === 'move' && groupIds.includes(clip.clip_id))) setPicked([]);
    setSelected(clip.clip_id);
    setDrag({ clip, mode, startX: e.clientX, deltaMs: 0, pointerId: e.pointerId });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    setDrag({ ...drag, deltaMs: Math.abs(dx) < 2 ? 0 : dx * msPerPx() }); // a shaky click does not move the clip
  };
  /** Owner 16 Nov: easier dragging — the clip sticks to nearby edges and stops against its neighbour
   *  (the server refuses overlaps, so a drop onto a neighbour used to bounce back). */
  const fitted = (d: Drag) => {
    const raw = dragSpan(d.mode, { ...d.clip, hasMedia: !!d.clip.media, sourceMs: sourceMs(d.clip) }, d.deltaMs);
    const others = (tracks.find((t) => t.clips.some((c) => c.clip_id === d.clip.clip_id))?.clips ?? []).filter((c) => c.clip_id !== d.clip.clip_id);
    if (d.mode === 'move') return fitMove(raw, others, [playhead], 8 * msPerPx(), d.clip);
    return fitTrim(raw, d.mode === 'trim-start' ? 'start' : 'end', others, d.clip);
  };
  const groupDrag = (d: Drag) => d.mode === 'move' && groupIds.length > 1 && groupIds.includes(d.clip.clip_id);
  const endDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    const span = groupDrag(d) ? dragSpan(d.mode, { ...d.clip, hasMedia: !!d.clip.media, sourceMs: sourceMs(d.clip) }, d.deltaMs) : fitted(d);
    if (span.start_ms === d.clip.start_ms && span.end_ms === d.clip.end_ms) return; // a click, not a drag
    dragMoved.current = true;
    if (groupDrag(d)) {
      void edit([{ op: 'shift_clips', clip_ids: groupIds, delta_ms: span.start_ms - d.clip.start_ms }]);
      return;
    }
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
    if (boxDone.current) {
      boxDone.current = false; // the click that ended a box selection is not a seek
      return;
    }
    setPlayhead(snap(Math.min(duration, Math.max(0, (e.clientX - rect.left + scrollPx) * msPerPx()))));
    setSelected(null);
    setPicked([]);
  };

  // Owner 16 Nov: the playhead can be dragged (scrub) on the ruler or by its line in the lanes;
  // the preview follows while dragging.
  const scrubId = useRef<number | null>(null);
  const scrubTo = (clientX: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlaying(false);
    setPlayhead(snap(Math.min(duration, Math.max(0, (clientX - rect.left + scrollPx) * msPerPx())), 10));
  };
  const scrubProps = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // not a box selection
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      scrubId.current = e.pointerId;
      scrubTo(e.clientX);
    },
    onPointerMove: (e: React.PointerEvent) => scrubId.current === e.pointerId && scrubTo(e.clientX),
    onPointerUp: () => (scrubId.current = null),
    onPointerCancel: () => (scrubId.current = null),
  };
  const openGapMenu = (e: React.MouseEvent, kind: string) => {
    e.preventDefault();
    const surf = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = (e.clientX - surf.left + scrollPx) * msPerPx();
    const gap = tracks.filter((x) => x.kind === kind).map((x) => gapAt(x.clips, at)).find((g) => g !== null) ?? null;
    setMenu(null);
    setGapMenu(gap && !locked ? { x: e.clientX, y: e.clientY, ...gap } : null);
  };

  // R33: drag a box over empty lane space → every clip it touches (on the lanes it covers).
  const tracksBox = (e: React.PointerEvent) => {
    const r = tracksRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const boxStart = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (locked || e.button !== 0 || t.closest('.clip') || !t.closest('.trackSurface') || t.closest('.ruler')) return;
    const p = tracksBox(e);
    setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, pointerId: e.pointerId });
  };
  const boxMove = (e: React.PointerEvent) => {
    if (!box || e.pointerId !== box.pointerId) return;
    const p = tracksBox(e);
    setBox({ ...box, x1: p.x, y1: p.y });
  };
  const boxEnd = (e: React.PointerEvent) => {
    if (!box || e.pointerId !== box.pointerId) return;
    const b = box;
    setBox(null);
    if (Math.abs(b.x1 - b.x0) < 6 && Math.abs(b.y1 - b.y0) < 6) return; // a click (seek)
    boxDone.current = true;
    const host = tracksRef.current!.getBoundingClientRect();
    const [top, bottom] = [Math.min(b.y0, b.y1) + host.top, Math.max(b.y0, b.y1) + host.top];
    const [left, right] = [Math.min(b.x0, b.x1) + host.left, Math.max(b.x0, b.x1) + host.left];
    const hits: string[] = [];
    for (const row of tracksRef.current!.querySelectorAll<HTMLElement>('.track[data-kind]')) {
      const rr = row.getBoundingClientRect();
      if (rr.bottom < top || rr.top > bottom) continue;
      const surf = row.querySelector('.trackSurface')!.getBoundingClientRect();
      const toMs = (x: number) => (x - surf.left + scrollPx) * msPerPx();
      const [a, z] = [toMs(left), toMs(right)];
      for (const c of allClips) if (c.kind === row.dataset.kind && c.start_ms < z && c.end_ms > a) hits.push(c.clip_id);
    }
    setPicked(hits);
    setSelected(hits[0] ?? null);
  };

  const versionOf = (versionId: string) => media.flatMap((m) => m.versions).find((v) => v.version_id === versionId);
  /** Source length from the import probe (W07); undefined = unknown (not probed / no ffprobe). */
  const sourceMs = (c: Clip) => (c.media ? versionOf(c.media.version_id)?.probe?.duration_ms : undefined);

  const addToTimeline = (m: Media, kind: 'video' | 'audio' | 'music' | 'sfx') => {
    const trackEnd = Math.max(0, ...(tracks.find((t) => t.kind === kind)?.clips.map((c) => c.end_ms) ?? [0]));
    const probe = versionOf(m.current_version_id)?.probe;
    void edit([{ op: 'add_clip', track_kind: kind, media: { media_id: m.media_id, version_id: m.current_version_id }, start_ms: trackEnd, duration_ms: probe?.duration_ms ?? DEFAULT_CLIP_MS }]);
  };

  // Audit 14 Nov: at the playhead if free, else the next free spot (no "tumpang tindih" error).
  /** R26: a picked picture → one overlay clip (whole video, or 3 s at the playhead), in front. */
  const addOverlay = (p: OverlayPick) => {
    setOverlayOpen(false);
    if (!project) return;
    const end = contentEnd(project.timeline.tracks);
    const whole = p.sepanjang && end >= 100;
    const start = whole ? 0 : Math.round(playhead / 100) * 100;
    void edit([{ op: 'add_clip', track_kind: 'overlay', media: p.ref, start_ms: start, duration_ms: whole ? end : TEXT_CLIP_MS, ...(whole ? { overlay: { pos: p.jenis === 'logo' ? 'tr' : p.jenis === 'frame' ? 'c' : 'br', dx: 0, dy: 0, skala: p.jenis === 'frame' ? 100 : p.jenis === 'logo' ? 18 : 30, opasitas: p.jenis === 'watermark' ? 0.6 : 1, margin: p.jenis === 'frame' ? 0 : 4, layer: Math.min(999, Math.max(-1, ...overlayLayers()) + 1), sepanjang: true } } : {}) }]);
  };
  const overlayLayers = () => (project?.timeline.tracks.find((t) => t.kind === 'overlay')?.clips ?? []).map((c) => c.overlay?.layer ?? 0);
  const addText = (kind: 'text' | 'subtitle') =>
    project && void edit([{ op: 'add_clip', track_kind: kind, text: kind === 'text' ? 'Teks baru' : 'Subtitle baru', start_ms: freeSlot(project, kind, playhead, TEXT_CLIP_MS), duration_ms: TEXT_CLIP_MS }]);

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
        <button
          className="btn primary"
          disabled={!project || (!!project.variant && project.variant.approved_revision !== project.revision)}
          onClick={() => setRenderOpen(true)}
          title={project?.variant && project.variant.approved_revision !== project.revision ? 'Varian harus disetujui (Owner / Reviewer) sebelum dirender' : 'Render proyek ke MP4 (metadata dibersihkan)'}
        >
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
      {overlayOpen && project && <OverlayPicker api={api} kit={brand?.kit ?? null} onPick={addOverlay} onClose={() => setOverlayOpen(false)} onKitSaved={() => setBrandReload((n) => n + 1)} />}
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
        {project && <RencanaBanner key={project.project_id} api={api} project={project} role={role} busy={busy} run={(fn) => run(fn).then(() => onProjectsChanged?.())} {...(onLihatRencana ? { onLihat: onLihatRencana } : {})} />}
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
            overlayDraft={overlayDraft}
            onMoveOverlay={(id, dx, dy) => void edit([{ op: 'set_overlay', clip_id: id, overlay: { dx, dy } }])}
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
          {selVo && sel && group.length < 2 && (
            <div className="notice info small" role="status" aria-label="VO dari teks">
              Klip ini VO dari &quot;Suara dari Teks&quot; ({selVo.kalimat.length} kalimat).{' '}
              <button
                className="btn small"
                disabled={locked || (sel.speed ?? 1) !== 1}
                title={(sel.speed ?? 1) !== 1 ? 'Kembalikan kecepatan ke 1× dulu' : 'Subtitle per kalimat dengan waktu tiap kata, dari teks yang sudah diketahui (tanpa Whisper)'}
                onClick={() => void edit(voSubtitleOps(selVo, sel.start_ms, sel.in_ms ?? 0, sel.end_ms - sel.start_ms) as EditOp[])}
              >
                ＋ Subtitle dari teks
              </button>
            </div>
          )}
          {sel?.media && project && group.length < 2 && (sel.kind === 'video' || sel.kind === 'broll') && (
            <VisualToolsPanel
              key={`ai-${sel.clip_id}` /* not the Inspector's key: sibling keys must differ */}
              api={api}
              projectId={project.project_id}
              clip={sel}
              video={(versionOf(sel.media.version_id)?.probe?.duration_ms ?? 0) > 0 && !!versionOf(sel.media.version_id)?.probe?.video_codec}
              durasiS={(versionOf(sel.media.version_id)?.probe?.duration_ms ?? 0) / 1000}
              locked={locked}
              edit={(ops) => edit(ops)}
            />
          )}
          {group.length > 1 && project && <MultiPanel clips={group} busy={busy} readOnly={locked} onEdit={(ops) => void edit(ops).then(() => ops[0]?.op === 'delete_clips' && setPicked([]))} onClear={() => setPicked([])} />}
          {sel && project && group.length < 2 && (
            <InspectorPanel
              // Audit 14 Nov: one panel per clip — a half-typed field never lands on the next clip.
              key={sel.clip_id}
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
              duck={project.timeline.tracks.find((t) => t.kind === 'music')?.duck}
              playhead={playhead}
              {...(project.status !== 'archived' && !reviewer ? { onCutReview: () => setCutClip(sel) } : {})}
              onEdit={(ops) => edit(ops)}
              lockReason={lockReason}
              onDraft={setStyleDraft}
              onOverlayDraft={setOverlayDraft}
              flushRef={inspectorFlush}
            />
          )}
          {project && !reviewer && (
            <LibraryPanel api={api} project={project} media={media} kit={brand?.kit ?? null} playhead={playhead} selected={sel} busy={locked} edit={(ops) => void edit(ops)} clipName={clipName} />
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
                <div className="mediaRow" key={m.media_id}>
                  <span title={m.display_name}>
                    {m.display_name}
                    <small className="muted" style={{ display: 'block' }}>
                      {m.scope.kind === 'shared' ? 'Bersama' : 'Proyek ini'} · {cur ? formatBytes(cur.size) : '–'}
                      {cur?.probe ? ` · ${formatDuration(cur.probe.duration_ms)}` : cur?.probe === null ? ' · bukan video/audio' : ''}
                    </small>
                  </span>
                  <span className="mediaAdd">
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
          <button className="smallbtn" disabled={locked || !project} onClick={() => setOverlayOpen(true)} title="Tambah logo / watermark / stiker / frame (gambar) di atas video">
            ＋ Overlay
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
          <button className="smallbtn" disabled={locked || !sel} onClick={() => sel && (groupIds.length > 1 ? edit([{ op: 'delete_clips', clip_ids: groupIds }]).then(() => setPicked([])) : edit([{ op: 'delete_clip', clip_id: sel.clip_id }]))} title={lockReason ?? (sel ? 'Hapus klip (Delete)' : 'Pilih klip dulu di linimasa atau pratinjau, lalu Hapus klip (Delete)')}>
            🗑 Hapus klip
          </button>
          <span className="zoomCtl" role="group" aria-label="Zoom linimasa">
            <button className="smallbtn" disabled={zoom <= TIMELINE_ZOOM.min} onClick={() => zoomTo(zoom / 1.5)} title="Perkecil linimasa (Ctrl + scroll)" aria-label="Perkecil linimasa">
              −
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((Math.log(zoom) / Math.log(TIMELINE_ZOOM.max)) * 100)}
              onChange={(e) => zoomTo(Math.exp((Number(e.target.value) / 100) * Math.log(TIMELINE_ZOOM.max)))}
              aria-label={`Zoom linimasa ${zoom.toFixed(1)}×`}
              title="Zoom linimasa (Ctrl + scroll di linimasa)"
            />
            <button className="smallbtn" disabled={zoom >= TIMELINE_ZOOM.max} onClick={() => zoomTo(zoom * 1.5)} title="Perbesar linimasa (Ctrl + scroll)" aria-label="Perbesar linimasa">
              ＋
            </button>
            <button
              className="smallbtn"
              disabled={zoom === 1}
              onClick={() => {
                setZoom(1);
                setScrollPx(0);
              }}
              title="Tampilkan seluruh linimasa"
            >
              Pas
            </button>
          </span>
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
        <div className="tracks" ref={tracksRef} onPointerDown={boxStart} onPointerMove={boxMove} onPointerUp={boxEnd} onPointerCancel={() => setBox(null)} style={{ position: 'relative' }}>
          {menu && (() => {
            const mc = allClips.find((x) => x.clip_id === menu.clip_id);
            if (!mc) return null;
            const many = groupIds.length > 1 && groupIds.includes(mc.clip_id);
            const canCut = !many && playhead > mc.start_ms && playhead < mc.end_ms;
            const act = (fn: () => void) => (e: React.PointerEvent) => {
              e.stopPropagation();
              setMenu(null);
              fn();
            };
            return (
              <div className="clipMenu" role="menu" aria-label="Menu klip" style={{ position: 'fixed', left: Math.max(4, Math.min(menu.x, window.innerWidth - 190)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 130)) /* always on screen */ }} onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" role="menuitem" disabled={locked} onPointerUp={act(() => void (many ? edit([{ op: 'delete_clips', clip_ids: groupIds }]).then(() => setPicked([])) : edit([{ op: 'delete_clip', clip_id: mc.clip_id }])))}>
                  🗑 Hapus{many ? ` ${groupIds.length} klip` : ''}
                </button>
                <button type="button" role="menuitem" disabled={locked || many} onPointerUp={act(() => void edit([{ op: 'duplicate_clip', clip_id: mc.clip_id }]))}>
                  ⧉ Duplikat
                </button>
                <button type="button" role="menuitem" disabled={locked || !canCut} title={canCut ? undefined : 'Taruh playhead di dalam klip ini dulu'} onPointerUp={act(() => void edit([{ op: 'split_clip', clip_id: mc.clip_id, at_ms: playhead }]))}>
                  ✂ Split di playhead
                </button>
              </div>
            );
          })()}
          {gapMenu && (
            <div className="clipMenu" role="menu" aria-label="Menu jarak" style={{ position: 'fixed', left: Math.max(4, Math.min(gapMenu.x, window.innerWidth - 190)), top: Math.max(4, Math.min(gapMenu.y, window.innerHeight - 60)) }} onPointerDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                role="menuitem"
                onPointerUp={(e) => {
                  e.stopPropagation();
                  const g = gapMenu;
                  setGapMenu(null);
                  void edit([{ op: 'shift_clips', clip_ids: g.clip_ids, delta_ms: g.delta_ms }]);
                }}
              >
                ⇤ Hapus jarak ({(-gapMenu.delta_ms / 1000).toFixed(1)} dtk)
              </button>
            </div>
          )}
          {box && <div className="boxSelect" aria-hidden="true" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          <div className="track rulerRow">
            <div className="trackLabel muted">{formatDuration(playhead)}</div>
            <div className="trackSurface ruler" ref={surfaceRef} {...scrubProps} role="slider" aria-label="Posisi playhead" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={playhead} tabIndex={-1}>
              <div className="lane" style={lane}>
                {rulerTicks(duration, duration / zoom).map((t) => (
                  <span key={t} className="tick" style={{ left: pct(t) }}>
                    {formatDuration(t)}
                  </span>
                ))}
                <div className="playhead" style={{ left: pct(playhead) }} />
              </div>
            </div>
          </div>
          {TRACKS.map((t) => {
            const clips = tracks.filter((x) => x.kind === t.kind).flatMap((x) => x.clips);
            return (
              <div className={`track${THUMB_TRACKS.has(t.kind) ? ' tall' : WAVE_TRACKS[t.kind] ? ' mid' : ''}`} key={t.kind} data-kind={t.kind}>
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
                <div className="trackSurface" onClick={seek} onContextMenu={(e) => openGapMenu(e, t.kind)}>
                  <div className="lane" style={lane}>
                  <div className="playhead" style={{ left: pct(playhead) }} />
                  <div className="playheadGrip" style={{ left: pct(playhead) }} title="Seret untuk menggeser playhead" aria-hidden="true" onClick={(e) => e.stopPropagation()} {...scrubProps} />
                  {clips.map((c) => {
                    // R33: a group follows the dragged clip.
                    const lead = drag && groupDrag(drag) && groupIds.includes(c.clip_id) ? dragSpan('move', { ...drag.clip, hasMedia: !!drag.clip.media }, drag.deltaMs).start_ms - drag.clip.start_ms : null;
                    const live = lead !== null ? { start_ms: c.start_ms + lead, end_ms: c.end_ms + lead } : drag && drag.clip.clip_id === c.clip_id ? fitted(drag) : c;
                    const isSel = c.clip_id === selected || groupIds.includes(c.clip_id);
                    return (
                      <div
                        key={c.clip_id}
                        className={`clip ${t.kind}${isSel ? ' selected' : ''}${drag?.clip.clip_id === c.clip_id ? ' dragging' : ''}`}
                        style={{ left: pct(live.start_ms), width: pct(Math.max(1, live.end_ms - live.start_ms)), ...(t.kind === 'overlay' ? overlayRow(clips, c) : {}) }}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSel}
                        aria-label={`${clipName(c)}, ${formatDuration(c.start_ms)} sampai ${formatDuration(c.end_ms)}`}
                        title={`${clipName(c)} · ${formatDuration(live.start_ms)}–${formatDuration(live.end_ms)}${c.in_ms ? ` · mulai dari detik ${(c.in_ms / 1000).toFixed(1)} sumber` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (dragMoved.current) {
                            dragMoved.current = false; // the click ending a drag keeps the selection
                            return;
                          }
                          pick(c, e);
                        }}
                        onFocus={(e) => !picked.length && e.currentTarget.matches(':focus-visible') && setSelected(c.clip_id) /* keyboard (Tab) only: a mouse click is handled by pick() — R33 */}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!groupIds.includes(c.clip_id)) {
                            setPicked([]);
                            setSelected(c.clip_id);
                          }
                          setMenu({ x: e.clientX, y: e.clientY, clip_id: c.clip_id });
                        }}
                        onPointerDown={(e) => beginDrag(e, c, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={() => setDrag(null)}
                      >
                        {c.media && t.kind !== 'overlay' && (
                          <ClipVisual api={api} clip={c} kind={t.kind} inMs={(c.in_ms ?? 0) + (drag?.mode === 'trim-start' ? live.start_ms - c.start_ms : 0) /* trimming the start moves the source in-point too */} lenMs={live.end_ms - live.start_ms} />
                        )}
                        <span className="handle start" aria-hidden="true" onPointerDown={(e) => beginDrag(e, c, 'trim-start')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} />
                        <span className="clipLabel">{ellipsize(clipName(c), 28)}</span>
                        {c.clip_id === selected && groupIds.length < 2 && !locked && ((live.end_ms - live.start_ms) / Math.max(1, duration)) * viewPx * zoom >= 64 && (
                          // only on clips wide enough: on a narrow clip it would cover the clip itself
                          // R33: the delete button sits ON the selected clip (owner could not find it).
                          <button
                            type="button"
                            className="clipTrash"
                            aria-label={`Hapus klip ${clipName(c)}`}
                            title="Hapus klip (Delete)"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              void edit([{ op: 'delete_clip', clip_id: c.clip_id }]);
                            }}
                          >
                            🗑
                          </button>
                        )}
                        <span className="handle end" aria-hidden="true" onPointerDown={(e) => beginDrag(e, c, 'trim-end')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} />
                      </div>
                    );
                  })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {zoom > 1 && viewPx > 0 && (
          <div className="laneScroll">
            <div className="trackLabel muted">{zoom.toFixed(1)}×</div>
            <input
              type="range"
              min={0}
              max={Math.round(viewPx * zoom - viewPx)}
              value={Math.round(scrollPx)}
              onChange={(e) => setScrollPx(clampScroll(Number(e.target.value), viewPx, zoom))}
              aria-label="Geser linimasa"
              title="Geser linimasa (atau Shift + scroll)"
            />
          </div>
        )}
        <div className="footerNote">
          {allClips.length === 0
            ? 'Linimasa kosong. Tambahkan media dari panel kanan (＋ Video).'
            : 'Spasi putar/jeda · klik klip untuk memilih · seret untuk geser · seret pinggirnya untuk trim · klik linimasa untuk memindah playhead · S split · Del hapus · ←/→ geser 0,1 dtk (Shift 1 dtk) · Ctrl+Z / Ctrl+Shift+Z.'}
        </div>
      </section>
    </div>
  );
}
