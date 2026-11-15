// R10 acceptance run: the PIC approval screen (real server + Chrome, random port). Videos waiting
// for a decision across projects, played in place, Setujui / Revisi + note, keyboard shortcuts,
// brand filter.
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
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r10-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const ays = (await svc.createBrand({ kit: { name: 'Aysilla', kode: 'AYS' }, actor: 'user' })).result;
const bln = (await svc.createBrand({ kit: { name: 'Brand Lain', kode: 'BLN' }, actor: 'user' })).result;
const sample = path.join(FIX, 'sample_3s_16x9.mp4');
const project = async (id, name, brand, at) => {
  await core.createProject(ws, { project_id: id, name });
  await svc.updateProjectMeta({ project_id: id, expected_revision: (await core.readProject(ws, id)).revision, brand_id: brand, actor: 'user' });
  await svc.editTimeline({ project_id: id, expected_revision: (await core.readProject(ws, id)).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Hook', start_ms: 0, duration_ms: 1000 }] });
  const f = path.join(wsRoot, 'PROJECTS', id, '05_OUTPUT', `${id}.mp4`);
  await fsp.copyFile(sample, f);
  await fsp.utimes(f, at / 1000, at / 1000);
};
const t0 = Date.now() - 60_000;
await project('satu', 'Korset hook A', ays.brand_id, t0);
await project('dua', 'Korset hook B', ays.brand_id, t0 + 1000);
await project('tiga', 'Brand lain promo', bln.brand_id, t0 + 2000);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Setujui/ }).click();
  await page.getByRole('heading', { name: 'Persetujuan' }).waitFor();
  const list = page.getByRole('listbox', { name: 'Video menunggu persetujuan' });
  const listed = await until(async () => (await list.getByRole('option').count()) === 3);
  check('R10-01 Semua video yang menunggu dari semua proyek tampil (terlama dulu)', listed && (await list.getByRole('option').first().innerText()).includes('Korset hook A'));
  const video = page.getByLabel('Video hasil render');
  const playable = await until(async () => (await video.getAttribute('src'))?.includes('/api/output') && (await video.evaluate((v) => v.readyState >= 1)));
  check('R10-02 Video diputar langsung di layar (link bertanda tangan)', playable);
  await page.screenshot({ path: path.join(EVID, 'persetujuan.png') });

  // Brand filter.
  await page.getByLabel('Brand persetujuan').selectOption(bln.brand_id);
  check('R10-03 Filter brand: hanya video brand itu', await until(async () => (await list.getByRole('option').count()) === 1 && (await list.innerText()).includes('Brand lain promo')));
  await page.getByLabel('Brand persetujuan').selectOption('');
  await until(async () => (await list.getByRole('option').count()) === 3);

  // Keyboard: J moves, A approves the selected one.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  check('R10-04 Pintasan J pindah ke video berikutnya', await until(async () => (await list.getByRole('option', { selected: true }).innerText()).includes('Korset hook B')));
  await page.keyboard.press('a');
  const approved = await until(async () => (await core.readReview(await core.openWorkspace(wsRoot), 'dua')).state === 'lulus');
  check('R10-05 Pintasan A = Setujui (review Lulus), video keluar dari daftar', approved && (await until(async () => (await list.getByRole('option').count()) === 2)));

  // Revision needs a note; R focuses it, Ctrl+Enter sends it.
  await list.getByRole('option').filter({ hasText: 'Korset hook A' }).click();
  await page.getByRole('button', { name: /Revisi/ }).click();
  check('R10-06 Revisi tanpa catatan ditolak dengan pesan jelas', await until(() => page.getByRole('alert').filter({ hasText: 'Tulis dulu apa yang perlu direvisi' }).isVisible()));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await page.keyboard.type('Hook kurang jelas di detik 0-2');
  await page.keyboard.press('Control+Enter');
  const revised = await until(async () => {
    const r = await core.readReview(await core.openWorkspace(wsRoot), 'satu');
    return r.state === 'revisi' && r.decision?.note === 'Hook kurang jelas di detik 0-2';
  });
  check('R10-07 Pintasan R + Ctrl+Enter = Revisi dengan catatan; video keluar dari daftar', revised && (await until(async () => (await list.getByRole('option').count()) === 1)));

  // Phone width.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Setujui/ }).click();
  await phone.getByRole('heading', { name: 'Persetujuan' }).waitFor();
  await until(() => phone.getByLabel('Video hasil render').isVisible());
  const out = await phone.evaluate(() => [...document.querySelectorAll('select, button, textarea, video')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  check('R10-08 Layar HP: tidak ada yang keluar layar', out === 0, `${out} keluar`);
  await phone.screenshot({ path: path.join(EVID, 'persetujuan-hp.png') });
  check('R10-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R10-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R10 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
