// R6 (contract §13): render of a Batch variant → `riwayat.py tandai <kode> <job> dirender <varian>`;
// batch rows struck → `lepas`, approved → `tandai … disetujui`. Arguments checked, no shell,
// failures never escape. The engine is not run here: the spawn is recorded.
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type EngineConfig, StorageService, createProject, initWorkspace, markEngineOrigin } from '../src/core.js';
import { createRiwayatSignal } from '../src/riwayat.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function fakeSpawn(calls: { cmd: string; args: string[]; cwd: string }[], code = 0) {
  return ((cmd: string, args: string[], o: { cwd: string }) => {
    calls.push({ cmd, args, cwd: o.cwd });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { resume: () => void }; stderr: EventEmitter & { setEncoding: () => void }; pid: number; kill: () => boolean };
    child.stdout = Object.assign(new EventEmitter(), { resume: () => undefined });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    child.pid = 0;
    child.kill = () => true;
    setTimeout(() => {
      if (code) child.stderr.emit('data', 'ValueError: kunci brand tidak valid\n');
      child.emit('close', code);
    }, 5);
    return child;
  }) as never;
}

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r6-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ws = await initWorkspace(path.join(dir, 'ws'));
  await new StorageService(ws).createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
  await createProject(ws, { project_id: 'master', name: 'Master' });
  await createProject(ws, { project_id: 'var1', name: 'Varian 1' });
  await createProject(ws, { project_id: 'biasa', name: 'Biasa' });
  await markEngineOrigin(ws, 'var1', { kind: 'batch', job_id: 'AYS-20261115-004', varian: 'varian-002' });
  const cfg: EngineConfig = { root: path.join(dir, 'engine'), command: 'python', script: 'pipeline/engine.py', timeout_ms: 60_000 };
  return { ws, cfg };
}

describe('R6 riwayat signal', () => {
  it('render done on a Batch variant → tandai dirender; other projects send nothing', async () => {
    const { ws, cfg } = await setup();
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const r = createRiwayatSignal(ws, cfg, { spawnImpl: fakeSpawn(calls) });
    await r.rendered('var1');
    await r.rendered('biasa');
    await r.idle();
    expect(calls).toEqual([{ cmd: 'python', args: [path.join(cfg.root, 'pipeline', 'batch', 'riwayat.py'), 'tandai', 'AYS', 'AYS-20261115-004', 'dirender', 'varian-002'], cwd: cfg.root }]);
  });

  it('batch decisions: struck → lepas, approved → tandai disetujui; bad ids are not sent', async () => {
    const { ws, cfg } = await setup();
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const r = createRiwayatSignal(ws, cfg, { spawnImpl: fakeSpawn(calls) });
    await r.decided('master', 'AYS-20261115-004', [
      { varian: 'varian-001', status: 'dicoret' },
      { varian: 'varian-003', status: 'dicoret' },
      { varian: 'varian-002', status: 'disetujui' },
      { varian: '--reset', status: 'dicoret' },
      { varian: 'varian-004', status: 'usul' },
    ]);
    await r.decided('master', '../evil', [{ varian: 'varian-001', status: 'dicoret' }]);
    await r.idle();
    expect(calls.map((c) => c.args.slice(1))).toEqual([
      ['lepas', 'AYS', 'AYS-20261115-004', 'varian-001', 'varian-003'],
      ['tandai', 'AYS', 'AYS-20261115-004', 'disetujui', 'varian-002'],
    ]);
  });

  it('a failing engine call or no engine never throws; the error is reported', async () => {
    const { ws, cfg } = await setup();
    const errors: unknown[] = [];
    const r = createRiwayatSignal(ws, cfg, { spawnImpl: fakeSpawn([], 1), onError: (e) => errors.push(e) });
    await expect(r.rendered('var1')).resolves.toBeUndefined();
    expect(String(errors[0])).toContain('riwayat tandai gagal (kode 1)');
    const none = createRiwayatSignal(ws, null, { spawnImpl: fakeSpawn(errors as never) });
    await none.rendered('var1');
    expect(errors).toHaveLength(1);
  });
});
