import { describe, expect, it } from 'vitest';
import { validateBrandInput } from '../src/storage/brand.js';
import { isStorageError } from '../src/storage/errors.js';
import { validateTtsJob } from '../src/storage/tts.js';
import { applyOps, validateOps } from '../src/storage/timeline.js';
import { splitKalimat, voSubtitleOps } from '../src/storage/voText.js';

/** R34 "Suara dari Teks": sentences, job validation, Brand Kit pronunciation, subtitles from a VO. */
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? `${e.code}:${e.message}` : `RAW:${String(e)}`;
  }
};

describe('R34 core', () => {
  it('splits a paragraph into sentences', () => {
    expect(splitKalimat('Halo kak!  Ini Loose Pants. Harganya 99 ribu?\n\nCek keranjang')).toEqual(['Halo kak!', 'Ini Loose Pants.', 'Harganya 99 ribu?', 'Cek keranjang']);
    expect(splitKalimat('Rp 99.000 saja')).toEqual(['Rp 99.000 saja']); // a dot inside a number is not an end
  });
  it('validates the job (limits from contract §21)', () => {
    expect(validateTtsJob({ project_id: 'p', mode: 'tts', tts: { teks: 'Satu. Dua.' } }).tts).toEqual({ kalimat: ['Satu.', 'Dua.'], suara: 'windows:Andika', kecepatan: 1, jeda_ms: 300 });
    for (const bad of [
      { project_id: 'p', mode: 'tts', tts: {} },
      { project_id: 'p', mode: 'tts', tts: { teks: '   ' } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', kecepatan: 0.2 } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', jeda_ms: 5000 } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', suara: '../x' } },
      { project_id: 'p', mode: 'tts', tts: { kalimat: Array.from({ length: 61 }, () => 'a') } },
      { project_id: 'p', mode: 'tts', tts: { kalimat: ['x'.repeat(1001)] } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', lain: 1 } },
    ]) expect(code(() => validateTtsJob(bad)), JSON.stringify(bad).slice(0, 80)).toMatch(/^EDIT_INVALID/);
  });
  it('§28 reader, speaking style and Ubah suara', () => {
    const ref = { media_id: 'm1', version_id: 'v1' };
    expect(validateTtsJob({ project_id: 'p', mode: 'tts', tts: { teks: 'Halo.', suara: 'grace:Suara Grace', model: 'chatterbox', gaya: 'jualan' } }).tts).toEqual({ kalimat: ['Halo.'], suara: 'grace:Suara Grace', kecepatan: 1, jeda_ms: 300, model: 'chatterbox', gaya: 'jualan', perkuat_warna: true });
    expect(validateTtsJob({ project_id: 'p', mode: 'tts', tts: { teks: 'Halo.', suara: 'owner:x', model: 'zonos', perkuat_warna: false } }).tts).toMatchObject({ model: 'zonos', gaya: 'natural', perkuat_warna: false });
    expect(validateTtsJob({ project_id: 'p', mode: 'tts', tts: { teks: 'Halo.', model: 'andika', gaya: 'heboh' } }).tts).toEqual({ kalimat: ['Halo.'], suara: 'windows:Andika', kecepatan: 1, jeda_ms: 300 });
    const u = validateTtsJob({ project_id: 'p', mode: 'tts', sources: [{ kunci: '$sumber', ref }], tts: { audio: '$sumber', suara: 'niar:Suara Niar', kecepatan: 1.2 } });
    expect(u.sources).toEqual([{ kunci: '$sumber', ref }]);
    expect(u.tts).toEqual({ kalimat: [], suara: 'niar:Suara Niar', kecepatan: 1.2, jeda_ms: 0, audio: '$sumber' });
    for (const bad of [
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', model: 'chatterbox' } }, // Windows voice
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', suara: 'grace:x', model: 'elevenlabs' } },
      { project_id: 'p', mode: 'tts', tts: { kalimat: Array.from({ length: 26 }, () => 'a.'), suara: 'grace:x', model: 'zonos' } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', suara: 'grace:x', model: 'zonos', gaya: 'marah' } },
      { project_id: 'p', mode: 'tts', tts: { teks: 'a', suara: 'grace:x', model: 'zonos', perkuat_warna: 'ya' } },
      { project_id: 'p', mode: 'tts', sources: [{ kunci: '$sumber', ref }], tts: { teks: 'a' } }, // sources only for Ubah suara
      { project_id: 'p', mode: 'tts', sources: [{ kunci: '$sumber', ref }], tts: { audio: '$sumber' } }, // Windows voice
      { project_id: 'p', mode: 'tts', sources: [], tts: { audio: '$sumber', suara: 'grace:x' } },
      { project_id: 'p', mode: 'tts', sources: [{ kunci: '$sumber', ref: { media_id: '../x', version_id: 'v' } }], tts: { audio: '$sumber', suara: 'grace:x' } },
      { project_id: 'p', mode: 'tts', sources: [{ kunci: '$sumber', ref }], tts: { audio: 'C:/x.wav', suara: 'grace:x' } },
    ]) expect(code(() => validateTtsJob(bad)), JSON.stringify(bad).slice(0, 100)).toMatch(/^EDIT_INVALID/);
  });
  it('Brand Kit pelafalan + asset kind vo are valid', () => {
    const k = validateBrandInput({ name: 'A', pelafalan: [{ tulisan: 'Aysilla', ucapan: 'Ay-si-la' }] });
    expect(k.pelafalan).toEqual([{ tulisan: 'Aysilla', ucapan: 'Ay-si-la' }]);
    expect(code(() => validateBrandInput({ name: 'A', pelafalan: [{ tulisan: '', ucapan: 'x' }] }))).toMatch(/^EDIT_INVALID/);
    expect(validateBrandInput({ name: 'A' }).pelafalan).toEqual([]);
  });
  it('subtitles from a VO: one clip per sentence with its words, cut to the clip', () => {
    const vo = { schema: 'vo-index/1' as const, job_id: 'AYS-20261116-001', teks: 'Halo kak. Cek sekarang.', kalimat: [
      { teks: 'Halo kak.', mulai: 0, akhir: 0.6, kata: [{ teks: 'Halo', mulai: 0, akhir: 0.3 }, { teks: 'kak.', mulai: 0.3, akhir: 0.6 }] },
      { teks: 'Cek sekarang.', mulai: 0.9, akhir: 1.5, kata: [{ teks: 'Cek', mulai: 0, akhir: 0.3 }, { teks: 'sekarang.', mulai: 0.3, akhir: 0.6 }] },
    ] };
    const ops = voSubtitleOps(vo, 2000);
    expect(ops.map((o) => [(o as { start_ms: number }).start_ms, (o as { duration_ms: number }).duration_ms])).toEqual([[2000, 600], [2900, 600]]);
    const t = applyOps({ tracks: [] }, validateOps(ops), () => `c_${Math.random()}`);
    expect(t.tracks[0]!.clips.map((c) => c.text)).toEqual(['Halo kak.', 'Cek sekarang.']);
    expect(t.tracks[0]!.clips[1]!.words).toEqual([{ text: 'Cek', start_ms: 0, end_ms: 300 }, { text: 'sekarang.', start_ms: 300, end_ms: 600 }]);
    // A clip that starts 0.9 s into the VO only gets the second sentence.
    expect(voSubtitleOps(vo, 0, 900, 600)).toHaveLength(1);
  });
});
