import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/storage/copilot.js';
import { loadLeases } from '../src/storage/deps.js';
import { type EngineConfig, decideBatch, engineConfigFromEnv, engineEnv, readBatchDecisions, readEngineBatch, listEngineJobs, loadEnginePlan, prepareEngineJob, readEngineLog, readEngineStatus, runEngineJob, settleOrphanJob, validateEngineJob } from '../src/storage/engine.js';
import { isStorageError } from '../src/storage/errors.js';
import { areaOf } from '../src/storage/permissions.js';
import { loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { listVariants, variantState } from '../src/storage/variants.js';
import { newId } from '../src/storage/ids.js';
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
const brief = (catatan = '') => ({ produk: 'Loose Pants', varian: 'Espresso', harga: '', placement: 'tiktok', catatan });

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  // Engine "repository" outside the workspace, with a music file the engine hands back (aset_lokal).
  const root = await tempDir();
  await fsp.mkdir(path.join(root, 'aset'));
  await fsp.mkdir(path.join(root, 'konten'));
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(root, 'aset', 'musik-lokal.wav')], { windowsHide: true });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'konten', 'f1.mp4')], { windowsHide: true });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=3', path.join(root, 'konten', 'f1-vokal.wav')], { windowsHide: true });
  const cfg: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const gen = async (name: string, args: string[]) => {
    const f = path.join(fx.src, name);
    execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  const video = await gen('bicara.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const pop = await gen('pop.wav', ['-f', 'lavfi', '-i', 'sine=f=1200:d=0.3']);
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', aset: [{ id: 'pop-01', ref: pop, jenis: 'sfx', tag: ['pop'], lisensi: { status: 'milik_sendiri', iklan: true } }] }, actor: 'user' });
  await createProject(fx.ws, { project_id: 'g', name: 'Generate' });
  return { ...fx, svc, cfg, video, pop };
}

describe('U6 engine runner', () => {
  it('validates the job request (one $sumber for generate, brief fields, batch extras)', () => {
    const ok = validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: { media_id: 'm_1', version_id: 'v_1' } }], preset: 'aysilla-konversi', brief: brief(), ai: false });
    expect(ok.brief).toMatchObject({ placement: 'tiktok', produk: 'Loose Pants' });
    const S = [{ kunci: '$sumber', ref: { media_id: 'm_1', version_id: 'v_1' } }];
    for (const bad of [
      { project_id: 'g', mode: 'render', sources: S, preset: 'p', brief: {} },
      { project_id: 'g', mode: 'generate', sources: [], preset: 'p', brief: {} },
      { project_id: 'g', mode: 'generate', sources: [{ kunci: '$logo', ref: S[0]!.ref }], preset: 'p', brief: {} },
      { project_id: 'g', mode: 'generate', sources: S, preset: 'Bad Preset', brief: {} },
      { project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief: { placement: 'facebook' } },
      { project_id: 'g', mode: 'generate', sources: S, preset: 'p', brief: {}, rm: true },
      { project_id: 'g', mode: 'batch', sources: S, preset: 'p', brief: {}, batch: { batch: '../x', jumlah: 3 } },
      { project_id: 'g', mode: 'batch', sources: S, preset: 'p', brief: {}, batch: { batch: 'b', jumlah: 99 } },
      { project_id: '../g', mode: 'generate', sources: S, preset: 'p', brief: {} },
    ])
      expect(() => validateEngineJob(bad), JSON.stringify(bad)).toThrow();
    expect(validateEngineJob({ project_id: 'g', mode: 'batch', sources: [], preset: 'p', brief: {}, batch: { batch: '2026-11-13_winning', jumlah: 20, tujuan: 'konversi', hak_pakai_jelas: true } }).batch).toMatchObject({ jumlah: 20, hak_pakai_jelas: true });
    expect(engineConfigFromEnv({})).toBeNull();
    expect(engineConfigFromEnv({ MOTION_ENGINE_ROOT: 'D:/remotion' })!.script).toMatch(/pipeline[\\/]engine\.py$/);
  });

  it.skipIf(!hasFfmpeg)('generate: job folder + exports, lease while running, progress, plan with MediaRefs', async () => {
    const { ws, cfg, video, pop } = await setup();
    const input = validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: video }], preset: 'aysilla-konversi', brief: brief(), ai: false });
    const s0 = await prepareEngineJob(ws, input);
    expect(s0.job_id).toMatch(/^AYS-\d{8}-001$/);
    expect(s0.state).toBe('menunggu');
    const rel = `PROJECTS/g/06_ENGINE/${s0.job_id}`;
    expect(areaOf(`${rel}/job.json`)).toBe('project_engine');
    const jdir = path.join(ws.root, ...rel.split('/'));
    const job = JSON.parse(await fsp.readFile(path.join(jdir, 'job.json'), 'utf8'));
    expect(job).toMatchObject({ schema: 'engine-job/1', job_id: s0.job_id, mode: 'generate', brand_kit: 'brand_kit.json', preset: 'aysilla-konversi', ai: false });
    expect(job.sumber[0].kunci).toBe('$sumber');
    expect(path.isAbsolute(job.sumber[0].path)).toBe(true);
    const kit = JSON.parse(await fsp.readFile(path.join(jdir, 'brand_kit.json'), 'utf8'));
    expect(kit.brand.kode).toBe('AYS');
    expect(kit.aset[0]).toMatchObject({ kunci: '$sfx:pop-01' });
    expect(path.isAbsolute(kit.aset[0].path)).toBe(true);
    // The source is leased while the job waits / runs (Auto Trash cannot move it).
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine').flatMap((l) => l.media.map((m) => m.version_id))).toEqual([video.version_id]);
    // A second job the same day gets the next number.
    const s1 = await prepareEngineJob(ws, input);
    expect(s1.job_id).toMatch(/-002$/);

    const seen: string[] = [];
    const done = await runEngineJob(ws, cfg, 'g', s0.job_id, { onProgress: (s) => seen.push(`${s.tahap}:${s.persen}`) });
    expect(done).toMatchObject({ state: 'siap', exit_code: 0, persen: 100, lease_id: null });
    expect(seen).toEqual(expect.arrayContaining(['cek_input:5', 'transkrip:40', 'rencana:80', 'selesai:100']));
    expect((await readEngineStatus(ws, 'g', s0.job_id)).state).toBe('siap');
    expect(await readEngineLog(ws, 'g', s0.job_id)).toContain('log: mulai');
    // Checkpoint I H1: a finished (or settled) job never runs again — and never without its lease.
    expect(await code(() => runEngineJob(ws, cfg, 'g', s0.job_id))).toBe('PRECONDITION');
    // M3: the engine never gets the server's secrets.
    const env = engineEnv({ PATH: 'p', MOTION_SECRET_KEY: 'k', MOTION_GOOGLE_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'a', PYTHONPATH: 'x', SystemRoot: 'C:/Windows' });
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PYTHONIOENCODING', 'PYTHONPATH', 'PYTHONUTF8', 'SystemRoot']);
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine')).toHaveLength(1); // only s1's

    // Plan: placeholders → MediaRefs; the engine's own music imported once as project media.
    const plan = await loadEnginePlan(ws, cfg, 'g', s0.job_id);
    expect(plan.imported).toEqual(['$musik:lokal-01']);
    const media = (plan.ops as { media?: { version_id: string } }[]).filter((o) => o.media).map((o) => o.media!.version_id);
    expect(media.slice(0, 2)).toEqual([video.version_id, pop.version_id]);
    const reg = await loadRegistry(ws);
    const music = reg.versions[media[2]!]!;
    expect(reg.media[music.media_id]!.scope).toEqual({ kind: 'project', project_id: 'g' });
    expect((await loadEnginePlan(ws, cfg, 'g', s0.job_id)).imported).toEqual([]); // remembered in refs.json
    // It is a valid Motion Studio plan (same checks as every Copilot plan).
    expect(checkPlan({ tracks: [] }, plan.ops, undefined, 1000).ops).toHaveLength(5);
    expect(plan.rencana).toMatchObject({ status: 'siap', hook: { teks: 'Celana adem' }, posisi_caption: 0.72 });
    expect(plan.qc!.butir.map((b) => b.lulus)).toEqual([false, true]);
    expect((await listEngineJobs(ws, 'g')).map((j) => j.job_id)).toEqual([s1.job_id, s0.job_id]);
    // A job left waiting by a stopped server is settled and frees its lease.
    expect((await settleOrphanJob(ws, s1)).state).toBe('gagal');
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine')).toHaveLength(0);
  }, 60_000);

  it.skipIf(!hasFfmpeg)('refused (2), failed (1), timeout; unknown placeholders and outside paths are refused', async () => {
    const { ws, cfg, video } = await setup();
    const run = async (catatan: string, c: EngineConfig = cfg) => {
      const s = await prepareEngineJob(ws, validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: video }], preset: 'p', brief: brief(catatan), ai: false }));
      return runEngineJob(ws, c, 'g', s.job_id);
    };
    expect(await run('tolak')).toMatchObject({ state: 'ditolak', exit_code: 2, alasan: 'tidak ada ucapan terdeteksi' });
    expect(await run('tolak0')).toMatchObject({ state: 'ditolak', alasan: 'durasi di luar target' }); // L3: rencana.status wins over exit 0
    const failed = await run('gagal');
    expect(failed).toMatchObject({ state: 'gagal', exit_code: 1 });
    expect(failed.alasan).toContain('whisper model tidak ada');
    expect(await run('lambat', { ...cfg, timeout_ms: 1500 })).toMatchObject({ state: 'gagal' });
    expect((await run('', { ...cfg, command: path.join(cfg.root, 'tidak-ada.exe') })).state).toBe('gagal'); // engine not installed
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine')).toHaveLength(0); // every lease freed
    const asing = await run('asing');
    expect(await code(() => loadEnginePlan(ws, cfg, 'g', asing.job_id))).toBe('PRECONDITION'); // $sfx:tidak-ada
    const kabur = await run('kabur');
    expect(await code(() => loadEnginePlan(ws, cfg, 'g', kabur.job_id))).toBe('PRECONDITION'); // C:/Windows/win.ini
    expect(await code(() => loadEnginePlan(ws, null, 'g', kabur.job_id))).toBe('PRECONDITION');
    // L2: the failure log shown in the browser has no local paths.
    expect(await readEngineLog(ws, 'g', failed.job_id, cfg)).not.toMatch(/[A-Za-z]:[\\/]/);
    // L1: only media files inside the engine folder (no .env, no code), symlinks resolved.
    await fsp.writeFile(path.join(cfg.root, '.env'), 'ANTHROPIC_API_KEY=x');
    const opsFile = path.join(ws.root, 'PROJECTS', 'g', '06_ENGINE', asing.job_id, 'out', 'ops.json');
    const doc = JSON.parse(await fsp.readFile(opsFile, 'utf8'));
    await fsp.writeFile(opsFile, JSON.stringify({ ...doc, ops: doc.ops.filter((o: { media?: string }) => o.media !== '$sfx:tidak-ada'), aset_lokal: [{ kunci: '$musik:env', path: '.env' }] }));
    expect(await code(() => loadEnginePlan(ws, cfg, 'g', asing.job_id))).toBe('PRECONDITION');
    // Job ids are checked: no path tricks.
    expect(await code(() => readEngineStatus(ws, 'g', '../../x'))).toBe('NOT_FOUND');
    expect(await code(() => loadEnginePlan(ws, cfg, 'g', asing.job_id, '../x'))).toBe('EDIT_INVALID');
  }, 90_000);

  it.skipIf(!hasFfmpeg)('a brand without a source in Trash / unknown source is refused before anything runs', async () => {
    const { ws, svc } = await setup();
    const bad = validateEngineJob({ project_id: 'g', mode: 'generate', sources: [{ kunci: '$sumber', ref: { media_id: 'm_0000000000000000', version_id: 'v_0000000000000000' } }], preset: 'p', brief: brief(), ai: false });
    expect(await code(() => prepareEngineJob(ws, bad))).toBe('PRECONDITION');
    expect(await listEngineJobs(ws, 'g')).toEqual([]); // the half-made folder is removed
    void svc;
  }, 60_000);
  it.skipIf(!hasFfmpeg)('Batch Remix: table → approve / strike → variant projects (approved = ready to render), footage shared', async () => {
    const { ws, cfg } = await setup();
    await createProject(ws, { project_id: 'b', name: 'Batch Winning' });
    const s = await prepareEngineJob(ws, validateEngineJob({ project_id: 'b', mode: 'batch', sources: [], preset: 'aysilla-konversi', brief: brief(), ai: false, mode_ops: 'u3', batch: { batch: '2026-11-13_winning', jumlah: 3, tujuan: 'konversi', hak_pakai_jelas: true } }));
    expect(JSON.parse(await fsp.readFile(path.join(ws.root, 'PROJECTS', 'b', '06_ENGINE', s.job_id, 'job.json'), 'utf8'))).toMatchObject({ mode: 'batch', batch: '2026-11-13_winning', jumlah: 3, hak_pakai_jelas: true, sumber: [] });
    expect((await runEngineJob(ws, cfg, 'b', s.job_id)).state).toBe('siap');
    expect(((await readEngineBatch(ws, 'b', s.job_id)).varian as unknown[]).length).toBe(3);
    const ids = () => `p_${newId('c').slice(2)}`;
    // Approve 1 and 3 (3 = test music, labelled UJI), strike 2.
    const d1 = await decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-001', status: 'disetujui' }, { varian: 'varian-002', status: 'dicoret' }, { varian: 'varian-003', status: 'disetujui' }], actor: 'user', newId: ids });
    expect(d1['varian-002']).toEqual({ status: 'dicoret', project_id: null });
    const vs = await listVariants(ws, 'b');
    expect(vs.map((p) => [p.variant!.label, variantState(p)])).toEqual([
      ['varian-001 · Hook 1', 'approved'],
      ['UJI · varian-003 · Hook 3', 'approved'],
    ]);
    const v1 = vs[0]!;
    const clip = v1.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!;
    expect(clip).toMatchObject({ volume: 0, crop: { y: 0.1, h: 0.8 }, blur: [{ x: 0.7 }] });
    const reg = await loadRegistry(ws);
    expect(reg.media[clip.media!.media_id]!.scope).toEqual({ kind: 'shared' }); // one copy for every variant
    expect(vs[1]!.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.media).toEqual(clip.media); // deduplicated
    // Strike 1 later: approval withdrawn, project kept; approve again: approved again, no new project.
    await decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-001', status: 'dicoret' }], actor: 'user', newId: ids });
    expect(variantState(await readProject(ws, v1.project_id))).toBe('draft');
    await decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-001', status: 'disetujui' }], actor: 'user', newId: ids });
    expect(variantState(await readProject(ws, v1.project_id))).toBe('approved');
    expect(await listVariants(ws, 'b')).toHaveLength(2);
    expect((await readBatchDecisions(ws, 'b', s.job_id))['varian-001']).toEqual({ status: 'disetujui', project_id: v1.project_id });
    // Checkpoint I H2: the same row twice in one request is refused (no duplicate variant projects).
    expect(await code(() => decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-002', status: 'disetujui' }, { varian: 'varian-002', status: 'disetujui' }], actor: 'user', newId: ids }))).toBe('EDIT_INVALID');
    expect(await listVariants(ws, 'b')).toHaveLength(2);
    // Unknown rows / statuses are refused.
    expect(await code(() => decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-009', status: 'disetujui' }], actor: 'user', newId: ids }))).toBe('EDIT_INVALID');
    expect(await code(() => decideBatch(ws, cfg, { project_id: 'b', job_id: s.job_id, rows: [{ varian: 'varian-001', status: 'lulus' }], actor: 'user', newId: ids }))).toBe('EDIT_INVALID');
  }, 90_000);
});
