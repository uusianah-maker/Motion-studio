// R11 Motion Transfer acceptance run: real server, real Chrome, real FFmpeg; the engine CLI is the
// contract stand-in (packages/core/test/fixtures/fake-engine.mjs, contract §15 output files).
// Upload a reference video + pick a Brand Kit product → scenes with frame, duration, copy-ready
// prompts, download; the team deletes / merges scenes and can restore the engine's split.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r11-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const ref = path.join(work, 'referensi-konsep.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ref], { windowsHide: true });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: [], ukuran: '' }, { nama: 'Celana Korset', varian: [], ukuran: '' }] }, actor: 'user' });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${server.port}` });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Motion Transfer/ }).click();
  await page.getByRole('heading', { name: 'Motion Transfer' }).waitFor();
  check('R11-01 Menu "Transfer" membuka halaman Motion Transfer', true);

  const form = page.getByRole('region', { name: 'Video referensi dan produk' });
  await until(async () => (await form.getByLabel('Produk', { exact: true }).inputValue()) !== '');
  await form.getByLabel('Produk', { exact: true }).selectOption('Celana Korset');
  await form.getByLabel('Keterangan produk').fill('hitam, high waist');
  await form.getByLabel('Video referensi').setInputFiles(ref);
  await form.getByRole('button', { name: /Pecah jadi adegan/ }).click();
  const grid = page.getByRole('region', { name: 'Adegan Motion Transfer' });
  const shown = await until(async () => (await grid.locator('[data-adegan]').count()) === 4, 30000);
  check('R11-02 Upload referensi + pilih produk Brand Kit → mesin jalan → 4 adegan tampil', shown, `${await grid.locator('[data-adegan]').count()} adegan`);
  const imgs = await until(async () => (await grid.locator('img.transferImg').count()) === 4 && (await grid.locator('img.transferImg').evaluateAll((els) => els.every((e) => e.complete && e.naturalWidth > 0))));
  const first = grid.locator('[data-adegan="1"]');
  check('R11-03 Tiap adegan: gambar, rentang waktu & durasi; nama referensi = nama file upload', imgs && /0,0–1,2 dtk · 1,2 dtk/.test(await first.innerText()) && (await grid.innerText()).includes('Referensi referensi-konsep.mp4'), (await first.innerText()).split('\n')[0]);
  await page.screenshot({ path: path.join(EVID, 'adegan.png'), fullPage: true });

  await first.getByRole('button', { name: /Salin prompt gambar/ }).click();
  await page.getByRole('status').filter({ hasText: 'disalin' }).waitFor();
  const clip1 = await page.evaluate(() => window.navigator.clipboard.readText());
  await first.getByRole('button', { name: /Salin prompt gerak/ }).click();
  await until(async () => (await page.evaluate(() => window.navigator.clipboard.readText())) !== clip1);
  const clip2 = await page.evaluate(() => window.navigator.clipboard.readText());
  check('R11-04 "Salin prompt gambar" / "Salin prompt gerak" menyalin prompt (produk Brand Kit + keterangan)', clip1.includes('Celana Korset') && clip1.includes('hitam, high waist') && /Gerakkan gambar ini selama 1\.2 detik/.test(clip2), `${clip1.slice(0, 60)}… | ${clip2.slice(0, 50)}…`);

  const dl = page.waitForEvent('download');
  await first.getByRole('link', { name: /Unduh gambar/ }).click();
  const file = await dl;
  const saved = path.join(work, file.suggestedFilename());
  await file.saveAs(saved);
  const head = (await fsp.readFile(saved)).subarray(0, 2).toString('hex');
  check('R11-05 "Unduh gambar" mengunduh JPG adegan', /^AYS-\d{8}-\d{3}-adegan-01\.jpg$/.test(file.suggestedFilename()) && head === 'ffd8', file.suggestedFilename());

  // Team edits: merge 2+3, delete 4, then restore the engine's split.
  await grid.getByRole('button', { name: 'Gabung Adegan 2 dengan berikutnya' }).click();
  await until(async () => (await grid.locator('[data-adegan="2+3"]').count()) === 1);
  const merged = await grid.locator('[data-adegan="2+3"]').innerText();
  check('R11-06 Gabung adegan 2 dengan 3 → satu adegan 2,9 dtk, tanda "digabung tim"', /1,2–4,1 dtk · 2,9 dtk/.test(merged) && merged.includes('digabung tim'), merged.split('\n')[0]);
  await grid.getByRole('button', { name: 'Hapus Adegan 3' }).click();
  await until(async () => (await grid.locator('[data-adegan]').count()) === 2);
  const ids = await grid.locator('[data-adegan]').evaluateAll((els) => els.map((e) => e.getAttribute('data-adegan')));
  check('R11-07 Hapus adegan → hilang dari daftar; jumlah & keterangan "diubah tim" ikut', ids.join(',') === '1,2+3' && (await grid.innerText()).includes('diubah tim (mesin membuat 4 adegan)'), ids.join(','));
  // Survives a reload (stored on the server, not in the page).
  await page.reload();
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Motion Transfer/ }).click();
  const kept = await until(async () => (await grid.locator('[data-adegan]').count()) === 2, 20000);
  // A fresh tab (no session memory): pick the project, open the job from the history.
  const tab = await ctx.newPage();
  await tab.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await tab.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Buat video/ }).click();
  await tab.getByRole('button', { name: /^Buka Motion Transfer/ }).click();
  const projectId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ms:transfer.proyek') ?? '""'));
  await tab.getByRole('region', { name: 'Video referensi dan produk' }).getByLabel('Proyek tujuan').selectOption(projectId);
  await tab.getByRole('region', { name: 'Riwayat Motion Transfer' }).getByRole('button', { name: /^Lihat / }).first().click();
  const kept2 = await until(async () => (await tab.getByRole('region', { name: 'Adegan Motion Transfer' }).locator('[data-adegan]').count()) === 2, 20000);
  await tab.close();
  check('R11-08 Perubahan tim tersimpan di server (muat ulang → tetap 2 adegan; tab baru lewat Riwayat juga)', kept && kept2);
  await grid.getByRole('button', { name: /Pulihkan adegan mesin/ }).click();
  const back = await until(async () => (await grid.locator('[data-adegan]').count()) === 4);
  check('R11-09 "Pulihkan adegan mesin" → kembali ke 4 adegan buatan mesin', back);

  // Phone width: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: path.join(EVID, 'adegan-hp.png'), fullPage: true });
  check('R11-10 HP 390px: tanpa scroll samping', over <= 1, `overflow ${over}px`);
  check('R11-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R11-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R11 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
