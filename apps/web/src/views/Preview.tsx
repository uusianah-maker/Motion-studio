import { useCallback, useEffect, useRef, useState } from 'react';
import { blurAt, placeOnCanvas } from '../../../../packages/core/dist/storage/framing.js';
import { zoomAt } from '../../../../packages/core/dist/storage/effects.js';
import { keyframeAt, keyframeCss } from '../../../../packages/core/dist/storage/keyframes.js';
import { DEFAULT_DUCK, duckGainAt, effectiveLook, fadeGainAt, lookCss, speechRanges, transitionCss } from '../../../../packages/core/dist/storage/clipLook.js';
import { orientCss, sourceAt } from '../../../../packages/core/dist/storage/clipMotion.js';
import { applyAudioFx, resumeAudioFx } from '../audioFx';
import type { LoadedBrand } from '../brand';
import type { Api, Clip, Media, Project } from '../api';
import type { TextStyle } from '../../../../packages/core/dist/storage/textStyle.js';
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
  selectedClipId = null,
  onSelectClip,
  styleDraft = null,
  onMoveText,
  brand = null,
  onBrandLogo,
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
  /** X02: the selected clip (its text can be dragged), live style draft from the inspector. */
  selectedClipId?: string | null;
  onSelectClip?: (id: string) => void;
  styleDraft?: { clip_id: string; style: Partial<TextStyle> } | null;
  onMoveText?: (id: string, x: number, y: number) => void;
  /** X06: Brand Kit (logo URL) and the per-project logo switch. */
  brand?: LoadedBrand | null;
  onBrandLogo?: (on: boolean) => void;
}) {
  const ratio: CanvasRatio = project.timeline.canvas?.ratio ?? '9:16';
  const [safe, setSafe] = useState(true);
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  /** U3: sound effects play on their own element, over music/voice. */
  const sfxRef = useRef<HTMLAudioElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
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
  const sfx = clipAt(clipsOf('sfx'), t);
  const music = clipAt(clipsOf('music'), t);
  // U3c: zoom effect covering the playhead (same curve as the render's zoompan).
  const fx = clipsOf('effects').find((c) => c.effect && t >= c.start_ms && t < c.end_ms);
  const zoom = fx?.effect ? zoomAt(fx.effect, t - fx.start_ms, fx.end_ms - fx.start_ms) : 1;
  const texts = clipsOf('text').filter((c) => t >= c.start_ms && t < c.end_ms);
  const subs = clipsOf('subtitle').filter((c) => t >= c.start_ms && t < c.end_ms);
  const versionOf = (c: Clip | null) => (c?.media ? media.flatMap((m) => m.versions).find((v) => v.version_id === c.media!.version_id) : undefined);

  /** Bumped when a layer's stream link failed (expired): re-sync with a fresh link. */
  const [retry, setRetry] = useState(0);
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
      // R23a: speed = playback rate (pitch kept, like atempo); a reversed or frozen clip is not played
      // but stepped: the element stays paused and is seeked to the right frame on every tick.
      const stepped = layer === 'visual' && (!!clip.reverse || !!clip.freeze);
      const rate = clip.speed ?? 1;
      if (!stepped && el.playbackRate !== rate) el.playbackRate = rate;
      const tolerance = isPlaying && !stepped ? 0.3 * Math.max(1, rate) : 0.04;
      // Before metadata the element cannot seek; the next sync (every frame while playing, or on
      // the next playhead change) corrects it once it is ready.
      if (el.readyState < 1) el.addEventListener('loadedmetadata', () => (el.currentTime = want), { once: true });
      else if (Math.abs(el.currentTime - want) > tolerance) el.currentTime = want;
      if (isPlaying && !stepped && el.paused) el.play().catch(() => undefined);
      if ((!isPlaying || stepped) && !el.paused) el.pause();
    },
    [urlFor],
  );

  // Paused: seek every layer exactly to the playhead. Playing: the clock loop below drives sync.
  useEffect(() => {
    void sync(videoRef.current, visual, t, playing, 'visual');
    void sync(audioRef.current, audio, t, playing, 'audio');
    void sync(sfxRef.current, sfx, t, playing, 'audio');
    void sync(musicRef.current, music, t, playing, 'audio');
  }, [visual, audio, sfx, music, t, playing, sync, retry]);

  useEffect(() => {
    if (!playing) {
      clock.current = null;
      lastTick.current = null;
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
      lastTick.current = Math.round(now);
      setPlayhead(lastTick.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  // Audit 14 Nov: a seek while playing (⏮, a comment's timecode, "Deteksi jeda" ▶) moves the clock
  // too — it used to be overwritten by the next frame.
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    const c = clock.current;
    if (!playing || !c || lastTick.current === null) return;
    if (Math.abs(playhead - lastTick.current) > 80) {
      clock.current = { wall: performance.now(), base: playhead };
      lastTick.current = playhead;
    }
  }, [playhead, playing]);

  useEffect(() => {
    for (const el of [videoRef.current, audioRef.current, sfxRef.current, musicRef.current]) if (el) el.muted = muted;
  }, [muted]);
  // Audit 14 Nov: a stream link expires after 10 min; seeking into an unbuffered part then fails
  // silently. On a media error the layer forgets its link, so the next sync fetches a fresh one.
  useEffect(() => {
    const els = [videoRef.current, audioRef.current, sfxRef.current, musicRef.current].filter((e): e is HTMLMediaElement => !!e);
    const onError = (e: Event) => {
      const el = e.currentTarget as HTMLMediaElement;
      const vid = el.dataset.vid;
      if (!vid) return;
      urls.current.delete(vid);
      el.dataset.vid = '';
      setRetry((n) => n + 1);
    };
    for (const el of els) el.addEventListener('error', onError);
    return () => {
      for (const el of els) el.removeEventListener('error', onError);
    };
  }, []);
  // X04: each layer plays at its clip's volume; a muted track is silent (same rule as render).
  // Malam 15 Nov: × the clip's fades (same curve as the render's volume filter).
  const gainOf = (c: Clip | null) => (!c ? 1 : tracks.find((tr) => tr.clips.some((x) => x.clip_id === c.clip_id))?.muted ? 0 : (c.volume ?? 1) * fadeGainAt(c, t - c.start_ms, c.end_ms - c.start_ms));
  // Malam 15 Nov: ducking — the music goes down while someone speaks (same ranges as the render).
  const musicTrack = tracks.find((tr) => tr.kind === 'music');
  const duck = musicTrack?.duck;
  const duckRanges = duck !== undefined ? speechRanges(project.timeline, (c) => !!versionOf(c as Clip)?.probe?.audio_codec) : [];
  // R23a: a reversed clip is silent in the preview (its backwards sound is in the render).
  const visualGain = visual?.reverse ? 0 : gainOf(visual);
  const audioGain = gainOf(audio);
  const sfxGain = gainOf(sfx);
  const musicGain = Math.round(gainOf(music) * (duck !== undefined ? duckGainAt(duckRanges, duck ?? DEFAULT_DUCK, t) : 1) * 1000) / 1000;
  useEffect(() => {
    if (musicRef.current) musicRef.current.volume = musicGain;
    if (videoRef.current) videoRef.current.volume = visualGain;
    if (audioRef.current) audioRef.current.volume = audioGain;
    if (sfxRef.current) sfxRef.current.volume = sfxGain;
  }, [visualGain, audioGain, sfxGain, musicGain]);
  // R23b: EQ + "Perjelas suara" of each playing clip (Web Audio, same numbers as the render).
  const fxKey = [visual, audio, sfx, music].map((c) => (c ? `${c.clip_id}:${JSON.stringify(c.eq ?? null)}:${c.voice ? 1 : 0}` : '-')).join('|');
  useEffect(() => {
    applyAudioFx(videoRef.current, visual);
    applyAudioFx(audioRef.current, audio);
    applyAudioFx(sfxRef.current, sfx);
    applyAudioFx(musicRef.current, music);
  }, [fxKey]);

  const v = versionOf(visual);
  // U3d: crop + blurred areas of the visual clip (same geometry as the render).
  const srcSize = v?.probe?.width && v.probe.height ? { w: v.probe.width, h: v.probe.height } : null;
  const crop = visual?.crop;
  const srcNow = visual ? sourceAt(visual, t - visual.start_ms) : 0;
  const blurs = srcSize ? blurAt(visual?.blur, srcNow) : [];
  // Malam 15 Nov: colour look (+ Brand Kit default), fit and the incoming transition of the picture.
  const lk = visual ? effectiveLook(visual, brand?.kit.filter_bawaan ?? null) : null;
  const css = lk ? lookCss(lk.adjust, lk.mono, lk.tone) : null;
  const fit = visual?.fit;
  const allVisual = [...clipsOf('video'), ...clipsOf('broll')];
  const halfMs = (c: Clip, prev: Clip | null) => (c.transition ? Math.min(c.transition.ms / 2, c.end_ms - c.start_ms, prev ? prev.end_ms - prev.start_ms : 0) : 0);
  let trans: ReturnType<typeof transitionCss> | null = null;
  if (visual) {
    // Into the current clip …
    const prev = clipAt(clipsOf('broll'), visual.start_ms - 1) ?? clipAt(clipsOf('video'), visual.start_ms - 1);
    const h = halfMs(visual, prev);
    if (h > 0 && prev && t - visual.start_ms < h) trans = transitionCss(visual.transition!.type, 0.5 + (t - visual.start_ms) / (2 * h));
    // … or out of it, into the next one.
    const next = allVisual.find((c) => c.start_ms === visual.end_ms && c.transition);
    const nh = next ? halfMs(next, visual) : 0;
    if (!trans && next && nh > 0 && visual.end_ms - t <= nh) trans = transitionCss(next.transition!.type, 0.5 - (visual.end_ms - t) / (2 * nh));
  }
  // Malam 15 Nov: keyframes of the visual clip (same curve as the render).
  const kf = visual?.keyframes?.length ? keyframeCss(keyframeAt(visual.keyframes, t - visual.start_ms)) : {};
  const bgRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // "Pas + latar blur": a blurred, filled copy of the current frame behind the picture.
    const cv = bgRef.current;
    const el = videoRef.current;
    if (!cv || !el || fit !== 'blur') return;
    const rot = visual?.rotate;
    const flipH = !!visual?.flip_h;
    const flipV = !!visual?.flip_v;
    const draw = () => {
      const ctx = cv.getContext('2d');
      if (!ctx || !el.videoWidth) return;
      cv.width = 90;
      cv.height = Math.round((90 * canvasPx.h) / Math.max(1, canvasPx.w));
      const swap = rot === 90 || rot === 270;
      const [vw, vh] = swap ? [el.videoHeight, el.videoWidth] : [el.videoWidth, el.videoHeight];
      const k = Math.max(cv.width / vw, cv.height / vh);
      ctx.filter = `blur(3px) brightness(0.94)`;
      ctx.save();
      ctx.translate(cv.width / 2, cv.height / 2);
      ctx.rotate(((rot ?? 0) * Math.PI) / 180);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.drawImage(el, (-el.videoWidth * k) / 2, (-el.videoHeight * k) / 2, el.videoWidth * k, el.videoHeight * k);
      ctx.restore();
    };
    draw();
    el.addEventListener('seeked', draw);
    el.addEventListener('loadeddata', draw);
    return () => {
      el.removeEventListener('seeked', draw);
      el.removeEventListener('loadeddata', draw);
    };
  });
  // R23a: rotation / flips are the innermost transform; for 90°/270° the element box swaps width
  // and height first, so "contain" fits the turned picture into the canvas like the render.
  const orient = visual?.media ? orientCss(visual) : { transform: '', swap: false };
  const swapBox = orient.swap ? { width: `${canvasPx.h}px`, height: `${canvasPx.w}px`, left: `${(canvasPx.w - canvasPx.h) / 2}px`, top: `${(canvasPx.h - canvasPx.w) / 2}px`, right: 'auto', bottom: 'auto' } : {};
  const zoomStyle = zoom !== 1 && fx?.effect ? { transform: `scale(${zoom})`, transformOrigin: `${fx.effect.x * 100}% ${fx.effect.y * 100}%` } : {};
  const cropStyle = crop ? ({ objectViewBox: `inset(${crop.y * 100}% ${(1 - crop.x - crop.w) * 100}% ${(1 - crop.y - crop.h) * 100}% ${crop.x * 100}%)` } as Record<string, string>) : {};
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
        <span className="row" style={{ gap: 12 }}>
          {onBrandLogo && (
            <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }} title={brand?.kit.logo ? 'Tampilkan logo Brand Kit di pratinjau & render' : 'Belum ada logo di Brand Kit'}>
              <input type="checkbox" aria-label="Logo brand" checked={!!project.timeline.brand_logo} disabled={busy || (!brand?.kit.logo && !project.timeline.brand_logo)} onChange={(e) => onBrandLogo(e.target.checked)} /> Logo
            </label>
          )}
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Area aman
          </label>
        </span>
      </div>
      <div className="canvasArea">
        <div className="canvas live" ref={canvasRef} style={{ aspectRatio: aspectCss(ratio) }} aria-label="Area pratinjau">
          {fit === 'blur' && visual?.media && <canvas ref={bgRef} className="fitBlurBg" aria-hidden="true" style={{ ...(css?.filter ? { filter: `blur(12px) ${css.filter}` } : {}), ...(kf.transform ? { transform: `${kf.transform} scale(1.08)` } : {}), ...(kf.opacity !== undefined ? { opacity: kf.opacity } : {}) }} />}
          <video
            ref={videoRef}
            playsInline
            preload="auto"
            aria-label="Video pratinjau"
            data-zoom={zoom.toFixed(3)}
            data-crop={crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : undefined}
            className={visual?.media && !unsupported ? '' : 'off'}
            data-look={visual?.look ?? brand?.kit.filter_bawaan ?? undefined}
            data-fit={fit ?? undefined}
            style={{
              ...zoomStyle,
              ...cropStyle,
              ...(css?.filter || trans?.blur ? { filter: `${css?.filter ?? ''}${trans?.blur ? ` blur(${trans.blur.toFixed(1)}px)` : ''}`.trim() } : {}),
              ...(fit === 'isi' ? { objectFit: 'cover' as const } : {}),
              ...(fit === 'blur' ? { background: 'transparent' } : fit === 'warna' && visual?.fit_color ? { background: visual.fit_color } : {}),
              ...(trans?.opacity !== undefined || kf.opacity !== undefined ? { opacity: (trans?.opacity ?? 1) * (kf.opacity ?? 1) } : {}),
              ...(trans?.clipPath ? { clipPath: trans.clipPath } : {}),
              ...(trans?.transform || kf.transform || orient.transform ? { transform: `${trans?.transform ?? ''} ${'transform' in zoomStyle ? zoomStyle.transform : ''} ${kf.transform ?? ''} ${orient.transform}`.trim() } : {}),
              ...swapBox,
            }}
            data-orient={orient.transform || undefined}
            data-rate={visual?.speed ?? undefined}
          />
          {css && css.warmth !== 0 && visual?.media && <div className="lookWash" aria-hidden="true" data-warmth={css.warmth.toFixed(2)} style={{ background: css.warmth > 0 ? '#ff9a3c' : '#3c8cff', opacity: Math.abs(css.warmth) * 0.28 }} />}
          {css && css.vignette > 0 && visual?.media && <div className="lookVignette" aria-hidden="true" style={{ background: `radial-gradient(ellipse at center, transparent ${Math.round(70 - css.vignette * 50)}%, rgba(0,0,0,${(css.vignette * 0.9).toFixed(2)}) 100%)` }} />}
          {css && css.grain > 0 && visual?.media && <div className="lookGrain" aria-hidden="true" data-grain={css.grain} style={{ opacity: Math.min(0.35, css.grain / 40) }} />}
          {trans?.flash !== undefined && trans.flash > 0 && <div className="transFlash" aria-hidden="true" style={{ opacity: trans.flash }} />}
          {trans?.black !== undefined && trans.black > 0 && <div className="transBlack" aria-hidden="true" style={{ opacity: trans.black }} />}
          {blurs.length > 0 && srcSize && (
            <div className="blurLayer" style={zoomStyle} aria-hidden="true">
              {blurs.map((b, i) => {
                const r = placeOnCanvas(srcSize, crop, canvasPx, b, fit === 'isi');
                const px = `${(b.radius * Math.min(canvasPx.w, canvasPx.h)) / 1080}px`;
                return <div key={i} className="blurBox" data-blur={i} style={{ left: r.left, top: r.top, width: r.width, height: r.height, backdropFilter: `blur(${px})`, WebkitBackdropFilter: `blur(${px})` }} />;
              })}
            </div>
          )}
          <audio ref={audioRef} preload="auto" />
          <audio ref={sfxRef} preload="auto" data-layer="sfx" />
          <audio ref={musicRef} preload="auto" data-layer="music" />
          {!visual && <div className="emptyFrame">{end === 0 ? 'Tambahkan media ke linimasa' : 'Tidak ada video di titik ini'}</div>}
          {(unsupported || problem) && <div className="emptyFrame warnFrame">{unsupported ?? problem}</div>}
          {[...texts.map((c) => ['text', c] as const), ...subs.map((c) => ['subtitle', c] as const)].map(([kind, c]) => (
            <TextOverlay
              key={c.clip_id}
              clip={c}
              kind={kind}
              ratio={ratio}
              canvas={canvasPx}
              draft={styleDraft?.clip_id === c.clip_id ? styleDraft.style : null}
              selected={selectedClipId === c.clip_id}
              {...(onSelectClip ? { onSelect: () => onSelectClip(c.clip_id) } : {})}
              {...(onMoveText && !busy ? { onMove: (x: number, y: number) => onMoveText(c.clip_id, x, y) } : {})}
              time={t}
              kf={c.keyframes?.length ? keyframeAt(c.keyframes, t - c.start_ms) : null}
            />
          ))}
          {project.timeline.brand_logo && brand?.kit.logo && brand.logoUrl && (
            <img
              className="brandLogo"
              data-corner={brand.kit.logo.corner}
              src={brand.logoUrl}
              alt="Logo brand"
              style={{
                width: `${brand.kit.logo.size}%`,
                opacity: brand.kit.logo.opacity,
                [brand.kit.logo.corner.startsWith('t') ? 'top' : 'bottom']: `${Math.min(canvasPx.w, canvasPx.h) * 0.04}px`,
                [brand.kit.logo.corner.endsWith('l') ? 'left' : 'right']: `${Math.min(canvasPx.w, canvasPx.h) * 0.04}px`,
              }}
            />
          )}
          {safe && <div className="safeArea" style={{ top: `${st}%`, right: `${sr}%`, bottom: `${sb}%`, left: `${sl}%` }} aria-hidden="true" />}
          <span className="canvasTag">● PREVIEW</span>
        </div>
      </div>
      <div className="player">
        <button className="tiny" onClick={() => setPlayhead(0)} aria-label="Ke awal">
          ⏮
        </button>
        <button className="play" onClick={() => (resumeAudioFx(), setPlaying(!playing))} aria-label={playing ? 'Jeda' : 'Putar'} disabled={end === 0}>
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
