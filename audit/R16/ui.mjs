// R16 Beat Spot acceptance run: real server, real Chrome, real FFmpeg; the engine CLI is the contract
// stand-in (packages/core/test/fixtures/fake-engine.mjs, contract §16 output files).
// Footage of people + the team's sound → cuts on the beat → the team excludes a shot / marks a creator
// and runs again → plan card → approved = on the timeline (one undo step).
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
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r16-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
const mall1 = path.join(work, 'mall 1.mp4');
const mall2 = path.join(work, 'mall-2.mp4');
const sound = path.join(work, 'sound-tren.wav');
ff(['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mall1]);
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mall2]);
ff(['-f', 'lavfi', '-i', 'sine=f=440:d=8', sound]);
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Beat Spot/ }).click();
  await page.getByRole('heading', { name: 'Beat Spot' }).waitFor();
  check('R16-01 Menu "Beat Spot" membuka halamannya', true);

  const form = page.getByRole('region', { name: 'Footage dan sound' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Footage orang').setInputFiles([mall1, mall2]);
  await form.getByLabel('Sound tim').setInputFiles(sound);
  check('R16-02 Dengan sound tim, isian BPM disembunyikan (ketukan dibaca dari sound)', (await form.getByLabel('BPM').count()) === 0);
  await form.getByRole('button', { name: /Susun Beat Spot/ }).click();
  const hasil = page.getByRole('region', { name: 'Hasil Beat Spot' });
  const shown = await until(async () => (await hasil.getByRole('table', { name: 'Daftar potongan' }).locator('tbody tr').count()) === 4, 30000);
  const txt = shown ? await hasil.innerText() : '';
  check('R16-03 Mesin jalan → 4 potongan di ketukan, tempo dari sound tim, nama footage = nama file upload', shown && txt.includes('128 BPM') && txt.includes('dari sound tim') && txt.includes('mall 1.mp4'), txt.split('\n').slice(0, 3).join(' | '));
  const planCard = page.getByRole('region', { name: 'Rencana edit' });
  check('R16-04 Kartu rencana edit muncul (render ditahan sampai disetujui)', await until(() => planCard.isVisible(), 15000));
  await page.screenshot({ path: path.join(EVID, 'beatspot.png'), fullPage: true });

  // Hybrid: exclude one shot, mark the other footage's shot as creator, run again.
  const firstJob = (await page.getByRole('status', { name: 'Status mesin' }).innerText()).match(/AYS-\d{8}-\d{3}/)?.[0];
  const pilihan = hasil.getByRole('group', { name: 'Pilihan tim' }).or(hasil.locator('details[aria-label="Pilihan tim"]'));
  await pilihan.locator('summary').click();
  const ulang = hasil.getByRole('button', { name: /Susun ulang dengan pilihan tim/ });
  const disabledBefore = await ulang.isDisabled();
  await hasil.getByRole('button', { name: 'Kecualikan mall-1#00' }).click();
  await hasil.getByLabel('Orang di mall-2#00').selectOption('kreator');
  await hasil.getByRole('button', { name: 'Pakai mall-2#01 duluan' }).click();
  await ulang.click();
  const rerun = await until(async () => {
    const j = (await page.getByRole('status', { name: 'Status mesin' }).innerText()).match(/AYS-\d{8}-\d{3}/)?.[0];
    return !!j && j !== firstJob && (await hasil.getByRole('table', { name: 'Daftar potongan' }).locator('tbody tr').count()) === 3;
  }, 30000);
  const rows = await hasil.getByRole('table', { name: 'Daftar potongan' }).locator('tbody tr').allInnerTexts();
  check('R16-05 Pilihan tim (kecualikan, kreator, urutan) → "Susun ulang" membuat job baru sesuai pilihan', disabledBefore && rerun && rows[0]?.includes('mall-2#01') && !rows.some((r) => r.includes('mall-1#00')) && rows.some((r) => r.includes('mall-2#00') && r.includes('Kreator')), rows.join(' / '));

  // Approve → on the timeline, one undo step.
  await until(() => planCard.isVisible(), 15000);
  await planCard.getByRole('button', { name: /Setujui/ }).click();
  await page.getByRole('region', { name: 'Draf diterapkan' }).waitFor();
  const pid = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ms:beatspot.proyek') ?? '""'));
  const p = await core.readProject(ws, pid);
  const vids = p.timeline.tracks.find((t) => t.kind === 'video')?.clips.length ?? 0;
  const music = p.timeline.tracks.find((t) => t.kind === 'music')?.clips.length ?? 0;
  check('R16-06 Setujui → draf Beat Spot masuk timeline (3 potongan + sound)', vids === 3 && music === 1, `video ${vids}, musik ${music}`);
  // The history lists both jobs; the first one still shows its own result.
  const riwayat = page.getByRole('region', { name: 'Riwayat Beat Spot' });
  await riwayat.getByRole('button', { name: `Lihat ${firstJob}` }).click();
  const old = await until(async () => (await hasil.getByRole('table', { name: 'Daftar potongan' }).locator('tbody tr').count()) === 4, 15000);
  check('R16-07 Riwayat: job pertama tetap bisa dibuka dengan hasilnya sendiri', old && (await riwayat.locator('tbody tr').count()) === 2);

  await page.setViewportSize({ width: 390, height: 844 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: path.join(EVID, 'beatspot-hp.png'), fullPage: true });
  check('R16-08 HP 390px: tanpa scroll samping halaman', over <= 1, `overflow ${over}px`);
  check('R16-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R16-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R16 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
