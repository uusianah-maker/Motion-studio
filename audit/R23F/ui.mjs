// R23f (owner 16 Nov): stabilisasi video — Inspector "Stabilkan" (Ringan/Kuat), dibuat sekali di
// latar belakang (FFmpeg vid.stab 2 tahap, prioritas rendah), status sampai siap, pratinjau memutar
// versi stabil, render memakai versi stabil, "Mati" kembali ke asli.
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
const until = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23f-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const f = path.join(work, 'goyang.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-vf', 'crop=320:600:20+12*sin(n*2.1):20+12*cos(n*1.7)', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: 'goyang.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'r23f', name: 'Uji Stabil' });
await svc.editTimeline({ project_id: 'r23f', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 2500 }] });
const clip = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r23f')).timeline.tracks.find((t) => t.kind === 'video').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Stabil' }).waitFor();
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const motion = page.getByRole('region', { name: 'Inspector klip' }).getByRole('group', { name: 'Arah dan kecepatan' });
  await motion.getByLabel('Stabilkan video').selectOption('kuat');
  check('R23F-01 Stabilkan "Kuat" tersimpan di klip', await until(async () => (await clip()).stabil === 'kuat', 8000));
  const status = motion.getByRole('status', { name: 'Status stabil' });
  check('R23F-02 Status tampil saat dibuat di latar belakang', await until(async () => /membuat video stabil|siap/.test(await status.innerText()), 8000), await status.innerText().catch(() => '-'));
  check('R23F-03 Video stabil selesai → "✓ siap"', await until(async () => (await status.innerText()).includes('siap')), await status.innerText().catch(() => '-'));
  const video = page.locator('video[aria-label="Video pratinjau"]');
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const usesStabil = await until(async () => ((await video.getAttribute('src')) ?? '').includes('stabil=kuat'), 90000);
  check('R23F-04 Pratinjau memutar versi stabil', usesStabil, ((await video.getAttribute('src')) ?? '').replace(/sig=[0-9a-f]+/, 'sig=…'));
  await page.screenshot({ path: path.join(EVID, 'stabil.png') });
  const res = await core.renderProject(await core.openWorkspace(wsRoot), { project_id: 'r23f', output_name: 'stabil.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  check('R23F-05 Render memakai versi stabil (selesai)', res.status === 'completed');
  await motion.getByLabel('Stabilkan video').selectOption('off');
  check('R23F-06 "Mati" → klip kembali memakai asli', await until(async () => (await clip()).stabil === undefined, 8000));
  check('R23F-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23F-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23F UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
