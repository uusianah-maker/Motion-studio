import { useRef, useState } from 'react';
import type { KfValues } from '../../../../packages/core/dist/storage/keyframes.js';

/**
 * 25 Nov (owner: "boleh tambahkan tools key frame manual"): handles on the preview canvas for the
 * selected clip while "◆ Atur di layar" is on. Drag the box = move, a corner = zoom, the knob on
 * top = rotate. On release the values are saved as a keyframe at the playhead (EditorView upserts
 * it), so the motion is built by moving the playhead and placing the picture/text.
 * `anchor` = the clip's normal centre on the canvas (0..1); `size` = its box at scale 1 (0..1).
 */
export function KeyframeHandles({ values, anchor, size, onCommit }: { values: KfValues; anchor: { x: number; y: number }; size: { w: number; h: number }; onCommit: (v: KfValues) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<KfValues | null>(null);
  const op = useRef<{ kind: 'move' | 'scale' | 'rot'; id: number; px: number; py: number; v0: KfValues; cx: number; cy: number; W: number; H: number } | null>(null);
  const v = live ?? values;
  const begin = (kind: 'move' | 'scale' | 'rot') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const r = ref.current?.parentElement?.getBoundingClientRect();
    if (!r) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    op.current = { kind, id: e.pointerId, px: e.clientX, py: e.clientY, v0: v, cx: r.left + (anchor.x + v.x) * r.width, cy: r.top + (anchor.y + v.y) * r.height, W: r.width, H: r.height };
  };
  const move = (e: React.PointerEvent) => {
    const o = op.current;
    if (!o || o.id !== e.pointerId) return;
    const c = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    if (o.kind === 'move') setLive({ ...o.v0, x: c(o.v0.x + (e.clientX - o.px) / o.W, -1, 1), y: c(o.v0.y + (e.clientY - o.py) / o.H, -1, 1) });
    else if (o.kind === 'scale') {
      const d0 = Math.hypot(o.px - o.cx, o.py - o.cy);
      const d1 = Math.hypot(e.clientX - o.cx, e.clientY - o.cy);
      if (d0 > 4) setLive({ ...o.v0, scale: c(Math.round(o.v0.scale * (d1 / d0) * 1000) / 1000, 0.1, 4) });
    } else {
      const a0 = Math.atan2(o.py - o.cy, o.px - o.cx);
      const a1 = Math.atan2(e.clientY - o.cy, e.clientX - o.cx);
      let deg = o.v0.rot + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift = per 15°
      setLive({ ...o.v0, rot: c(Math.round(deg), -360, 360) });
    }
  };
  const end = (e: React.PointerEvent) => {
    const o = op.current;
    if (!o || o.id !== e.pointerId) return;
    op.current = null;
    const done = live;
    setLive(null);
    if (done && JSON.stringify(done) !== JSON.stringify(o.v0)) onCommit(done);
  };
  const box = {
    left: `${(anchor.x + v.x) * 100}%`,
    top: `${(anchor.y + v.y) * 100}%`,
    width: `${size.w * v.scale * 100}%`,
    height: `${size.h * v.scale * 100}%`,
    transform: `translate(-50%, -50%) rotate(${v.rot}deg)`,
  };
  const h = { onPointerMove: move, onPointerUp: end, onPointerCancel: () => ((op.current = null), setLive(null)) };
  return (
    <div ref={ref} className="kfHandles" aria-label="Atur keyframe di layar">
      <div className="kfBox" style={box} onPointerDown={begin('move')} {...h} title="Seret: pindah posisi">
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
          <span key={k} className={`kfCorner ${k}`} onPointerDown={begin('scale')} {...h} title="Seret: zoom (skala)" />
        ))}
        <span className="kfRot" onPointerDown={begin('rot')} {...h} title="Seret: putar (Shift = per 15°)" />
        <span className="kfInfo">
          {Math.round(v.scale * 100)}% · {Math.round(v.rot)}°
        </span>
      </div>
    </div>
  );
}
