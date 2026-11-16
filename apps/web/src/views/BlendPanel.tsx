import { OVERLAY_BLENDS, OVERLAY_BLEND_LABEL, type OverlayBlend } from '../../../../packages/core/dist/storage/overlay.js';
import type { Clip, EditOp } from '../api';

/**
 * R38b (owner 16 Nov): how an overlay mixes with the picture below — video effects (light leak, dust,
 * particles) usually Screen. Preview = CSS mix-blend-mode, render = FFmpeg blend (same modes).
 */
export function BlendPanel({ clip, submit }: { clip: Clip; submit: (ops: EditOp[]) => void }) {
  const cur = (clip.overlay as { blend?: OverlayBlend; stinger?: true } | undefined) ?? {};
  return (
    <div className="inspGrid" role="group" aria-label="Mode campur">
      <label>
        Mode campur
        <select aria-label="Mode campur" value={cur.blend ?? 'normal'} onChange={(e) => submit([{ op: 'set_overlay', clip_id: clip.clip_id, overlay: { blend: e.target.value as OverlayBlend } }])}>
          {OVERLAY_BLENDS.map((b) => (
            <option key={b} value={b}>
              {OVERLAY_BLEND_LABEL[b]}
            </option>
          ))}
        </select>
      </label>
      {cur.stinger && <span className="muted small">Transisi stinger: pergantian gambar di tengahnya. Geser klip ini untuk memindah titik transisi.</span>}
    </div>
  );
}
