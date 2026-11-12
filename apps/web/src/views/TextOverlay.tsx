import { type CSSProperties, useRef, useState } from 'react';
import { type TextStyle, contrastText, effectiveStyle, layoutText } from '../../../../packages/core/dist/storage/textStyle.js';
import { spokenCount, wordKey } from '../../../../packages/core/dist/storage/words.js';
import type { Clip } from '../api';
import { BRAND_CAPTION_FAMILY, BRAND_FONT_FAMILY } from '../brand';

/**
 * U3b: same rules as the ASS captions — spoken words visible (later ones invisible so the line
 * does not move), the newest one popping/fading in, keywords in the highlight colour and size.
 */
function renderText(clip: Clip, s: TextStyle, ratio: string, time: number | undefined) {
  const plain = layoutText(clip.text ?? '', s, ratio);
  if (!clip.words?.length && s.anim === 'none' && !s.highlight) return plain;
  const words = clip.words?.length ? clip.words : (clip.text ?? '').split(/\s+/).filter(Boolean).map((t) => ({ text: t, start_ms: 0, end_ms: clip.end_ms - clip.start_ms }));
  const rel = (time ?? clip.start_ms) - clip.start_ms;
  const spoken = clip.words?.length ? spokenCount(words, rel) : words.length;
  const keys = new Set((s.highlight?.words ?? []).map(wordKey));
  const lines = layoutText(words.map((w) => w.text).join(' '), s, ratio).split('\n');
  const breaks = new Set<number>();
  let n = 0;
  for (const l of lines.slice(0, -1)) {
    n += l.split(' ').filter(Boolean).length;
    breaks.add(n - 1);
  }
  const anim = s.anim === 'none' ? '' : s.anim;
  return (
    <span className={!clip.words?.length && anim ? `wanim ${anim}` : undefined} style={{ animationDuration: `${s.anim_ms}ms` }}>
      {words.map((w, i) => {
        const hot = !!s.highlight && (keys.has(wordKey(w.text)) || (s.highlight.current && i === spoken - 1));
        const fresh = !!clip.words?.length && i === spoken - 1 && !!anim;
        return (
          <span key={i}>
            <span
              key={fresh ? `${i}:new` : i}
              className={`w${fresh ? ` wanim ${anim}` : ''}`}
              data-word={w.text}
              data-hot={hot || undefined}
              style={{
                visibility: i < spoken ? 'visible' : 'hidden',
                color: hot ? (s.highlight!.box ? contrastText(s.highlight!.color) : s.highlight!.color) : undefined,
                background: hot && s.highlight!.box ? s.highlight!.color : undefined,
                padding: hot && s.highlight!.box ? '0 0.18em' : undefined,
                borderRadius: hot && s.highlight!.box ? '0.18em' : undefined,
                display: 'inline-block',
                transform: hot && s.highlight!.scale !== 1 ? `scale(${s.highlight!.scale})` : undefined,
                animationDuration: `${s.anim_ms}ms`,
              }}
            >
              {w.text}
            </span>
            {i === words.length - 1 ? '' : breaks.has(i) ? <br /> : ' '}
          </span>
        );
      })}
    </span>
  );
}

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
  time,
}: {
  clip: Clip;
  kind: 'text' | 'subtitle';
  ratio: string;
  canvas: { w: number; h: number };
  draft?: Partial<TextStyle> | null;
  selected?: boolean;
  onSelect?: () => void;
  onMove?: (x: number, y: number) => void;
  /** U3b: playhead (ms) — words appear as they are spoken. */
  time?: number;
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
    // U3c: frosted glass behind the box (render: gblur of the same area).
    ...(s.bg_blur > 0 ? { backdropFilter: `blur(${(s.bg_blur * Math.min(canvas.w, canvas.h)) / 1080}px)`, WebkitBackdropFilter: `blur(${(s.bg_blur * Math.min(canvas.w, canvas.h)) / 1080}px)` } : {}),
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
      {renderText(clip, s, ratio, time)}
    </div>
  );
}
