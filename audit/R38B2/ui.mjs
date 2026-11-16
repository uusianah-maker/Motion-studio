// R38b(2) (owner 16 Nov): LUT .cube dari Aset (R38a wawok) — pemilih "LUT warna" di Inspector klip,
// "LUT bawaan video" di Brand, pratinjau (matriks warna perkiraan, swatch persis), render lut3d. Undo.
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
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const cube = (size, f) => {
  const lines = ['TITLE "uji"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r38b2-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = async (name, content, filter) => {
  const f = path.join(work, name);
  if (content !== null) await fsp.writeFile(f, content);
  else execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const red = await imp('merah.mp4', null, 'color=c=0xc02020:s=360x640:r=30:d=2');
const invert = await imp('invert.cube', cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b]));
const blue = await imp('biru.cube', cube(2, (r, g, b) => [0, 0, Math.max(r, g, b)]));
const lic = { status: 'milik_sendiri', bukti: '', iklan: true };
await svc.createBrand({ kit: { name: 'Uji LUT', kode: 'LUT', aset: [{ id: 'negatif', ref: invert, jenis: 'lut', nama: 'Negatif', tag: [], lisensi: lic }, { id: 'serba-biru', ref: blue, jenis: 'lut', nama: 'Serba Biru', tag: [], lisensi: lic }] }, actor: 'user' });
await core.createProject(ws, { project_id: 'r38b2', name: 'Uji LUT Klip' });
await svc.editTimeline({ project_id: 'r38b2', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 2000 }] });
const clip = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r38b2')).timeline.tracks.find((t) => t.kind === 'video').clips[0];
const kit = async () => (await new core.StorageService(await core.openWorkspace(wsRoot)).listBrands()).find((b) => b.kode === 'LUT');

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await page.getByRole('heading', { name: 'Uji LUT Klip' }).waitFor();

  // ---- Inspector klip: LUT warna.
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const sel = page.getByRole('region', { name: 'Inspector klip' }).getByLabel('LUT warna');
  check('R38B2-01 Inspector klip video → "LUT warna" berisi LUT Aset brand', await until(async () => (await sel.locator('option').allInnerTexts()).join('|') === 'Tanpa LUT|Negatif|Serba Biru'), (await sel.locator('option').allInnerTexts().catch(() => [])).join('|'));
  await sel.selectOption({ label: 'Negatif' });
  check('R38B2-02 Pilih Negatif → clip.lut tersimpan', await until(async () => (await clip()).lut?.version_id === invert.version_id));
  const video = page.getByLabel('Video pratinjau');
  check('R38B2-03 Pratinjau: filter LUT (matriks warna) terpasang di video', await until(async () => (await video.getAttribute('data-lut')) === invert.version_id && /url\(.*#lutPreview/.test(await video.evaluate((e) => e.style.filter))));
  const mat = await page.locator('#lutPreview feColorMatrix').getAttribute('values');
  check('R38B2-04 Matriks pratinjau LUT negatif = −1 di diagonal, offset 1', !!mat && mat.split(' ').map(Number).slice(0, 5).map((v) => Math.round(v)).join(',') === '-1,0,0,0,1', mat ?? '');
  const sw = page.getByRole('region', { name: 'Inspector klip' }).getByRole('img', { name: 'Contoh warna LUT sebelum dan sesudah' });
  check('R38B2-05 Swatch sebelum/sesudah (persis = lut3d) di Inspector', await until(async () => (await sw.getAttribute('data-lut-ready')) === '1'));
  await page.screenshot({ path: path.join(EVID, 'lut-klip.png') });
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R38B2-06 Undo → LUT klip hilang, pratinjau tanpa LUT', await until(async () => !(await clip()).lut) && (await until(async () => (await video.getAttribute('data-lut')) === null)));

  // ---- Brand: LUT bawaan video.
  await nav.getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await until(async () => (await form.getByLabel('Nama brand').inputValue()) === 'Uji LUT');
  await form.getByLabel('LUT bawaan video').selectOption({ label: 'Serba Biru' });
  check('R38B2-07 Brand: "LUT bawaan video" + swatch', await until(async () => (await form.getByRole('group', { name: 'Contoh LUT bawaan' }).getByRole('img').getAttribute('data-lut-ready')) === '1'));
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  check('R38B2-08 Simpan → kit.lut_bawaan tersimpan', await until(async () => (await kit())?.lut_bawaan?.version_id === blue.version_id, 15000));

  // ---- Editor follows the Brand LUT; "Tanpa filter" switches it off.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('button', { name: /Uji LUT Klip/ }).first().click().catch(() => undefined);
  await page.getByRole('heading', { name: 'Uji LUT Klip' }).waitFor();
  check('R38B2-09 Pratinjau mengikuti LUT bawaan brand', await until(async () => (await video.getAttribute('data-lut')) === blue.version_id, 15000));
  await page.locator('.track[data-kind="video"] .clip').first().click();
  check('R38B2-10 Inspector: pilihan "Ikuti brand (Serba Biru)"', await until(async () => (await sel.locator('option').first().innerText()) === 'Ikuti brand (Serba Biru)'));
  await page.getByRole('region', { name: 'Inspector klip' }).getByLabel('Filter warna').selectOption('none');
  check('R38B2-11 Filter "Tanpa filter" → LUT bawaan mati di klip itu', await until(async () => (await clip()).look === 'none') && (await until(async () => (await video.getAttribute('data-lut')) === null)));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await until(async () => (await clip()).look === undefined);

  const res = await core.renderProject(await core.openWorkspace(wsRoot), { project_id: 'r38b2', output_name: 'lut.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  let px = null;
  if (res.status === 'completed') {
    const out = path.join(wsRoot, (await core.listOutputs(await core.openWorkspace(wsRoot), 'r38b2'))[0].rel);
    const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const i = (160 * (b.length / 3 / 320) + 50) * 3;
    px = [b[i], b[i + 1], b[i + 2]];
  }
  check('R38B2-12 Render: LUT bawaan brand dipasang (lut3d → merah jadi biru)', !!px && px[0] < 40 && px[2] > 150, JSON.stringify(px));
  check('R38B2-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R38B2-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R38B2 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
