// X03 acceptance run: text preset library + preset/colour commands in Copilot (real Chrome).
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x03-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
await core.createProject(ws, { project_id: 'preset', name: 'Uji Preset' });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'preset');
const same = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const clips = async (kind) => (await proj()).timeline.tracks.find((t) => t.kind === kind)?.clips ?? [];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Preset' }).waitFor();
  const presets = page.getByRole('region', { name: 'Preset teks' });
  check('X3-01 Perpustakaan preset: Hook, USP, CTA, Sale, Subtitle', (await presets.getByRole('button').count()) === 5);

  await presets.getByRole('button', { name: 'Tambah preset Sale' }).click();
  await page.locator('.track .clip', { hasText: 'DISKON 50%' }).waitFor();
  let t = await clips('text');
  const sale = core.presetById('sale');
  check('X3-02 Sale: masuk di playhead dengan gaya preset (kotak merah) + teks contoh', t.length === 1 && t[0].start_ms === 0 && t[0].end_ms === sale.duration_ms && same(t[0].style, sale.style));
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  check('X3-03 Klip preset baru langsung terpilih di inspector', (await insp.getByLabel('Isi teks di inspector').inputValue()) === 'DISKON 50%');
  const bg = await page.locator('.overlayText.styled[data-kind="text"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  check('X3-04 Pratinjau: kotak merah Sale', bg === 'rgb(229, 57, 53)', bg);

  await presets.getByRole('button', { name: 'Tambah preset Hook' }).click();
  await page.waitForTimeout(500);
  t = await clips('text');
  const hook = t.find((c) => c.style?.size === 7.5);
  check('X3-05 Hook di playhead yang terisi → tempat kosong berikutnya (tidak bentrok)', hook && hook.start_ms === sale.duration_ms, hook ? `${hook.start_ms}` : 'tidak ada');
  await presets.getByRole('button', { name: 'Tambah preset Subtitle' }).click();
  await page.waitForTimeout(500);
  check('X3-06 Subtitle masuk ke track subtitle', (await clips('subtitle')).length === 1);

  // Inspector preset dropdown on the Sale clip.
  await page.locator('.track .clip', { hasText: 'DISKON 50%' }).click();
  await insp.getByLabel('Terapkan preset').selectOption('cta');
  await page.waitForTimeout(900);
  t = await clips('text');
  check('X3-07 Inspector: terapkan preset CTA ke klip terpilih', t.find((c) => c.text === 'DISKON 50%').style.bg === '#ffd23f');

  // Copilot colour command on the selected clip.
  const cp = page.getByRole('region', { name: 'Motion Copilot' });
  await cp.getByLabel('Perintah Copilot').fill('warna teks merah; posisi bawah');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  const plan = cp.getByLabel('Rencana edit');
  await plan.waitFor();
  const labels = await plan.locator('.planOps li').allInnerTexts();
  await plan.getByRole('button', { name: /Terapkan/ }).click();
  await cp.getByText(/Diterapkan/).waitFor();
  t = await clips('text');
  const s = t.find((c) => c.text === 'DISKON 50%').style;
  check('X3-08 Copilot "warna teks merah; posisi bawah" → rencana jelas → warna & posisi berubah', s.color === '#e53935' && s.y === 0.75 && labels.some((l) => /warna #e53935/.test(l)), labels.join(' | '));

  await cp.getByLabel('Perintah Copilot').fill('sale "HARGA SPESIAL" detik 8-10');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  await plan.getByRole('button', { name: /Terapkan/ }).click();
  await page.locator('.track .clip', { hasText: 'HARGA SPESIAL' }).waitFor();
  check('X3-09 Copilot "sale …" → klip baru bergaya Sale', (await clips('text')).find((c) => c.text === 'HARGA SPESIAL').style.bg === '#e53935');
  await page.screenshot({ path: path.join(EVID, 'presets.png') });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('region', { name: 'Preset teks' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X3-10 HP 390px: tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('X3-11 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X3-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX03 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
