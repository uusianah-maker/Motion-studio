import { describe, expect, it } from 'vitest';
import { validateBrandInput } from '../src/storage/brand.js';
import { checkBrandGuard, containsPhrase, containsPrice, localDate, validateGuard } from '../src/storage/brandGuard.js';
import { isStorageError } from '../src/storage/errors.js';
import { renderPreflight } from '../src/storage/preflight.js';
import { StorageService } from '../src/storage/service.js';
import type { Timeline } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const GUARD = { prices: [{ text: 'Rp99.000', valid_until: '2026-11-10' }, { text: 'DISKON 50%', valid_until: '2026-12-31' }], banned: ['paling murah', '100% menyembuhkan'], banned_level: 'block' as const };
const tl = (...texts: [string, 'text' | 'subtitle', number][]): Timeline => ({
  tracks: [
    { track_id: 't', kind: 'text', clips: texts.filter((x) => x[1] === 'text').map(([text, , s], i) => ({ clip_id: `t${i}`, start_ms: s, end_ms: s + 1000, text })) },
    { track_id: 's', kind: 'subtitle', clips: texts.filter((x) => x[1] === 'subtitle').map(([text, , s], i) => ({ clip_id: `s${i}`, start_ms: s, end_ms: s + 1000, text })) },
  ],
});

describe('X08 Brand guard', () => {
  it('matching: prices ignore spaces/dots/case but not longer numbers; claims match whole words, accents ignored', () => {
    expect(containsPrice('Cuma rp 99.000 aja!', 'Rp99.000')).toBe(true);
    expect(containsPrice('Harga RP99,000', 'Rp99.000')).toBe(true);
    expect(containsPrice('Rp199.000', 'Rp99.000')).toBe(false);
    expect(containsPrice('diskon 150%', 'DISKON 50%')).toBe(false);
    expect(containsPrice('DISKON 50% hari ini', 'diskon 50%')).toBe(true);
    expect(containsPhrase('Ini PALING  murah!', 'paling murah')).toBe(true);
    expect(containsPhrase('Paling murahnya', 'paling murah')).toBe(false);
    expect(containsPhrase('Garansi dijamín', 'dijamin')).toBe(true);
  });

  it('check: expired price blocks (from the day after valid_until), banned claim follows its level, text + subtitle both checked', () => {
    const t = tl(['Promo Rp99.000!', 'text', 3000], ['Ini paling murah', 'subtitle', 1000], ['DISKON 50%', 'text', 5000], ['Aman', 'text', 7000]);
    const on10 = checkBrandGuard(t, validateGuard(GUARD), '2026-11-10');
    expect(on10.map((i) => [i.kind, i.level, i.clip_id])).toEqual([['BANNED_CLAIM', 'block', 's0']]); // price still valid on its last day
    const on11 = checkBrandGuard(t, validateGuard(GUARD), '2026-11-11');
    expect(on11.map((i) => [i.kind, i.level, i.clip_id, i.match])).toEqual([
      ['BANNED_CLAIM', 'block', 's0', 'paling murah'],
      ['PRICE_EXPIRED', 'block', 't0', 'Rp99.000'],
    ]);
    expect(on11[1]).toMatchObject({ valid_until: '2026-11-10', start_ms: 3000, track_kind: 'text' });
    expect(checkBrandGuard(t, validateGuard({ ...GUARD, banned_level: 'warn' }), '2026-11-11').find((i) => i.kind === 'BANNED_CLAIM')!.level).toBe('warn');
    expect(checkBrandGuard(t, validateGuard(null), '2030-01-01')).toEqual([]);
    expect(localDate(Date.UTC(2026, 10, 13, 5))).toMatch(/^2026-11-1[34]$/);
  });

  it('validation: dates, lengths, limits, unknown fields; old kits without a guard still load', async () => {
    for (const bad of [
      { prices: [{ text: 'Rp1', valid_until: '13/11/2026' }] },
      { prices: [{ text: '', valid_until: '2026-11-13' }] },
      { prices: [{ text: 'x', valid_until: '2026-11-13', note: 1 }] },
      { banned: ['a'] },
      { banned: Array.from({ length: 201 }, (_, i) => `klaim ${i}`) },
      { banned_level: 'sometimes' },
      { owner: 'x' },
    ]) {
      expect(await code(() => validateGuard(bad)), JSON.stringify(bad).slice(0, 60)).toBe('EDIT_INVALID');
    }
    expect(validateGuard({ banned: ['Paling Murah', 'Paling Murah', '  dijamin  '] }).banned).toEqual(['Paling Murah', 'dijamin']);
    expect(validateBrandInput({ name: 'A', colors: [], text_color: '#ffffff', font: null, logo: null }).guard).toEqual({ prices: [], banned: [], banned_level: 'block' });
  });

  it('render preflight: block issues stop the render; warn issues need the USER to accept (recorded); AI cannot accept', async () => {
    const fx = await fixtureWorkspace(); // clock: 2026-11-01
    const svc = new StorageService(fx.ws);
    const ref = await importShared(fx.ws, fx.src, 'v');
    await svc.setBrandKit({ expected_revision: 0, kit: { name: 'B', colors: [], text_color: '#ffffff', font: null, logo: null, guard: { prices: [{ text: 'Rp99.000', valid_until: '2026-10-31' }], banned: ['dijamin'], banned_level: 'warn' } }, actor: 'user' });
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    await svc.editTimeline({
      project_id: 'p',
      expected_revision: 0,
      actor: 'user',
      ops: [
        { op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 4000 },
        { op: 'add_clip', track_kind: 'text', text: 'Cuma Rp99.000', start_ms: 0, duration_ms: 1000 },
        { op: 'add_clip', track_kind: 'subtitle', text: 'Pasti dijamin puas', start_ms: 1000, duration_ms: 1000 },
      ],
    });
    const pf = (extra = {}) => renderPreflight(fx.ws, { project_id: 'p', output_name: 'x.mp4', estimated_bytes: 1, actor: 'user', disk: { free_bytes: 1e12, total_bytes: 2e12 }, ...extra });
    const r1 = await pf();
    expect(r1.ok).toBe(false);
    expect(r1.problems.map((p) => p.code).sort()).toEqual(['BRAND_BLOCKED', 'BRAND_WARNING']);
    // Fix the expired price: only the warning is left, and accepting it lets the render through.
    const p = (await svc.editTimeline({ project_id: 'p', expected_revision: 1, actor: 'user', ops: [{ op: 'set_text', clip_id: (await import('../src/storage/workspace.js').then((m) => m.readProject(fx.ws, 'p'))).timeline.tracks.find((t) => t.kind === 'text')!.clips[0]!.clip_id, text: 'Harga spesial' }] })).result;
    expect(p.revision).toBe(2);
    expect((await pf()).problems.map((x) => x.code)).toEqual(['BRAND_WARNING']);
    const ok = await pf({ accept_brand_warnings: true });
    expect(ok.ok).toBe(true);
    expect(ok.notes.join(' ')).toMatch(/Peringatan Brand guard diterima user.*dijamin/);
    expect(await code(() => renderPreflight(fx.ws, { project_id: 'p', output_name: 'x.mp4', estimated_bytes: 1, actor: 'ai', accept_brand_warnings: true }))).toBe('FORBIDDEN');
  });
});
