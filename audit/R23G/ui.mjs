// R23g / R35b (owner 16 Nov): Auto reframe — panel "Alat AI" → deteksi wajah/subjek (mesin) →
// reframe (§18.2 keyframe_app) → keyframe posisi + skala di klip; usulan bisa dihapus / di-undo.
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
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23g-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const f = path.join(work, 'lebar.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: 'lebar.mp4', actor: 'user' });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
await core.createProject(ws, { project_id: 'r23g', name: 'Uji Auto Reframe' });
await svc.editTimeline({ project_id: 'r23g', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3000 }] });
const clip = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r23g')).timeline.tracks.find((t) => t.kind === 'video').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Auto Reframe' }).waitFor();
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const g = page.getByRole('region', { name: 'Alat AI' }).getByRole('group', { name: 'Auto reframe' });
  check('R23G-01 Panel Alat AI punya "Auto reframe (9:16)" + pilihan ikuti wajah / orang', await until(() => g.isVisible(), 8000) && (await g.innerText()).includes('9:16'));
  await g.getByRole('button', { name: /Auto reframe/ }).click();
  const hasil = g.getByRole('status', { name: 'Hasil reframe' });
  check('R23G-02 Deteksi → reframe jalan berurutan (2 job mesin) → keyframe dipasang', await until(() => hasil.isVisible()));
  const c = await clip();
  check('R23G-03 Klip punya keyframe posisi + skala dari mesin (x 0,58 → 0; skala 3,16)', c.keyframes?.length === 2 && c.keyframes[0].x === 0.58 && c.keyframes[0].scale === 3.16 && c.keyframes[1].at_ms === 2000, JSON.stringify(c.keyframes));
  const jobs = await core.listEngineJobs(await core.openWorkspace(wsRoot), 'r23g');
  check('R23G-04 Dua job mesin: deteksi lalu reframe (pakai jalur deteksi)', jobs.length === 2 && jobs.every((j) => j.mode === 'visual' && j.state === 'siap'));
  const video = page.locator('video[aria-label="Video pratinjau"]');
  check('R23G-05 Pratinjau mengikuti keyframe (diperbesar)', await until(async () => /matrix\(3\.1/.test(await video.evaluate((v) => getComputedStyle(v).transform)), 8000), await video.evaluate((v) => getComputedStyle(v).transform));
  await page.screenshot({ path: path.join(EVID, 'reframe.png') });
  await hasil.getByRole('button', { name: 'Hapus keyframe reframe' }).click();
  check('R23G-06 "Hapus keyframe reframe" → keyframe hilang (usulan, hybrid)', await until(async () => !(await clip()).keyframes, 8000));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23G-07 Undo → keyframe reframe kembali', await until(async () => (await clip()).keyframes?.length === 2, 8000));
  check('R23G-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23G-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23G UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
