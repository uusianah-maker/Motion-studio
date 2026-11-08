import { describe, expect, it } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import type { Timeline } from '../src/storage/timeline.js';
import { type Transcript, buildCues, cuesToSubtitleOps, listTranscripts, readTranscript, saveNewTranscript, updateCues, validateCues } from '../src/storage/transcript.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';

const w = (text: string, s: number, e: number) => ({ text, start_ms: s, end_ms: e });
const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe('W14 transcripts (core)', () => {
  it('buildCues: sentence ends, pauses and length limits split cues; times stay on word boundaries; never overlap', () => {
    const cues = buildCues([
      w('Halo', 200, 600),
      w('semua,', 600, 1100),
      w('ini', 1400, 1600),
      w('promo', 1600, 2000),
      w('spesial.', 2000, 2600),
      w('Diskon', 4000, 4400), // pause > 600 ms
      w('lima', 4400, 4700),
      w('puluh', 4700, 5000),
      w('persen', 5000, 5400),
      w('untuk', 5400, 5700),
      w('semua', 5700, 6000),
      w('produk', 6000, 6400),
      w('pilihan', 6400, 6800),
      w('kami', 6800, 7100),
      w('hari', 7100, 7300),
      w('ini', 7300, 7500),
    ]);
    expect(cues.map((c) => [c.text, c.start_ms, c.end_ms])).toEqual([
      ['Halo semua, ini promo spesial.', 200, 2600],
      ['Diskon lima puluh persen untuk semua', 4000, 6000],
      ['produk pilihan kami hari ini', 6000, 7500],
    ]);
    expect(cues.every((c) => /^cue_[0-9a-f]{16}$/.test(c.cue_id))).toBe(true);
    expect(buildCues([])).toEqual([]);
  });

  it('validateCues: sorted, inside the media, min length, no overlap, strict fields', async () => {
    const ok = validateCues(
      [
        { start_ms: 3000, end_ms: 4000, text: ' B ' },
        { start_ms: 0, end_ms: 1000, text: 'A' },
      ],
      8000,
    );
    expect(ok.map((c) => c.text)).toEqual(['A', 'B']);
    expect(await code(() => validateCues([{ start_ms: 0, end_ms: 1500, text: 'A' }, { start_ms: 1000, end_ms: 2000, text: 'B' }], 8000))).toBe('EDIT_INVALID'); // overlap
    expect(await code(() => validateCues([{ start_ms: 7000, end_ms: 9000, text: 'A' }], 8000))).toBe('EDIT_INVALID'); // past the media
    expect(await code(() => validateCues([{ start_ms: 1000, end_ms: 1100, text: 'A' }], 8000))).toBe('EDIT_INVALID'); // too short
    expect(await code(() => validateCues([{ start_ms: 0, end_ms: 1000, text: '   ' }], 8000))).toBe('EDIT_INVALID');
    expect(await code(() => validateCues([{ start_ms: 0, end_ms: 1000, text: 'A', style: 'x' }], 8000))).toBe('EDIT_INVALID');
    expect(await code(() => validateCues('semua', 8000))).toBe('EDIT_INVALID');
  });

  it('save / read / list / edit with revision check; per project', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'p1', name: 'P' });
    await createProject(fx.ws, { project_id: 'p2', name: 'Q' });
    const t = await saveNewTranscript(fx.ws, { project_id: 'p1', media_id: 'm_1', version_id: 'v_1', language: 'id', provider: 'openai', model: 'whisper-1', source_duration_ms: 8000, words: [w('Halo', 0, 500)], cues: buildCues([w('Halo', 0, 500)]) });
    expect(t).toMatchObject({ rev: 0, edited: false });
    expect((await listTranscripts(fx.ws, 'p1')).map((x) => x.transcript_id)).toEqual([t.transcript_id]);
    expect(await listTranscripts(fx.ws, 'p2')).toEqual([]);
    expect(await code(() => readTranscript(fx.ws, 'p2', t.transcript_id))).toBe('NOT_FOUND');
    expect(await code(() => readTranscript(fx.ws, 'p1', '../../x'))).toBe('NOT_FOUND');
    const e1 = await updateCues(fx.ws, 'p1', t.transcript_id, 0, [{ cue_id: t.cues[0]!.cue_id, start_ms: 0, end_ms: 900, text: 'Halo semua' }]);
    expect(e1).toMatchObject({ rev: 1, edited: true, cues: [{ cue_id: t.cues[0]!.cue_id, text: 'Halo semua', end_ms: 900 }] });
    expect(await code(() => updateCues(fx.ws, 'p1', t.transcript_id, 0, []))).toBe('CONFLICT'); // stale tab
    expect((await readTranscript(fx.ws, 'p1', t.transcript_id)).cues[0]!.text).toBe('Halo semua');
  });

  it('cuesToSubtitleOps: maps through each clip in-point, clips cues to the visible part, skips clashes', async () => {
    const t = { version_id: 'v_1', cues: [
      { cue_id: 'cue_a', start_ms: 0, end_ms: 1000, text: 'satu' },
      { cue_id: 'cue_b', start_ms: 2000, end_ms: 3500, text: 'dua' },
      { cue_id: 'cue_c', start_ms: 6000, end_ms: 7000, text: 'tiga' },
    ] } as unknown as Transcript;
    const tl: Timeline = {
      tracks: [
        { track_id: 'video', kind: 'video', clips: [{ clip_id: 'c1', start_ms: 10_000, end_ms: 13_000, in_ms: 1000, media: { media_id: 'm_1', version_id: 'v_1' } }] },
        { track_id: 'subtitle', kind: 'subtitle', clips: [{ clip_id: 's1', start_ms: 12_500, end_ms: 13_000, text: 'lama' }] },
      ],
    };
    const r = cuesToSubtitleOps(t, tl);
    // Source window 1000–4000 → timeline 10 000–13 000. "satu" (0–1000) falls before it; "dua" maps to 11 000–12 500; "tiga" after it.
    expect(r.ops).toEqual([{ op: 'add_clip', track_kind: 'subtitle', text: 'dua', start_ms: 11_000, duration_ms: 1500 }]);
    expect(r.warnings).toEqual([]);
    const clash: Timeline = { tracks: [tl.tracks[0]!, { track_id: 'subtitle', kind: 'subtitle', clips: [{ clip_id: 's1', start_ms: 11_200, end_ms: 11_600, text: 'lama' }] }] };
    expect(await code(() => cuesToSubtitleOps(t, clash))).toBe('EDIT_INVALID');
    expect(await code(() => cuesToSubtitleOps({ ...t, version_id: 'v_other' } as Transcript, tl))).toBe('EDIT_INVALID');
  });
});
