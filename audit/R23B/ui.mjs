// R23b (owner 16 Nov, alat edit gaya CapCut — suara): EQ (preset + 3 slider), "Perjelas suara",
// kecepatan klip suara; pratinjau Web Audio memakai angka yang sama dengan render; undo.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23b-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const talk = await gen('bicara.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const music = await gen('musik.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=6', '-af', 'volume=0.3']);
await core.createProject(ws, { project_id: 'r23b', name: 'Uji Suara CapCut' });
await svc.editTimeline({
  project_id: 'r23b',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: talk, start_ms: 0, duration_ms: 4000 },
    { op: 'add_clip', track_kind: 'music', media: music, start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'music', media: music, start_ms: 3000, duration_ms: 1000, in_ms: 3000 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'r23b');
const clips = async (k) => (await proj()).timeline.tracks.find((t) => t.kind === k).clips;

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Suara CapCut' }).waitFor();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const fx = insp.getByRole('group', { name: 'EQ dan suara' });
  const video = page.locator('video[aria-label="Video pratinjau"]');
  const musicEl = page.locator('audio[data-layer="music"]');
  const pick = async (sel, i) => {
    await page.locator(sel).nth(i).click();
    await fx.waitFor();
  };

  // 1. Klip video: "Perjelas suara" + EQ preset.
  await pick('.track .clip.video', 0);
  check('R23B-01 Inspector klip video punya grup "EQ dan suara"', await fx.isVisible());
  await fx.getByLabel('Perjelas suara').click();
  check('R23B-02 "Perjelas suara" tersimpan di klip', await until(async () => (await clips('video'))[0].voice === true));
  await page.getByRole('button', { name: 'Putar', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Jeda', exact: true }).click();
  const vfx = (await video.getAttribute('data-audiofx')) ?? '';
  check('R23B-03 Pratinjau: suara video lewat highpass 80 Hz + EQ suara + kompresor (Web Audio)', /hp80/.test(vfx) && /peaking3000:3/.test(vfx) && /comp/.test(vfx), vfx);
  const ctxState = await page.evaluate(() => (typeof AudioContext !== 'undefined' ? 'ada' : 'tidak'));
  check('R23B-04 Web Audio tersedia (dipakai pratinjau)', ctxState === 'ada');

  // 2. Klip musik: preset Bass, slider treble (satu simpan), kecepatan 2×.
  await pick('.track .clip.music', 0);
  await fx.getByLabel('Preset EQ').selectOption('bass');
  check('R23B-05 Preset "Bass" mengisi slider (bass +6, treble −1)', await until(async () => JSON.stringify((await clips('music'))[0].eq) === JSON.stringify({ bass: 6, mid: 0, treble: -1 })));
  await pick('.track .clip.music', 0);
  await fx.getByLabel('EQ Treble').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const eqOk = await until(async () => (await clips('music'))[0].eq?.treble === 2);
  check('R23B-06 Slider treble digeser → tersimpan, preset jadi "Atur sendiri" (hybrid)', eqOk && (await fx.getByLabel('Preset EQ').inputValue()) === 'sendiri', JSON.stringify((await clips('music'))[0].eq));
  const revBefore = (await proj()).revision;
  await fx.getByLabel('Pilihan kecepatan suara').selectOption('2');
  const sped = await until(async () => (await clips('music'))[0].end_ms === 1500);
  check('R23B-07 Kecepatan musik 2× → durasi 3→1,5 dtk, klip musik berikutnya ikut maju', sped && (await clips('music'))[1].start_ms === 1500, JSON.stringify((await clips('music')).map((c) => [c.start_ms, c.end_ms])));
  check('R23B-08 Satu perubahan = satu revisi (satu undo)', (await proj()).revision === revBefore + 1);
  const total = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuemax'));
  const ruler = await page.getByRole('slider', { name: 'Posisi playhead' }).boundingBox();
  await page.mouse.click(ruler.x + (ruler.width * 500) / total, ruler.y + ruler.height / 2);
  await page.waitForTimeout(400);
  const mfx = (await musicEl.getAttribute('data-audiofx')) ?? '';
  const rate = await musicEl.evaluate((a) => a.playbackRate);
  check('R23B-09 Pratinjau musik: playbackRate 2 + EQ (lowshelf 100 Hz +6, highshelf 8 kHz +2)', rate === 2 && /lowshelf100:6/.test(mfx) && /highshelf8000:2/.test(mfx), `rate ${rate} · ${mfx}`);
  await page.screenshot({ path: path.join(EVID, 'eq-suara.png') });
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23B-10 Undo mengembalikan kecepatan musik', await until(async () => (await clips('music'))[0].end_ms === 3000 && (await clips('music'))[0].speed === undefined));
  await pick('.track .clip.music', 0);
  await fx.getByLabel('Preset EQ').selectOption('datar');
  check('R23B-11 Preset "Datar" menghapus EQ', await until(async () => (await clips('music'))[0].eq === undefined));
  check('R23B-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23B-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23B UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
