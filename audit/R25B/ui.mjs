// R25b butir 1 (kasus nyata 16 Nov: footage DJI HEVC Main 10, 59,94 fps): pratinjau ringan dibuat
// OTOMATIS saat impor juga untuk video kecil yang 10-bit / > 30 fps (sebelumnya hanya kalau besar),
// lalu Editor memutar salinan ringan itu. Render tetap dari file asli (tes core r25b).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r25b-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
await core.createProject(ws, { project_id: 'p', name: 'Uji DJI 10-bit' });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
// Small and light (540×960, low bitrate) — only its 10-bit / 59,94 fps make the browser fail.
const h10 = path.join(work, 'dji-h264-10bit.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=s=540x960:r=60000/1001:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-b:v', '800k', '-c:a', 'aac', '-shortest', h10]);
const hevc = path.join(work, 'dji-hevc-10bit.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=s=540x960:r=60000/1001:d=2', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le', '-b:v', '800k', '-tag:v', 'hvc1', hevc]);
const plain = path.join(work, 'biasa-8bit.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=s=540x960:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '800k', plain]);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|ERR_ABORTED|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Media/ }).click();
  await page.getByRole('heading', { name: 'Media' }).waitFor();
  await page.getByLabel('Pilih file media').setInputFiles([h10, hevc, plain]);
  const reg = async () => core.loadRegistry(await core.openWorkspace(wsRoot));
  const ver = async (n) => Object.values((await reg()).versions).find((x) => x.original_name === n);
  const ready = async (n) => {
    const v = await ver(n);
    return !!v && !!(await fsp.stat(core.proxyPath(ws, v.version_id)).catch(() => null));
  };
  const both = await until(async () => (await ready('dji-h264-10bit.mp4')) && (await ready('dji-hevc-10bit.mp4')), 90000);
  check('R25B-01 Impor video kecil 10-bit 59,94 fps (H.264 & HEVC) → pratinjau ringan dibuat otomatis', both);
  const st = page.getByLabel('Pratinjau ringan dji-h264-10bit.mp4');
  check('R25B-02 Halaman Media menampilkan status "siap" sendiri', await until(async () => (await st.innerText()).includes('siap'), 20000), await st.innerText().catch(() => '?'));
  const p8 = await ver('biasa-8bit.mp4');
  check('R25B-03 Video 8-bit 30 fps yang sudah ringan: tidak dibuatkan (tidak perlu)', !(await ready('biasa-8bit.mp4')) && p8?.probe?.pix_fmt === 'yuv420p', `pix_fmt ${p8?.probe?.pix_fmt} fps ${p8?.probe?.fps}`);
  const v10 = await ver('dji-h264-10bit.mp4');
  check('R25B-04 Probe mencatat pix_fmt + fps (yuv420p10le, 59,94)', v10?.probe?.pix_fmt === 'yuv420p10le' && v10?.probe?.fps === 59.94, JSON.stringify(v10?.probe));

  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji DJI 10-bit' }).waitFor();
  await page.getByRole('button', { name: 'Tambah dji-h264-10bit.mp4 ke linimasa' }).click();
  const video = page.getByLabel('Video pratinjau');
  const usesProxy = await until(async () => (await video.getAttribute('src'))?.includes('proxy=1'), 20000);
  const plays = usesProxy && (await until(() => video.evaluate((el) => el.readyState >= 1 && el.videoWidth === 540)));
  check('R25B-05 Editor memutar salinan ringan (H.264 8-bit) — gambar tampil, tidak hitam', usesProxy && plays);
  await page.screenshot({ path: path.join(EVID, 'pratinjau-10bit.png') });
  check('R25B-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R25B-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R25B UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
