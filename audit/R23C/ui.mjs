// R23c (owner 16 Nov): preset look Vintage, Clean Product, Natural Skin Tone, Cinematic (angka
// milik sendiri) di Editor dan Brand Kit; Pastel / Adem tetap; pratinjau sepia + grain; undo.
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
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23c-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const f = path.join(work, 'produk.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: 'produk.mp4', actor: 'user' });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
await core.createProject(ws, { project_id: 'r23c', name: 'Uji Look Baru' });
await svc.editTimeline({ project_id: 'r23c', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: r.media.media_id, version_id: r.version.version_id }, start_ms: 0, duration_ms: 3000 }] });
const clip = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r23c')).timeline.tracks.find((t) => t.kind === 'video').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Look Baru' }).waitFor();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const video = page.locator('video[aria-label="Video pratinjau"]');
  await page.locator('.track .clip.video').first().click();
  const lookSel = insp.getByRole('group', { name: 'Tampilan gambar' }).getByLabel('Filter warna');
  const opts = (await lookSel.locator('option').allInnerTexts()).map((t) => t.trim());
  check('R23C-01 Filter warna: + Vintage, Clean Product, Natural Skin Tone, Cinematic; Pastel & Adem Lembut tetap', ['Vintage', 'Clean Product', 'Natural Skin Tone', 'Cinematic', 'Pastel', 'Adem Lembut'].every((x) => opts.includes(x)), opts.join(' | '));
  await lookSel.selectOption('vintage');
  check('R23C-02 Pilih Vintage → tersimpan di klip', await until(async () => (await clip()).look === 'vintage'));
  await page.waitForTimeout(400);
  const filt = await video.evaluate((v) => getComputedStyle(v).filter);
  const grain = page.locator('.lookGrain');
  check('R23C-03 Pratinjau Vintage: sepia di filter CSS + lapisan grain + vignette', /sepia\(0\.35/.test(filt) && (await grain.count()) === 1 && (await grain.getAttribute('data-grain')) === '10' && (await page.locator('.lookVignette').count()) === 1, filt);
  await page.screenshot({ path: path.join(EVID, 'vintage.png') });
  await page.locator('.track .clip.video').first().click();
  await lookSel.selectOption('produk');
  await until(async () => (await clip()).look === 'produk');
  await page.waitForTimeout(300);
  check('R23C-04 Clean Product: tanpa grain/sepia (gambar bersih)', (await grain.count()) === 0 && !/sepia/.test(await video.evaluate((v) => getComputedStyle(v).filter)));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23C-05 Undo → kembali ke Vintage', await until(async () => (await clip()).look === 'vintage'));

  // Brand Kit: the same list for "Filter bawaan video".
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: /Brand Kit/ }).first();
  const bsel = page.getByLabel('Filter bawaan video');
  await bsel.waitFor();
  const bopts = (await bsel.locator('option').allInnerTexts()).map((t) => t.trim());
  check('R23C-06 Brand Kit "Filter bawaan video" juga punya 4 look baru', ['Vintage', 'Clean Product', 'Natural Skin Tone', 'Cinematic'].every((x) => bopts.includes(x)), bopts.join(' | '));
  void form;
  check('R23C-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23C-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23C UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
