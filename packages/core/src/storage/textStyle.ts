/**
 * Text style for text/subtitle clips (plan v3 X01, PRD §7 P0 "text overlay" + presets). Pure
 * module (no Node APIs): the web preview imports it too, so preview and render compute the same
 * line breaks and placement from the same numbers.
 *
 * Geometry is relative to the output canvas, so one style works for every ratio/resolution:
 *  - x, y: centre of the text block (0..1 of canvas width / height);
 *  - size: font size in % of the canvas SHORT side;
 *  - width: max line width (0..1 of canvas width) used for word wrapping.
 */
import { StorageError } from './errors.js';

export type TextAlign = 'left' | 'center' | 'right';
export interface TextStyle {
  x: number;
  y: number;
  size: number;
  width: number;
  color: string;
  /** Background box colour, or null for no box. */
  bg: string | null;
  bg_opacity: number;
  bold: boolean;
  /** Dark outline + shadow for legibility on busy footage. */
  outline: boolean;
  align: TextAlign;
  /** X06/U1: 'brand' = the brand's title font, 'caption' = its caption font (default font if missing). */
  font: 'default' | 'brand' | 'caption';
}

export type TextKind = 'text' | 'subtitle';

export const DEFAULT_STYLES: Record<TextKind, TextStyle> = {
  text: { x: 0.5, y: 0.2, size: 6.2, width: 0.84, color: '#ffffff', bg: null, bg_opacity: 0.6, bold: true, outline: true, align: 'center', font: 'default' },
  subtitle: { x: 0.5, y: 0.78, size: 4.5, width: 0.76, color: '#ffffff', bg: '#000000', bg_opacity: 0.62, bold: true, outline: false, align: 'center', font: 'default' },
};

export const STYLE_LIMITS = { size: [2, 20], width: [0.2, 1] } as const;
const HEX = /^#[0-9a-f]{6}$/;
const KEYS: readonly (keyof TextStyle)[] = ['x', 'y', 'size', 'width', 'color', 'bg', 'bg_opacity', 'bold', 'outline', 'align', 'font'];

const bad = (msg: string): never => {
  throw new StorageError('EDIT_INVALID', msg);
};

/** Validate a (partial) style from an edit, a plan or a stored manifest. Unknown keys are refused. */
export function validateStyle(raw: unknown, where = 'style'): Partial<TextStyle> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${where} harus objek`);
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k as keyof TextStyle));
  if (extra.length) bad(`${where}: field tidak dikenal ${extra.join(', ')}`);
  const out: Partial<TextStyle> = {};
  const num = (k: 'x' | 'y' | 'size' | 'width' | 'bg_opacity', min: number, max: number) => {
    if (o[k] === undefined) return;
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${where}.${k} harus angka ${min}–${max}`);
    out[k] = Math.round((v as number) * 1000) / 1000;
  };
  num('x', 0, 1);
  num('y', 0, 1);
  num('size', STYLE_LIMITS.size[0], STYLE_LIMITS.size[1]);
  num('width', STYLE_LIMITS.width[0], STYLE_LIMITS.width[1]);
  num('bg_opacity', 0, 1);
  if (o.color !== undefined) {
    if (typeof o.color !== 'string' || !HEX.test(o.color.toLowerCase())) bad(`${where}.color harus warna #rrggbb`);
    out.color = (o.color as string).toLowerCase();
  }
  if (o.bg !== undefined) {
    if (o.bg !== null && (typeof o.bg !== 'string' || !HEX.test(o.bg.toLowerCase()))) bad(`${where}.bg harus warna #rrggbb atau null`);
    out.bg = o.bg === null ? null : (o.bg as string).toLowerCase();
  }
  for (const k of ['bold', 'outline'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') bad(`${where}.${k} harus true/false`);
    out[k] = o[k] as boolean;
  }
  if (o.align !== undefined) {
    if (o.align !== 'left' && o.align !== 'center' && o.align !== 'right') bad(`${where}.align harus left | center | right`);
    out.align = o.align as TextAlign;
  }
  if (o.font !== undefined) {
    if (o.font !== 'default' && o.font !== 'brand' && o.font !== 'caption') bad(`${where}.font harus default | brand | caption`);
    out.font = o.font as TextStyle['font'];
  }
  return out;
}

/** The style actually used: track default + the clip's own overrides. */
export const effectiveStyle = (kind: TextKind, style?: Partial<TextStyle> | null): TextStyle => ({ ...DEFAULT_STYLES[kind], ...(style ?? {}) });

/** Width / short side of a canvas ratio "a:b". */
export function aspectOverShort(ratio: string): number {
  const [a, b] = ratio.split(':').map(Number) as [number, number];
  return a >= b ? a / b : 1;
}

/** Greedy word wrap; words longer than a line are broken. */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n')) {
    let line = '';
    for (let word of para.split(/ +/).filter(Boolean)) {
      while (word.length > maxChars) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Characters per line for a style on a canvas ratio: line width / (≈0.56 × font size), from the
 * unrounded geometry so the preview (any pixel size) and the render (720/1080) break identically.
 */
export function wrapCharsFor(style: TextStyle, ratio: string): number {
  return Math.max(4, Math.floor((style.width * aspectOverShort(ratio)) / ((style.size / 100) * 0.56)));
}

/** The exact lines both preview and render draw. */
export const layoutText = (text: string, style: TextStyle, ratio: string) => wrapText(text.trim(), wrapCharsFor(style, ratio));
