// Upload queue acceptance run (owner request): while another upload is running (another page / team
// member), an upload from Media waits its turn instead of failing with "Upload lain sedang berjalan",
// shows the server queue, and finishes by itself once the other one is done.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-antrean-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
const clip = path.join(work, 'klip-kedua.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { windowsHide: true });

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Media/ }).click();
  await page.getByRole('heading', { name: 'Media' }).waitFor();

  // "Another team member": an upload that is half sent and kept open.
  const total = 400_000;
  const other = http.request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/api/media/import?scope=shared', headers: { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${server.app.token}`, 'content-type': 'application/octet-stream', 'content-length': String(total), 'x-file-name': 'lain.mp4' } });
  const otherDone = new Promise((resolve) => other.on('response', (res) => (res.resume(), res.on('end', () => resolve(res.statusCode)))));
  other.write(Buffer.alloc(total / 2, 1));
  const busy = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/media/import/antrean`, { headers: { authorization: `Bearer ${server.app.token}` } })).json()).berjalan === true;
  await until(busy);

  await page.getByLabel('Pilih file media').setInputFiles(clip);
  const queue = page.getByRole('status', { name: 'Antrean upload server' });
  const waits = await until(() => queue.isVisible(), 15000);
  check('R-ANTREAN-01 Upload saat upload lain berjalan: tidak gagal, antrean server tampil ("menunggu giliran")', waits && (await queue.innerText()).includes('1 menunggu'), waits ? await queue.innerText() : '');
  const row = page.locator('.uploadRow').filter({ hasText: 'klip-kedua.mp4' });
  check('R-ANTREAN-02 Baris upload tidak berubah jadi "Gagal" selama menunggu', !(await row.innerText()).includes('Gagal'), await row.innerText());
  await page.screenshot({ path: path.join(EVID, 'antrean.png') });

  other.end(Buffer.alloc(total / 2, 2));
  const st = await otherDone;
  const finished = await until(async () => (await row.innerText()).includes('Selesai'), 30000);
  check('R-ANTREAN-03 Setelah upload lain selesai, upload ini lanjut sendiri sampai "Selesai"; antrean hilang', st === 200 && finished && !(await queue.isVisible()), `lain=${st} · ${await row.innerText()}`);
  check('R-ANTREAN-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R-ANTREAN-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`ANTREAN UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
