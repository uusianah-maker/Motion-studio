import { chromaAlpha, chromaKeyUV } from '../../../../packages/core/dist/storage/chroma.js';
import { useEffect, useRef, useState } from 'react';
import { overlayOrder, overlaySpan } from '../../../../packages/core/dist/storage/overlay.js';
import type { Overlay } from '../../../../packages/core/dist/storage/overlay.js';
import type { Api, Clip, Media } from '../api';

/**
 * R26: picture/video overlays in the preview, back to front by layer — the same placement as the
 * render (core overlayBox: width % of the canvas, preset corner + margin from the short side, then
 * the nudge as a canvas fraction). The selected overlay can be dragged: the drop becomes ONE
 * `set_overlay` edit (one undo), so dragging never floods the history.
 */
export function OverlayLayer({
  api,
  clips,
  media,
  time,
  total,
  canvas,
  selectedId = null,
  draft = null,
  onSelect,
  onMove,
}: {
  api: Api;
  clips: readonly Clip[];
  media: readonly Media[];
  time: number;
  /** Video length (whole-video overlays follow it). */
  total: number;
  canvas: { w: number; h: number };
  selectedId?: string | null;
  /** Live (unsaved) spec from the inspector for the selected overlay. */
  draft?: { clip_id: string; overlay: Overlay } | null;
  onSelect?: (id: string) => void;
  onMove?: (id: string, dx: number, dy: number) => void;
}) {
  const shown = overlayOrder(clips.filter((c) => c.media && c.overlay)).filter((c) => {
    const [a, b] = overlaySpan(c, total);
    return time >= a && time < b;
  });
  return (
    <>
      {shown.map((c) => (
        <OverlayItem
          key={c.clip_id}
          api={api}
          clip={c}
          spec={draft?.clip_id === c.clip_id ? draft.overlay : c.overlay!}
          media={media}
          time={time}
          canvas={canvas}
          selected={selectedId === c.clip_id}
          {...(onSelect ? { onSelect: () => onSelect(c.clip_id) } : {})}
          {...(onMove ? { onMove: (dx: number, dy: number) => onMove(c.clip_id, dx, dy) } : {})}
        />
      ))}
    </>
  );
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'gif']);

function OverlayItem({ api, clip, spec, media, time, canvas, selected, onSelect, onMove }: { api: Api; clip: Clip; spec: Overlay; media: readonly Media[]; time: number; canvas: { w: number; h: number }; selected: boolean; onSelect?: () => void; onMove?: (dx: number, dy: number) => void }) {
  const vid = clip.media!.version_id;
  const version = media.flatMap((m) => m.versions).find((v) => v.version_id === vid);
  const p = version?.probe;
  const isVideo = !!p && !!p.video_codec && !IMAGE_CODECS.has(p.video_codec) && p.duration_ms > 100;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .streamUrl(vid)
      .then((r) => live && setUrl(r.url))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [api, vid]);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo) return;
    const at = ((clip.in_ms ?? 0) + Math.max(0, time - clip.start_ms)) / 1000;
    if (Math.abs(el.currentTime - at) > 0.15) el.currentTime = at;
  }, [time, clip.in_ms, clip.start_ms, isVideo]);

  // Drag (selected only): nudge in canvas fractions, saved once on release.
  const [drag, setDrag] = useState<{ x0: number; y0: number; dx: number; dy: number } | null>(null);
  const dx = drag ? drag.dx : spec.dx;
  const dy = drag ? drag.dy : spec.dy;
  const short = Math.min(canvas.w, canvas.h);
  const m = (short * spec.margin) / 100;
  const style: React.CSSProperties = {
    width: `${spec.skala}%`,
    opacity: spec.opasitas,
    ...(spec.pos === 'c' ? { left: '50%', top: '50%' } : {}),
    ...(spec.pos !== 'c' ? { [spec.pos.endsWith('l') ? 'left' : 'right']: `${m}px`, [spec.pos.startsWith('t') ? 'top' : 'bottom']: `${m}px` } : {}),
    transform: `${spec.pos === 'c' ? 'translate(-50%, -50%) ' : ''}translate(${dx * canvas.w}px, ${dy * canvas.h}px)`,
  };
  const clamp = (v: number) => Math.max(-1, Math.min(1, Math.round(v * 10000) / 10000));
  const handlers =
    selected && onMove
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag({ x0: e.clientX - spec.dx * canvas.w, y0: e.clientY - spec.dy * canvas.h, dx: spec.dx, dy: spec.dy });
          },
          onPointerMove: (e: React.PointerEvent) => {
            if (!drag) return;
            setDrag({ ...drag, dx: clamp((e.clientX - drag.x0) / canvas.w), dy: clamp((e.clientY - drag.y0) / canvas.h) });
          },
          onPointerUp: () => {
            if (!drag) return;
            const moved = drag.dx !== spec.dx || drag.dy !== spec.dy;
            setDrag(null);
            if (moved) onMove(drag.dx, drag.dy);
          },
        }
      : onSelect
        ? { onPointerDown: (e: React.PointerEvent) => (e.stopPropagation(), onSelect()) }
        : {};
  const cls = `overlayImg${selected ? ' sel' : ''}${onSelect || (selected && onMove) ? ' drag' : ''}`;
  const common = { className: cls, style: { ...style, zIndex: 3 }, 'data-overlay': clip.clip_id, 'data-pos': spec.pos, 'data-layer': spec.layer, ...handlers };
  if (!url) return <span {...common} aria-hidden="true" />;
  // R23e (ucok): chroma key — a hidden source, keyed onto a canvas with the render's own formula.
  if (clip.chroma) return <ChromaOverlay url={url} isVideo={isVideo} videoRef={videoRef} chroma={clip.chroma} common={common} />;
  return isVideo ? <video ref={videoRef} src={url} muted playsInline preload="auto" aria-label="Overlay video" {...common} /> : <img src={url} alt="Overlay" draggable={false} {...common} />;
}

/** R23e: the overlay with its key colour made transparent (FFmpeg chromakey's rule, chroma.ts). */
function ChromaOverlay({ url, isVideo, videoRef, chroma, common }: { url: string; isVideo: boolean; videoRef: React.RefObject<HTMLVideoElement | null>; chroma: { warna: string; toleransi: number; halus: number }; common: Record<string, unknown> & { style: React.CSSProperties } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    let raf = 0;
    const key = chromaKeyUV(chroma.warna);
    const draw = () => {
      const src = (isVideo ? videoRef.current : imgRef.current) as HTMLVideoElement | HTMLImageElement | null;
      const cv = canvasRef.current;
      const w0 = src ? ('videoWidth' in src ? src.videoWidth : src.naturalWidth) : 0;
      const h0 = src ? ('videoHeight' in src ? src.videoHeight : src.naturalHeight) : 0;
      if (src && cv && w0 && h0) {
        const k = Math.min(1, 360 / w0);
        const w = Math.max(1, Math.round(w0 * k));
        const h = Math.max(1, Math.round(h0 * k));
        if (cv.width !== w || cv.height !== h) {
          cv.width = w;
          cv.height = h;
        }
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(src, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.round(d[i + 3]! * chromaAlpha(d[i]!, d[i + 1]!, d[i + 2]!, key, chroma));
          ctx.putImageData(img, 0, 0);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [isVideo, videoRef, chroma.warna, chroma.toleransi, chroma.halus]);
  const hidden: React.CSSProperties = { position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' };
  return (
    <>
      {isVideo ? <video ref={videoRef} src={url} muted playsInline preload="auto" aria-hidden="true" style={hidden} /> : <img ref={imgRef} src={url} alt="" aria-hidden="true" style={hidden} />}
      <canvas ref={canvasRef} aria-label="Overlay chroma key" data-chroma={chroma.warna} {...common} style={{ ...common.style, height: 'auto' }} />
    </>
  );
}
