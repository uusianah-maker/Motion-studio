import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAss } from '../src/storage/ass.js';
import { isStorageError } from '../src/storage/errors.js';
import { DEFAULT_RENDER, buildRenderPlan, listOutputs, renderProject } from '../src/storage/render.js';
import { StorageService } from '../src/storage/service.js';
import { validateStyle } from '../src/storage/textStyle.js';
import { type Timeline, applyOps, validateOps } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { cutWords, sliceWords, validateWords } from '../src/storage/words.js';
import { cuesToSubtitleOps } from '../src/storage/transcript.js';
import { fixtureWorkspace } from './fixtures.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
let n = 0;
const ids = () => `c_${++n}`;
const W3 = [
  { text: 'Celana', start_ms: 0, end_ms: 400 },
  { text: 'anti', start_ms: 400, end_ms: 700 },
  { text: 'kusut!', start_ms: 700, end_ms: 1100 },
];

describe('U3b per-word captions (libass)', () => {
  it('words: validated (sorted, inside the clip, one token each); text = the words', () => {
    expect(validateWords(W3, 1200)).toEqual(W3);
    for (const bad of [[], [{ text: 'dua kata', start_ms: 0, end_ms: 100 }], [{ text: 'a', start_ms: 100, end_ms: 50 }], [W3[1], W3[0]], [{ text: 'a', start_ms: 0, end_ms: 2000 }], [{ text: 'a', start_ms: 0, end_ms: 10, x: 1 }]]) {
      expect(code(() => validateWords(bad, 1200)), JSON.stringify(bad)).toBe('EDIT_INVALID');
    }
    const t = applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'subtitle', text: 'apa saja', words: W3, style: { anim: 'pop', highlight: { words: ['anti', 'KUSUT'], color: '#e53935' } }, start_ms: 1000, duration_ms: 1200 }]), ids);
    const c = t.tracks[0]!.clips[0]!;
    expect(c.text).toBe('Celana anti kusut!');
    expect(c.style).toMatchObject({ anim: 'pop', highlight: { words: ['anti', 'KUSUT'], color: '#e53935', scale: 1.15, current: false } });
    expect(code(() => validateOps([{ op: 'add_clip', track_kind: 'subtitle', text: 'x', words: W3, start_ms: 0, duration_ms: 500 }]))).toBe('EDIT_INVALID'); // words past the clip
    expect(code(() => applyOps({ tracks: [] }, validateOps([{ op: 'add_clip', track_kind: 'video', media: { media_id: 'm_1', version_id: 'v_1' }, words: W3, start_ms: 0, duration_ms: 1200 }]), ids))).toBe('EDIT_INVALID');
    for (const bad of [{ anim: 'spin' }, { anim_ms: 5000 }, { highlight: { color: 'merah' } }, { highlight: { scale: 3 } }, { highlight: { words: 'anti' } }]) expect(code(() => validateStyle(bad)), JSON.stringify(bad)).toBe('EDIT_INVALID');
  });

  it('edits keep word timings in step: move, trim, split, cut, set_text', () => {
    const base = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'subtitle', text: 'x', words: W3, start_ms: 1000, duration_ms: 1200 }], ids);
    const id = base.tracks[0]!.clips[0]!.clip_id;
    const words = (t: Timeline) => t.tracks[0]!.clips.map((c) => [c.start_ms, c.text, (c.words ?? []).map((w) => `${w.text}@${w.start_ms}-${w.end_ms}`).join(' ')]);
    expect(words(applyOps(base, [{ op: 'move_clip', clip_id: id, start_ms: 3000 }], ids))).toEqual([[3000, 'Celana anti kusut!', 'Celana@0-400 anti@400-700 kusut!@700-1100']]);
    expect(words(applyOps(base, [{ op: 'trim_clip', clip_id: id, edge: 'start', to_ms: 1400 }], ids))).toEqual([[1400, 'anti kusut!', 'anti@0-300 kusut!@300-700']]);
    expect(words(applyOps(base, [{ op: 'trim_clip', clip_id: id, edge: 'end', to_ms: 1600 }], ids))).toEqual([[1000, 'Celana anti', 'Celana@0-400 anti@400-600']]);
    expect(words(applyOps(base, [{ op: 'split_clip', clip_id: id, at_ms: 1400 }], ids))).toEqual([
      [1000, 'Celana', 'Celana@0-400'],
      [1400, 'anti kusut!', 'anti@0-300 kusut!@300-700'],
    ]);
    // Cutting the middle word's audio (remove_range) drops it and pulls the rest left.
    expect(words(applyOps(base, [{ op: 'remove_range', from_ms: 1400, to_ms: 1700 }], ids))).toEqual([[1000, 'Celana kusut!', 'Celana@0-400 kusut!@400-800']]);
    expect(base.tracks[0]!.clips[0]!.words).toHaveLength(3); // input untouched (undo)
    const plain = applyOps(base, [{ op: 'set_text', clip_id: id, text: 'Teks baru' }], ids).tracks[0]!.clips[0]!;
    expect([plain.text, plain.words]).toEqual(['Teks baru', undefined]);
    expect(sliceWords(W3, 400, 1100).map((w) => w.text)).toEqual(['anti', 'kusut!']);
    expect(cutWords(W3, 300, 800).map((w) => `${w.text}@${w.start_ms}-${w.end_ms}`)).toEqual(['Celana@0-300', 'kusut!@300-600']);
  });

  it('ASS: one event per spoken word, unspoken words transparent, keyword colour + pop; titles without words stay drawtext', () => {
    const t: Timeline = {
      tracks: [
        { track_id: 'v', kind: 'video', clips: [{ clip_id: 'v', start_ms: 0, end_ms: 3000, media: { media_id: 'm_1', version_id: 'v_1' } }] },
        { track_id: 't', kind: 'text', clips: [{ clip_id: 'title', start_ms: 0, end_ms: 1000, text: 'Judul biasa' }] },
        { track_id: 's', kind: 'subtitle', clips: [{ clip_id: 'cap', start_ms: 1000, end_ms: 2200, text: 'Celana anti kusut!', words: W3, style: { anim: 'pop', anim_ms: 100, highlight: { words: ['anti'], color: '#e53935', scale: 1.3, current: false, box: false } } }] },
      ],
    };
    const ass = buildAss({ clips: [{ kind: 'subtitle', clip: t.tracks[2]!.clips[0]! }], width: 1080, height: 1920, ratio: '9:16', total_ms: 3000, fonts: { bold: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: true }, regular: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: false }, brand: null, caption: null } });
    const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(ev.map((l) => l.split(',').slice(1, 3).join('–'))).toEqual(['0:00:01.00–0:00:01.40', '0:00:01.40–0:00:01.70', '0:00:01.70–0:00:02.20']);
    expect(ev[0]).toMatch(/\\fscx70\\fscy70\\t\(0,100,\\fscx100\\fscy100\)\}Celana/); // first word pops in
    expect(ev[0]).toMatch(/\{\\1a&HFF&[^}]*\}anti/); // not yet spoken: invisible (layout stays)
    expect(ev[1]).toMatch(/\{\\1a&H00&\\c&H3539E5&\\fscx91\\fscy91\\t\(0,100,\\fscx130\\fscy130\)\}anti/); // keyword: red, bigger, popping
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toMatch(/\\fs(\d+(\.\d+)?)/);
    const probe = { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' };
    const plan = buildRenderPlan(t, new Map([['v_1', { path: 'C:/s.mp4', probe }]]), { ...DEFAULT_RENDER, short_side: 1080 }, 'C:/f/arialbd.ttf', 'C:/f/arial.ttf');
    expect(plan.graph.match(/drawtext=/g)?.length).toBe(1); // the plain title
    expect(plan.graph).toContain('ass=filename=captions.ass:fontsdir=.');
    expect(plan.files.map((f) => f.name)).toEqual(['t0.txt', 'captions.ass']);
    // Hostile text cannot open override blocks.
    const evil = buildAss({ clips: [{ kind: 'text', clip: { clip_id: 'e', start_ms: 0, end_ms: 1000, text: '{\\b1}x\\N', style: { anim: 'pop' } } }], width: 100, height: 100, ratio: '1:1', total_ms: 1000, fonts: { bold: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: true }, regular: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: false }, brand: null, caption: null } });
    expect(evil.split('\n').find((l) => l.startsWith('Dialogue'))).toContain('(/b1)x/N');
  });

  it('audit 14 Nov: a boxed caption keeps its see-through, full-width box; "Pop" on plain text really pops', () => {
    const fonts = { bold: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: true }, regular: { family: 'Arial', unitsPerEm: 2048, winHeight: 2288, bold: false }, brand: null, caption: null };
    const boxed = buildAss({
      clips: [{ kind: 'subtitle', clip: { clip_id: 's', start_ms: 0, end_ms: 2000, text: 'halo semua', words: [{ text: 'halo', start_ms: 0, end_ms: 800 }, { text: 'semua', start_ms: 800, end_ms: 1600 }], style: { bg: '#000000', bg_opacity: 0.62 } } }],
      width: 1080, height: 1920, ratio: '9:16', total_ms: 2000, fonts,
    });
    const ev = boxed.split('\n').filter((l) => l.startsWith('Dialogue'));
    expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(e).toMatch(/\\3a&H61&/); // the box keeps 62 % (alpha 0x61)
      expect(e).not.toMatch(/\\alpha&H/); // nothing resets every alpha (that made the box opaque)
    }
    expect(ev[0]).toMatch(/\{\\1a&HFF&[^}]*\}semua/); // not yet spoken: text hidden, box stays full width
    expect(ev[1]).toMatch(/\{\\1a&H00&[^}]*\}semua/);
    const pop = buildAss({ clips: [{ kind: 'text', clip: { clip_id: 't', start_ms: 0, end_ms: 1000, text: 'Diskon besar', style: { anim: 'pop' } } }], width: 1080, height: 1920, ratio: '9:16', total_ms: 1000, fonts });
    const line = pop.split('\n').find((l) => l.startsWith('Dialogue'))!;
    // Each word starts small and grows (a block-level \fscx70 was undone by every word's \fscx100).
    expect(line.match(/\\fscx70\\fscy70\\t\(0,\d+,\\fscx100\\fscy100\)/g)).toHaveLength(2);
    expect(line).not.toMatch(/\}\{?[^{]*\\fscx100\\fscy100\}Diskon/);
  });

  it('subtitles from a transcript keep word timings when the cue was not edited', () => {
    const tl: Timeline = { tracks: [{ track_id: 'v', kind: 'video', clips: [{ clip_id: 'v', start_ms: 2000, end_ms: 8000, in_ms: 1000, media: { media_id: 'm_1', version_id: 'v_1' } }] }] };
    const words = [
      { text: 'Halo', start_ms: 1500, end_ms: 1900 },
      { text: 'semua', start_ms: 2000, end_ms: 2400 },
      { text: 'ini', start_ms: 3000, end_ms: 3200 },
      { text: 'diedit', start_ms: 3300, end_ms: 3600 },
    ];
    const tr = { version_id: 'v_1', words, cues: [{ cue_id: 'a', start_ms: 1500, end_ms: 2400, text: 'Halo semua' }, { cue_id: 'b', start_ms: 3000, end_ms: 3600, text: 'Ini sudah diubah' }] } as unknown as Parameters<typeof cuesToSubtitleOps>[0];
    const ops = cuesToSubtitleOps(tr, tl).ops as { words?: unknown; start_ms: number }[];
    expect(ops[0]).toMatchObject({ start_ms: 2500, words: [{ text: 'Halo', start_ms: 0, end_ms: 400 }, { text: 'semua', start_ms: 500, end_ms: 900 }] });
    expect(ops[1]!.words).toBeUndefined(); // edited cue: plain text
    expect(() => applyOps(tl, validateOps(ops, 1000), ids)).not.toThrow();
  });

  it.skipIf(!hasFfmpeg)('real render: the keyword appears (red) only once it is spoken; ASS text is as big as drawtext text', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    const grey = path.join(fx.src, 'grey.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', grey], { windowsHide: true });
    const imp = await svc.importMedia({ sourcePath: grey, scope: { kind: 'shared' }, actor: 'user' });
    const media = { media_id: imp.media.media_id, version_id: imp.version.version_id };
    await createProject(fx.ws, { project_id: 'cap', name: 'Cap' });
    await svc.editTimeline({
      project_id: 'cap',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 3000 },
        // Words "AA" then "BB" (keyword, red) at the bottom; at the top a drawtext "BB" in the same size, black, for the size check.
        { op: 'add_clip', track_kind: 'subtitle', text: 'x', words: [{ text: 'AA', start_ms: 0, end_ms: 1000 }, { text: 'BB', start_ms: 1000, end_ms: 2000 }], style: { y: 0.7, size: 10, color: '#ffffff', bg: null, outline: false, anim: 'none', highlight: { words: ['BB'], color: '#ff0000', scale: 1, current: false } }, start_ms: 0, duration_ms: 2000 },
        { op: 'add_clip', track_kind: 'text', text: 'BB', style: { y: 0.25, size: 10, color: '#000000', bg: null, outline: false }, start_ms: 0, duration_ms: 3000 },
      ],
    });
    const r = await renderProject(fx.ws, { project_id: 'cap', output_name: 'cap.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast' } });
    expect(r.status).toBe('completed');
    const out = path.join(fx.ws.root, (await listOutputs(fx.ws, 'cap'))[0]!.rel);
    const frame = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    const W = 360;
    const H = 640;
    const box = (raw: Buffer, pred: (r: number, g: number, b: number) => boolean, y0: number, y1: number) => {
      let top = H;
      let bottom = -1;
      let count = 0;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          if (pred(raw[i]!, raw[i + 1]!, raw[i + 2]!)) {
            count++;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { count, height: bottom - top + 1 };
    };
    const red = (r: number, g: number, b: number) => r > 180 && g < 80 && b < 80;
    const black = (r: number, g: number, b: number) => r < 40 && g < 40 && b < 40;
    const early = box(frame(0.5), red, 320, 640);
    const late = box(frame(1.5), red, 320, 640);
    expect(early.count).toBe(0); // "BB" not spoken yet
    expect(late.count).toBeGreaterThan(30); // now in red
    const title = box(frame(1.5), black, 0, 320);
    expect(Math.abs(late.height - title.height) / title.height).toBeLessThan(0.12); // same cap height ±12 %
  }, 90_000);
});
