// R21 (owner: "hapus aja broo"): the PIC approval step is gone — rendered videos are downloaded
// straight from Hasil. Menu = 1. Buat video · 2. Edit · 3. Hasil; old #/setujui and #/persetujuan
// land on Hasil; no "Kirim ke PIC" in Edit; after a render only "Lihat di 3. Hasil →"; the queue
// and kirim-pic endpoints are gone. Variant approval for mass render stays (Varian dialog).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r21-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const clip = path.join(work, 'klip.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { windowsHide: true });
const v = await svc.importMedia({ sourcePath: clip, scope: { kind: 'shared' }, actor: 'user' });
await core.createProject(ws, { project_id: 'promo', name: 'Promo Langsung' });
await svc.editTimeline({ project_id: 'promo', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: v.media.media_id, version_id: v.version.version_id }, start_ms: 0, duration_ms: 1000 }] });

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const base = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Buat video/ }).waitFor();
  const flow = (await nav.getByRole('group', { name: 'Alur kerja' }).getByRole('button').allInnerTexts()).map((t) => t.replace(/^\S+\s+/, '').replace(/\s+/g, ' ').trim());
  const all = (await nav.innerText()).replace(/\s+/g, ' ');
  check('R21-01 Menu alur kerja: 1. Buat video · 2. Edit · 3. Hasil (tanpa Setujui)', flow.join('|') === '1. Buat video|2. Edit|3. Hasil' && !/Setujui/.test(all), flow.join('|'));

  const r1 = await page.evaluate(() => (location.hash = '#/setujui')).then(() => until(async () => (await page.evaluate(() => location.hash)) === '#/hasil'));
  await page.goto(`${base}#/persetujuan`);
  await page.reload();
  const r2 = await until(async () => (await page.evaluate(() => location.hash)) === '#/hasil' && (await nav.getByRole('button', { name: /3\. Hasil/ }).getAttribute('aria-current')) === 'page');
  check('R21-02 Alamat lama #/setujui dan #/persetujuan dialihkan ke #/hasil', r1 && r2);

  const cards = await page.evaluate(() => (location.hash = '#/buat')).then(async () => {
    await page.getByRole('heading', { name: 'Buat video', level: 1 }).waitFor();
    return page.locator('.buatGrid').innerText();
  });
  check('R21-03 Kartu "Buat video" tanpa sebutan Setujui / PIC', !/Setujui|PIC/.test(cards));

  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByText('Promo Langsung', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Promo Langsung' }).waitFor();
  check('R21-04 Edit: tidak ada tombol "Kirim ke PIC"', (await page.getByRole('button', { name: /Kirim ke PIC/ }).count()) === 0);
  await page.getByRole('button', { name: /Render/ }).first().click();
  await page.getByRole('button', { name: /Mulai render/ }).click();
  const next = page.getByRole('group', { name: 'Langkah berikutnya' });
  const shown = await until(() => next.isVisible(), 90000);
  const links = shown ? await next.getByRole('link').allInnerTexts() : [];
  check('R21-05 Sesudah render: hanya "Lihat di 3. Hasil →" (tanpa "Lanjut ke Setujui")', links.length === 1 && /Lihat di 3\. Hasil/.test(links[0]), links.join(' | '));
  await next.getByRole('link', { name: /Lihat di 3\. Hasil/ }).click();
  check('R21-06 "Lihat di 3. Hasil" membuka Hasil, file render ada di sana', await until(async () => (await page.evaluate(() => location.hash)) === '#/hasil' && (await page.getByText('Promo Langsung').count()) > 0));

  const api = async (p, method = 'GET') => (await fetch(`${base.slice(0, -1)}${p}`, { method, headers: { authorization: `Bearer ${server.app.token}`, 'content-type': 'application/json', 'x-motion-request': '1' }, ...(method === 'POST' ? { body: '{"expected_revision":1}' } : {}) })).status;
  const gone = [await api('/api/review/antrean'), await api('/api/projects/promo/kirim-pic'), await api('/api/projects/promo/kirim-pic', 'POST')];
  check('R21-07 Endpoint antrean PIC dan kirim-pic sudah tidak ada (404)', gone.every((s) => s === 404), gone.join(','));
  check('R21-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R21-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R21 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
