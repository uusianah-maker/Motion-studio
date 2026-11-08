import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDeploy } from '../../../scripts/check-deploy.mjs';
import { HOST, createApp } from '../src/app.js';
import { initWorkspace } from '../src/core.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w15-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
const get = (port: number, p: string, host: string) =>
  new Promise<http.IncomingMessage>((resolve, reject) => {
    const r = http.request({ host: HOST, port, path: p, headers: { host } }, (res) => {
      res.resume();
      resolve(res);
    });
    r.on('error', reject);
    r.end();
  });

describe('W15 online deployment', () => {
  it('HSTS on every response when served behind an https public origin; none in local mode', async () => {
    const dir = await tmp();
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const online = createApp({ ws, publicOrigin: 'https://motion.example.com' });
    const p1 = await online.listen(0);
    cleanup.push(() => online.close());
    for (const p of ['/api/health', '/api/session', '/api/nope']) expect((await get(p1, p, 'motion.example.com')).headers['strict-transport-security']).toBe('max-age=15552000');
    expect((await get(p1, '/api/health', 'evil.example')).statusCode).toBe(403);
    const local = createApp({ ws });
    const p2 = await local.listen(0);
    cleanup.push(() => local.close());
    expect((await get(p2, '/api/health', `${HOST}:${p2}`)).headers['strict-transport-security']).toBeUndefined();
  });

  it('check:deploy flags what must be fixed before going online', async () => {
    const dir = await tmp();
    const ws = path.join(dir, 'ws');
    await initWorkspace(ws);
    const level = async (env: Record<string, string>, what: RegExp) => (await checkDeploy(env, null)).find((l) => what.test(l.what))?.level;
    expect(await level({ MOTION_WORKSPACE: ws, MOTION_PUBLIC_URL: 'https://motion.example.com' }, /butuh login Google/)).toBe('FAIL');
    expect(await level({ MOTION_WORKSPACE: ws, MOTION_PUBLIC_URL: 'http://motion.example.com' }, /harus https/)).toBe('FAIL');
    expect(await level({ MOTION_WORKSPACE: ws, MOTION_GOOGLE_CLIENT_ID: 'x' }, /setengah terisi/)).toBe('FAIL');
    expect(await level({ MOTION_WORKSPACE: path.join(dir, 'nope') }, /Workspace/)).toBe('FAIL');
    const good = await checkDeploy({ MOTION_WORKSPACE: ws, MOTION_PORT: '4317', MOTION_PUBLIC_URL: 'https://motion.example.com', MOTION_GOOGLE_CLIENT_ID: 'c', MOTION_GOOGLE_CLIENT_SECRET: 's', MOTION_ALLOWED_EMAILS: 'a@b.co' }, null);
    expect(good.filter((l) => l.level === 'FAIL' && !/FFmpeg|Font|Build|dibuild/.test(l.what))).toEqual([]);
    expect(good.find((l) => /Redirect URI/.test(l.what))?.detail).toBe('https://motion.example.com/api/auth/callback');
    expect(JSON.stringify(good)).not.toContain('"s"'); // never echoes the client secret
  });
});
