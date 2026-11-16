import { useEffect, useRef, useState } from 'react';
import { type Lut, applyLut, parseCube } from '../../../../packages/core/dist/storage/lut.js';
import type { Api } from '../api';

const W = 120;
const H = 40;

/** A test strip: hues on top, a grey ramp below (skin-ish tones in the middle). */
function strip(x: number, y: number): [number, number, number] {
  const t = x / (W - 1);
  if (y >= H * 0.65) return [t, t, t];
  const h = t * 6;
  const c = 0.85;
  const f = (n: number) => {
    const k = (n + h) % 6;
    return 0.1 + c * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function draw(canvas: HTMLCanvasElement | null, lut: Lut | null) {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = lut ? applyLut(lut, ...strip(x, y)) : strip(x, y);
      const i = (y * W + x) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

/**
 * R38a: before / after swatch of a `.cube` LUT — computed exactly like FFmpeg `lut3d` (trilinear),
 * so the team sees the real grade before using it.
 */
export function LutSwatch({ api, versionId }: { api: Api; versionId: string }) {
  const before = useRef<HTMLCanvasElement>(null);
  const after = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ lut: Lut | null; error: string | null }>({ lut: null, error: null });
  useEffect(() => {
    let live = true;
    (async () => {
      const { url } = await api.streamUrl(versionId);
      const text = await (await fetch(url)).text();
      const lut = parseCube(text);
      if (live) setState({ lut, error: null });
    })().catch((e: unknown) => live && setState({ lut: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [api, versionId]);
  useEffect(() => {
    draw(before.current, null);
    draw(after.current, state.lut);
  }, [state.lut]);
  if (state.error) return <span className="notice err small">LUT tidak terbaca: {state.error}</span>;
  return (
    <span className="lutSwatch" role="img" aria-label="Contoh warna LUT sebelum dan sesudah" data-lut-ready={state.lut ? '1' : '0'}>
      <span className="small muted">sebelum</span>
      <canvas ref={before} width={W} height={H} />
      <span className="small muted">sesudah</span>
      <canvas ref={after} width={W} height={H} data-testid="lut-after" />
      {state.lut?.title && <span className="small muted">{state.lut.title}</span>}
    </span>
  );
}
