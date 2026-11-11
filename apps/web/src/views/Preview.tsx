import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Clip, Media, Project } from '../api';
import { TextOverlay } from './TextOverlay';
import { CANVAS_RATIOS, type CanvasRatio, aspectCss, clipAt, formatDuration, safeInsets, sourceSeconds } from '../lib';

type Layer = 'visual' | 'audio';

/**
 * Timeline preview (W07). The timeline clock drives everything: video/b-roll (b-roll on top),
 * the audio track and text/subtitle overlays all follow the same playhead. Media elements are
 * re-seeked when they drift (>0.3 s while playing, exact while paused). Bytes come through
 * short-lived signed URLs; nothing is decoded on the server.
 */
export function Preview({
  api,
  project,
  media,
  playhead,
  setPlayhead,
  playing,
  setPlaying,
  onRatio,
  busy,
}: {
  api: Api;
  project: Project;
  media: Media[];
  playhead: number;
  setPlayhead: (ms: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  onRatio: (r: CanvasRatio) => void;
  busy: boolean;
}) {
  const ratio: CanvasRatio = project.timeline.canvas?.ratio ?? '9:16';
  const [safe, setSafe] = useState(true);
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasPx, setCanvasPx] = useState({ w: 360, h: 640 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setCanvasPx({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const urls = useRef(new Map<string, { url: string; expires_at: number }>());
  const clock = useRef<{ wall: number; base: number } | null>(null);

  const tracks = project.timeline.tracks;
  const clipsOf = (kind: string) => tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips);
  const end = Math.max(0, ...tracks.flatMap((t) => t.clips.map((c) => c.end_ms)));
  const t = playhead;
  const visual = clipAt(clipsOf('broll'), t) ?? clipAt(clipsOf('video'), t);
  const audio = clipAt(clipsOf('audio'), t);
  const texts = clipsOf('text').filter((c) => t >= c.start_ms && t < c.end_ms);
  const subs = clipsOf('subtitle').filter((c) => t >= c.start_ms && t < c.end_ms);
  const versionOf = (c: Clip | null) => (c?.media ? media.flatMap((m) => m.versions).find((v) => v.version_id === c.media!.version_id) : undefined);

  const urlFor = useCallback(
    async (versionId: string) => {
      const hit = urls.current.get(versionId);
      if (hit && hit.expires_at - Date.now() > 60_000) return hit.url;
      const fresh = await api.streamUrl(versionId);
      urls.current.set(versionId, fresh);
      return fresh.url;
    },
    [api],
  );

  /** Bring one media element in line with the timeline at time `at`. */
  const sync = useCallback(
    async (el: HTMLMediaElement | null, clip: Clip | null, at: number, isPlaying: boolean, layer: Layer) => {
      if (!el) return;
      if (!clip?.media) {
        if (!el.paused) el.pause();
        if (el.dataset.vid) {
          el.removeAttribute('src');
          el.dataset.vid = '';
          el.load();
        }
        return;
      }
      const vid = clip.media.version_id;
      if (el.dataset.vid !== vid) {
        el.dataset.vid = vid;
        try {
          el.src = await urlFor(vid);
          setProblem(null);
        } catch {
          setProblem(`Media ${layer === 'visual' ? 'video' : 'audio'} tidak bisa diputar (ada di Trash atau berubah).`);
          return;
        }
      }
      const want = sourceSeconds(clip, at);
      const tolerance = isPlaying ? 0.3 : 0.04;
      // Before metadata the element cannot seek; the next sync (every frame while playing, or on
      // the next playhead change) corrects it once it is ready.
      if (el.readyState < 1) el.addEventListener('loadedmetadata', () => (el.currentTime = want), { once: true });
      else if (Math.abs(el.currentTime - want) > tolerance) el.currentTime = want;
      if (isPlaying && el.paused) el.play().catch(() => undefined);
      if (!isPlaying && !el.paused) el.pause();
    },
    [urlFor],
  );

  // Paused: seek every layer exactly to the playhead. Playing: the clock loop below drives sync.
  useEffect(() => {
    void sync(videoRef.current, visual, t, playing, 'visual');
    void sync(audioRef.current, audio, t, playing, 'audio');
  }, [visual, audio, t, playing, sync]);

  useEffect(() => {
    if (!playing) {
      clock.current = null;
      return;
    }
    clock.current = { wall: performance.now(), base: playhead >= end ? 0 : playhead };
    let raf = 0;
    const tick = () => {
      const c = clock.current;
      if (!c) return;
      const now = c.base + (performance.now() - c.wall);
      if (now >= end) {
        setPlayhead(end);
        setPlaying(false);
        return;
      }
      setPlayhead(Math.round(now));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    for (const el of [videoRef.current, audioRef.current]) if (el) el.muted = muted;
  }, [muted]);

  const v = versionOf(visual);
  const unsupported = v && v.preview === false ? `Codec ${v.probe?.video_codec ?? '?'} belum bisa dipratinjau di browser (tetap bisa dirender).` : null;
  const [st, sr, sb, sl] = safeInsets(ratio);

  return (
    <>
      <div className="editorHeader">
        <span>
          PRATINJAU{' '}
          <select className="smallbtn" aria-label="Rasio canvas" value={ratio} disabled={busy} onChange={(e) => onRatio(e.target.value as CanvasRatio)}>
            {CANVAS_RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </span>
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Area aman
        </label>
      </div>
      <div className="canvasArea">
        <div className="canvas live" ref={canvasRef} style={{ aspectRatio: aspectCss(ratio) }} aria-label="Area pratinjau">
          <video ref={videoRef} playsInline preload="auto" aria-label="Video pratinjau" className={visual?.media && !unsupported ? '' : 'off'} />
          <audio ref={audioRef} preload="auto" />
          {!visual && <div className="emptyFrame">{end === 0 ? 'Tambahkan media ke linimasa' : 'Tidak ada video di titik ini'}</div>}
          {(unsupported || problem) && <div className="emptyFrame warnFrame">{unsupported ?? problem}</div>}
          {texts.map((c) => (
            <TextOverlay key={c.clip_id} clip={c} kind="text" ratio={ratio} canvas={canvasPx} />
          ))}
          {subs.map((c) => (
            <TextOverlay key={c.clip_id} clip={c} kind="subtitle" ratio={ratio} canvas={canvasPx} />
          ))}
          {safe && <div className="safeArea" style={{ top: `${st}%`, right: `${sr}%`, bottom: `${sb}%`, left: `${sl}%` }} aria-hidden="true" />}
          <span className="canvasTag">● PREVIEW</span>
        </div>
      </div>
      <div className="player">
        <button className="tiny" onClick={() => setPlayhead(0)} aria-label="Ke awal">
          ⏮
        </button>
        <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Jeda' : 'Putar'} disabled={end === 0}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time">
          {formatDuration(t)} / {formatDuration(end)}
        </span>
        <button className="tiny" onClick={() => setMuted(!muted)} aria-label={muted ? 'Nyalakan suara' : 'Bisukan'}>
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
    </>
  );
}
