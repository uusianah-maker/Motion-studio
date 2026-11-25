import { useRef, useState } from 'react';
import type { Clip, EditOp } from '../api';

/**
 * 25 Nov (owner: "boleh tambahkan tools key frame manual"): the clip's keyframes as ◆ on its
 * timeline block. Click = jump the playhead to that keyframe; drag sideways = move it in time
 * (one `set_keyframes` edit = one undo step). Keyframes outside the clip (anchors after a split)
 * are not drawn.
 */
export function KeyframeDiamonds({ clip, msPerPx, locked, onSeek, submit }: { clip: Clip; msPerPx: () => number; locked: boolean; onSeek: (ms: number) => void; submit: (ops: EditOp[]) => void }) {
  const len = clip.end_ms - clip.start_ms;
  const [drag, setDrag] = useState<{ i: number; x0: number; d: number; id: number } | null>(null);
  const moved = useRef(false);
  const kfs = clip.keyframes ?? [];
  if (!kfs.length || len <= 0) return null;
  const at = (i: number) => {
    const k = kfs[i]!;
    if (!drag || drag.i !== i) return k.at_ms;
    const lo = i > 0 ? kfs[i - 1]!.at_ms + 10 : 0;
    const hi = i < kfs.length - 1 ? kfs[i + 1]!.at_ms - 10 : len;
    return Math.round(Math.max(lo, Math.min(hi, k.at_ms + drag.d)) / 10) * 10;
  };
  return (
    <div className="kfDiamonds" aria-label={`Keyframe ${clip.clip_id}`}>
      {kfs.map((k, i) =>
        k.at_ms < 0 || k.at_ms > len ? null : (
          <span
            key={`${k.at_ms}:${i}`}
            className={`kfDiamond${drag?.i === i ? ' dragging' : ''}`}
            role="button"
            tabIndex={-1}
            aria-label={`Keyframe ${i + 1} di detik ${(k.at_ms / 1000).toFixed(2)}`}
            title={`Keyframe ${i + 1} · detik ${(at(i) / 1000).toFixed(2).replace('.', ',')} — klik: lompat ke sini, seret: pindah waktu`}
            style={{ left: `${(at(i) / len) * 100}%` }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation(); // not a clip drag / box selection
              moved.current = false;
              if (!locked) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ i, x0: e.clientX, d: 0, id: e.pointerId });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.id !== e.pointerId || locked) return;
              const dx = e.clientX - drag.x0;
              if (Math.abs(dx) >= 3) moved.current = true;
              setDrag({ ...drag, d: moved.current ? dx * msPerPx() : 0 });
            }}
            onPointerUp={(e) => {
              if (!drag || drag.id !== e.pointerId) return;
              const ms = at(drag.i);
              setDrag(null);
              if (!moved.current || ms === k.at_ms) return onSeek(clip.start_ms + k.at_ms);
              submit([{ op: 'set_keyframes', clip_id: clip.clip_id, keyframes: kfs.map((x, j) => (j === i ? { ...x, at_ms: ms } : x)) }]);
              onSeek(clip.start_ms + ms);
            }}
            onPointerCancel={() => setDrag(null)}
          />
        ),
      )}
    </div>
  );
}
