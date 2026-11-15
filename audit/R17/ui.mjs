// R17 menu restructure (owner: "Ya, rapikan"): sidebar = Alur kerja (1. Buat video · 2. Edit ·
// 3. Hasil — R21: no PIC step), Bahan (Media · Shot · Brand), Pengaturan (AI · Tim · Storage · Trash).
// "Buat video" = 4 cards (when to use + what to prepare) that open the feature inside it; Transfer and
// Beat Spot are no separate menus; a draft ends in "Buka di Edit"; old addresses are redirected.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r17-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', '-af', 'volume=0.05', path.join(engine, 'aset', 'musik-lokal.wav')]);
const talk = path.join(work, 'rekaman-bicara.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: [], ukuran: '' }] }, actor: 'user' });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const base = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Buat video/ }).waitFor();
  const groups = {};
  for (const g of ['Alur kerja', 'Bahan', 'Pengaturan']) groups[g] = (await nav.getByRole('group', { name: g }).getByRole('button').allInnerTexts()).map((t) => t.replace(/^\S+\s+/, '').replace(/\s+/g, ' ').trim());
  check(
    'R17-01 Menu dikelompokkan: Alur kerja (1–3), Bahan, Pengaturan',
    groups['Alur kerja'].join('|') === '1. Buat video|2. Edit|3. Hasil' && groups.Bahan.join('|') === 'Media|Shot|Brand' && groups.Pengaturan.join('|') === 'AI|Storage|Trash',
    JSON.stringify(groups),
  );
  const names = (await nav.getByRole('button').allInnerTexts()).join(' ');
  check('R17-02 Transfer, Beat Spot, Generate, Batch bukan menu terpisah lagi', !/Transfer|Beat Spot|Generate|Batch/.test(names), names.replace(/\s+/g, ' '));

  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('heading', { name: 'Buat video', level: 1 }).waitFor();
  const cards = ['Video iklan', 'Batch Remix', 'Beat Spot', 'Motion Transfer'];
  let cardsOk = true;
  for (const c of cards) {
    const t = await page.getByRole('region', { name: c }).innerText().catch(() => '');
    if (!t.includes('Kapan dipakai') || !t.includes('Siapkan')) cardsOk = false;
  }
  check('R17-03 "Buat video" = 4 kartu, masing-masing "Kapan dipakai" + "Siapkan"', cardsOk);
  await page.screenshot({ path: path.join(EVID, 'buat-video.png'), fullPage: true });

  // A card opens its feature inside "Buat video" (tabs above, menu stays on "1. Buat video").
  await page.getByRole('button', { name: /^Buka Beat Spot/ }).click();
  await page.getByRole('heading', { name: 'Beat Spot', level: 1 }).waitFor();
  const tabs = page.getByRole('navigation', { name: 'Cara membuat video' });
  const sel = await nav.getByRole('button', { name: /Buat video/ }).getAttribute('aria-current');
  check('R17-04 Kartu membuka fiturnya di dalam "Buat video" (tab cara lain di atas, menu tetap "1. Buat video")', (await tabs.isVisible()) && sel === 'page' && (await page.evaluate(() => location.hash)) === '#/buat/beat-spot');
  await tabs.getByRole('button', { name: /Motion Transfer/ }).click();
  check('R17-05 Pindah cara lewat tab (Beat Spot → Motion Transfer)', await until(() => page.getByRole('heading', { name: 'Motion Transfer', level: 1 }).isVisible()));

  // Old addresses are redirected.
  await page.evaluate(() => (location.hash = '#/transfer'));
  const r1 = await until(async () => (await page.evaluate(() => location.hash)) === '#/buat/motion-transfer');
  await page.goto(`${base}#/generate`);
  await page.reload();
  const r2 = await until(async () => (await page.getByRole('heading', { name: 'Generate Otomatis', level: 1 }).isVisible()) && (await page.evaluate(() => location.hash)) === '#/buat/video-iklan');
  await page.goto(`${base}#/editor`);
  await page.reload();
  const r3 = await until(async () => (await page.evaluate(() => location.hash)) === '#/edit');
  check('R17-06 URL lama dialihkan (#/transfer, #/generate, #/editor → alamat baru, halaman benar)', r1 && r2 && r3, `${r1} ${r2} ${r3} ${await page.evaluate(() => location.hash)}`);

  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();

  // A draft ends in "Buka di Edit" → lands in 2. Edit.
  const form = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Video bicara').setInputFiles(talk);
  await form.getByLabel('Produk').selectOption('Loose Pants');
  await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
  const planCard = page.getByRole('region', { name: 'Rencana edit' });
  await planCard.waitFor({ timeout: 30000 });
  await planCard.getByRole('button', { name: /Terapkan ke timeline/ }).click();
  await page.getByRole('button', { name: /Buka di Edit/ }).click();
  const inEdit = await until(async () => (await page.evaluate(() => location.hash)) === '#/edit' && (await nav.getByRole('button', { name: /^2\. Edit$/ }).getAttribute('aria-current')) === 'page');
  check('R17-07 Setelah draf jadi: tombol "Buka di Edit" membuka 2. Edit', inEdit);

  // Phone width: the menu and the cards fit.
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${base}#token=${server.app.token}`);
  await phone.evaluate(() => (location.hash = '#/buat'));
  await phone.getByRole('heading', { name: 'Buat video', level: 1 }).waitFor();
  const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const navOk = await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Trash/ }).isVisible();
  await phone.screenshot({ path: path.join(EVID, 'buat-video-hp.png'), fullPage: true });
  check('R17-08 HP 390px: tanpa scroll samping, semua menu terjangkau', over <= 1 && navOk, `overflow ${over}px`);
  check('R17-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R17-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R17 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
