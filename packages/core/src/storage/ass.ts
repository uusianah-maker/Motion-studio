/**
 * ASS captions for libass (U3b, the Remotion replacement for animated captions). Pure module.
 * Used for text/subtitle clips that have word timings, an animation or keyword highlights; plain
 * titles keep using drawtext. Geometry, wrapping and sizes come from the same `textStyle` numbers
 * as drawtext and the preview, so all three line up:
 *  - each caption is centred on (x, y) with `\an5\pos`, lines from `layoutText`;
 *  - font size = style size (em px) converted with the font's metrics (`assFontSize`);
 *  - words appear when spoken (`pop`: grow from 70 % in `anim_ms`), words not yet spoken are
 *    drawn fully transparent so the line never jumps;
 *  - keywords (`highlight.words`) and optionally the word being spoken use the highlight colour
 *    and scale.
 */
import { type FontInfo, assFontSize } from './fontInfo.js';
import type { Clip, TrackKind } from './project.js';
import { type TextStyle, contrastText, effectiveStyle, layoutText } from './textStyle.js';
import { type Word, wordKey } from './words.js';

export const DEFAULT_FONT_INFO: FontInfo = { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: true };

export interface AssFonts {
  /** Default bold / regular faces and the brand faces, when present. */
  bold: FontInfo;
  regular: FontInfo;
  brand: FontInfo | null;
  caption: FontInfo | null;
}

/** A clip goes through libass when it needs what drawtext cannot do. */
export const needsAss = (s: TextStyle, c: Clip) => !!c.words?.length || s.anim !== 'none' || !!s.highlight;

const time = (ms: number) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
/** #rrggbb (+ opacity 0..1) → ASS &HBBGGRR& / &HAA& (alpha 00 = opaque). */
const assColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
const assAlpha = (opacity: number) => `&H${Math.round(255 * (1 - Math.min(1, Math.max(0, opacity))))
  .toString(16)
  .padStart(2, '0')
  .toUpperCase()}&`;
/** Text must never open an override block or a line break. */
const safe = (t: string) => t.replace(/[{}]/g, (m) => (m === '{' ? '(' : ')')).replace(/\\/g, '/');

function faceFor(s: TextStyle, f: AssFonts): FontInfo {
  if (s.font === 'brand' && f.brand) return f.brand;
  if (s.font === 'caption' && f.caption) return f.caption;
  return s.bold || !f.regular ? f.bold : f.regular;
}

export interface AssInput {
  clips: { kind: TrackKind; clip: Clip }[];
  width: number;
  height: number;
  ratio: string;
  fonts: AssFonts;
  /** Captions end at the video's end. */
  total_ms: number;
}

/** `line(…, ALL)`: every visible word is "new" (the whole block animates in). */
const ALL = -2;

export function buildAss(input: AssInput): string {
  const { width: W, height: H } = input;
  const short = Math.min(W, H);
  const events: string[] = [];
  for (const { kind, clip } of input.clips) {
    if (kind !== 'text' && kind !== 'subtitle') continue;
    if (!clip.text?.trim() || clip.start_ms >= input.total_ms) continue;
    const s = effectiveStyle(kind, clip.style);
    const face = faceFor(s, input.fonts);
    const px = Math.max(8, Math.round((short * s.size) / 100));
    const fs = assFontSize(px, face);
    const end = Math.min(clip.end_ms, input.total_ms);
    // Base look: position, face, size, colour, then outline or box.
    const box = !!s.bg;
    const look = [
      '\\an5',
      `\\pos(${Math.round(s.x * W)},${Math.round(s.y * H)})`,
      `\\fn${safe(face.family)}`,
      `\\fs${fs}`,
      `\\b${s.bold ? 1 : 0}`,
      `\\c${assColor(s.color)}`,
      box ? `\\3c${assColor(s.bg!)}\\3a${assAlpha(s.bg_opacity)}\\bord${Math.round(px * 0.4)}\\shad0` : s.outline ? `\\3c&H000000&\\3a&H33&\\bord${Math.max(2, Math.round(px * 0.06))}\\4c&H000000&\\4a&H66&\\shad${Math.round(px * 0.08)}` : '\\bord0\\shad0',
    ].join('');
    const style = box ? 'Box' : 'Line';
    // Back to the clip's own border after a boxed keyword.
    const restore = s.highlight?.box ? (box ? `\\3c${assColor(s.bg!)}\\3a${assAlpha(s.bg_opacity)}\\bord${Math.round(px * 0.4)}` : s.outline ? `\\3c&H000000&\\3a&H33&\\bord${Math.max(2, Math.round(px * 0.06))}\\shad${Math.round(px * 0.08)}` : '\\bord0\\shad0') : '';
    const hl = s.highlight;
    const keys = new Set((hl?.words ?? []).map(wordKey));
    const words: Word[] = clip.words?.length ? clip.words : clip.text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, start_ms: 0, end_ms: end - clip.start_ms }));
    const timed = !!clip.words?.length;
    // Line breaks from the shared layout, applied word by word.
    const lines = layoutText(words.map((w) => w.text).join(' '), s, input.ratio).split('\n');
    const breakAfter = new Set<number>();
    let n = 0;
    for (const l of lines.slice(0, -1)) {
      n += l.split(' ').filter(Boolean).length;
      breakAfter.add(n - 1);
    }
    // Audit (14 Nov): `\alpha` sets EVERY alpha, so on a boxed caption it made the box opaque and
    // grow word by word. A boxed caption only hides / shows the text (`\1a`); the box (`\3a`) stays
    // as the style says, full width, like the preview.
    const SHOW = box ? '\\1a&H00&' : '\\alpha&H00&';
    const HIDE = box ? '\\1a&HFF&' : '\\alpha&HFF&';
    const wordTag = (w: Word, i: number, state: 'hidden' | 'new' | 'shown', current: boolean) => {
      const isKey = keys.has(wordKey(w.text));
      const hot = (isKey || (current && !!hl?.current)) && !!hl;
      // Boxed keyword: a thick outline in the highlight colour behind the word, text in contrast.
      const color = hot ? (hl!.box ? `\\c${assColor(contrastText(hl!.color))}\\3c${assColor(hl!.color)}\\3a&H00&\\bord${Math.max(2, Math.round(px * 0.18))}\\shad0` : `\\c${assColor(hl!.color)}`) : `\\c${assColor(s.color)}${restore}`;
      const scale = (isKey || (current && hl?.current)) && hl ? Math.round(hl.scale * 100) : 100;
      if (state === 'hidden') return `{${HIDE}\\fscx${scale}\\fscy${scale}${color}}`;
      if (state === 'new' && s.anim === 'pop') return `{${SHOW}${color}\\fscx${Math.round(scale * 0.7)}\\fscy${Math.round(scale * 0.7)}\\t(0,${s.anim_ms},\\fscx${scale}\\fscy${scale})}`;
      if (state === 'new' && s.anim === 'fade') return `{${HIDE}${color}\\fscx${scale}\\fscy${scale}\\t(0,${s.anim_ms},${SHOW})}`;
      void i;
      return `{${SHOW}${color}\\fscx${scale}\\fscy${scale}}`;
    };
    const line = (visible: number, fresh: number) =>
      words
        .map((w, i) => `${wordTag(w, i, i < visible ? (i === fresh || fresh === ALL ? 'new' : 'shown') : 'hidden', i === visible - 1)}${safe(w.text)}${i === words.length - 1 ? '' : breakAfter.has(i) ? '\\N' : ' '}`)
        .join('');
    if (timed) {
      // One event per spoken word: words so far shown, the newest one animating in.
      words.forEach((w, i) => {
        const from = clip.start_ms + w.start_ms;
        const to = i + 1 < words.length ? clip.start_ms + words[i + 1]!.start_ms : end;
        if (to <= from) return;
        events.push(`Dialogue: 0,${time(from)},${time(to)},${style},,0,0,0,,{${look}}${line(i + 1, i)}`);
      });
    } else {
      // Whole text at once: every word pops / fades in together. (A block-level \fscx was undone by
      // each word's own \fscx100 — audit 14 Nov: "Pop" did nothing.)
      events.push(`Dialogue: 0,${time(clip.start_ms)},${time(end)},${style},,0,0,0,,{${look}}${line(words.length, s.anim === 'pop' || s.anim === 'fade' ? ALL : -1)}`);
    }
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Line,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    'Style: Box,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
