// U3 acceptance run (render features replacing Remotion). U3a: SFX track next to music, mute,
// final loudness setting; real render measured with ebur128 (real Chrome + FFmpeg).
import { execFileSync, spawnSync } from 'node:child_process';
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u3-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const video = await gen('bicara.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=220:d=3', '-af', 'volume=0.05', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const music = await gen('musik.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-af', 'volume=0.05']);
await gen('pop.wav', ['-f', 'lavfi', '-i', 'sine=f=1200:d=0.3']);
await core.createProject(ws, { project_id: 'u3', name: 'Uji U3' });
await svc.editTimeline({
  project_id: 'u3',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: video, start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'audio', media: music, start_ms: 0, duration_ms: 3000, volume: 0.3 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'u3');
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji U3' }).waitFor();

  // U3a — SFX over music.
  await page.getByRole('button', { name: 'Tambah SFX pop.wav' }).click();
  check('U3a-01 "＋ SFX" menaruh SFX di track SFX (bersamaan dengan musik di track Audio)', await until(async () => (await proj()).timeline.tracks.find((t) => t.kind === 'sfx')?.clips.length === 1));
  await page.locator('.track .clip.sfx').first().waitFor({ timeout: 5000 }).catch(() => undefined);
  check('U3a-02 Track SFX tampil di linimasa dengan tombol mute', (await page.locator('.track .clip.sfx').count()) === 1 && (await page.getByRole('button', { name: /track SFX/ }).count()) === 1);
  check('U3a-03 Pratinjau punya lapisan suara SFX sendiri', (await page.locator('audio[data-layer="sfx"]').count()) === 1);
  await page.locator('summary[aria-label="Kelola proyek"]').click();
  await page.getByRole('group', { name: 'Kelola proyek' }).getByLabel('Loudness akhir').selectOption('-14');
  check('U3a-04 Menu ⋯ Proyek: Loudness akhir −14 LUFS tersimpan di proyek', await until(async () => (await proj()).timeline.loudness_lufs === -14));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '↧ Render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render MP4' });
  await dialog.getByLabel('Nama file output').fill('u3a');
  await dialog.getByLabel('Resolusi render').selectOption('720');
  const startBtn = dialog.getByRole('button', { name: /Mulai render/ });
  await until(() => startBtn.isEnabled());
  await startBtn.click();
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 90_000 });
  const out = path.join(wsRoot, 'PROJECTS', 'u3', '05_OUTPUT', 'u3a.mp4');
  const log = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr;
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf('Summary')))?.[1]);
  check('U3a-05 Render: loudness terukur ±−14 LUFS, metadata bersih', Math.abs(lufs + 14) < 1.5 && (await dialog.getByText(/metadata bersih \(terverifikasi\)/).isVisible()), `${lufs} LUFS`);
  await page.keyboard.press('Escape');

  // U3b — per-word captions.
  const v0 = (await proj()).revision;
  await svc.editTimeline({
    project_id: 'u3',
    expected_revision: v0,
    actor: 'user',
    ops: [{ op: 'add_clip', track_kind: 'subtitle', text: 'x', words: [{ text: 'Celana', start_ms: 0, end_ms: 500 }, { text: 'anti', start_ms: 500, end_ms: 900 }, { text: 'kusut', start_ms: 900, end_ms: 1400 }], style: { anim: 'pop', highlight: { words: ['kusut'], color: '#ff0000', scale: 1.2, current: false } }, start_ms: 1000, duration_ms: 1600 }],
  });
  await page.reload();
  await page.getByRole('heading', { name: 'Uji U3' }).waitFor();
  const ruler = await page.getByRole('slider', { name: 'Posisi playhead' }).boundingBox();
  const total = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuemax'));
  const seek = async (ms) => {
    await page.mouse.click(ruler.x + (ruler.width * ms) / total, ruler.y + ruler.height / 2);
    await page.waitForTimeout(250);
  };
  const vis = () => page.evaluate(() => [...document.querySelectorAll('.overlayText[data-kind="subtitle"] [data-word]')].filter((e) => getComputedStyle(e).visibility === 'visible').map((e) => e.getAttribute('data-word')));
  await seek(1700);
  const mid = await vis();
  await seek(2200);
  const all = await vis();
  check('U3b-01 Pratinjau: kata muncul sesuai ucapan (1,7 dtk: 2 kata; 2,2 dtk: 3 kata), sisanya tak terlihat', mid.join() === 'Celana,anti' && all.join() === 'Celana,anti,kusut', `${mid} | ${all}`);
  const hot = await page.evaluate(() => getComputedStyle(document.querySelector('.overlayText [data-word="kusut"]')).color);
  check('U3b-02 Kata kunci "kusut" berwarna sorot di pratinjau', hot === 'rgb(255, 0, 0)', hot);
  await page.locator('.track .clip.subtitle').first().click();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  check('U3b-03 Inspector: Animasi "Pop" + kata kunci "kusut" + jumlah kata bertimecode', (await insp.getByLabel('Animasi teks').inputValue()) === 'pop' && (await insp.getByLabel('Kata kunci disorot').inputValue()) === 'kusut' && (await insp.getByText(/3 kata bertimecode/).count()) === 1);
  await insp.getByLabel('Animasi teks').selectOption('fade');
  check('U3b-04 Ganti animasi di inspector tersimpan', await until(async () => (await proj()).timeline.tracks.find((t) => t.kind === 'subtitle').clips[0].style.anim === 'fade'));
  await page.getByRole('button', { name: 'Tambah musik musik.wav' }).click();
  check('U3b-05 "＋ Musik" menaruh musik di track Musik (terpisah dari Audio & SFX)', await until(async () => (await proj()).timeline.tracks.find((t) => t.kind === 'music')?.clips.length === 1));
  await page.screenshot({ path: path.join(EVID, 'captions.png') });

  check('U3-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('U3-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nU3 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
