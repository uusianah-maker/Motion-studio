import { useEffect, useRef, useState } from 'react';
import type { Api, MediaVisuals } from '../api';

/**
 * Paket 1: waveform and thumbnail strip drawn inside timeline clips. The server makes both once
 * per media version (FFmpeg, cached); here they are fetched once per page and drawn for the
 * part of the source a clip actually uses (in_ms … in_ms + length).
 */

export interface LoadedVisuals {
  peaks: Uint8Array | null;
  bucketMs: number;
  thumbs: (Omit<NonNullable<MediaVisuals['thumbs']>, 'jpeg'> & { url: string }) | null;
}

const cache = new Map<string, Promise<LoadedVisuals | null>>();

function load(api: Api, versionId: string): Promise<LoadedVisuals | null> {
  let hit = cache.get(versionId);
  if (!hit) {
    hit = api
      .mediaVisuals(versionId)
      .then((v) => {
        const peaks = v.peaks ? Uint8Array.from(atob(v.peaks.data), (c) => c.charCodeAt(0)) : null;
        let thumbs: LoadedVisuals['thumbs'] = null;
        if (v.thumbs) {
          const { jpeg, ...meta } = v.thumbs;
          const bytes = Uint8Array.from(atob(jpeg), (c) => c.charCodeAt(0));
          thumbs = { ...meta, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) };
        }
        return { peaks, bucketMs: v.peaks?.bucket_ms ?? 20, thumbs };
      })
      .catch((e: unknown) => {
        // Visuals are a convenience: the timeline still works without them. Retry on next page load.
        console.warn('[timeline] visual media gagal dimuat', versionId, e);
        cache.delete(versionId);
        return null;
      });
    cache.set(versionId, hit);
  }
  return hit;
}

export function useMediaVisuals(api: Api, versionId: string | undefined): LoadedVisuals | null {
  const [v, setV] = useState<LoadedVisuals | null>(null);
  useEffect(() => {
    setV(null);
    if (!versionId) return;
    let alive = true;
    void load(api, versionId).then((r) => alive && setV(r));
    return () => {
      alive = false;
    };
  }, [api, versionId]);
  return v;
}

/** Pixel width of an element, kept current. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Mirrored peak bars for the source range this clip plays. */
export function ClipWave({ v, inMs, lenMs, color }: { v: LoadedVisuals; inMs: number; lenMs: number; color: string }) {
  const [box, w] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const peaks = v.peaks;
    if (!c || !peaks || w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const h = c.clientHeight || 20;
    c.width = Math.min(16_000, Math.round(w * dpr));
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = color;
    const mid = c.height / 2;
    const bar = Math.max(1, Math.round(dpr)); // 1 CSS px per column
    const cols = Math.floor(c.width / bar);
    for (let x = 0; x < cols; x++) {
      // Peak of all buckets under this column (so zoomed-out view never hides a loud word).
      const a = Math.floor((inMs + (x / cols) * lenMs) / v.bucketMs);
      const b = Math.max(a + 1, Math.floor((inMs + ((x + 1) / cols) * lenMs) / v.bucketMs));
      let p = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i]! > p) p = peaks[i]!;
      const hh = Math.max(dpr * 0.5, (p / 255) * (c.height - 2 * dpr)) / 2;
      g.fillRect(x * bar, mid - hh, bar, hh * 2);
    }
  }, [v, inMs, lenMs, color, w]);
  return (
    <div ref={box} className="clipVis" aria-hidden="true">
      <canvas ref={canvas} className="clipWave" />
    </div>
  );
}

/** Thumbnail frames tiled along the clip; each tile shows the frame nearest its source time. */
export function ClipThumbs({ v, inMs, lenMs }: { v: LoadedVisuals; inMs: number; lenMs: number }) {
  const [box, w] = useWidth<HTMLDivElement>();
  const t = v.thumbs;
  const tiles: { left: number; idx: number }[] = [];
  let tileW = 0;
  let tileH = 0;
  if (t && w > 0) {
    tileH = box.current?.clientHeight || 40;
    tileW = Math.max(12, Math.round((tileH * t.frame_w) / t.frame_h));
    const n = Math.min(400, Math.ceil(w / tileW));
    for (let i = 0; i < n; i++) {
      const src = inMs + ((i * tileW + tileW / 2) / w) * lenMs;
      tiles.push({ left: i * tileW, idx: Math.min(t.count - 1, Math.max(0, Math.round(src / t.interval_ms))) });
    }
  }
  return (
    <div ref={box} className="clipVis thumbs" aria-hidden="true">
      {t &&
        tiles.map((x) => (
          <span
            key={x.left}
            style={{
              left: x.left,
              width: tileW,
              backgroundImage: `url(${t.url})`,
              backgroundSize: `${t.count * tileW}px ${tileH}px`,
              backgroundPosition: `-${x.idx * tileW}px 0`,
            }}
          />
        ))}
    </div>
  );
}
