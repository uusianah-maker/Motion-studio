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
  const s = await start({ MOTION_WORKSPACE: ws, MOTION_PORT: '0', MOTION_UPLOAD_TMP: tmp }, () => undefined);
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    if (health.ok !== true) fail('server health tidak ok');
    const noToken = await fetch(`${base}/api/session`);
    if (noToken.status !== 401) fail(`session tanpa token harus 401, dapat ${noToken.status}`);
    const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${s.app.token}` } }).then((r) => r.json());
    if (session.actor !== 'user' || session.workspace_id !== init.workspace_id) fail(`session salah: ${JSON.stringify(session)}`);
    const h = { authorization: `Bearer ${s.app.token}` };
    const proj = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Smoke' }) }).then((r) => r.json());
    if (!proj.project?.project_id) fail(`buat proyek gagal: ${JSON.stringify(proj)}`);
    const bytes = new TextEncoder().encode(`smoke-${Date.now()}`);
    const imp = await fetch(`${base}/api/media/import?scope=shared`, { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'smoke.mp4' }, body: bytes }).then((r) => r.json());
    if (imp.version?.size !== bytes.length) fail(`import gagal: ${JSON.stringify(imp)}`);
    const dash = await fetch(`${base}/api/dashboard`, { headers: h }).then((r) => r.json());
    if (dash.dashboard?.gc?.ok !== true) fail(`dashboard gagal: ${JSON.stringify(dash).slice(0, 300)}`);
  } finally {
    await s.stop();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('smoke: OK (core dist + CLI init/dashboard, server dist: health, session, proyek, upload, dashboard)');
