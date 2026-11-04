// Smoke check for the repo layout (W01): the BUILT storage core in packages/core/dist must be
// importable by path and its CLI must run end to end (init + dashboard on a fresh temp workspace).
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('smoke: OK (packages/core/dist importable, CLI init + dashboard jalan)');
