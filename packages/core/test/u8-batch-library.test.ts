// Batch Remix library (audit yuki 14 Nov 2026): Pisah Audio job, batch list, Shot Library +
// exclusions, per-sentence shot breakdown. The engine is the contract stand-in fake-engine.mjs.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLeases } from '../src/storage/deps.js';
import { type EngineConfig, listEngineJobs, prepareEngineJob, readEngineBatchView, readPisahResult, runEngineJob, scrubPaths, settleOrphanJob, validateEngineJob } from '../src/storage/engine.js';
import { listEngineBatches, parseBatchList, readShotExclusions, readShotLibrary, readShotThumbs, setShotExclusions } from '../src/storage/engineLibrary.js';
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
const brief = { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' };

async function setup() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const root = await tempDir();
  await fsp.mkdir(path.join(root, 'konten'));
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'konten', 'f1.mp4')], { windowsHide: true });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=3', path.join(root, 'konten', 'f1-vokal.wav')], { windowsHide: true });
  const cfg: EngineConfig = { root, command: process.execPath, script: FAKE, timeout_ms: 60_000 };
  const gen = async (name: string, color: string) => {
    const f = path.join(fx.src, name);
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { windowsHide: true });
    const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'project', project_id: 'f' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(fx.ws, { project_id: 'f', name: 'Footage' });
  const a = await gen('IN1.mp4', 'gray');
  const b = await gen('IN2.mp4', 'navy');
  return { ...fx, svc, cfg, a, b };
}

describe('U8 Batch Remix library', () => {
  it('validates a Pisah Audio job (1–50 videos, unique file names, batch name, no other fields)', () => {
    const ref = { media_id: 'm_1', version_id: 'v_1' };
    const ok = validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: '2026-11-14_baru', video_saja: true } });
    expect(ok).toMatchObject({ mode: 'pisah', pisah: { batch: '2026-11-14_baru', video_saja: true } });
    for (const bad of [
      { project_id: 'f', mode: 'pisah', sources: [], pisah: { batch: 'b' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber', ref }], pisah: { batch: 'b' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:../x', ref }], pisah: { batch: 'b' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }, { kunci: '$sumber:in1', ref: { media_id: 'm_2', version_id: 'v_2' } }], pisah: { batch: 'b' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }, { kunci: '$sumber:IN2', ref }], pisah: { batch: 'b' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: '../konten' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: '.' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: '_x' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: 'b', video_saja: 'ya' } },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: 'b' }, preset: 'p' },
      { project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref }], pisah: { batch: 'b', jumlah: 3 } },
    ])
      expect(() => validateEngineJob(bad), JSON.stringify(bad)).toThrow();
    // The app never sends kecualikan_shot itself: the server adds it from its own store.
    expect(() => validateEngineJob({ project_id: 'f', mode: 'batch', sources: [], preset: 'p', brief, batch: { batch: 'b', jumlah: 2, kecualikan_shot: ['IN1#00'] } })).toThrow();
  });

  it.skipIf(!hasFfmpeg)('Pisah Audio: uploads → engine konten/ → result + Shot Library; batch list; thumbnails only from the batch folder', async () => {
    const { ws, cfg, a, b } = await setup();
    const s = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: a }, { kunci: '$sumber:IN2', ref: b }], pisah: { batch: '2026-11-14_baru' } }));
    const jdir = path.join(ws.root, 'PROJECTS', 'f', '06_ENGINE', s.job_id);
    const job = JSON.parse(await fsp.readFile(path.join(jdir, 'job.json'), 'utf8'));
    expect(job).toMatchObject({ mode: 'pisah', batch: '2026-11-14_baru' });
    expect(job.sumber.map((x: { path: string }) => path.basename(x.path))).toEqual(['IN1.mp4', 'IN2.mp4']);
    // The uploads stay pinned (Auto Trash never moves them) until the engine is done.
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine').flatMap((l) => l.media.map((m) => m.version_id)).sort()).toEqual([a.version_id, b.version_id].sort());
    const done = await runEngineJob(ws, cfg, 'f', s.job_id);
    expect(done.state).toBe('siap');
    expect(await fsp.stat(path.join(jdir, 'masuk')).catch(() => null)).toBeNull(); // the engine's copies, not kept twice
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine')).toHaveLength(0);
    const r = await readPisahResult(ws, 'f', s.job_id);
    expect(r).toEqual({ batch: '2026-11-14_baru', alasan: null, ditolak: [], files: [{ file: 'IN1.mp4', video: true, vokal: true, musik: true }, { file: 'IN2.mp4', video: true, vokal: true, musik: true }] });
    expect(JSON.stringify(r)).not.toMatch(/[A-Za-z]:[\\/]/); // no local paths

    // Batch dropdown.
    const list = await listEngineBatches(cfg);
    expect(list).toEqual([expect.objectContaining({ batch: '2026-11-14_baru', upload: 2, footage: 2, vo: 2, musik: 2, shot_library: true, jumlah_shot: 5, siap_batch: true })]);

    // Shot Library: labels (with the team's engine-side koreksi applied), no paths.
    const lib = await readShotLibrary(cfg, '2026-11-14_baru');
    expect(lib.footage).toEqual([{ id: 'IN1', durasi: 3 }, { id: 'IN2', durasi: 3 }]);
    expect(lib.shots).toHaveLength(5);
    expect(lib.shots[0]).toMatchObject({ id: 'IN1#00', footage: 'IN1', dari: 0, sampai: 1.5, label: { framing: 'medium', wajah_bicara: true, teks_bawaan: false, buram: false }, ucapan: 'celananya adem banget', thumb: true, koreksi: false });
    expect(lib.shots[1]).toMatchObject({ id: 'IN1#01', label: { buram: true, teks_bawaan: true }, tag: ['produk'], teks: ['Loosepants'], koreksi: true });
    expect(JSON.stringify(lib)).not.toMatch(/[A-Za-z]:[\\/]|konten\//);
    const thumbs = await readShotThumbs(cfg, '2026-11-14_baru', ['IN1#00', 'IN2#01', 'X#99']);
    expect(Object.keys(thumbs).sort()).toEqual(['IN1#00', 'IN2#01']); // X#99 points at C:/Windows/win.ini: refused
    expect(thumbs['IN1#00']).toMatch(/^data:image\/jpeg;base64,/);
    expect(await code(() => readShotThumbs(cfg, '2026-11-14_baru', Array.from({ length: 61 }, (_, i) => `IN1#${i}`)))).toBe('EDIT_INVALID');
    expect(await code(() => readShotLibrary(cfg, '..'))).toBe('EDIT_INVALID');
    expect(await code(() => readShotLibrary(cfg, 'belum-ada'))).toBe('NOT_FOUND');

    // Contract v0.3.2a: a broken upload is skipped and listed (name only, reason without paths).
    const rs = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: a }, { kunci: '$sumber:RUSAK1', ref: b }], pisah: { batch: 'campur' } }));
    expect((await runEngineJob(ws, cfg, 'f', rs.job_id)).state).toBe('siap');
    const rr = await readPisahResult(ws, 'f', rs.job_id);
    expect(rr.files.map((f) => f.file)).toEqual(['IN1.mp4']);
    expect(rr.ditolak).toEqual([{ file: 'RUSAK1.mp4', alasan: 'ffprobe gagal membaca <path>' }]);
    // Exit 1: the result file's reason (paths scrubbed), else the log tail (paths scrubbed too).
    const g = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: a }], pisah: { batch: 'gagal' } }));
    expect(await runEngineJob(ws, cfg, 'f', g.job_id)).toMatchObject({ state: 'gagal', alasan: 'GPU kehabisan memori saat membuka <path>', lease_id: null });
    const gp = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: a }], pisah: { batch: 'gagal-polos' } }));
    const gps = await runEngineJob(ws, cfg, 'f', gp.job_id);
    expect(gps.state).toBe('gagal');
    expect(gps.alasan).toContain('Traceback');
    expect(gps.alasan).not.toMatch(/[A-Za-z]:[\\/]/);
    // A refused split (exit 2) keeps the engine's reason.
    const t = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN1', ref: a }], pisah: { batch: 'tolak' } }));
    expect(await runEngineJob(ws, cfg, 'f', t.job_id)).toMatchObject({ state: 'ditolak', alasan: 'tidak ada video yang bisa dibaca', lease_id: null });
    // A queued job cancelled / left by a restart: its copies of the uploads are removed, lease freed.
    const q = await prepareEngineJob(ws, validateEngineJob({ project_id: 'f', mode: 'pisah', sources: [{ kunci: '$sumber:IN2', ref: b }], pisah: { batch: 'nanti' } }));
    const qdir = path.join(ws.root, 'PROJECTS', 'f', '06_ENGINE', q.job_id);
    expect(await fsp.readdir(path.join(qdir, 'masuk'))).toEqual(['IN2.mp4']);
    expect(await settleOrphanJob(ws, q)).toMatchObject({ state: 'gagal', lease_id: null });
    expect(await fsp.stat(path.join(qdir, 'masuk')).catch(() => null)).toBeNull();
    expect((await loadLeases(ws)).leases.filter((l) => l.job === 'engine')).toHaveLength(0);
    expect((await listEngineJobs(ws, 'f')).map((j) => j.mode)).toEqual(['pisah', 'pisah', 'pisah', 'pisah', 'pisah', 'pisah']);
  }, 90_000);

  it('shot exclusions are kept on the app side, validated, deduplicated, audited', async () => {
    const { ws } = await fixtureWorkspace();
    expect(await readShotExclusions(ws, 'b1')).toEqual([]);
    expect(await setShotExclusions(ws, { batch: 'b1', shots: ['IN2#01', 'IN1#00', 'IN1#00'], actor: 'user' })).toEqual(['IN1#00', 'IN2#01']);
    expect(await readShotExclusions(ws, 'b1')).toEqual(['IN1#00', 'IN2#01']);
    expect(await readShotExclusions(ws, 'b2')).toEqual([]);
    for (const bad of ['IN1#00', ['a b'], ['../x'], [1]]) expect(await code(() => setShotExclusions(ws, { batch: 'b1', shots: bad, actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await code(() => setShotExclusions(ws, { batch: '../b', shots: [], actor: 'user' }))).toBe('EDIT_INVALID');
    // Contract §9: at most 500 ids in kecualikan_shot (duplicates do not count).
    expect(await code(() => setShotExclusions(ws, { batch: 'b1', shots: Array.from({ length: 501 }, (_, i) => `IN1#${i}`), actor: 'user' }))).toBe('EDIT_INVALID');
    expect(await setShotExclusions(ws, { batch: 'b1', shots: [...Array.from({ length: 500 }, (_, i) => `IN1#${i}`), 'IN1#0'], actor: 'user' })).toHaveLength(500);
    expect(await setShotExclusions(ws, { batch: 'b1', shots: [], actor: 'user' })).toEqual([]);
    const log = await fsp.readFile(path.join(ws.root, '.motionstudio', 'audit.log.jsonl'), 'utf8').catch(() => '');
    expect(log).toContain('engine.shot_exclude');
  });

  it('engine text shown to the team carries no local paths (drive letters, UNC)', () => {
    expect(scrubPaths('gagal baca D:/VIBECODING/remotion/konten/x.mp4 dan \\\\nas\\share\\a.mp4 ok')).toBe('gagal baca <path> dan <path> ok');
  });

  it('batch list parsing tolerates the engine shapes and drops bad names', () => {
    expect(parseBatchList('{"schema":"daftar-batch/1","batch":[{"batch":"a","footage":3,"vo":2,"musik":1,"shot_library":true,"jumlah_shot":9}]}')[0]).toEqual({ batch: 'a', upload: 0, footage: 3, vo: 2, musik: 1, dipisah: true, dipisah_pada: null, shot_library: true, jumlah_shot: 9, siap_batch: true });
    expect(parseBatchList('log\n[{"batch":"../x"},{"batch":"b","footage":-1}]').map((b) => [b.batch, b.footage, b.siap_batch])).toEqual([['b', 0, false]]);
    expect(() => parseBatchList('bukan json')).toThrow();
  });

  it.skipIf(!hasFfmpeg)('batch table view: kalimat per variant (engine or ops fallback), exclusions passed in job.json, no media map', async () => {
    const { ws, cfg } = await setup();
    await createProject(ws, { project_id: 'b', name: 'Batch' });
    const input = validateEngineJob({ project_id: 'b', mode: 'batch', sources: [], preset: 'p', brief, ai: false, mode_ops: 'u3', batch: { batch: 'gambar', jumlah: 3, vo_batch: 'vo-lain' } });
    input.batch!.kecualikan_shot = ['F1#02']; // as the server does from setShotExclusions
    const s = await prepareEngineJob(ws, input);
    expect(await runEngineJob(ws, cfg, 'b', s.job_id)).toMatchObject({ state: 'siap', alasan: null });
    const view = await readEngineBatchView(ws, 'b', s.job_id);
    expect(view.media).toBeUndefined();
    expect(view).toMatchObject({ kecualikan_diterima: ['F1#02'], vo_batch: 'vo-lain' });
    const rows = view.varian as { id: string; kalimat: unknown[]; kalimat_sumber: string | null }[];
    expect(rows[0]).toMatchObject({ kalimat_sumber: 'mesin', kalimat: [{ teks: 'Hook 1', dari: 0, sampai: 0.8, shot: ['F1#00'] }, { teks: 'Cek keranjang', shot: ['F1#01', 'F1#00', 'F1＠1.5'] }] });
    // varian-002 has no kalimat from the engine: taken from its subtitle clips (no shots).
    expect(rows[1]).toMatchObject({ kalimat_sumber: 'ops', kalimat: [{ teks: 'Hook 2', dari: 0, sampai: 0.8, shot: [] }] });
  }, 90_000);
});
