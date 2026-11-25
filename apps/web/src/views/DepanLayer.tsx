import { useEffect, useRef, useState } from 'react';
import type { Api, Clip } from '../api';

/**
 * 25 Nov "Objek di depan teks" in the preview: the engine's transparent cut-out (VP9 + alpha WebM,
 * made from the same canvas picture the mask comes from) laid over the text for the mask's span.
 * The render uses the mask on the full-frame-rate picture instead (preview = close to the result).
 */
export function DepanLayer({ api, clip, time, playing }: { api: Api; clip: Clip; time: number; playing: boolean }) {
  const d = clip.depan!;
  const vid = d.potongan.version_id;
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLVideoElement>(null);
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
  const inside = time >= Math.max(d.dari_ms, clip.start_ms) && time < Math.min(d.dari_ms + d.durasi_ms, clip.end_ms);
  useEffect(() => {
    const el = ref.current;
    if (!el || !url) return;
    const at = (time - d.dari_ms) / 1000;
    if (!inside) {
      if (!el.paused) el.pause();
      return;
    }
    if (Math.abs(el.currentTime - at) > (playing ? 0.25 : 0.04)) el.currentTime = Math.max(0, at);
    if (playing && el.paused) el.play().catch(() => undefined);
    if (!playing && !el.paused) el.pause();
  }, [time, playing, inside, url, d.dari_ms]);
  if (!url) return null;
  return <video ref={ref} className="depanLayer" src={url} muted playsInline preload="auto" aria-hidden="true" data-depan={clip.clip_id} style={{ opacity: inside ? 1 : 0 }} />;
}
