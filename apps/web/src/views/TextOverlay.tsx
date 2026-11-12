import { type CSSProperties, useRef, useState } from 'react';
import { type TextStyle, effectiveStyle, layoutText } from '../../../../packages/core/dist/storage/textStyle.js';
import type { Clip } from '../api';
import { BRAND_CAPTION_FAMILY, BRAND_FONT_FAMILY } from '../brand';

/** #rrggbb + opacity → rgba() */
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One text/subtitle clip drawn on the preview canvas (X01). Same numbers as the render: centre
 * at (x, y), font size = size % of the canvas short side, lines from the shared layout function.
 * X02: click selects the clip; dragging moves it (saved as one `set_style` on release).
 */
export function TextOverlay({
  clip,
  kind,
  ratio,
  canvas,
  draft,
  selected,
  onSelect,
  onMove,
}: {
  clip: Clip;
  kind: 'text' | 'subtitle';
  ratio: string;
  canvas: { w: number; h: number };
  draft?: Partial<TextStyle> | null;
  selected?: boolean;
  onSelect?: () => void;
  onMove?: (x: number, y: number) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; x: number; y: number; id: number } | null>(null);
  const s: TextStyle = { ...effectiveStyle(kind, clip.style), ...(draft ?? {}), ...(pos ?? {}) };
  const px = (Math.min(canvas.w, canvas.h) * s.size) / 100;
  const style: CSSProperties = {
    left: `${s.x * 100}%`,
    top: `${s.y * 100}%`,
    fontSize: `${px}px`,
    lineHeight: 1.15,
    color: s.color,
    fontWeight: s.bold ? 800 : 400,
    // X06: brand font (registered by useBrand); falls back to the default face if not loaded.
    ...(s.font === 'brand' ? { fontFamily: `'${BRAND_FONT_FAMILY}', Arial, sans-serif` } : s.font === 'caption' ? { fontFamily: `'${BRAND_CAPTION_FAMILY}', Arial, sans-serif` } : {}),
    textAlign: s.align,
    background: s.bg ? rgba(s.bg, s.bg_opacity) : 'transparent',
    padding: s.bg ? `${px * 0.4}px` : 0,
    textShadow: s.outline ? `0 0 ${Math.max(1, px * 0.06)}px #000c, 0 ${px * 0.08}px ${px * 0.12}px #0009` : 'none',
    pointerEvents: onSelect ? 'auto' : 'none',
    cursor: onMove ? 'move' : undefined,
    touchAction: onMove ? 'none' : undefined,
  };
  const interactive = !!onSelect;
  return (
    <div
      className={`overlayText styled${selected ? ' picked' : ''}`}
      style={style}
      data-kind={kind}
      data-clip={clip.clip_id}
      {...(interactive
        ? {
            role: 'button',
            'aria-label': `Teks di pratinjau: ${clip.text ?? ''}`,
            tabIndex: -1,
            onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              start.current = { px: e.clientX, py: e.clientY, x: s.x, y: s.y, id: e.pointerId };
            },
            onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
              const st = start.current;
              if (!st || st.id !== e.pointerId || !onMove) return;
              const dx = (e.clientX - st.px) / canvas.w;
              const dy = (e.clientY - st.py) / canvas.h;
              if (!pos && Math.hypot(e.clientX - st.px, e.clientY - st.py) < 3) return;
              setPos({ x: clamp01(st.x + dx), y: clamp01(st.y + dy) });
            },
            onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
              const st = start.current;
              start.current = null;
              if (!st || st.id !== e.pointerId) return;
              onSelect?.();
              if (pos && onMove) onMove(Math.round(pos.x * 1000) / 1000, Math.round(pos.y * 1000) / 1000);
              setPos(null);
            },
          }
        : {})}
    >
      {layoutText(clip.text ?? '', s, ratio)}
    </div>
  );
}
