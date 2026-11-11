import { describe, expect, it } from 'vitest';
import { checkPlan, planLocal } from '../src/storage/copilot.js';
import { TEXT_PRESETS, presetById } from '../src/storage/textPresets.js';
import { validateStyle } from '../src/storage/textStyle.js';
import { type Timeline, applyOps } from '../src/storage/timeline.js';

let n = 0;
const ids = () => `c_${++n}`;
const base: Timeline = applyOps(
  { tracks: [] },
  [
    { op: 'add_clip', track_kind: 'video', media: { media_id: 'm_1', version_id: 'v_1' }, start_ms: 0, duration_ms: 10_000 },
    { op: 'add_clip', track_kind: 'text', text: 'Promo', start_ms: 4000, duration_ms: 2000 },
  ],
  ids,
);
const textId = base.tracks.find((t) => t.kind === 'text')!.clips[0]!.clip_id;
const videoId = base.tracks.find((t) => t.kind === 'video')!.clips[0]!.clip_id;
const sel = { timeline: base, selected_clip_ids: [textId] };
const run = (prompt: string, ctx: Parameters<typeof planLocal>[1] = sel) => {
  const r = planLocal(prompt, ctx);
  if (!r.ok) throw new Error(r.message);
  return r.ops;
};
const msg = (prompt: string, ctx: Parameters<typeof planLocal>[1] = sel) => {
  const r = planLocal(prompt, ctx);
  return r.ok ? 'OK' : r.message;
};

describe('X03 text presets + Copilot style words', () => {
  it('the preset table is valid and covers Hook / USP / CTA / Sale / Subtitle', () => {
    expect(TEXT_PRESETS.map((p) => p.id)).toEqual(['hook', 'usp', 'cta', 'sale', 'subtitle']);
    for (const p of TEXT_PRESETS) {
      expect(validateStyle(p.style)).toEqual(p.style);
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it('new text kinds pick their preset look: sale, USP, CTA; tone and colour words tweak it', () => {
    expect(run('sale "DISKON 70%" detik 1-3', { timeline: base })).toEqual([{ op: 'add_clip', track_kind: 'text', text: 'DISKON 70%', style: presetById('sale')!.style, start_ms: 1000, duration_ms: 2000 }]);
    expect(run('usp "Bahan adem" detik 7-9', { timeline: base })[0]).toMatchObject({ style: presetById('usp')!.style });
    expect(run('CTA "Join live" di akhir', { timeline: base })[0]).toMatchObject({ style: { bg: '#ffd23f' }, start_ms: 7000 });
    // PRD workflow A wording: "hook … tone minimalis".
    expect(run('hook "Effortless ke kantor" 2 detik tone minimalis', { timeline: base })[0]).toMatchObject({ style: { ...presetById('hook')!.style, bold: false, outline: false, bg: null } });
    expect(run('tambah teks "Halo" detik 7-9 warna kuning', { timeline: base })[0]).toMatchObject({ style: { color: '#ffd23f' } });
  });

  it('style commands on the selected text: colour, box, no box, preset, position, size', () => {
    expect(run('warna teks merah')).toEqual([{ op: 'set_style', clip_id: textId, style: { color: '#e53935' } }]);
    expect(run('ubah warna jadi #00ff00')).toEqual([{ op: 'set_style', clip_id: textId, style: { color: '#00ff00' } }]);
    expect(run('kotak kuning')).toEqual([{ op: 'set_style', clip_id: textId, style: { bg: '#ffd23f', bg_opacity: 1 } }]);
    expect(run('tanpa kotak')).toEqual([{ op: 'set_style', clip_id: textId, style: { bg: null } }]);
    expect(run('pakai preset cta')).toEqual([{ op: 'set_style', clip_id: textId, style: presetById('cta')!.style }]);
    expect(run('posisi teks bawah, lebih besar')).toEqual([{ op: 'set_style', clip_id: textId, style: { y: 0.75, size: 7.8 } }]);
    expect(run('gaya elegan')[0]).toMatchObject({ op: 'set_style', style: { color: '#f5e6c8', bold: false } });
  });

  it('refuses clearly: no selection, a video clip, unknown colour', () => {
    expect(msg('warna teks merah', { timeline: base })).toMatch(/Pilih satu klip/);
    expect(msg('warna teks merah', { timeline: base, selected_clip_ids: [videoId] })).toMatch(/bukan klip teks/);
    expect(msg('warna teks magentaungu')).toMatch(/Gaya apa yang mau diubah/);
  });

  it('plans show what a style change does (labels + diff)', () => {
    const r = checkPlan(base, run('warna teks merah; kotak kuning'));
    expect(r.labels).toEqual(['Ubah gaya klip teks “Promo” (0:04–0:06): warna #e53935', 'Ubah gaya klip teks “Promo” (0:04–0:06): kotak #ffd23f']);
    expect(r.diff.map((d) => d.summary)).toEqual(['~ teks: “Promo” gaya: warna #e53935, kotak #ffd23f']);
  });
});
