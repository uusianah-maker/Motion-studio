// R25 (kasus nyata tim 16 Nov): job Generate "siap" tapi rencana belum diterapkan → Edit hanya
// "Linimasa kosong". Sekarang: banner "Rencana mesin siap (job …)" di Edit dengan "Terapkan ke
// timeline" + "Lihat rencana", dan label "Rencana belum diterapkan" di daftar proyek.
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
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r25-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', '-af', 'volume=0.05', path.join(engine, 'aset', 'musik-lokal.wav')]);
const talk = path.join(work, 'rekaman-bicara.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: ['Espresso'] }] }, actor: 'user' });
await core.createProject(ws, { project_id: 'lain', name: 'Proyek Lain', fitur: 'editor' });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  // Start a Generate job, then leave before applying (what the team did on 16 Nov).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  const form = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Nama proyek baru').fill('Aysilla Konten Uji').catch(() => undefined);
  await form.getByLabel('Video bicara').setInputFiles(talk);
  await form.getByLabel('Produk').selectOption('Loose Pants');
  await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
  await until(() => page.getByRole('region', { name: 'Rencana edit' }).isVisible(), 30000);
  const pid = (await core.listProjectIds(ws)).find((p) => p !== 'lain');
  const name = (await core.readProject(ws, pid)).name;
  const jobId = (await core.listEngineJobs(ws, pid))[0].job_id;

  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  const row = page.locator('button.project', { hasText: name });
  check('R25-01 Daftar proyek: label "Rencana belum diterapkan" hanya di proyek itu', await until(async () => (await row.innerText()).includes('Rencana belum diterapkan')) && !(await page.locator('button.project', { hasText: 'Proyek Lain' }).innerText()).includes('Rencana belum'), (await row.innerText()).replace(/\n/g, ' · '));
  await row.click();
  await page.getByRole('heading', { name }).waitFor();
  const banner = page.getByRole('status', { name: 'Rencana mesin siap' });
  check('R25-02 Edit: banner "Rencana mesin siap (job AYS-…)" di proyek berlinimasa kosong', await until(() => banner.isVisible()) && (await banner.innerText()).includes(`job ${jobId}`), await banner.innerText().catch(() => '-'));
  await page.screenshot({ path: path.join(EVID, 'banner.png') });
  await page.locator('button.project', { hasText: 'Proyek Lain' }).click();
  await page.getByRole('heading', { name: 'Proyek Lain' }).waitFor();
  check('R25-03 Proyek tanpa job mesin: tanpa banner', (await page.waitForTimeout(600).then(() => banner.count())) === 0);

  // "Lihat rencana" → the plan card on the Video iklan page.
  await row.click();
  await page.getByRole('heading', { name }).waitFor();
  await banner.getByRole('button', { name: 'Lihat rencana' }).click();
  check('R25-04 "Lihat rencana" membuka 1. Buat video → Video iklan dengan kartu rencana job itu', await until(async () => (await page.evaluate(() => location.hash)) === '#/buat/video-iklan' && (await page.getByRole('region', { name: 'Rencana edit' }).isVisible()) && (await page.getByRole('status', { name: 'Status mesin' }).innerText()).includes(jobId)));

  // Back to Edit: apply from the banner.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await row.click();
  await page.getByRole('heading', { name }).waitFor();
  const rev0 = (await core.readProject(ws, pid)).revision;
  await banner.getByRole('button', { name: 'Terapkan ke timeline' }).click();
  const applied = await until(async () => (await core.readProject(ws, pid)).timeline.tracks.some((t) => t.clips.length));
  const p1 = await core.readProject(ws, pid);
  check('R25-05 "Terapkan ke timeline" dari banner = satu edit (video + subtitle + musik mesin)', applied && p1.revision === rev0 + 1 && p1.timeline.tracks.map((t) => t.kind).join(',') === 'video,subtitle,music', p1.timeline.tracks.map((t) => t.kind).join(','));
  check('R25-06 Sesudah diterapkan: banner hilang, klip tampil di linimasa', (await until(async () => (await banner.count()) === 0)) && (await page.locator('.track .clip').count()) > 0);
  check('R25-07 Label daftar proyek hilang sesudah diterapkan', await until(async () => !(await row.innerText()).includes('Rencana belum diterapkan')));
  const tt = await (await fetch(`http://127.0.0.1:${server.port}/api/engine/rencana-tertunda`, { headers: { authorization: `Bearer ${server.app.token}` } })).json();
  check('R25-08 API rencana-tertunda kosong sesudah diterapkan', Array.isArray(tt.tertunda) && tt.tertunda.length === 0, JSON.stringify(tt));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R25-09 Undo → linimasa kosong lagi, banner muncul lagi (hybrid)', await until(async () => !(await core.readProject(ws, pid)).timeline.tracks.some((t) => t.clips.length)) && (await until(() => banner.isVisible())));
  check('R25-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R25-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R25 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
