// R14 acceptance run: a heavy video uploaded in Media gets a light preview copy in the background
// (status in the list), and the Editor's preview plays the light copy — render keeps the original.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
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
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r14-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
await core.createProject(ws, { project_id: 'p', name: 'Uji Pratinjau Ringan' });
const heavy = path.join(work, 'berat-1080p.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1080x1920:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', heavy], { windowsHide: true });

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Media/ }).click();
  await page.getByRole('heading', { name: 'Media' }).waitFor();
  await page.getByLabel('Pilih file media').setInputFiles(heavy);
  const status = page.getByLabel('Pratinjau ringan berat-1080p.mp4');
  const ready = await until(async () => (await status.innerText()).includes('siap'), 60000);
  check('R14-01 Upload video berat → pratinjau ringan dibuat di latar belakang, status "siap" muncul sendiri', ready, ready ? '' : await status.innerText().catch(() => '?'));
  const reg = await core.loadRegistry(await core.openWorkspace(wsRoot));
  const v = Object.values(reg.versions).find((x) => x.original_name === 'berat-1080p.mp4');
  const proxySize = (await fsp.stat(core.proxyPath(ws, v.version_id))).size;
  check('R14-02 Pratinjau ringan jauh lebih kecil dari file asli; file asli utuh', proxySize < v.size / 2, `${proxySize} vs ${v.size}`);

  // Editor: add it to the timeline; the preview plays the light copy.
  await nav.getByRole('button', { name: /Editor/ }).click();
  await page.getByRole('heading', { name: 'Uji Pratinjau Ringan' }).waitFor();
  await page.getByRole('button', { name: 'Tambah berat-1080p.mp4 ke linimasa' }).click();
  const video = page.getByLabel('Video pratinjau');
  const usesProxy = await until(async () => (await video.getAttribute('src'))?.includes('proxy=1'), 20000);
  const plays = usesProxy && (await until(() => video.evaluate((el) => el.readyState >= 1 && el.videoWidth === 540)));
  check('R14-03 Pratinjau Editor memakai salinan ringan (540 px), bukan file asli', usesProxy && plays, await video.getAttribute('src').then((s) => (s ?? '').replace(/sig=[0-9a-f]+/, 'sig=…')));
  await page.screenshot({ path: path.join(EVID, 'pratinjau-ringan.png') });
  check('R14-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R14-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R14 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
