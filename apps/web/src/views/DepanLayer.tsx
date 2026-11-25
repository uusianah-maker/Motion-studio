import { useEffect, useRef, useState } from 'react';
import type { Api, Clip } from '../api';

const W = 360; // canvas width (height follows the picture); same budget as the chroma preview

/**
 * 25 Nov "Objek di depan teks" in the preview, over the text for the mask's span. Not every browser
 * shows the alpha of a VP9 WebM (the in-app browser ignores it and the whole picture covered the
 * text), so the cut-out is composed on a canvas: colours from the engine's cut-out file, alpha from
 * its grey mask (white = subject) — the same mask the render uses on the full-frame-rate picture.
 */
export function DepanLayer({ api, clip, time, playing }: { api: Api; clip: Clip; time: number; playing: boolean }) {
  const d = clip.depan!;
  const [urls, setUrls] = useState<{ c: string; m: string } | null>(null);
  const colRef = useRef<HTMLVideoElement>(null);
  const maskRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.streamUrl(d.potongan.version_id), api.streamUrl(d.masker.version_id)]).then(
      ([c, m]) => live && setUrls({ c: c.url, m: m.url }),
      () => live && setUrls(null),
    );
    return () => {
      live = false;
    };
  }, [api, d.potongan.version_id, d.masker.version_id]);
  const inside = time >= Math.max(d.dari_ms, clip.start_ms) && time < Math.min(d.dari_ms + d.durasi_ms, clip.end_ms);
  // keep both files on the same frame as the timeline
  useEffect(() => {
    for (const el of [colRef.current, maskRef.current]) {
      if (!el || !urls) continue;
      const at = Math.max(0, (time - d.dari_ms) / 1000);
      if (!inside) {
        if (!el.paused) el.pause();
        continue;
      }
      if (Math.abs(el.currentTime - at) > (playing ? 0.2 : 0.03)) el.currentTime = at;
      if (playing && el.paused) el.play().catch(() => undefined);
      if (!playing && !el.paused) el.pause();
    }
  }, [time, playing, inside, urls, d.dari_ms]);
  // compose: colour × mask → canvas (every animation frame while visible)
  useEffect(() => {
    if (!inside || !urls) return;
    let raf = 0;
    const tmp = document.createElement('canvas');
    const draw = () => {
      const cv = canvasRef.current;
      const c = colRef.current;
      const m = maskRef.current;
      if (cv && c && m && c.readyState >= 2 && m.readyState >= 2 && c.videoWidth) {
        const h = Math.round((W * c.videoHeight) / c.videoWidth);
        if (cv.width !== W || cv.height !== h) {
          cv.width = W;
          cv.height = h;
        }
        tmp.width = W;
        tmp.height = h;
        const tx = tmp.getContext('2d', { willReadFrequently: true });
        const cx = cv.getContext('2d', { willReadFrequently: true });
        if (tx && cx) {
          tx.drawImage(m, 0, 0, W, h);
          const mask = tx.getImageData(0, 0, W, h).data;
          cx.clearRect(0, 0, W, h);
          cx.drawImage(c, 0, 0, W, h);
          const img = cx.getImageData(0, 0, W, h);
          const px = img.data;
          for (let i = 0; i < px.length; i += 4) px[i + 3] = mask[i]!; // grey mask → alpha
          cx.putImageData(img, 0, 0);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [inside, urls]);
  if (!urls) return null;
  const hidden: React.CSSProperties = { position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' };
  return (
    <>
      <video ref={colRef} src={urls.c} muted playsInline preload="auto" aria-hidden="true" style={hidden} />
      <video ref={maskRef} src={urls.m} muted playsInline preload="auto" aria-hidden="true" style={hidden} />
      <canvas ref={canvasRef} className="depanLayer" aria-label="Objek di depan teks" data-depan={clip.clip_id} style={{ opacity: inside ? 1 : 0 }} />
    </>
  );
}
