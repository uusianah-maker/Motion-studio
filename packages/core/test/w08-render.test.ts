import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { createLease, loadLeases, releaseOrphanLeases } from '../src/storage/deps.js';
import { isStorageError } from '../src/storage/errors.js';
import { checkTools, verifyCleanOutput } from '../src/storage/ffmpeg.js';
import { recoverOnStartup } from '../src/storage/recovery.js';
import { DEFAULT_RENDER, STRIP_METADATA_ARGS, buildRenderPlan, canvasSize, listOutputs, renderProject, visualSegments, wrapText } from '../src/storage/render.js';
import type { Timeline } from '../src/storage/project.js';
import { importMedia, loadRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { runAutoTrash } from '../src/storage/trash.js';
import { createProject, readProject } from '../src/storage/workspace.js';
import { DAY_MS } from '../src/storage/clock.js';
import { fixtureWorkspace, importShared } from './fixtures.js';
import { tempDir } from './helpers.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const acode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};
const ff = (args: string[]) => execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
/** Mean loudness (dB) of a time window; silence ≈ -91 dB or -inf. */
const meanVolume = (file: string, from: number, dur: number): number => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' }).stderr;
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r);
  return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : NaN;
};
/** Average luma (0–255) of one frame at `t` seconds. */
const luma = (file: string, t: number): number => {
  const buf = ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return buf[0]!;
};

async function realMediaWorkspace() {
  const fx = await fixtureWorkspace();
  const svc = new StorageService(fx.ws);
  const imp = async (file: string) => {
    const r = await svc.importMedia({ sourcePath: file, scope: { kind: 'shared' }, actor: 'user' });
    return { media_id: r.media.media_id, version_id: r.version.version_id };
  };
  // A source carrying identifying metadata (title, comment, GPS-like location, artist).
  const tagged = path.join(fx.src, 'tagged.mp4');
  ff([
    '-i', path.join(FIX, 'sample_8s_9x16.mp4'),
    '-c', 'copy',
    '-metadata', 'title=OWNER-SECRET-TITLE-7781',
    '-metadata', 'comment=Lokasi rahasia owner 9921',
    '-metadata', 'artist=Nama Asli Pembuat',
    '-metadata', 'location=+06.1754+106.8272/',
    tagged,
  ]);
  const main = await imp(tagged);
  const broll = await imp(path.join(FIX, 'sample_3s_16x9.mp4'));
  await createProject(fx.ws, { project_id: 'promo', name: 'Promo' });
  return { ...fx, svc, main, broll };
}

const edit = async (svc: StorageService, ops: unknown[]) => {
  const p = await readProject(svc.ws, 'promo');
  return svc.editTimeline({ project_id: 'promo', expected_revision: p.revision, ops, actor: 'user' });
};
const SMALL = { short_side: 240, preset: 'ultrafast' as const };

describe('W08 render plan (pure)', () => {
  it('canvas sizes are even and keep the ratio; 1080 short side for every ratio', () => {
    expect(canvasSize('9:16', 1080)).toEqual({ width: 1080, height: 1920 });
    expect(canvasSize('16:9', 1080)).toEqual({ width: 1920, height: 1080 });
    expect(canvasSize('1:1', 1080)).toEqual({ width: 1080, height: 1080 });
    expect(canvasSize('3:4', 1080)).toEqual({ width: 1080, height: 1440 });
    expect(canvasSize('9:16', 241)).toEqual({ width: 242, height: 430 });
  });

  it('visual runs follow the preview rule: b-roll over video, black gaps, frame-snapped', () => {
    const m = { media_id: 'm_1', version_id: 'v_1' };
    const t: Timeline = {
      tracks: [
        { track_id: 'tv', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 2000, media: m }, { clip_id: 'b', start_ms: 3000, end_ms: 5000, media: m }] },
        { track_id: 'tb', kind: 'broll', clips: [{ clip_id: 'r', start_ms: 1510, end_ms: 2490, media: m }] },
        { track_id: 'tt', kind: 'text', clips: [{ clip_id: 'x', start_ms: 4000, end_ms: 6000, text: 'CTA' }] },
      ],
    };
    const segs = visualSegments(t, 30).map((s) => [s.from_frame, s.to_frame, s.clip?.clip_id ?? null]);
    // 1510 ms → frame 45, 2490 ms → frame 75; text extends the end to 6 s (black after b).
    expect(segs).toEqual([[0, 45, 'a'], [45, 75, 'r'], [75, 90, null], [90, 150, 'b'], [150, 180, null]]);
  });

  it('wraps text on words and breaks words longer than a line', () => {
    expect(wrapText('Halo dunia yang indah sekali', 10)).toBe('Halo dunia\nyang indah\nsekali');
    expect(wrapText('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij\nklmnopqrst\nuvwxyz');
    expect(wrapText('a\r\nb', 10)).toBe('a\nb');
  });

  it('plan: metadata stripped, text from files (no escaping), audio mixed, exact length', () => {
    const m = { media_id: 'm_1', version_id: 'v_1' };
    const t: Timeline = {
      canvas: { ratio: '16:9' },
      tracks: [
        { track_id: 'tv', kind: 'video', clips: [{ clip_id: 'a', start_ms: 0, end_ms: 1000, in_ms: 500, media: m }] },
        { track_id: 'ta', kind: 'audio', clips: [{ clip_id: 'au', start_ms: 200, end_ms: 900, media: m }] },
        { track_id: 'ts', kind: 'subtitle', clips: [{ clip_id: 's', start_ms: 0, end_ms: 1000, text: "50% off: [now]; it's 'free'" }] },
      ],
    };
    const inputs = new Map([['v_1', { path: 'C:/x y/src.mp4', probe: { duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac' } }]]);
    const plan = buildRenderPlan(t, inputs, { ...DEFAULT_RENDER, short_side: 360 }, 'C:/Windows/Fonts/arialbd.ttf');
    expect(plan).toMatchObject({ width: 640, height: 360, total_ms: 1000, total_frames: 30 });
    const joined = plan.args.join(' ');
    for (const a of STRIP_METADATA_ARGS) expect(plan.args).toContain(a);
    expect(joined).toContain('-ss 0.5 -t 1 -i C:/x y/src.mp4');
    expect(joined).toContain('-/filter_complex graph.txt');
    expect(plan.files).toEqual([{ name: 't0.txt', content: "50% off: [now]; it's 'free'" }]);
    expect(plan.graph).toContain('textfile=t0.txt:expansion=none');
    expect(plan.graph).not.toContain('50%');
    expect(plan.graph).toContain('adelay=delays=200:all=1');
    expect(plan.graph).toContain('amix=inputs=2:duration=first:normalize=0');
    expect(() => buildRenderPlan(t, inputs, DEFAULT_RENDER, null)).toThrow(/Font/);
    expect(() => buildRenderPlan({ tracks: [] }, inputs, DEFAULT_RENDER, null)).toThrow(/kosong/);
  });
});

describe.skipIf(!hasFfmpeg)('W08 render MP4 (FFmpeg nyata)', () => {
  it('tools check passes on this machine (FFmpeg ≥7, libx264, drawtext, ffprobe)', async () => {
    expect(await checkTools()).toMatchObject({ ok: true, problems: [] });
  });

  it('renders the timeline like the preview; output has NO metadata, originals untouched', async () => {
    const fx = await realMediaWorkspace();
    const reg0 = await loadRegistry(fx.ws);
    const srcHash = reg0.versions[fx.main.version_id]!.content_hash;
    await edit(fx.svc, [
      { op: 'add_clip', track_kind: 'video', media: fx.main, start_ms: 0, duration_ms: 2000, in_ms: 1000 },
      { op: 'add_clip', track_kind: 'video', media: fx.main, start_ms: 3000, duration_ms: 1500 },
      { op: 'add_clip', track_kind: 'broll', media: fx.broll, start_ms: 1000, duration_ms: 500 },
      { op: 'add_clip', track_kind: 'text', text: 'OWNER-SECRET-TITLE-7781 tampil sebagai piksel saja', start_ms: 0, duration_ms: 1000 },
      { op: 'add_clip', track_kind: 'subtitle', text: 'Diskon 50%: {hari ini}', start_ms: 3000, duration_ms: 1500 },
      { op: 'set_canvas', ratio: '9:16' },
    ]);
    const phases: string[] = [];
    let last = 0;
    const r = await renderProject(fx.ws, { project_id: 'promo', output_name: 'final.mp4', actor: 'user' }, { settings: SMALL, onPhase: (p) => phases.push(p), onProgress: (f) => (last = f) });
    expect(phases).toEqual(['preflight', 'preparing', 'encoding', 'verifying', 'saving']);
    expect(last).toBeGreaterThan(0.5);
    if (r.status !== 'completed') throw new Error('not completed');
    expect(r.output).toMatchObject({ rel: 'PROJECTS/promo/05_OUTPUT/final.mp4', name: 'final.mp4', width: 240, height: 426, metadata_clean: true });
    expect(Math.abs(r.output.duration_ms - 4500)).toBeLessThanOrEqual(100);
    const file = path.join(fx.ws.root, r.output.rel);

    // Independent check (not the app's own verifier): ffprobe tags + raw bytes.
    const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
    expect(Object.keys(probe.format.tags ?? {}).sort()).toEqual(['compatible_brands', 'major_brand', 'minor_version']);
    for (const s of probe.streams) expect(Object.keys(s.tags ?? {}).every((k: string) => ['language', 'handler_name', 'vendor_id'].includes(k))).toBe(true);
    expect(probe.chapters).toEqual([]);
    const bytes = (await fsp.readFile(file)).toString('latin1');
    for (const marker of ['Lavf', 'Lavc', 'x264', 'OWNER-SECRET', 'Lokasi rahasia', 'Nama Asli', '+106.8272']) expect(bytes.includes(marker), marker).toBe(false);
    // The source DID carry them (so the test proves removal, not absence).
    const srcBytes = (await fsp.readFile(path.join(fx.ws.root, reg0.versions[fx.main.version_id]!.rel_path))).toString('latin1');
    expect(srcBytes.includes('OWNER-SECRET-TITLE-7781')).toBe(true);

    // Picture/sound follow the timeline: video → b-roll (no audio) → black gap → video.
    expect(luma(file, 0.5)).toBeGreaterThan(40);
    expect(luma(file, 2.5)).toBeLessThan(25);
    expect(meanVolume(file, 0.2, 0.6)).toBeGreaterThan(-40);
    expect(meanVolume(file, 1.1, 0.3)).toBeLessThan(-80); // b-roll clip has no audio stream
    expect(meanVolume(file, 2.1, 0.7)).toBeLessThan(-80);
    expect(meanVolume(file, 3.2, 0.6)).toBeGreaterThan(-40);

    // Output is final and read-only; originals unchanged; lease released; audited.
    await expect(fsp.writeFile(file, 'x')).rejects.toThrow();
    expect((await loadRegistry(fx.ws)).versions[fx.main.version_id]!.content_hash).toBe(srcHash);
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
    const done = await readAudit(fx.ws, (e) => e.op === 'render.complete');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outcome: 'ok', output: { hash: r.output.hash, metadata_clean: true } });

    // Same name again → versioned, the first final is never overwritten.
    const r2 = await renderProject(fx.ws, { project_id: 'promo', output_name: 'final.mp4', actor: 'user' }, { settings: SMALL });
    expect(r2.status === 'completed' && r2.output.name).toBe('final_v2.mp4');
    expect((await listOutputs(fx.ws, 'promo')).map((o) => o.name).sort()).toEqual(['final.mp4', 'final_v2.mp4']);
  }, 120_000);

  it('failed metadata verification = failed render: nothing saved, lease released, temp removed', async () => {
    const fx = await realMediaWorkspace();
    await edit(fx.svc, [{ op: 'add_clip', track_kind: 'video', media: fx.main, start_ms: 0, duration_ms: 1000 }]);
    const tmpRoot = await tempDir('render-tmp-');
    const c = await acode(
      renderProject(fx.ws, { project_id: 'promo', output_name: 'dirty.mp4', actor: 'user' }, {
        settings: SMALL,
        tmpRoot,
        afterEncode: (f) => fsp.appendFile(f, Buffer.from('Lavf61.7.100 leaked')),
      }),
    );
    expect(c).toBe('RENDER_FAILED');
    expect(await listOutputs(fx.ws, 'promo')).toEqual([]);
    expect(await fsp.readdir(tmpRoot)).toEqual([]);
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
    const v = await readAudit(fx.ws, (e) => e.op === 'render.verify');
    expect(v[0]).toMatchObject({ outcome: 'failed' });
    expect(String(v[0]?.problems)).toMatch(/jejak encoder/);
  }, 60_000);

  it('cancel stops FFmpeg; no output, lease released', async () => {
    const fx = await realMediaWorkspace();
    await edit(fx.svc, [{ op: 'add_clip', track_kind: 'video', media: fx.main, start_ms: 0, duration_ms: 8000 }]);
    const ac = new AbortController();
    const c = await acode(
      renderProject(fx.ws, { project_id: 'promo', output_name: 'x.mp4', actor: 'user' }, { settings: { short_side: 1080, preset: 'medium' }, signal: ac.signal, onPhase: (p) => p === 'encoding' && ac.abort() }),
    );
    expect(c).toBe('CANCELLED');
    expect(await listOutputs(fx.ws, 'promo')).toEqual([]);
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
    expect((await readAudit(fx.ws, (e) => e.op === 'render.failed'))[0]).toMatchObject({ result: 'cancelled' });
  }, 60_000);

  it('verifier flags metadata on a normal (unstripped) FFmpeg output', async () => {
    const dir = await tempDir('dirty-');
    const f = path.join(dir, 'dirty.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=240x426:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-metadata', 'title=Judul Bocor 1234', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', f]);
    const r = await verifyCleanOutput(f, { width: 240, height: 426, duration_ms: 1000, source_markers: ['Judul Bocor 1234'] });
    expect(r.ok).toBe(false);
    expect(r.problems.join('|')).toMatch(/tag tersisa: format\.title/);
    expect(r.problems.join('|')).toMatch(/jejak encoder/);
    expect(r.problems.join('|')).toMatch(/metadata file sumber/);
  });
});

describe('W08 render guards', () => {
  it('AI can never render; blocked preflight returns problems without a lease', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'promo', name: 'P' });
    expect(await acode(renderProject(fx.ws, { project_id: 'promo', output_name: 'a.mp4', actor: 'ai' }))).toBe('FORBIDDEN');
  });

  it.skipIf(!hasFfmpeg)('changed media → blocked (no lease, no output)', async () => {
    const fx = await realMediaWorkspace();
    await edit(fx.svc, [{ op: 'add_clip', track_kind: 'video', media: fx.main, start_ms: 0, duration_ms: 1000 }]);
    const raw = await readProject(fx.ws, 'promo');
    // Bytes changed outside the app after import.
    const reg = await loadRegistry(fx.ws);
    const abs = path.join(fx.ws.root, reg.versions[fx.main.version_id]!.rel_path);
    await fsp.chmod(abs, 0o666);
    await fsp.appendFile(abs, 'changed');
    const r = await renderProject(fx.ws, { project_id: 'promo', output_name: 'a.mp4', actor: 'user' }, { settings: SMALL });
    expect(r.status).toBe('blocked');
    expect(r.status === 'blocked' && r.preflight.problems.map((p) => p.code)).toEqual(['MEDIA_CHANGED']);
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
    expect(raw.revision).toBe(1);
  });

  it('missing FFmpeg → RENDER_UNAVAILABLE before any lease', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'promo', name: 'P' });
    const prev = process.env.MOTION_FFMPEG;
    process.env.MOTION_FFMPEG = path.join(os.tmpdir(), 'no-such-ffmpeg-binary');
    try {
      expect(await acode(renderProject(fx.ws, { project_id: 'promo', output_name: 'a.mp4', actor: 'user' }))).toBe('RENDER_UNAVAILABLE');
    } finally {
      if (prev === undefined) delete process.env.MOTION_FFMPEG;
      else process.env.MOTION_FFMPEG = prev;
    }
    expect((await loadLeases(fx.ws)).leases).toEqual([]);
  });

  it('server start releases leases of dead workers only (never CLI/no-pid or live ones)', async () => {
    const fx = await fixtureWorkspace();
    const m = await importShared(fx.ws, fx.src);
    const dead = await createLease(fx.ws, { job: 'render', label: 'dead', media: [m], actor: 'user', worker_pid: 999_001 });
    const live = await createLease(fx.ws, { job: 'render', label: 'live', media: [m], actor: 'user', worker_pid: 999_002 });
    const mine = await createLease(fx.ws, { job: 'render', label: 'self pid reused', media: [m], actor: 'user', worker_pid: 4242 });
    const cli = await createLease(fx.ws, { job: 'render', label: 'cli', media: [m], actor: 'user' });
    const released = await releaseOrphanLeases(fx.ws, { selfPid: 4242, alive: (pid) => pid === 999_002 });
    expect(released.sort()).toEqual([dead.lease_id, mine.lease_id].sort());
    expect((await loadLeases(fx.ws)).leases.map((l) => l.lease_id).sort()).toEqual([live.lease_id, cli.lease_id].sort());
    expect(await readAudit(fx.ws, (e) => e.op === 'lease.orphans_released')).toHaveLength(1);
  });

  it('recovery sweeps stale output staging temps in 05_OUTPUT, never finals', async () => {
    const fx = await fixtureWorkspace();
    await createProject(fx.ws, { project_id: 'promo', name: 'P' });
    const out = path.join(fx.ws.root, 'PROJECTS/promo/05_OUTPUT');
    await fsp.writeFile(path.join(out, '.importing-op_00000000deadbeef'), 'partial');
    await fsp.writeFile(path.join(out, 'v_0123456789abcdef.mp4'), 'a final the user named like a version id');
    const old = new Date(Date.now() - 2 * DAY_MS);
    await fsp.utimes(path.join(out, '.importing-op_00000000deadbeef'), old, old);
    const rep = await recoverOnStartup(fx.ws);
    expect(rep.removed_temp_files).toEqual(['PROJECTS/promo/05_OUTPUT/.importing-op_00000000deadbeef']);
    expect(rep.orphan_files).toEqual([]);
    expect(await fsp.readdir(out)).toEqual(['v_0123456789abcdef.mp4']);
  });

  it('import of real media still never trashes leased render inputs (GC unchanged)', async () => {
    const fx = await fixtureWorkspace();
    const r = await importMedia(fx.ws, { sourcePath: path.join(FIX, 'not_video.txt'), scope: { kind: 'shared' }, actor: 'user' });
    await createLease(fx.ws, { job: 'render', label: 'x', media: [{ media_id: r.media.media_id, version_id: r.version.version_id }], actor: 'user', worker_pid: process.pid });
    fx.clock.advance(60 * DAY_MS);
    expect((await runAutoTrash(fx.ws, { actor: 'scheduler' })).moved).toEqual([]);
  });
});
