import { promises as fsp } from 'node:fs';

/**
 * Minimal TrueType/OpenType reader (U3b): the family name libass looks fonts up by, and the
 * vertical metrics libass sizes text with. libass scales a font so that its Windows ascent +
 * descent (OS/2 usWinAscent + usWinDescent) equal the ASS font size, while drawtext and the
 * browser size the em square — `assScale` converts one into the other so captions rendered
 * through ASS are exactly as big as the preview and the drawtext titles.
 */
export interface FontInfo {
  family: string;
  unitsPerEm: number;
  /** usWinAscent + usWinDescent (or hhea ascender − descender when OS/2 is missing). */
  winHeight: number;
  bold: boolean;
}

function readTables(buf: Buffer): Map<string, { offset: number; length: number }> {
  if (buf.length < 12) throw new Error('bukan file font');
  const tag = buf.toString('latin1', 0, 4);
  const sfnt = buf.readUInt32BE(0);
  if (sfnt !== 0x00010000 && tag !== 'OTTO' && tag !== 'true') throw new Error('bukan TrueType/OpenType');
  const n = buf.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    if (p + 16 > buf.length) break;
    tables.set(buf.toString('latin1', p, p + 4), { offset: buf.readUInt32BE(p + 8), length: buf.readUInt32BE(p + 12) });
  }
  return tables;
}

function familyName(buf: Buffer, t: { offset: number; length: number }): string | null {
  const base = t.offset;
  const count = buf.readUInt16BE(base + 2);
  const strings = base + buf.readUInt16BE(base + 4);
  let mac: string | null = null;
  // Prefer the typographic family (16) only when the legacy family (1) is missing: libass uses 1.
  for (const wantId of [1, 16]) {
    for (let i = 0; i < count; i++) {
      const r = base + 6 + i * 12;
      const platform = buf.readUInt16BE(r);
      const nameId = buf.readUInt16BE(r + 6);
      if (nameId !== wantId) continue;
      const len = buf.readUInt16BE(r + 8);
      const off = strings + buf.readUInt16BE(r + 10);
      if (off + len > buf.length) continue;
      if (platform === 3 || platform === 0) {
        const bytes = Buffer.from(buf.subarray(off, off + len));
        bytes.swap16();
        return bytes.toString('utf16le');
      }
      if (platform === 1 && !mac) mac = buf.toString('latin1', off, off + len);
    }
    if (mac) return mac;
  }
  return mac;
}

export async function readFontInfo(file: string): Promise<FontInfo> {
  const buf = await fsp.readFile(file);
  const tables = readTables(buf);
  const head = tables.get('head');
  const name = tables.get('name');
  if (!head || !name) throw new Error('font tanpa tabel head/name');
  const unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
  const macStyle = buf.readUInt16BE(head.offset + 44);
  const os2 = tables.get('OS/2');
  const hhea = tables.get('hhea');
  let winHeight = 0;
  if (os2 && os2.length >= 78) winHeight = buf.readUInt16BE(os2.offset + 74) + buf.readUInt16BE(os2.offset + 76);
  if (!winHeight && hhea) winHeight = buf.readInt16BE(hhea.offset + 4) - buf.readInt16BE(hhea.offset + 6);
  if (!winHeight) winHeight = unitsPerEm;
  return { family: familyName(buf, name) ?? 'Arial', unitsPerEm, winHeight, bold: (macStyle & 1) === 1 };
}

/** ASS font size that draws text as big as a drawtext/CSS em size of `px`. */
export const assFontSize = (px: number, f: FontInfo): number => Math.round(((px * f.winHeight) / f.unitsPerEm) * 100) / 100;
