// R13 acceptance run: "Duplikat brand" in the Brand menu (real server + Chrome, random port).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r13-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', colors: ['#111111', '#ffd23f'], presets: [{ id: 'preset-1', nama: 'Konversi Aysilla', tujuan: 'konversi' }] }, actor: 'user' });

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Brand/ }).click();
  await page.getByLabel('Nama brand').waitFor();
  await until(async () => (await page.getByLabel('Nama brand').inputValue()) === 'Aysilla Factory');
  await page.getByRole('button', { name: /Duplikat brand/ }).click();
  const form = page.getByRole('group', { name: 'Duplikat brand' });
  await form.getByLabel('Nama brand baru').fill('Korset Nusantara');
  await form.getByLabel('Kode brand baru').fill('ksn');
  check('R13-01 Kode diketik huruf besar otomatis', (await form.getByLabel('Kode brand baru').inputValue()) === 'KSN');
  await form.getByRole('button', { name: 'Buat' }).click();
  const opened = await until(async () => (await page.getByLabel('Nama brand').inputValue()) === 'Korset Nusantara');
  const brands = await new core.StorageService(await core.openWorkspace(wsRoot)).listBrands();
  const made = brands.find((b) => b.name === 'Korset Nusantara');
  check('R13-02 Brand baru dibuat dari Brand Kit asal (warna + preset ikut), langsung terbuka', opened && made?.kode === 'KSN' && made.presets[0]?.nama === 'Konversi Aysilla' && made.colors[1] === '#ffd23f', made ? `${made.kode} · ${made.presets.length} preset` : 'tidak ada');
  check('R13-03 Brand asal tidak berubah', brands.find((b) => b.kode === 'AYS')?.name === 'Aysilla Factory');
  // A code already used is refused with a clear message.
  await page.getByRole('button', { name: /Duplikat brand/ }).click();
  await form.getByLabel('Nama brand baru').fill('Satu Lagi');
  await form.getByLabel('Kode brand baru').fill('AYS');
  await form.getByRole('button', { name: 'Buat' }).click();
  check('R13-04 Kode yang sudah dipakai ditolak dengan pesan jelas', await until(() => page.getByRole('alert').filter({ hasText: 'sudah dipakai' }).isVisible()));
  await page.screenshot({ path: path.join(EVID, 'duplikat-brand.png') });
  check('R13-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R13-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R13 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
