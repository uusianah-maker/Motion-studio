// R35c (owner 16 Nov): Lacak objek — seret kotak di pratinjau → mesin melacak (§18.7) → teks ikut
// objek (keyframe) atau blur ikut objek (area blur); semuanya edit biasa (bisa diatur / undo).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r35c-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const f = path.join(work, 'produk.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: 'produk.mp4', actor: 'user' });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
await core.createProject(ws, { project_id: 'r35c', name: 'Uji Lacak Objek' });
await svc.editTimeline({ project_id: 'r35c', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3000 },
  { op: 'add_clip', track_kind: 'text', text: 'Harga 99rb', start_ms: 0, duration_ms: 3000 },
] });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'r35c');
const vclip = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips[0];
const tclip = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Lacak Objek' }).waitFor();
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const g = page.getByRole('region', { name: 'Alat AI' }).getByRole('group', { name: 'Lacak objek' });
  check('R35C-01 Panel Alat AI punya "Lacak objek"', await until(() => g.isVisible(), 8000));
  await g.getByRole('button', { name: /Pilih objek di pratinjau/ }).click();
  const picker = page.getByRole('application', { name: 'Gambar kotak objek' });
  check('R35C-02 Pratinjau masuk mode gambar kotak (+ petunjuk)', await until(() => picker.isVisible(), 5000));
  const box = await picker.boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 6 });
  await page.mouse.up();
  const hasil = g.getByRole('status', { name: 'Hasil lacak' });
  check('R35C-03 Kotak → job lacak mesin → objek terlacak', await until(() => hasil.isVisible()), await g.innerText().catch(() => '-'));
  const jobs = await core.listEngineJobs(await core.openWorkspace(wsRoot), 'r35c');
  const jobJson = JSON.parse(await fsp.readFile(path.join(wsRoot, 'PROJECTS', 'r35c', '06_ENGINE', jobs[0].job_id, 'job.json'), 'utf8'));
  check('R35C-04 Kotak dikirim dalam pecahan SUMBER (dari kotak pratinjau), metode csrt', jobJson.visual.alat === 'lacak' && jobJson.visual.kotak.length === 4 && jobJson.visual.kotak.every((v) => v > 0 && v < 1) && jobJson.visual.metode === 'csrt', JSON.stringify(jobJson.visual.kotak));
  check('R35C-05 Pratinjau keluar dari mode gambar kotak', (await picker.count()) === 0);
  await page.screenshot({ path: path.join(EVID, 'lacak.png') });
  await hasil.getByRole('button', { name: 'Teks ikut objek' }).click();
  check('R35C-06 "Teks ikut objek" → teks dapat keyframe gerak', await until(async () => ((await tclip()).keyframes?.length ?? 0) >= 2), JSON.stringify((await tclip()).keyframes));
  await hasil.getByRole('button', { name: 'Blur ikut objek' }).click();
  check('R35C-07 "Blur ikut objek" → area blur di klip video (waktu bertahap)', await until(async () => ((await vclip()).blur?.length ?? 0) >= 2), JSON.stringify((await vclip()).blur?.map((b) => [b.dari_ms, b.sampai_ms])));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R35C-08 Undo → blur ikut objek hilang, keyframe teks tetap', await until(async () => !(await vclip()).blur && ((await tclip()).keyframes?.length ?? 0) >= 2));
  check('R35C-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R35C-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R35C UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
