// Smoke check of the BUILT outputs: storage core (packages/core/dist) importable and its CLI runs
// (init + dashboard on a fresh temp workspace); server (apps/server/dist) starts and answers.
// Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDist = path.join(root, 'packages', 'core', 'dist');
const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

const service = await import(pathToFileURL(path.join(coreDist, 'storage', 'service.js')).href);
if (typeof service.StorageService !== 'function') fail('StorageService tidak diekspor dari packages/core/dist');

const cli = path.join(coreDist, 'cli', 'motion-storage.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'motion-smoke-'));
try {
  const ws = path.join(tmp, 'ws');
  const init = JSON.parse(execFileSync(process.execPath, [cli, 'init', ws, '--json'], { encoding: 'utf8' }));
  if (!init.workspace_id) fail('CLI init tidak mengembalikan workspace_id');
  const dash = JSON.parse(execFileSync(process.execPath, [cli, 'dashboard', ws, '--json'], { encoding: 'utf8' }));
  if (!dash.gc || dash.gc.ok !== true) fail(`dashboard workspace baru tidak ok: ${JSON.stringify(dash.gc)}`);

  // Built server (apps/server/dist): start on a free loopback port, check health + session.
  const { start } = await import(pathToFileURL(path.join(root, 'apps', 'server', 'dist', 'main.js')).href);
  const s = await start({ MOTION_WORKSPACE: ws, MOTION_PORT: '0' }, () => undefined);
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    if (health.ok !== true) fail('server health tidak ok');
    const noToken = await fetch(`${base}/api/session`);
    if (noToken.status !== 401) fail(`session tanpa token harus 401, dapat ${noToken.status}`);
    const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${s.app.token}` } }).then((r) => r.json());
    if (session.actor !== 'user' || session.workspace_id !== init.workspace_id) fail(`session salah: ${JSON.stringify(session)}`);
  } finally {
    await s.app.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('smoke: OK (core dist + CLI init/dashboard, server dist: health + session)');
