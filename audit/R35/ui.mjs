// R35a (owner 16 Nov): Visual Tools di Editor — panel "Alat AI" per klip video: Hapus latar /
// Perjelas (AI) jalan sebagai job mesin (perkiraan waktu, progres), hasil masuk Media, "Pakai di klip
// ini" + "Kembalikan asli" (hybrid, undo). Plus look "Soft Aesthetic".
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
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r35-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const f = path.join(work, 'produk.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
const imp = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: 'produk.mp4', actor: 'user' });
const ORIG = imp.version.version_id;
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
await core.createProject(ws, { project_id: 'r35', name: 'Uji Alat AI' });
await svc.editTimeline({ project_id: 'r35', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: ORIG }, start_ms: 0, duration_ms: 3000 }] });
const clip = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r35')).timeline.tracks.find((t) => t.kind === 'video').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Alat AI' }).waitFor();
  await page.locator('.track[data-kind="video"] .clip').first().click();
  const panel = page.getByRole('region', { name: 'Alat AI' });
  check('R35-01 Klip video → panel "Alat AI" (Hapus latar, Perjelas) dengan perkiraan waktu', (await until(() => panel.isVisible())) && (await panel.getByRole('button', { name: /Hapus latar/ }).isVisible()) && (await panel.getByRole('button', { name: /Perjelas/ }).isVisible()) && /±\d+ (dtk|menit)/.test(await panel.innerText()));
  await panel.getByLabel('Kualitas hapus latar').selectOption('tinggi');
  const est = await panel.getByRole('group', { name: 'Hapus latar' }).innerText();
  check('R35-02 Kualitas tinggi → perkiraan waktu jauh lebih lama (menit)', /menit/.test(est), est.replace(/\n/g, ' '));
  await panel.getByLabel('Kualitas hapus latar').selectOption('cepat');

  // Perjelas → result → use on the clip → back.
  await panel.getByRole('button', { name: /Perjelas/ }).click();
  const status = panel.getByRole('status', { name: 'Status alat AI' });
  const hasil = panel.getByRole('status', { name: 'Hasil alat AI' });
  check('R35-03 Perjelas jalan sebagai job mesin → selesai, hasil 720×1280 tersimpan di Media', (await until(() => hasil.isVisible())) && /selesai/.test(await status.innerText()) && /720×1280/.test(await hasil.innerText()), await status.innerText().catch(() => '-'));
  await hasil.getByRole('button', { name: 'Pakai di klip ini' }).click();
  check('R35-04 "Pakai di klip ini" → klip memakai file hasil (waktu sama)', await until(async () => (await clip()).media.version_id !== ORIG && (await clip()).end_ms === 3000));
  await page.screenshot({ path: path.join(EVID, 'alat-ai.png') });
  await hasil.getByRole('button', { name: /Kembalikan asli/ }).click();
  check('R35-05 "Kembalikan asli" → file asli lagi', await until(async () => (await clip()).media.version_id === ORIG));

  // Hapus latar → result in Media.
  await panel.getByRole('button', { name: /Hapus latar/ }).click();
  check('R35-06 Hapus latar → hasil "Latar terhapus" tersimpan di Media', await until(async () => /Latar terhapus/.test(await hasil.innerText())));
  const names = Object.values((await core.loadRegistry(await core.openWorkspace(wsRoot))).media).map((m) => m.display_name);
  check('R35-07 Media: "Tanpa latar …" + "Masker …" + "Diperjelas …"', names.some((n) => n.startsWith('Tanpa latar')) && names.some((n) => n.startsWith('Masker')) && names.some((n) => n.startsWith('Diperjelas')), names.join(', '));

  // Soft Aesthetic look.
  const look = page.getByRole('region', { name: 'Inspector klip' }).getByRole('group', { name: 'Tampilan gambar' }).getByLabel('Filter warna');
  await look.selectOption('soft');
  check('R35-08 Look "Soft Aesthetic" tersedia + tersimpan', await until(async () => (await clip()).look === 'soft'));
  check('R35-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R35-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R35 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
