// R9 over HTTP: an editor's change to an engine draft is written to the brand's learning log;
// the same change on a hand-made project is not.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { StorageService, createProject, initWorkspace, markEngineOrigin, readLearning, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('R9 learning notes via the edit route', () => {
  it('records words / hook / cut corrections only on an engine draft', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r9-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const svc = new StorageService(ws);
    const b = (await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS' }, actor: 'user' })).result;
    for (const id of ['mesin', 'manual']) {
      await createProject(ws, { project_id: id, name: id });
      await svc.updateProjectMeta({ project_id: id, expected_revision: (await readProject(ws, id)).revision, brand_id: b.brand_id, actor: 'user' });
      await svc.editTimeline({ project_id: id, expected_revision: (await readProject(ws, id)).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Diskon 50%', start_ms: 0, duration_ms: 2000 }] });
    }
    await markEngineOrigin(ws, 'mesin', { kind: 'generate', job_id: 'AYS-20261115-001' });
    const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }) });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const edit = (id: string, rev: number, ops: unknown[]) =>
      new Promise<number>((resolve, reject) => {
        const data = Buffer.from(JSON.stringify({ expected_revision: rev, ops }));
        const r = http.request({ host: HOST, port, path: `/api/projects/${id}/edit`, method: 'POST', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, 'content-type': 'application/json', 'content-length': String(data.length) } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        r.on('error', reject);
        r.end(data);
      });
    for (const id of ['mesin', 'manual']) {
      const p = await readProject(ws, id);
      const hook = p.timeline.tracks.find((t) => t.kind === 'text')!.clips[0]!.clip_id;
      expect(await edit(id, p.revision, [{ op: 'set_text', clip_id: hook, text: 'Diskon 50% hari ini' }])).toBe(200);
    }
    const log = await readLearning(ws, b.brand_id);
    expect(log).toEqual([expect.objectContaining({ jenis: 'koreksi', bagian: 'hook', project_id: 'mesin', sebelum: 'Diskon 50%', sesudah: 'Diskon 50% hari ini', asal: expect.objectContaining({ kind: 'generate', job_id: 'AYS-20261115-001' }) })]);
  });
});
