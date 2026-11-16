/**
 * R30 (owner 16 Nov: "subtitle masih banyak typo, celana jadi cana"): a word the editor corrects in
 * an engine subtitle becomes a Whisper fix for the brand's NEXT videos, without anyone filling the
 * Brand Kit dictionary by hand. Pure module.
 *
 * Source: `belajar.jsonl` notes `{jenis: 'koreksi', bagian: 'kata', track: 'subtitle', sebelum, sesudah}`
 * (PC-R6). Each correction is aligned word by word; the changed run becomes a pair
 * `salah → benar` ("cana" → "celana", "icy love" → "Aysilla").
 *
 * A pair is applied automatically (`otomatis`) when it is safe:
 *  - corrected at least twice, or
 *  - the right side is the brand's own word (brand name, Brand Kit vocabulary / keywords), or
 *  - the wrong word sounds like a clipped form of the right one (letters in the same order,
 *    "cana" ⊂ "celana") — a typical Whisper mishearing, not a different word.
 * Other pairs ("janganlah" → "Join Live": a real word, fixed once) are only suggestions (`usulan`).
 * The Brand Kit dictionary always wins: a pair the team wrote is never overridden.
 */

export interface PasanganKamus {
  salah: string;
  benar: string;
  kali: number;
  otomatis: boolean;
  terakhir: number;
}

const MAX_KATA = 3;
const MIN_HURUF = 3;

const bersih = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const kata = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Longest-common-subsequence alignment of two word lists (normalised). */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Word substitutions between two versions of one subtitle (case / punctuation changes ignored). */
export function pasanganDari(sebelum: string, sesudah: string): { salah: string; benar: string }[] {
  const ra = kata(sebelum);
  const rb = kata(sesudah);
  const a = ra.map(bersih);
  const b = rb.map(bersih);
  const out: { salah: string; benar: string }[] = [];
  const anchors = [...lcs(a, b), [a.length, b.length] as [number, number]];
  let pi = 0;
  let pj = 0;
  for (const [i, j] of anchors) {
    const sa = a.slice(pi, i).filter(Boolean);
    const sb = rb.slice(pj, j).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
    // Only a replacement (both sides), short, and a real change of letters.
    if (sa.length && sb.length && sa.length <= MAX_KATA && sb.length <= MAX_KATA) {
      const salah = sa.join(' ');
      const benar = sb.join(' ');
      if (salah.replace(/\s/g, '').length >= MIN_HURUF && salah !== benar.toLowerCase()) out.push({ salah, benar });
    }
    pi = i + 1;
    pj = j + 1;
  }
  return out;
}

/** "cana" is "celana" with letters dropped (same order, same first letter). */
export function mirip(salah: string, benar: string): boolean {
  const s = salah.toLowerCase().replace(/\s/g, '');
  const b = benar.toLowerCase().replace(/\s/g, '');
  if (!s || !b || s[0] !== b[0] || s.length > b.length) return false;
  let k = 0;
  for (const ch of b) if (ch === s[k]) k++;
  return k === s.length && s.length >= b.length * 0.6;
}

/**
 * All pairs learned from a brand's notes. `kataBrand` = brand name + vocabulary + keywords;
 * `kamusTim` = the Brand Kit dictionary (its wrong words are skipped: the team already decided).
 */
export function kamusBelajar(notes: readonly Record<string, unknown>[], kataBrand: readonly string[], kamusTim: readonly { salah: string }[] = []): PasanganKamus[] {
  const tim = new Set(kamusTim.map((k) => k.salah.toLowerCase().trim()));
  const brand = kataBrand.map((w) => w.toLowerCase().trim()).filter(Boolean);
  const per = new Map<string, Map<string, { kali: number; terakhir: number }>>();
  for (const n of notes) {
    if (n.jenis !== 'koreksi' || n.bagian !== 'kata' || n.track !== 'subtitle') continue;
    if (typeof n.sebelum !== 'string' || typeof n.sesudah !== 'string') continue;
    const at = typeof n.at === 'number' ? n.at : 0;
    for (const p of pasanganDari(n.sebelum, n.sesudah)) {
      if (tim.has(p.salah)) continue;
      const m = per.get(p.salah) ?? new Map<string, { kali: number; terakhir: number }>();
      const cur = m.get(p.benar) ?? { kali: 0, terakhir: 0 };
      m.set(p.benar, { kali: cur.kali + 1, terakhir: Math.max(cur.terakhir, at) });
      per.set(p.salah, m);
    }
  }
  const out: PasanganKamus[] = [];
  for (const [salah, m] of per) {
    // One wrong phrase, several fixes: the most frequent (then newest) wins.
    const [benar, v] = [...m.entries()].sort((x, y) => y[1].kali - x[1].kali || y[1].terakhir - x[1].terakhir)[0]!;
    const b = benar.toLowerCase();
    const milikBrand = brand.some((w) => w === b || w.includes(b) || b.includes(w));
    out.push({ salah, benar, kali: v.kali, terakhir: v.terakhir, otomatis: v.kali >= 2 || milikBrand || mirip(salah, benar) });
  }
  return out.sort((x, y) => y.kali - x.kali || y.terakhir - x.terakhir);
}
