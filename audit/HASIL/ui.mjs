// Halaman Hasil + pratinjau editor (owner 14 Nov): BUILT web UI + BUILT server di Chrome asli.
// - menu Hasil: semua output lintas proyek, cari, unduh satu, unduh yang dipilih, tanpa scroll horizontal di HP
// - pratinjau editor tidak menyusut jadi titik saat judul proyek panjang (bug owner: video "gelap"/kecil)
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-hasil-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const PANJANG = 'Batch 2026-11-14_footage 2026-11-14 · varian-002 · Sekarang aku mau buktiin gimana hasil yang panjang sekali';
await core.createProject(ws, { project_id: 'korset', name: PANJANG });
await core.createProject(ws, { project_id: 'promo', name: 'Promo Payday' });
const out = async (pid, name) => {
  const d = path.join(wsRoot, 'PROJECTS', pid, '05_OUTPUT');
  await fsp.mkdir(d, { recursive: true });
  await fsp.copyFile(path.join(FIX, 'sample_3s_16x9.mp4'), path.join(d, name));
};
await out('korset', 'varian-002 · Sekarang aku mau buktiin.mp4');
await out('korset', 'varian-002 · Sekarang aku mau buktiin_v2.mp4');
await out('promo', 'Promo Payday.mp4');

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`${base}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });

  // ---- pratinjau editor dengan judul panjang tetap berukuran layak
  await nav.getByRole('button', { name: /Editor/ }).click();
  await page.getByRole('button', { name: /varian-002/ }).first().click();
  await page.waitForTimeout(800);
  const tinggi = await page.evaluate(() => document.querySelector('.canvas')?.getBoundingClientRect().height ?? 0);
  check('HASIL-01 Pratinjau editor tidak menyusut (judul panjang)', tinggi >= 280, `tinggi=${Math.round(tinggi)}px`);
  const tumpang = await page.evaluate(() => {
    const c = document.querySelector('.editor')?.getBoundingClientRect();
    const t = document.querySelector('.timeline')?.getBoundingClientRect();
    return c && t ? Math.round(c.bottom - t.top) : 999;
  });
  check('HASIL-01b Pratinjau tidak menimpa linimasa', tumpang <= 1, `tumpang=${tumpang}px`);
  await page.screenshot({ path: path.join(EVID, 'editor-judul-panjang.png') });

  // ---- menu Hasil
  await nav.getByRole('button', { name: /Hasil/ }).click();
  await page.getByRole('heading', { name: 'Hasil' }).waitFor();
  const rows = page.getByRole('table', { name: 'Daftar hasil render' }).locator('tbody tr');
  await rows.nth(2).waitFor({ timeout: 10000 }).catch(() => undefined);
  check('HASIL-02 Semua output lintas proyek tampil', (await rows.count()) === 3, `baris=${await rows.count()}`);
  check('HASIL-03 Tanpa path lokal di halaman', !(await page.content()).match(/05_OUTPUT|[A-Za-z]:\\\\/));
  await page.screenshot({ path: path.join(EVID, 'hasil-desktop.png') });

  await page.getByLabel('Cari hasil').fill('payday');
  await page.waitForTimeout(600);
  check('HASIL-04 Cari menyaring', (await rows.count()) === 1);
  await page.getByLabel('Cari hasil').fill('');
  await page.waitForTimeout(600);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Unduh Promo Payday.mp4' }).click()]);
  check('HASIL-05 Unduh satu file', dl.suggestedFilename() === 'Promo Payday.mp4', dl.suggestedFilename());

  await page.getByLabel('Pilih varian-002 · Sekarang aku mau buktiin.mp4').check();
  await page.getByLabel('Pilih varian-002 · Sekarang aku mau buktiin_v2.mp4').check();
  const got = [];
  page.on('download', (d) => got.push(d.suggestedFilename()));
  await page.getByRole('button', { name: /Unduh yang dipilih \(2\)/ }).click();
  await page.getByText('2 file dikirim ke folder Unduhan').waitFor({ timeout: 15000 });
  check('HASIL-06 Unduh yang dipilih (2 file berurutan)', got.length === 2, got.join(', '));

  // ---- tetap hidup saat pindah menu
  await page.getByLabel('Cari hasil').fill('korset-tidak-ada');
  await nav.getByRole('button', { name: /Editor/ }).click();
  await nav.getByRole('button', { name: /Hasil/ }).click();
  check('HASIL-07 Isian tetap saat pindah menu', (await page.getByLabel('Cari hasil').inputValue()) === 'korset-tidak-ada');

  // ---- HP
  const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  p2.on('pageerror', (e) => consoleErrors.push(String(e)));
  await p2.goto(`${base}/#token=${server.app.token}`);
  await p2.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Hasil/ }).click();
  await p2.getByRole('heading', { name: 'Hasil' }).waitFor();
  check('HASIL-08 HP 390px tanpa scroll horizontal', await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p2.screenshot({ path: path.join(EVID, 'hasil-hp.png'), fullPage: true });

  check('HASIL-99 0 error JS', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
} catch (e) {
  check('HASIL-RUN tanpa exception', false, String(e).slice(0, 400));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const summary = results.reduce((a, r) => ((a[r.ok ? 'PASS' : 'FAIL'] = (a[r.ok ? 'PASS' : 'FAIL'] ?? 0) + 1), a), {});
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
console.log(`\nHASIL UI: ${summary.PASS ?? 0}/${results.length} lulus`);
process.exit(summary.FAIL ? 1 : 0);
