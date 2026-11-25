import { useCallback, useEffect, useRef, useState } from 'react';
import { blurAt, placeOnCanvas } from '../../../../packages/core/dist/storage/framing.js';
import { zoomAt } from '../../../../packages/core/dist/storage/effects.js';
import { type KfValues, keyframeAt, keyframeCss } from '../../../../packages/core/dist/storage/keyframes.js';
import { effectiveStyle } from '../../../../packages/core/dist/storage/textStyle.js';
import { KeyframeHandles } from './KeyframeHandles';
import { DEFAULT_DUCK, duckGainAt, effectiveLook, effectiveLut, fadeGainAt, lookCss, speechRanges, transitionCss } from '../../../../packages/core/dist/storage/clipLook.js';
import { orientCss, sourceAt } from '../../../../packages/core/dist/storage/clipMotion.js';
import { applyAudioFx, resumeAudioFx } from '../audioFx';
import { useLutValues } from '../lutPreview';
import { type LoadedBrand, ensureAsetFont } from '../brand';
import { fontRef } from '../../../../packages/core/dist/storage/textStyle.js';
import type { Api, Clip, Media, Project } from '../api';
import type { TextStyle } from '../../../../packages/core/dist/storage/textStyle.js';
import { TextOverlay } from './TextOverlay';
import { OverlayLayer } from './OverlayLayer';
import { type Overlay, contentEnd } from '../../../../packages/core/dist/storage/overlay.js';
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
  boxPick = null,
  styleDraft = null,
  onMoveText,
  brand = null,
  onBrandLogo,
  overlayDraft = null,
  onMoveOverlay,
  kfMode = false,
  onKeyframe,
}: {
  api: Api;
  project: Project;
  media: Media[];
  /** 25 Nov: "◆ Atur di layar" — handles that save a keyframe at the playhead for the selected clip. */
  kfMode?: boolean;
  onKeyframe?: (clipId: string, v: KfValues) => void;
  playhead: number;
  setPlayhead: (ms: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  onRatio: (r: CanvasRatio) => void;
  busy: boolean;
  /** X02: the selected clip (its text can be dragged), live style draft from the inspector. */
  selectedClipId?: string | null;
  onSelectClip?: (id: string) => void;
  /** R35c: draw a box on the picture (canvas fractions) — Lacak objek. */
  boxPick?: ((b: { x: number; y: number; w: number; h: number }) => void) | null;
  styleDraft?: { clip_id: string; style: Partial<TextStyle> } | null;
  onMoveText?: (id: string, x: number, y: number) => void;
  /** X06: Brand Kit (logo URL) and the per-project logo switch. */
  brand?: LoadedBrand | null;
  onBrandLogo?: (on: boolean) => void;
  /** R26: live overlay spec from the inspector, and dragging the selected overlay (one edit on drop). */
  overlayDraft?: { clip_id: string; overlay: Overlay } | null;
  onMoveOverlay?: (id: string, dx: number, dy: number) => void;
}) {
  const ratio: CanvasRatio = project.timeline.canvas?.ratio ?? '9:16';
  const [safe, setSafe] = useState(true);
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  /** U3: sound effects play on their own element, over music/voice. */
  const sfxRef = useRef<HTMLAudioElement>(null);
  /** Keluhan tim: two SFX can overlap (the render mixes them all) — a second element for the overlap. */
  const sfx2Ref = useRef<HTMLAudioElement>(null);
  /** 25 Nov (＋ SFX di timeline): up to 4 overlapping sounds in the preview (the render mixes all). */
  const sfx3Ref = useRef<HTMLAudioElement>(null);
  const sfx4Ref = useRef<HTMLAudioElement>(null);
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
  const end = contentEnd(tracks); // R26: whole-video overlays follow the video, as in the render
  const t = playhead;
  const visual = clipAt(clipsOf('broll'), t) ?? clipAt(clipsOf('video'), t);
  // 25 Nov (keluhan "keyframe/zoom masih kasar" di preview): the clock below follows wall time while
  // <video> plays natively, so the transform could drift up to the 0.3 s re-seek tolerance from the
  // picture (then jump). The tick reads the playing clip through this ref and pulls the clock gently
  // toward the video's own time, so motion stays glued to the frames.
  const visualRef = useRef(visual);
  visualRef.current = visual;
  const audio = clipAt(clipsOf('audio'), t);
  // Each SFX clip keeps one element (greedy by start time), so an overlap never restarts a sound.
  const sfxSlot = new Map<string, number>();
  {
    const ends = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (const c of [...clipsOf('sfx')].sort((a, b) => a.start_ms - b.start_ms)) {
      const k = ends.findIndex((e) => e <= c.start_ms);
      if (k < 0) continue;
      sfxSlot.set(c.clip_id, k);
      ends[k] = c.end_ms;
    }
  }
  const sfx = clipAt(clipsOf('sfx').filter((c) => sfxSlot.get(c.clip_id) === 0), t);
  const sfx2 = clipAt(clipsOf('sfx').filter((c) => sfxSlot.get(c.clip_id) === 1), t);
  const sfx3 = clipAt(clipsOf('sfx').filter((c) => sfxSlot.get(c.clip_id) === 2), t);
  const sfx4 = clipAt(clipsOf('sfx').filter((c) => sfxSlot.get(c.clip_id) === 3), t);
  const music = clipAt(clipsOf('music'), t);
  // U3c: zoom effect covering the playhead (same curve + anchor as the render's perspective window).
  const fx = clipsOf('effects').find((c) => c.effect && t >= c.start_ms && t < c.end_ms);
  const zoom = fx?.effect ? zoomAt(fx.effect, t - fx.start_ms, fx.end_ms - fx.start_ms) : 1;
  const texts = clipsOf('text').filter((c) => t >= c.start_ms && t < c.end_ms);
  const subs = clipsOf('subtitle').filter((c) => t >= c.start_ms && t < c.end_ms);
  // R38a: register every Aset font the texts use (once per page; text re-flows when it arrives).
  const asetFontIds = [...new Set([...clipsOf('text'), ...clipsOf('subtitle')].flatMap((c) => { const r = fontRef(c.style?.font ?? (styleDraft?.clip_id === c.clip_id ? styleDraft.style.font : undefined)); return r ? [r.version_id] : []; }))].join(',');
  useEffect(() => {
    for (const v of asetFontIds.split(',').filter(Boolean)) void ensureAsetFont(api, v);
  }, [api, asetFontIds]);
  const versionOf = (c: Clip | null) => (c?.media ? media.flatMap((m) => m.versions).find((v) => v.version_id === c.media!.version_id) : undefined);

  /** R23f: the visual clip is stabilised but its copy is not ready: look again every few seconds. */
  const stabilWaiting = useRef(false);
  /** Bumped when a layer's stream link failed (expired): re-sync with a fresh link. */
  const [retry, setRetry] = useState(0);
  const urlFor = useCallback(
    async (versionId: string, stabil?: string) => {
      const key = stabil ? `${versionId}@${stabil}` : versionId;
      const hit = urls.current.get(key);
      if (hit && hit.expires_at - Date.now() > 60_000) return hit.url;
      const fresh = await api.streamUrl(versionId, stabil ? { stabil } : {});
      // R23f: the stabilised copy may not exist yet → the original plays; ask again in a few seconds.
      const notYet = !!stabil && fresh.stabil !== stabil;
      stabilWaiting.current = notYet;
      urls.current.set(key, notYet ? { ...fresh, expires_at: Math.min(fresh.expires_at, Date.now() + 61_000) } : fresh);
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
      // R23f: a stabilised clip plays its stabilised copy (once made).
      const stabil = layer === 'visual' ? clip.stabil : undefined;
      const vid = stabil ? `${clip.media.version_id}@${stabil}` : clip.media.version_id;
      const cached = urls.current.get(vid);
      if (el.dataset.vid !== vid || (stabil && cached && cached.expires_at - Date.now() < 60_000)) {
        el.dataset.vid = vid;
        try {
          const before = el.currentSrc;
          const next = await urlFor(clip.media.version_id, stabil);
          if (next !== before || !el.src) el.src = next;
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

  useEffect(() => {
    if (!visual?.stabil) return;
    const t = setInterval(() => stabilWaiting.current && setRetry((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [visual?.stabil, visual?.clip_id]);
  // Paused: seek every layer exactly to the playhead. Playing: the clock loop below drives sync.
  useEffect(() => {
    void sync(videoRef.current, visual, t, playing, 'visual');
    void sync(audioRef.current, audio, t, playing, 'audio');
    void sync(sfxRef.current, sfx, t, playing, 'audio');
    void sync(sfx2Ref.current, sfx2, t, playing, 'audio');
    void sync(sfx3Ref.current, sfx3, t, playing, 'audio');
    void sync(sfx4Ref.current, sfx4, t, playing, 'audio');
    void sync(musicRef.current, music, t, playing, 'audio');
  }, [visual, audio, sfx, sfx2, sfx3, sfx4, music, t, playing, sync, retry]);

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
      let now = c.base + (performance.now() - c.wall);
      const el = videoRef.current;
      const vc = visualRef.current;
      if (el && vc?.media && !el.paused && !el.seeking && el.readyState >= 2 && !vc.reverse && !vc.freeze && now >= vc.start_ms && now < vc.end_ms) {
        const drift = ((el.currentTime - sourceSeconds(vc, now)) * 1000) / (vc.speed ?? 1);
        if (Math.abs(drift) < 250) {
          c.base += drift * 0.2;
          now += drift * 0.2;
        }
      }
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
    for (const el of [videoRef.current, audioRef.current, sfxRef.current, sfx2Ref.current, sfx3Ref.current, sfx4Ref.current, musicRef.current]) if (el) el.muted = muted;
  }, [muted]);
  // Audit 14 Nov: a stream link expires after 10 min; seeking into an unbuffered part then fails
  // silently. On a media error the layer forgets its link, so the next sync fetches a fresh one.
  useEffect(() => {
    const els = [videoRef.current, audioRef.current, sfxRef.current, sfx2Ref.current, sfx3Ref.current, sfx4Ref.current, musicRef.current].filter((e): e is HTMLMediaElement => !!e);
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
  const sfx2Gain = gainOf(sfx2);
  const sfx3Gain = gainOf(sfx3);
  const sfx4Gain = gainOf(sfx4);
  const musicGain = Math.round(gainOf(music) * (duck !== undefined ? duckGainAt(duckRanges, duck ?? DEFAULT_DUCK, t) : 1) * 1000) / 1000;
  useEffect(() => {
    if (musicRef.current) musicRef.current.volume = musicGain;
    if (videoRef.current) videoRef.current.volume = visualGain;
    if (audioRef.current) audioRef.current.volume = audioGain;
    if (sfxRef.current) sfxRef.current.volume = sfxGain;
    if (sfx2Ref.current) sfx2Ref.current.volume = sfx2Gain;
    if (sfx3Ref.current) sfx3Ref.current.volume = sfx3Gain;
    if (sfx4Ref.current) sfx4Ref.current.volume = sfx4Gain;
  }, [visualGain, audioGain, sfxGain, sfx2Gain, sfx3Gain, sfx4Gain, musicGain]);
  // R23b: EQ + "Perjelas suara" of each playing clip (Web Audio, same numbers as the render).
  const fxKey = [visual, audio, sfx, sfx2, sfx3, sfx4, music].map((c) => (c ? `${c.clip_id}:${JSON.stringify(c.eq ?? null)}:${c.voice ? 1 : 0}` : '-')).join('|');
  useEffect(() => {
    applyAudioFx(videoRef.current, visual);
    applyAudioFx(audioRef.current, audio);
    applyAudioFx(sfxRef.current, sfx);
    applyAudioFx(sfx2Ref.current, sfx2);
    applyAudioFx(sfx3Ref.current, sfx3);
    applyAudioFx(sfx4Ref.current, sfx4);
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
  const look = lk ? lookCss(lk.adjust, lk.mono, lk.tone) : null;
  // R38b(2): colour LUT (clip > Brand default) as an SVG colour matrix after the look (render: lut3d).
  const lutRef = visual?.media ? effectiveLut(visual, brand?.kit.lut_bawaan ?? null) : null;
  const lutVals = useLutValues(api, lutRef?.version_id);
  const css = look && lutVals ? { ...look, filter: `${look.filter} url(#lutPreview)`.trim() } : look;
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
  // preview=false only while the light (h264) copy of a video the browser cannot decode is not made yet;
  // once it is, the server says preview=true and the stream link serves that copy (render keeps the original).
  const unsupported = v && v.preview === false ? `Video ${v.probe?.video_codec ?? '?'}${v.probe?.pix_fmt ? ` ${v.probe.pix_fmt}` : ''} belum bisa diputar browser — pratinjau ringan sedang dibuat… (render tetap dari file asli)` : null;
  // R25b(2): the light copy just became ready — drop the cached link to the original and load the copy
  // (no page reload). Adapted from Hanagaki's hotfix/pratinjau-hevc.
  const wasUnsupported = useRef(false);
  useEffect(() => {
    if (unsupported) {
      wasUnsupported.current = true;
      return;
    }
    if (!wasUnsupported.current) return;
    wasUnsupported.current = false;
    urls.current.clear();
    if (videoRef.current) videoRef.current.dataset.vid = '';
    setRetry((r) => r + 1);
  }, [unsupported]);
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
          {lutVals && (
            <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
              <filter id="lutPreview" colorInterpolationFilters="sRGB">
                <feColorMatrix type="matrix" values={lutVals} />
              </filter>
            </svg>
          )}
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
            data-lut={lutVals ? lutRef?.version_id : undefined}
            style={{
              ...zoomStyle,
              ...cropStyle,
              ...(css?.filter || trans?.blur || trans?.glitch ? { filter: `${css?.filter ?? ''}${trans?.blur ? ` blur(${trans.blur.toFixed(1)}px)` : ''}${trans?.glitch ? ` hue-rotate(${Math.round(trans.glitch * 90)}deg) saturate(${(1 + trans.glitch).toFixed(2)})` : ''}`.trim() } : {}),
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
          <audio ref={sfx2Ref} preload="auto" data-layer="sfx2" />
          <audio ref={sfx3Ref} preload="auto" data-layer="sfx3" />
          <audio ref={sfx4Ref} preload="auto" data-layer="sfx4" />
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
          <OverlayLayer
            api={api}
            clips={clipsOf('overlay')}
            media={media}
            time={t}
            total={end}
            canvas={canvasPx}
            selectedId={selectedClipId}
            draft={overlayDraft}
            {...(onSelectClip ? { onSelect: onSelectClip } : {})}
            {...(onMoveOverlay && !busy ? { onMove: onMoveOverlay } : {})}
          />
          {kfMode && onKeyframe && !busy && !playing && (() => {
            if (visual && visual.clip_id === selectedClipId)
              return <KeyframeHandles key={visual.clip_id} values={keyframeAt(visual.keyframes, t - visual.start_ms)} anchor={{ x: 0.5, y: 0.5 }} size={{ w: 1, h: 1 }} onCommit={(v) => onKeyframe(visual.clip_id, v)} />;
            const tc = [...texts.map((c) => ['text', c] as const), ...subs.map((c) => ['subtitle', c] as const)].find(([, c]) => c.clip_id === selectedClipId);
            if (!tc) return null;
            const [kind, c] = tc;
            const s = effectiveStyle(kind, c.style);
            return <KeyframeHandles key={c.clip_id} values={keyframeAt(c.keyframes, t - c.start_ms)} anchor={{ x: s.x, y: s.y }} size={{ w: 0.5, h: 0.12 }} onCommit={(v) => onKeyframe(c.clip_id, v)} />;
          })()}
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
          {boxPick && <BoxPicker onBox={boxPick} />}
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

/** R35c: drag a box over the picture; released → the box in canvas fractions. */
function BoxPicker({ onBox }: { onBox: (b: { x: number; y: number; w: number; h: number }) => void }) {
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const b = box ? { x: Math.min(box.x0, box.x1), y: Math.min(box.y0, box.y1), w: Math.abs(box.x1 - box.x0), h: Math.abs(box.y1 - box.y0) } : null;
  return (
    <div
      className="boxPicker"
      role="application"
      aria-label="Gambar kotak objek"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        const p = rel(e);
        setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => box && setBox({ ...box, x1: rel(e).x, y1: rel(e).y })}
      onPointerUp={() => {
        if (b && b.w > 0.02 && b.h > 0.02) onBox(b);
        setBox(null);
      }}
    >
      <span className="boxPickerHint">Seret kotak di sekitar objek yang mau dilacak</span>
      {b && <div className="boxPickerRect" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />}
    </div>
  );
}
