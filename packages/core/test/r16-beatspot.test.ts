// R16 Beat Spot (contract §16), app side: the `beatspot` job (footage + the team's sound), the
// engine's report for the page, a re-run with the team's choices, and the plan through the usual path.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBeatspotView, rerunBeatspot } from '../src/storage/beatspot.js';
import { type EngineConfig, engineJobDir, loadEnginePlan, prepareEngineJob, runEngineJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { StorageService } from '../src/storage/service.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace } from './fixtures.js';
import { tempDir } from './helpers.js';

const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const code = async (fn: () => unknown) => {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-engine.mjs');
const R = (n: number) => ({ media_id: `m_${n}`, version_id: `v_${n}` });

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const cfg: EngineConfig = { root: await tempDir(), command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const imp = async (name: string, args: string[]) => {
    const f = path.join(fx.src, name);
    execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'b' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(fx.ws, { project_id: 'b', name: 'Beat Spot' });
  const v = ['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  const mall1 = await imp('mall-1.mp4', v);
  const mall2 = await imp('mall-2.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const sound = await imp('sound-tren.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=8']);
  const sources = [
    { kunci: '$sumber:mall-1', ref: mall1 },
    { kunci: '$sumber:mall-2', ref: mall2 },
    { kunci: '$sumber:sound', ref: sound },
  ];
  return { ...fx, svc, cfg, sources };
}

describe('R16 Beat Spot', () => {
  it('validates the job and the team settings (contract §16 fields only)', async () => {
    const S = [{ kunci: '$sumber:a', ref: R(1) }, { kunci: '$sumber:s', ref: R(2) }];
    const ok = validateEngineJob({ project_id: 'b', mode: 'beatspot', sources: S, beatspot: { sound: '$sumber:s', ketukan_per_potong: 2, durasi: [15, 25], urutan_shot: ['a#01', 'a#01'], sumber_orang: { a: 'kreator', 'a#00': 'umum' } } });
    expect(ok.beatspot).toEqual({ sound: '$sumber:s', bpm: null, ketukan_per_potong: 2, durasi: [15, 25], tagline: null, urutan_shot: ['a#01'], kecualikan_shot: [], sumber_orang: { a: 'kreator', 'a#00': 'umum' }, seed: 1 });
    expect(validateEngineJob({ project_id: 'b', mode: 'beatspot', sources: S.slice(0, 1) }).beatspot).toMatchObject({ sound: null, ketukan_per_potong: 'auto', durasi: [15, 20] });
    for (const beatspot of [
      { sound: '$sumber:x' },
      { bpm: 300 },
      { ketukan_per_potong: 3 },
      { durasi: [20, 10] },
      { durasi: [2, 10] },
      { durasi: '15' },
      { urutan_shot: ['../x#01'] },
      { kecualikan_shot: 'a#01' },
      { sumber_orang: { a: 'teman' } },
      { sumber_orang: { '../a': 'umum' } },
      { seed: -1 },
      { tagline: 'x'.repeat(121) },
      { blur_wajah: true },
    ])
      expect(await code(() => validateEngineJob({ project_id: 'b', mode: 'beatspot', sources: S, beatspot }))).toBe('EDIT_INVALID');
    for (const bad of [
      { project_id: 'b', mode: 'beatspot', sources: [] },
      { project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber', ref: R(1) }] },
      { project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: R(1) }, { kunci: '$sumber:A', ref: R(2) }] },
      { project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber:a', ref: R(1) }, { kunci: '$sumber:b', ref: R(1) }] },
      { project_id: 'b', mode: 'beatspot', sources: [{ kunci: '$sumber:s', ref: R(2) }], beatspot: { sound: '$sumber:s' } }, // sound only
      { project_id: 'b', mode: 'beatspot', sources: S, ai: true },
    ])
      expect(await code(() => validateEngineJob(bad))).toBe('EDIT_INVALID');
  });

  it.skipIf(!hasFfmpeg)('runs, reports cuts + candidates, re-runs with the team’s choices, plan maps every file', async () => {
    const { ws, cfg, sources } = await setup();
    const prepared = await prepareEngineJob(ws, validateEngineJob({ project_id: 'b', mode: 'beatspot', sources, beatspot: { sound: '$sumber:sound', durasi: [15, 20] } }));
    const s = await runEngineJob(ws, cfg, 'b', prepared.job_id);
    expect([s.mode, s.state]).toEqual(['beatspot', 'siap']);
    const job = JSON.parse(await fsp.readFile(path.join(engineJobDir(ws, 'b', s.job_id), 'job.json'), 'utf8'));
    expect(job).toMatchObject({ mode: 'beatspot', beatspot: { sound: '$sumber:sound', durasi: [15, 20], ketukan_per_potong: 'auto' } });
    expect(job.sumber).toHaveLength(3);

    const v = await readBeatspotView(ws, 'b', s.job_id);
    expect(v.sumber).toEqual([
      { kunci: '$sumber:mall-1', id: 'mall-1', nama: 'mall-1.mp4', sound: false },
      { kunci: '$sumber:mall-2', id: 'mall-2', nama: 'mall-2.mp4', sound: false },
      { kunci: '$sumber:sound', id: 'sound', nama: 'sound-tren.wav', sound: true },
    ]);
    expect(v.laporan).toMatchObject({ bpm: 128, sumber_ketukan: 'sound', ketukan_per_potong: 2 });
    expect(v.laporan!.potongan.map((p) => p.shot)).toEqual(['mall-1#00', 'mall-1#01', 'mall-2#00', 'mall-2#01']);
    expect(v.laporan!.kandidat).toHaveLength(4);
    expect(v.pengaturan).toMatchObject({ sound: '$sumber:sound' });

    // The plan goes the usual way: every $sumber:<id> maps to the team's file, nothing unknown.
    const plan = await loadEnginePlan(ws, cfg, 'b', s.job_id);
    const media = plan.ops.filter((o) => (o as { media?: unknown }).media).map((o) => (o as { media: { version_id: string } }).media.version_id);
    expect(new Set(media)).toEqual(new Set(sources.map((x) => x.ref.version_id)));

    // Hybrid re-run: order, an excluded shot, a creator footage; a NEW job, the first one stays.
    const again = await rerunBeatspot(ws, 'b', s.job_id, { ...v.pengaturan, urutan_shot: ['mall-2#01'], kecualikan_shot: ['mall-1#00'], sumber_orang: { 'mall-2': 'kreator' } });
    expect(again.job_id).not.toBe(s.job_id);
    const s2 = await runEngineJob(ws, cfg, 'b', again.job_id);
    const v2 = await readBeatspotView(ws, 'b', s2.job_id);
    expect(v2.laporan!.potongan.map((p) => p.shot)).toEqual(['mall-2#01', 'mall-1#01', 'mall-2#00']);
    expect(v2.laporan!.potongan[0]).toMatchObject({ sumber_orang: 'kreator' });
    expect(v2.laporan!.dibuang).toEqual([{ id: 'mall-1#00', alasan: 'dikecualikan tim' }]);
    expect((await readBeatspotView(ws, 'b', s.job_id)).laporan!.potongan).toHaveLength(4);
    expect(await code(() => rerunBeatspot(ws, 'b', s.job_id, { sound: '$sumber:lain' }))).toBe('EDIT_INVALID');
  }, 60_000);

  it.skipIf(!hasFfmpeg)('a refused job has no report; a non-Beat-Spot job is refused', async () => {
    const { ws, cfg, sources } = await setup();
    const p = await prepareEngineJob(ws, validateEngineJob({ project_id: 'b', mode: 'beatspot', sources, beatspot: { tagline: 'tolak' } }));
    const s = await runEngineJob(ws, cfg, 'b', p.job_id);
    expect(s.state).toBe('ditolak');
    expect((await readBeatspotView(ws, 'b', s.job_id)).laporan).toBeNull();
    const t = await prepareEngineJob(ws, validateEngineJob({ project_id: 'b', mode: 'transfer', sources: [{ kunci: '$sumber', ref: sources[0]!.ref }] }));
    expect(await code(() => readBeatspotView(ws, 'b', t.job_id))).toBe('EDIT_INVALID');
  }, 60_000);
});
