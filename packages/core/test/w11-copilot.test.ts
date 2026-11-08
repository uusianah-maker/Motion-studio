import { describe, expect, it } from 'vitest';
import { checkPlan, diffTimelines, parseTime, pickOps, planLocal } from '../src/storage/copilot.js';
import { isStorageError } from '../src/storage/errors.js';
import { type Timeline, applyOps } from '../src/storage/timeline.js';

const M = { media_id: 'm_1', version_id: 'v_1' };
let n = 0;
const ids = () => `c_${++n}`;
const base: Timeline = applyOps(
  { tracks: [] },
  [
    { op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 10_000 },
    { op: 'add_clip', track_kind: 'text', text: 'Lama', start_ms: 4000, duration_ms: 2000 },
  ],
  ids,
);
const video = base.tracks.find((t) => t.kind === 'video')!.clips[0]!;
const oldText = base.tracks.find((t) => t.kind === 'text')!.clips[0]!;
const ok = (r: ReturnType<typeof planLocal>) => {
  if (!r.ok) throw new Error(r.message);
  return r;
};
const msg = (r: ReturnType<typeof planLocal>) => (r.ok ? 'OK' : r.message);

describe('W11 local planner (zero LLM)', () => {
  it('times: seconds, decimals with comma, m:ss', () => {
    expect(parseTime('3')).toBe(3000);
    expect(parseTime('2,5')).toBe(2500);
    expect(parseTime('1:05.5')).toBe(65_500);
  });

  it('hook / text / subtitle / CTA with quoted text and time ranges', () => {
    expect(ok(planLocal('hook "Diskon 50% hari ini!" 2 detik', { timeline: base })).ops).toEqual([{ op: 'add_clip', track_kind: 'text', text: 'Diskon 50% hari ini!', start_ms: 0, duration_ms: 2000 }]);
    expect(ok(planLocal('tambah teks "Cek keranjang kuning" detik 6-9', { timeline: base })).ops[0]).toMatchObject({ track_kind: 'text', start_ms: 6000, duration_ms: 3000 });
    expect(ok(planLocal('subtitle "Halo semua" 0:01-0:04', { timeline: base })).ops[0]).toMatchObject({ track_kind: 'subtitle', text: 'Halo semua', start_ms: 1000, duration_ms: 3000 });
    // CTA lands on the last 3 s of the timeline; numbers inside the quote are not times.
    expect(ok(planLocal('CTA "Join live jam 7" di akhir', { timeline: base })).ops[0]).toMatchObject({ track_kind: 'text', text: 'Join live jam 7', start_ms: 7000, duration_ms: 3000 });
    // English, curly quotes.
    expect(ok(planLocal('add text “Limited stock” from 7s to 9s', { timeline: base })).ops[0]).toMatchObject({ start_ms: 7000, duration_ms: 2000 });
    // No time: playhead, with a warning.
    const r = ok(planLocal('tambah teks "Di playhead"', { timeline: base, playhead_ms: 7000 }));
    expect(r.ops[0]).toMatchObject({ start_ms: 7000, duration_ms: 3000 });
    expect(r.warnings[0]).toMatch(/playhead/);
  });

  it('several commands in one prompt are planned in order against the evolving timeline', () => {
    const r = ok(planLocal('hook "A" 2 detik lalu ubah rasio ke 1:1; subtitle "B" detik 2-4', { timeline: base }));
    expect(r.ops.map((o) => o.op)).toEqual(['add_clip', 'set_canvas', 'add_clip']);
    expect(r.ops[1]).toEqual({ op: 'set_canvas', ratio: '1:1' });
  });

  it('selection commands: delete, move, replace text, duration, split', () => {
    const sel = { timeline: base, selected_clip_ids: [oldText.clip_id] };
    expect(ok(planLocal('hapus klip terpilih', sel)).ops).toEqual([{ op: 'delete_clip', clip_id: oldText.clip_id }]);
    expect(ok(planLocal('geser klip terpilih ke detik 7', sel)).ops).toEqual([{ op: 'move_clip', clip_id: oldText.clip_id, start_ms: 7000 }]);
    expect(ok(planLocal('ganti teks jadi "Promo terbatas"', sel)).ops).toEqual([{ op: 'set_text', clip_id: oldText.clip_id, text: 'Promo terbatas' }]);
    expect(ok(planLocal('durasi klip terpilih 4 detik', sel)).ops).toEqual([{ op: 'trim_clip', clip_id: oldText.clip_id, edge: 'end', to_ms: 8000 }]);
    // Split without selection: the clip under that time on the video track.
    expect(ok(planLocal('potong di detik 3', { timeline: base })).ops).toEqual([{ op: 'split_clip', clip_id: video.clip_id, at_ms: 3000 }]);
    expect(ok(planLocal('split here', { timeline: base, playhead_ms: 2500 })).ops[0]).toMatchObject({ at_ms: 2500 });
    expect(ok(planLocal('hapus semua teks', { timeline: base })).warnings[0]).toMatch(/1 klip teks/);
  });

  it('refuses instead of guessing: unknown, clash, no selection, wrong kind, empty timeline', () => {
    expect(msg(planLocal('bikin video viral', { timeline: base }))).toMatch(/belum dikenali/);
    expect(msg(planLocal('tambah teks "X" detik 5-7', { timeline: base }))).toMatch(/Bentrok dengan teks .* 0:04–0:06/);
    expect(msg(planLocal('hapus klip terpilih', { timeline: base }))).toMatch(/Pilih satu klip/);
    expect(msg(planLocal('ganti teks jadi "Y"', { timeline: base, selected_clip_ids: [video.clip_id] }))).toMatch(/bukan klip teks/);
    expect(msg(planLocal('CTA "Z" di akhir', { timeline: { tracks: [] } }))).toMatch(/kosong/);
    expect(msg(planLocal('ubah rasio ke 21:9', { timeline: base }))).toMatch(/Rasio tidak dikenali/);
    expect(msg(planLocal('potong di detik 30', { timeline: base }))).toMatch(/Tidak ada klip/);
    expect(msg(planLocal('hapus semua subtitle', { timeline: base }))).toMatch(/Tidak ada klip subtitle/);
    expect(msg(planLocal('   ', { timeline: base }))).toMatch(/kosong/);
    // One bad command fails the whole prompt (no half plans).
    expect(msg(planLocal('hook "A" 2 detik; terbangkan drone', { timeline: base }))).toMatch(/terbangkan drone/);
  });

  it('checkPlan validates untrusted ops as a whole, labels them and builds the diff', () => {
    const r = checkPlan(base, [
      { op: 'add_clip', track_kind: 'text', text: 'Baru', start_ms: 0, duration_ms: 2000 },
      { op: 'set_text', clip_id: oldText.clip_id, text: 'Ganti' },
      { op: 'split_clip', clip_id: video.clip_id, at_ms: 5000 },
      { op: 'set_canvas', ratio: '16:9' },
    ]);
    expect(r.labels).toEqual(['Tambah teks “Baru” di 0:00–0:02', 'Ubah teks klip teks “Lama” (0:04–0:06) → “Ganti”', 'Potong klip video (0:00–0:10) di 0:05', 'Ubah rasio ke 16:9']);
    expect(r.diff.map((d) => d.summary)).toEqual(['~ video: 0:00–0:10 → 0:00–0:05', '~ teks: “Lama” → “Ganti”', '+ video 0:05–0:10', '+ teks “Baru” 0:00–0:02', 'Rasio 9:16 → 16:9']);
    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'OK';
      } catch (e) {
        return isStorageError(e) ? e.code : String(e);
      }
    };
    expect(code(() => checkPlan(base, [{ op: 'add_clip', track_kind: 'text', text: 'X', start_ms: 4500, duration_ms: 1000 }]))).toBe('EDIT_INVALID'); // overlap
    expect(code(() => checkPlan(base, [{ op: 'delete_clip', clip_id: 'c_nope' }]))).toBe('EDIT_INVALID');
    expect(code(() => checkPlan(base, [{ op: 'rm_rf', path: '/' }]))).toBe('EDIT_INVALID');
    expect(code(() => checkPlan(base, [{ op: 'add_clip', track_kind: 'video', media: M, start_ms: 0, duration_ms: 1000, actor: 'user' }]))).toBe('EDIT_INVALID');
    expect(code(() => checkPlan(base, Array.from({ length: 61 }, () => ({ op: 'set_canvas', ratio: '1:1' }))))).toBe('EDIT_INVALID');
    // Source length enforced through the same probe callback as manual edits.
    expect(code(() => checkPlan(base, [{ op: 'trim_clip', clip_id: video.clip_id, edge: 'end', to_ms: 12_000 }], () => 10_000))).toBe('EDIT_INVALID');
  });

  it('pickOps: approve a subset; bad selections refused', () => {
    const ops = ok(planLocal('hook "A" 2 detik; subtitle "B" detik 2-4; ubah rasio ke 1:1', { timeline: base })).ops;
    expect(pickOps(ops, [2, 0]).map((o) => o.op)).toEqual(['add_clip', 'set_canvas']);
    expect(pickOps(ops, undefined)).toBe(ops);
    for (const bad of [[], [3], [0, 0], [-1], ['0'], 'all']) expect(() => pickOps(ops, bad)).toThrow();
  });

  it('diff of identical timelines is empty', () => {
    expect(diffTimelines(base, base)).toEqual([]);
  });
});
