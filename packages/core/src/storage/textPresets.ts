/**
 * Text preset library (plan v3 X03, PRD §7 P0 "Text preset library: Hook, USP, CTA, Sale,
 * Subtitle"). A preset is a named style + default copy + duration. Pure module: the editor, the
 * local Copilot rules and the AI planner prompt all read the same table. Brand Kit (X06) will
 * re-colour these per workspace.
 */
import type { TextKind, TextStyle } from './textStyle.js';

export type PresetId = 'hook' | 'usp' | 'cta' | 'sale' | 'subtitle';

export interface TextPreset {
  id: PresetId;
  label: string;
  /** What it is for (shown as a tooltip). */
  hint: string;
  track: TextKind;
  text: string;
  duration_ms: number;
  style: Partial<TextStyle>;
}

export const TEXT_PRESETS: readonly TextPreset[] = [
  { id: 'hook', label: 'Hook', hint: 'Kalimat pembuka besar di atas, 2 detik pertama', track: 'text', text: 'Stop scroll! Ini wajib kamu lihat', duration_ms: 2000, style: { x: 0.5, y: 0.2, size: 7.5, width: 0.86, color: '#ffffff', bg: null, bold: true, outline: true, align: 'center' } },
  { id: 'usp', label: 'USP', hint: 'Keunggulan produk di tengah, kotak gelap', track: 'text', text: 'Bahan adem, nggak nerawang', duration_ms: 3000, style: { x: 0.5, y: 0.5, size: 5, width: 0.8, color: '#ffffff', bg: '#000000', bg_opacity: 0.55, bold: true, outline: false, align: 'center' } },
  { id: 'cta', label: 'CTA', hint: 'Ajakan bertindak di bawah, kotak kuning', track: 'text', text: 'Cek keranjang kuning sekarang!', duration_ms: 3000, style: { x: 0.5, y: 0.66, size: 6, width: 0.82, color: '#111111', bg: '#ffd23f', bg_opacity: 1, bold: true, outline: false, align: 'center' } },
  { id: 'sale', label: 'Sale', hint: 'Diskon/harga besar, kotak merah', track: 'text', text: 'DISKON 50%', duration_ms: 2500, style: { x: 0.5, y: 0.36, size: 10, width: 0.86, color: '#ffffff', bg: '#e53935', bg_opacity: 1, bold: true, outline: false, align: 'center' } },
  { id: 'subtitle', label: 'Subtitle', hint: 'Teks bicara di bawah, kotak hitam transparan', track: 'subtitle', text: 'Subtitle baru', duration_ms: 3000, style: { x: 0.5, y: 0.78, size: 4.5, width: 0.76, color: '#ffffff', bg: '#000000', bg_opacity: 0.62, bold: true, outline: false, align: 'center' } },
];

export const presetById = (id: string): TextPreset | undefined => TEXT_PRESETS.find((p) => p.id === id);

/** Colour words the local Copilot understands (Indonesian + English). */
export const COLOR_WORDS: Record<string, string> = {
  merah: '#e53935',
  red: '#e53935',
  kuning: '#ffd23f',
  yellow: '#ffd23f',
  hijau: '#43a047',
  green: '#43a047',
  biru: '#1e88e5',
  blue: '#1e88e5',
  putih: '#ffffff',
  white: '#ffffff',
  hitam: '#111111',
  black: '#111111',
  oranye: '#fb8c00',
  orange: '#fb8c00',
  ungu: '#8e24aa',
  purple: '#8e24aa',
  pink: '#ec407a',
  emas: '#f5c542',
  gold: '#f5c542',
  abu: '#9e9e9e',
  grey: '#9e9e9e',
  gray: '#9e9e9e',
};

/** Tone words → style tweaks (PRD workflow A: "tone minimalis"). */
export const TONES: Record<string, Partial<TextStyle>> = {
  minimalis: { bold: false, outline: false, bg: null },
  minimal: { bold: false, outline: false, bg: null },
  tegas: { bold: true, outline: true },
  bold: { bold: true, outline: true },
  elegan: { bold: false, outline: false, color: '#f5e6c8', bg: null },
  elegant: { bold: false, outline: false, color: '#f5e6c8', bg: null },
};
