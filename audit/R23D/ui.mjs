// R23d (owner 16 Nov): transisi Fade ke hitam, Zoom in, Blur, Pull out — pilihan di Inspector,
// pratinjau mendekati render di titik potong, undo.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23d-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, color) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:r=30:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const red = await gen('merah.mp4', 'red');
const blue = await gen('biru.mp4', 'blue');
await core.createProject(ws, { project_id: 'r23d', name: 'Uji Transisi Baru' });
await svc.editTimeline({ project_id: 'r23d', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: red, start_ms: 0, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 2000, duration_ms: 2000 },
] });
const second = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r23d')).timeline.tracks.find((t) => t.kind === 'video').clips[1];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Transisi Baru' }).waitFor();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const video = page.locator('video[aria-label="Video pratinjau"]');
  const slider = page.getByRole('slider', { name: 'Posisi playhead' });
  const seek = async (ms) => {
    const total = Number(await slider.getAttribute('aria-valuemax'));
    const box = await slider.boundingBox();
    await page.mouse.click(box.x + (box.width * ms) / total, box.y + box.height / 2);
    await page.waitForTimeout(300);
  };
  const choose = async (type) => {
    await page.locator('.track .clip.video').nth(1).click();
    await insp.getByRole('group', { name: 'Transisi masuk' }).getByLabel('Transisi masuk').selectOption(type);
    return until(async () => (await second()).transition?.type === type);
  };
  await page.locator('.track .clip.video').nth(1).click();
  const opts = (await insp.getByRole('group', { name: 'Transisi masuk' }).getByLabel('Transisi masuk').locator('option').allInnerTexts()).map((t) => t.trim());
  check('R23D-01 Pilihan transisi: + Fade ke hitam, Zoom in, Blur, Pull out (zoom out)', ['Fade ke hitam', 'Zoom in', 'Blur', 'Pull out (zoom out)'].every((x) => opts.includes(x)), opts.join(' | '));

  check('R23D-02 Fade ke hitam tersimpan', await choose('hitam'));
  await seek(2000);
  const black = page.locator('.transBlack');
  const op = (await black.count()) ? Number(await black.evaluate((e) => getComputedStyle(e).opacity)) : 0;
  check('R23D-03 Pratinjau: hitam penuh di titik potong', op > 0.8, String(op));
  await page.screenshot({ path: path.join(EVID, 'fade-hitam.png') });

  check('R23D-04 Blur tersimpan', await choose('blur'));
  await seek(2000);
  const f = await video.evaluate((v) => getComputedStyle(v).filter);
  check('R23D-05 Pratinjau: gambar kabur di titik potong (CSS blur)', /blur\(/.test(f), f);

  check('R23D-06 Zoom in tersimpan', await choose('zoom_in'));
  await seek(1850);
  const tz = await video.evaluate((v) => getComputedStyle(v).transform);
  check('R23D-07 Pratinjau zoom in: gambar keluar membesar sebelum potong', tz !== 'none', tz);

  check('R23D-08 Pull out tersimpan', await choose('pull_out'));
  await seek(2100);
  const tp = await video.evaluate((v) => getComputedStyle(v).transform);
  const scale = tp.startsWith('matrix(') ? Number(tp.slice(7).split(',')[0]) : 1;
  check('R23D-09 Pratinjau pull out: gambar masuk mulai membesar lalu kembali normal', scale > 1.05, tp);
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23D-10 Undo → kembali ke Zoom in', await until(async () => (await second()).transition?.type === 'zoom_in'));

  // Tahap 2: Spin + Glitch (own xfade expressions).
  check('R23D-11 Spin tersimpan', await choose('spin'));
  await seek(2000);
  const ts = await video.evaluate((v) => getComputedStyle(v).transform);
  check('R23D-12 Pratinjau Spin: gambar berputar + mengecil di titik potong', ts !== 'none' && !ts.startsWith('matrix(1, 0, 0, 1'), ts);
  await page.screenshot({ path: path.join(EVID, 'spin.png') });
  check('R23D-13 Glitch tersimpan', await choose('glitch'));
  await seek(2000);
  const fg = await video.evaluate((v) => getComputedStyle(v).filter);
  check('R23D-14 Pratinjau Glitch: warna bergeser (hue-rotate) di titik potong', /hue-rotate/.test(fg), fg);
  check('R23D-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23D-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23D UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
