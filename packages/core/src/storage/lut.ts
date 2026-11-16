/**
 * R38a: colour LUTs (`.cube`, Adobe/Resolve 3D LUT) as a "Filter warna". Pure module shared by the
 * server (validation before a LUT joins the Brand Kit) and the browser (exact before/after swatch,
 * approximate live preview). The render applies the real file with FFmpeg `lut3d` — the preview of a
 * moving clip can only approximate it (a 3×4 colour matrix fitted to the LUT), and says so.
 */

export const LUT_LIMITS = { size: [2, 65] as const, bytes: 8 * 1024 * 1024 };

export interface Lut {
  title: string;
  size: number;
  /** RGB triples, red fastest (cube order), values 0..1 after DOMAIN scaling. */
  data: Float32Array;
  min: [number, number, number];
  max: [number, number, number];
}

/** Parse a `.cube` 3D LUT. Throws a plain Error with an Indonesian reason when it is not one. */
export function parseCube(text: string): Lut {
  if (text.length > LUT_LIMITS.bytes) throw new Error('file LUT terlalu besar (maks 8 MB)');
  let size = 0;
  let title = '';
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '').slice(0, 80);
    else if (key === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (key === 'LUT_1D_SIZE') throw new Error('LUT 1D belum didukung, pakai LUT 3D (.cube)');
    else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const v = parts.slice(1, 4).map(Number) as [number, number, number];
      if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) throw new Error(`${key} tidak valid`);
      if (key === 'DOMAIN_MIN') min = v;
      else max = v;
    } else if (/^[-+.\d]/.test(key)) {
      if (parts.length < 3) throw new Error('baris warna LUT harus 3 angka');
      for (let i = 0; i < 3; i++) {
        const n = Number(parts[i]);
        if (!Number.isFinite(n)) throw new Error('angka LUT tidak valid');
        vals.push(n);
      }
    }
    // Other keywords (LUT_IN_VIDEO_RANGE…) are ignored like FFmpeg does.
  }
  if (!Number.isInteger(size) || size < LUT_LIMITS.size[0] || size > LUT_LIMITS.size[1]) throw new Error(`LUT_3D_SIZE harus ${LUT_LIMITS.size[0]}–${LUT_LIMITS.size[1]}`);
  if (vals.length !== size ** 3 * 3) throw new Error(`isi LUT harus ${size ** 3} warna (ada ${Math.floor(vals.length / 3)})`);
  if (min.some((v, i) => v >= max[i]!)) throw new Error('DOMAIN_MIN harus lebih kecil dari DOMAIN_MAX');
  return { title, size, data: Float32Array.from(vals), min, max };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Apply the LUT to one colour (0..1) with trilinear interpolation (what `lut3d` does by default). */
export function applyLut(l: Lut, r: number, g: number, b: number): [number, number, number] {
  const n = l.size - 1;
  const pos = [r, g, b].map((v, i) => clamp01((v - l.min[i]!) / (l.max[i]! - l.min[i]!)) * n);
  const i0 = pos.map((p) => Math.min(n - 1, Math.floor(p)));
  const f = pos.map((p, i) => p - i0[i]!);
  const at = (x: number, y: number, z: number, c: number) => l.data[((z * l.size + y) * l.size + x) * 3 + c]!;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
          if (w) acc += w * at(i0[0]! + dx, i0[1]! + dy, i0[2]! + dz, c);
        }
    out[c] = clamp01(acc);
  }
  return out;
}

/**
 * Best 3×4 colour matrix (least squares over a 9³ grid) — what the browser preview can do with an
 * SVG feColorMatrix. Exact for linear LUTs (contrast, saturation, channel mix), approximate for
 * curves. Rows: R, G, B → [r, g, b, offset].
 */
export function lutMatrix(l: Lut): number[][] {
  const N = 9;
  // Normal equations X^T X (4×4) and X^T Y (4×3).
  const xtx = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
  const xty = Array.from({ length: 4 }, () => new Array<number>(3).fill(0));
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++) {
        const x = [i / (N - 1), j / (N - 1), k / (N - 1), 1];
        const y = applyLut(l, x[0]!, x[1]!, x[2]!);
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) xtx[a]![b]! += x[a]! * x[b]!;
          for (let c = 0; c < 3; c++) xty[a]![c]! += x[a]! * y[c]!;
        }
      }
  // Solve with Gauss-Jordan (4×4, well conditioned on a full grid).
  const m = xtx.map((row, a) => [...row, ...xty[a]!]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    const d = m[col]![col]!;
    for (let c = 0; c < 7; c++) m[col]![c]! /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const k = m[r]![col]!;
      for (let c = 0; c < 7; c++) m[r]![c]! -= k * m[col]![c]!;
    }
  }
  // m[a][4 + c] = coefficient of input a for output c.
  return [0, 1, 2].map((c) => [0, 1, 2, 3].map((a) => Math.round(m[a]![4 + c]! * 10000) / 10000));
}

/** SVG feColorMatrix `values` (4×5, alpha row identity) for the preview. */
export const lutMatrixValues = (rows: number[][]): string => [...rows.map((r) => [r[0], r[1], r[2], 0, r[3]].join(' ')), '0 0 0 1 0'].join(' ');
