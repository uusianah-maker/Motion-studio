// Uji ops.json mesin dengan validator ASLI Motion Studio (validateOps + applyOps), hanya baca.
//
// Pakai:
//   node pipeline/validasi_ops.mjs out/a3/ops.json [--sumber-ms 27520]
// Lokasi build Motion Studio: env MOTION_STUDIO_CORE (default D:/VIBECODING/Video motion/packages/core/dist).
// Placeholder media diganti MediaRef palsu; panjang sumber dipakai untuk cek "klip melebihi sumber".
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const core = process.env.MOTION_STUDIO_CORE || 'D:/VIBECODING/Video motion/packages/core/dist';
const { validateOps, applyOps, MAX_SERVER_OPS } = await import(pathToFileURL(`${core}/storage/timeline.js`).href);

const [file, ...rest] = process.argv.slice(2);
const sumberMs = rest[0] === '--sumber-ms' ? Number(rest[1]) : undefined;
const doc = JSON.parse(readFileSync(file, 'utf8'));
const refs = new Map();
const refOf = (ph) => {
  if (!refs.has(ph)) {
    const n = refs.size + 1;
    refs.set(ph, { media_id: `m${String(n).padStart(4, '0')}placeholder`, version_id: `v${String(n).padStart(4, '0')}placeholder` });
  }
  return refs.get(ph);
};
const declared = new Set(['$sumber', ...(doc.aset_lokal || []).map((a) => a.kunci)]);
const raw = doc.ops.map((o) => {
  if (typeof o.media === 'string') {
    if (!declared.has(o.media) && !o.media.startsWith('$sumber')) throw new Error(`placeholder tidak dideklarasikan: ${o.media}`);
    return { ...o, media: refOf(o.media) };
  }
  return o;
});
const ops = validateOps(raw, MAX_SERVER_OPS);
let n = 0;
const sumberRef = refs.get('$sumber');
const durasi = (ref) => (sumberRef && ref.media_id === sumberRef.media_id ? sumberMs : undefined);
const t = applyOps({ tracks: [] }, ops, () => `c${String(++n).padStart(6, '0')}`, durasi);
const ringkas = Object.fromEntries(t.tracks.map((tr) => [tr.kind, tr.clips.length]));
const akhir = Math.max(...t.tracks.flatMap((tr) => tr.clips.map((c) => c.end_ms)));
console.log(JSON.stringify({ ok: true, ops: ops.length, track: ringkas, durasi_ms: akhir, kanvas: t.canvas, logo: t.brand_logo }));
