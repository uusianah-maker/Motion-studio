import type { CSSProperties } from 'react';
import { type TextStyle, effectiveStyle, layoutText } from '../../../../packages/core/dist/storage/textStyle.js';
import type { Clip } from '../api';

/** #rrggbb + opacity → rgba() */
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

/**
 * One text/subtitle clip drawn on the preview canvas (X01). Same numbers as the render: centre
 * at (x, y), font size = size % of the canvas short side, lines from the shared layout function.
 * Font: the same family the render burns in (Arial / DejaVu Sans).
 */
export function TextOverlay({ clip, kind, ratio, canvas }: { clip: Clip; kind: 'text' | 'subtitle'; ratio: string; canvas: { w: number; h: number } }) {
  const s: TextStyle = effectiveStyle(kind, clip.style);
  const px = (Math.min(canvas.w, canvas.h) * s.size) / 100;
  const style: CSSProperties = {
    left: `${s.x * 100}%`,
    top: `${s.y * 100}%`,
    fontSize: `${px}px`,
    lineHeight: 1.15,
    color: s.color,
    fontWeight: s.bold ? 800 : 400,
    textAlign: s.align,
    background: s.bg ? rgba(s.bg, s.bg_opacity) : 'transparent',
    padding: s.bg ? `${px * 0.4}px` : 0,
    textShadow: s.outline ? `0 0 ${Math.max(1, px * 0.06)}px #000c, 0 ${px * 0.08}px ${px * 0.12}px #0009` : 'none',
  };
  return (
    <div className="overlayText styled" style={style} data-kind={kind} data-clip={clip.clip_id}>
      {layoutText(clip.text ?? '', s, ratio)}
    </div>
  );
}
