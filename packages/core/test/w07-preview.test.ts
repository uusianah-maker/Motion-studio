import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAudit } from '../src/storage/audit.js';
import { isStorageError } from '../src/storage/errors.js';
import { probeFile } from '../src/storage/probe.js';
import { getDashboard } from '../src/storage/quota.js';
import { backfillProbes, importMedia, loadRegistry, saveRegistry } from '../src/storage/registry.js';
import { StorageService } from '../src/storage/service.js';
import { applyOps, stepHistory, editManifest } from '../src/storage/timeline.js';
import { createProject } from '../src/storage/workspace.js';
import { fixtureWorkspace, importShared } from './fixtures.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const hasFfprobe = (() => {
  try {
    execFileSync(process.env.MOTION_FFPROBE || 'ffprobe', ['-version'], { stdio: 'ignore', windowsHide: true });
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
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return isStorageError(e) ? e.code : `RAW:${String(e)}`;
  }
};

describe.skipIf(!hasFfprobe)('W07 probe (ffprobe)', () => {
  it('reads duration, size and codecs of a real MP4; text files are not media', async () => {
    expect(await probeFile(path.join(FIX, 'sample_8s_9x16.mp4'))).toEqual({ duration_ms: 8000, width: 360, height: 640, video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p', fps: 25 }); // R25b: + pix_fmt, fps
    expect(await probeFile(path.join(FIX, 'not_video.txt'))).toBeNull();
  });

  it('import stores the probe; a version without probe is backfilled once', async () => {
    const fx = await fixtureWorkspace();
    const src = path.join(fx.src, 'clip.mp4');
    await fsp.copyFile(path.join(FIX, 'sample_3s_16x9.mp4'), src);
    const r = await importMedia(fx.ws, { sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    expect(r.version.probe).toMatchObject({ duration_ms: expect.any(Number), width: expect.any(Number), video_codec: 'h264' });
    // Simulate a version imported before W07.
    const reg = await loadRegistry(fx.ws);
    delete reg.versions[r.version.version_id]!.probe;
    await saveRegistry(fx.ws, reg);
    expect((await backfillProbes(fx.ws)).probed).toEqual([r.version.version_id]);
    expect((await loadRegistry(fx.ws)).versions[r.version.version_id]!.probe).toEqual(r.version.probe);
    expect((await backfillProbes(fx.ws)).probed).toEqual([]); // idempotent
  });

  it('missing ffprobe leaves the probe empty (retry later), never "not media"', async () => {
    const fx = await fixtureWorkspace();
    const prev = process.env.MOTION_FFPROBE;
    process.env.MOTION_FFPROBE = path.join(fx.src, 'no-such-ffprobe.exe');
    try {
      const src = path.join(fx.src, 'clip.mp4');
      await fsp.copyFile(path.join(FIX, 'sample_3s_16x9.mp4'), src);
      const r = await importMedia(fx.ws, { sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
      expect(r.version.probe).toBeUndefined();
      expect((await backfillProbes(fx.ws)).probed).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MOTION_FFPROBE;
      else process.env.MOTION_FFPROBE = prev;
    }
  });

  it('edits never run past the end of the source video', async () => {
    const fx = await fixtureWorkspace();
    const svc = new StorageService(fx.ws);
    await createProject(fx.ws, { project_id: 'p', name: 'P' });
    const src = path.join(fx.src, 'eight.mp4');
    await fsp.copyFile(path.join(FIX, 'sample_8s_9x16.mp4'), src);
    const r = await importMedia(fx.ws, { sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    const media = { media_id: r.media.media_id, version_id: r.version.version_id };
    expect(await acode(svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 9000 }], actor: 'user' }))).toBe('EDIT_INVALID');
    const ok = await svc.editTimeline({ project_id: 'p', expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 8000 }], actor: 'user' });
    const clip = ok.result.timeline.tracks[0]!.clips[0]!;
    expect(await acode(svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'trim_clip', clip_id: clip.clip_id, edge: 'end', to_ms: 8100 }], actor: 'user' }))).toBe('EDIT_INVALID');
    const trimmed = await svc.editTimeline({ project_id: 'p', expected_revision: 1, ops: [{ op: 'trim_clip', clip_id: clip.clip_id, edge: 'start', to_ms: 3000 }], actor: 'user' });
    expect(trimmed.result.timeline.tracks[0]!.clips[0]).toMatchObject({ start_ms: 3000, end_ms: 8000, in_ms: 3000 });
  });
});

describe('W07 text clips and canvas ratio', () => {
  const ids = (() => {
    let n = 0;
    return () => `c_${++n}`;
  })();
  it('text clips need text and live only on text/subtitle tracks; set_text edits them', () => {
    const t1 = applyOps({ tracks: [] }, [{ op: 'add_clip', track_kind: 'text', text: 'Hook elegan', start_ms: 0, duration_ms: 3000 }], ids);
    const id = t1.tracks[0]!.clips[0]!.clip_id;
    expect(t1.tracks[0]!.clips[0]!.text).toBe('Hook elegan');
    expect(applyOps(t1, [{ op: 'set_text', clip_id: id, text: 'Join live!' }], ids).tracks[0]!.clips[0]!.text).toBe('Join live!');
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'subtitle', start_ms: 0, duration_ms: 1000 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'video', text: 'x', start_ms: 0, duration_ms: 1000 }], ids))).toBe('EDIT_INVALID');
    expect(code(() => applyOps(t1, [{ op: 'add_clip', track_kind: 'video', media: { media_id: 'm_1', version_id: 'v_1' }, text: 'x', start_ms: 5000, duration_ms: 1000 }], ids))).toBe('EDIT_INVALID');
  });

  it('canvas ratio is part of the timeline: undo brings the old ratio back', () => {
    const m0 = { schema_version: 1 as const, project_id: 'p', name: 'P', status: 'active' as const, revision: 0, created_at: 0, updated_at: 0, timeline: { tracks: [] }, snapshots: [] };
    const ctx = { now: 1, newId: () => `snap_${Math.random().toString(16).slice(2, 10)}`, newClipId: ids };
    const m1 = editManifest(m0, [{ op: 'set_canvas', ratio: '1:1' }], 'Ubah rasio', ctx);
    expect(m1.timeline.canvas).toEqual({ ratio: '1:1' });
    expect(stepHistory(m1, 'undo', ctx).timeline.canvas).toBeUndefined();
  });
});

describe('W07 / Checkpoint D F6: dashboard is read-only', () => {
  it('a dashboard view writes no audit entry and hashes nothing', async () => {
    const fx = await fixtureWorkspace();
    await importShared(fx.ws, fx.src);
    let hashed = 0;
    const realHash = fx.ws.blobs.hash.bind(fx.ws.blobs);
    (fx.ws.blobs as { hash: typeof realHash }).hash = async (rel: string) => {
      hashed++;
      return realHash(rel);
    };
    const before = (await readAudit(fx.ws)).length;
    const d = await getDashboard(fx.ws, { disk: null });
    expect(d.gc.ok).toBe(true);
    expect((await readAudit(fx.ws)).length).toBe(before);
    expect(hashed).toBe(0);
  });
});

describe('W07 byte-range reads from the backend', () => {
  it('readStream returns exactly the requested inclusive range', async () => {
    const fx = await fixtureWorkspace();
    const src = path.join(fx.src, 'bytes.bin');
    await fsp.writeFile(src, Buffer.from('0123456789'));
    const r = await importMedia(fx.ws, { sourcePath: src, scope: { kind: 'shared' }, actor: 'user' });
    const read = async (range?: { start: number; end: number }) => {
      const chunks: Buffer[] = [];
      for await (const c of await fx.ws.blobs.readStream(r.version.rel_path, range)) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString();
    };
    expect(await read()).toBe('0123456789');
    expect(await read({ start: 2, end: 5 })).toBe('2345');
  });
});
