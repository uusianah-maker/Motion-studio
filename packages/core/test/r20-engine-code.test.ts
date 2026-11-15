// R20 (owner: "Ya, pisahkan"): the engine's CODE may come from a release folder (MOTION_ENGINE_CODE)
// while its DATA stays in MOTION_ENGINE_ROOT. Without the new env everything is exactly as before.
// Every data path check stays on the data folder; the engine is told where its data is and which
// app core (timeline.js) to use.
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOTION_STUDIO_CORE, engineCode, engineConfigFromEnv, engineEnv } from '../src/storage/engine.js';
import { listEngineBatches, readShotThumbs } from '../src/storage/engineLibrary.js';
import { tempDir } from './helpers.js';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

describe('R20 engine code folder apart from its data', () => {
  it('no MOTION_ENGINE_CODE = exactly as before (code = root, script and python in root)', () => {
    const root = path.resolve('/data/mesin');
    const cfg = engineConfigFromEnv({ MOTION_ENGINE_ROOT: root })!;
    expect(cfg.root).toBe(root);
    expect(cfg.code).toBe(root);
    expect(engineCode(cfg)).toBe(root);
    expect(cfg.script).toBe(path.join(root, 'pipeline', 'engine.py'));
    expect(cfg.command.startsWith(path.join(root, '.venv'))).toBe(true);
    expect(engineConfigFromEnv({})).toBeNull();
    // A config written by hand (tests, older callers) without `code`: the root is the code folder.
    expect(engineCode({ root, command: 'python', script: 's', timeout_ms: 1 })).toBe(root);
  });

  it('MOTION_ENGINE_CODE: script from the release folder; python, data and cwd stay in root', () => {
    const root = path.resolve('/data/mesin');
    const code = path.resolve('/rilis/mesin-v4');
    const cfg = engineConfigFromEnv({ MOTION_ENGINE_ROOT: root, MOTION_ENGINE_CODE: ` ${code} ` })!;
    expect([cfg.root, cfg.code, cfg.script]).toEqual([root, code, path.join(code, 'pipeline', 'engine.py')]);
    expect(cfg.command.startsWith(path.join(root, '.venv'))).toBe(true);
    // An explicit script still wins (as before).
    expect(engineConfigFromEnv({ MOTION_ENGINE_ROOT: root, MOTION_ENGINE_CODE: code, MOTION_ENGINE_SCRIPT: 'x.py' })!.script).toBe('x.py');
  });

  it('engineEnv: MOTION_ENGINE_DATA = root and MOTION_STUDIO_CORE = this app core dist; secrets still dropped', async () => {
    const cfg = engineConfigFromEnv({ MOTION_ENGINE_ROOT: path.resolve('/data/mesin'), MOTION_ENGINE_CODE: path.resolve('/rilis/mesin') })!;
    const env = engineEnv({ PATH: 'p', MOTION_SECRET_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, cfg);
    expect(env).toMatchObject({ PATH: 'p', MOTION_ENGINE_DATA: cfg.root, MOTION_STUDIO_CORE });
    expect(env).not.toHaveProperty('MOTION_SECRET_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(path.basename(MOTION_STUDIO_CORE)).toBe('dist');
    expect(path.basename(path.dirname(MOTION_STUDIO_CORE))).toBe('core');
    expect((await fsp.stat(path.join(MOTION_STUDIO_CORE, 'storage', 'timeline.js'))).isFile()).toBe(true);
    // Without a config (older callers): no new variables.
    expect(engineEnv({ PATH: 'p' })).not.toHaveProperty('MOTION_ENGINE_DATA');
  });

  it('the engine query runs the code folder script in the data folder (cwd), with the new env', async () => {
    const root = await tempDir();
    const code = await tempDir();
    const cfg = { ...engineConfigFromEnv({ MOTION_ENGINE_ROOT: root, MOTION_ENGINE_CODE: code })!, command: 'python' };
    const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const spawnImpl = ((cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, cwd: o.cwd, env: o.env });
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() as EventEmitter & { setEncoding?: () => void }, stderr: new EventEmitter() as EventEmitter & { setEncoding?: () => void }, pid: 0, kill: () => true });
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      setTimeout(() => {
        child.stdout.emit('data', '{"batch":[]}\n');
        child.emit('close', 0);
      }, 5);
      return child;
    }) as never;
    await listEngineBatches(cfg, { spawnImpl }).catch(() => undefined);
    expect(calls[0]).toMatchObject({ cmd: 'python', args: [path.join(code, 'pipeline', 'engine.py'), 'daftar_batch'], cwd: path.resolve(root) });
    expect(calls[0]!.env).toMatchObject({ MOTION_ENGINE_DATA: path.resolve(root), MOTION_STUDIO_CORE });
  });

  it('data path checks stay on the data folder: a thumbnail inside the CODE folder is not served', async () => {
    const root = await tempDir();
    const code = await tempDir();
    const cfg = engineConfigFromEnv({ MOTION_ENGINE_ROOT: root, MOTION_ENGINE_CODE: code })!;
    const dir = path.join(root, 'konten', '2-dipisah', 'b1');
    await fsp.mkdir(path.join(dir, 'thumb'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'thumb', 'ok.jpg'), JPEG);
    await fsp.mkdir(path.join(code, 'thumb'), { recursive: true });
    await fsp.writeFile(path.join(code, 'thumb', 'kode.jpg'), JPEG);
    await fsp.writeFile(
      path.join(dir, 'shots.json'),
      JSON.stringify({ schema: 'shots/1', batch: 'b1', footage: {}, shots: [{ id: 'F1#00', footage: 'F1', dari: 0, sampai: 1, thumb: path.join(dir, 'thumb', 'ok.jpg') }, { id: 'F1#01', footage: 'F1', dari: 1, sampai: 2, thumb: path.join(code, 'thumb', 'kode.jpg') }] }),
    );
    const t = await readShotThumbs(cfg, 'b1', ['F1#00', 'F1#01']);
    expect(Object.keys(t)).toEqual(['F1#00']);
  });
});
