import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { validateProjectManifest } from '../src/storage/project.js';
import { type Timeline, applyOps, editManifest, stepHistory, validateOps } from '../src/storage/timeline.js';

/** R33 (owner 16 Nov): several clips at once — delete / move / restyle together, duplicate — one undo each. */
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? `${e.code}:${e.message}` : `RAW:${String(e)}`;
  }
};
let n = 0;
const ids = () => `c_${++n}`;
const BASE = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 1, updated_at: 1, snapshots: [] };
const subs = (t: Timeline) => t.tracks.find((x) => x.kind === 'subtitle')!.clips;
const make = () =>
  applyOps({ tracks: [] }, validateOps([
    { op: 'add_clip', track_kind: 'subtitle', text: 'satu', start_ms: 0, duration_ms: 1000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'dua', start_ms: 1000, duration_ms: 1000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'tiga', start_ms: 2000, duration_ms: 1000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'empat', start_ms: 5000, duration_ms: 1000 },
    { op: 'add_clip', track_kind: 'video', media: { media_id: 'm', version_id: 'v' }, start_ms: 0, duration_ms: 6000 },
  ]), ids);

describe('R33 multi-select ops', () => {
  it('validates ids and values', () => {
    for (const bad of [
      { op: 'delete_clips', clip_ids: [] },
      { op: 'delete_clips', clip_ids: ['../x'] },
      { op: 'shift_clips', clip_ids: ['a'] },
      { op: 'set_style_many', clip_ids: ['a'], style: {} },
      { op: 'set_style_many', clip_ids: ['a'], style: { size: 99 } },
      { op: 'duplicate_clip' },
    ]) expect(code(() => validateOps([bad])), JSON.stringify(bad)).toMatch(/^EDIT_INVALID/);
    expect((validateOps([{ op: 'delete_clips', clip_ids: ['a', 'a', 'b'] }])[0] as { clip_ids: string[] }).clip_ids).toEqual(['a', 'b']);
  });

  it('delete / shift / restyle several clips; refusals leave everything as it was', () => {
    const t = make();
    const [a, b, c, d] = subs(t).map((x) => x.clip_id);
    expect(subs(applyOps(t, validateOps([{ op: 'delete_clips', clip_ids: [a!, c!] }]), ids)).map((x) => x.text)).toEqual(['dua', 'empat']);
    expect(subs(applyOps(t, validateOps([{ op: 'shift_clips', clip_ids: [c!, d!], delta_ms: 1500 }]), ids)).map((x) => x.start_ms)).toEqual([0, 1000, 3500, 6500]);
    expect(code(() => applyOps(t, validateOps([{ op: 'shift_clips', clip_ids: [a!, b!], delta_ms: -500 }]), ids))).toMatch(/sebelum detik 0/);
    expect(code(() => applyOps(t, validateOps([{ op: 'shift_clips', clip_ids: [b!], delta_ms: 500 }]), ids))).toMatch(/tumpang tindih/);
    expect(code(() => applyOps(t, validateOps([{ op: 'delete_clips', clip_ids: [a!, 'c_tidak_ada'] }]), ids))).toMatch(/Klip tidak ditemukan/);
    const s = applyOps(t, validateOps([{ op: 'set_style_many', clip_ids: [a!, b!, c!], style: { size: 9, y: 0.7, color: '#ffcc00' } }]), ids);
    expect(subs(s).map((x) => x.style?.size ?? null)).toEqual([9, 9, 9, null]);
    const vid = t.tracks.find((x) => x.kind === 'video')!.clips[0]!.clip_id;
    expect(code(() => applyOps(t, validateOps([{ op: 'set_style_many', clip_ids: [a!, vid], style: { size: 9 } }]), ids))).toMatch(/hanya untuk klip teks/);
  });

  it('duplicate: right after the clip, or after the lane when taken; a deep copy', () => {
    const t0 = make();
    const t = applyOps(t0, validateOps([{ op: 'set_style_many', clip_ids: [subs(t0)[0]!.clip_id], style: { bold: true } }]), ids);
    const [a, , , d] = subs(t);
    const t1 = applyOps(t, validateOps([{ op: 'duplicate_clip', clip_id: d!.clip_id }]), ids);
    expect(subs(t1).map((x) => [x.text, x.start_ms])).toContainEqual(['empat', 6000]);
    const t2 = applyOps(t, validateOps([{ op: 'duplicate_clip', clip_id: a!.clip_id }]), ids); // 1000 is taken → after the lane (6000)
    const copy = subs(t2).find((x) => x.text === 'satu' && x.clip_id !== a!.clip_id)!;
    expect([copy.start_ms, copy.end_ms, copy.style?.bold]).toEqual([6000, 7000, true]);
    copy.style!.bold = false;
    expect(subs(t2).find((x) => x.clip_id === a!.clip_id)!.style?.bold).toBe(true);
  });

  it('one edit = one undo step', () => {
    const t = make();
    const m0 = validateProjectManifest({ ...BASE, timeline: t });
    const ctx = { now: 1, newId: () => `s_${++n}`, newClipId: ids };
    const all = subs(t).map((x) => x.clip_id);
    const m1 = editManifest(m0, validateOps([{ op: 'delete_clips', clip_ids: all }]), 'Hapus beberapa klip', ctx);
    expect(m1.timeline.tracks.find((x) => x.kind === 'subtitle')!.clips).toEqual([]);
    expect(subs(stepHistory(m1, 'undo', ctx).timeline).length).toBe(4);
  });
});
