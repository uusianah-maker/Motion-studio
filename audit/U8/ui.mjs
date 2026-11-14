// U8 acceptance run (audit yuki 14 Nov 2026, Batch Remix library): real server, real Chrome, real
// FFmpeg; the engine CLI is the contract stand-in (packages/core/test/fixtures/fake-engine.mjs:
// `engine pisah`, `engine daftar_batch`, shots.json + thumbnails, kalimat per variant).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u8-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'konten'), { recursive: true });
ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(engine, 'konten', 'f1.mp4')]);
ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3', '-af', 'volume=0.1', path.join(engine, 'konten', 'f1-vokal.wav')]);
const uploads = [];
for (const [n, c] of [['IN1', 'gray'], ['IN2', 'navy'], ['RUSAK', 'olive']]) {
  const f = path.join(work, `${n}.mp4`);
  ff(['-f', 'lavfi', '-i', `color=c=${c}:s=360x640:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  uploads.push(f);
}
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const BATCH = '2026-11-14_baru';
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Batch/ }).click();
  await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();

  // ---- fitur 1: Upload + Pisah Audio from the dashboard
  const up = page.getByRole('region', { name: 'Footage baru' });
  await up.getByLabel('Nama batch baru').fill(BATCH);
  await up.getByLabel('Video footage').setInputFiles(uploads);
  await until(() => up.getByRole('button', { name: /Upload 3 video & Pisahkan/ }).isEnabled());
  await up.getByRole('button', { name: /Upload 3 video & Pisahkan/ }).click();
  const hasil = up.getByLabel('Hasil pisah');
  const split = await until(() => hasil.isVisible(), 30000);
  check('U8-01 Upload 2 video → mesin Pisah Audio (progres) → daftar hasil: video bisu, vokal, musik per file', split && (await up.getByRole('status', { name: 'Status mesin' }).innerText()).includes('Selesai dipisah') && (await hasil.locator('tbody tr').count()) === 2 && (await hasil.getByRole('cell', { name: 'IN1.mp4' }).isVisible()) && (await hasil.innerText()).includes('Batch 2026-11-14_baru siap'));
  const skipped = up.getByLabel('File dilewati');
  check('U8-01b Video rusak dilewati mesin dan disebut (nama file + alasan, tanpa path lokal)', (await skipped.isVisible()) && (await skipped.innerText()).includes('RUSAK.mp4') && (await skipped.innerText()).includes('<path>') && !/[A-Za-z]:[\\/]/.test(await skipped.innerText()));
  const inEngine = await fsp.readdir(path.join(engine, 'konten', '1-upload', BATCH)).catch(() => []);
  check('U8-02 Mesin yang menyalin unggahan ke konten/1-upload/<batch>; salinan di job (masuk/) dihapus', inEngine.sort().join(',') === 'IN1.mp4,IN2.mp4', inEngine.join(','));
  await page.screenshot({ path: path.join(EVID, 'pisah.png') });

  // ---- fitur 2: batch dropdown from `engine daftar_batch`
  const bform = page.getByRole('region', { name: 'Susun batch' });
  const picked = await until(async () => (await bform.getByLabel('Nama batch').inputValue()) === BATCH);
  const opt = await bform.getByLabel('Nama batch').locator('option').first().innerText();
  check('U8-03 Nama batch = dropdown dari mesin (jumlah footage, VO, shot); batch hasil pisah langsung terpilih', picked && opt.includes('2 footage · 2 VO · 5 shot'), opt);

  // ---- fitur 5: Shot Library page
  await nav.getByRole('button', { name: /Shot/ }).click();
  await page.getByRole('heading', { name: 'Shot Library' }).waitFor();
  const grid = page.getByRole('region', { name: 'Daftar shot' });
  await until(() => grid.isVisible());
  const cards = grid.locator('.shotCard');
  const thumbsOk = await until(async () => (await grid.locator('img.shotThumb').count()) === 4);
  const srcs = await grid.locator('img.shotThumb').evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
  const decoded = await until(async () => (await grid.locator('img.shotThumb').evaluateAll((els) => els.every((e) => e.complete && e.naturalWidth > 0))));
  check('U8-04 Grid shot per batch: 5 shot, thumbnail mesin (4; path di luar batch tidak dilayani), label tampil', (await cards.count()) === 5 && thumbsOk && srcs.every((s) => s.startsWith('data:image/jpeg;base64,')) && decoded && (await grid.locator('[data-shot="IN1#00"]').innerText()).includes('wajah bicara') && !(await grid.innerText()).includes('Loosepants') && (await grid.locator('[data-shot="IN1#01"]').innerText()).includes('dikoreksi tim'));
  await page.getByLabel('Filter label').selectOption('teks_bawaan');
  check('U8-05 Filter label (teks_bawaan) → 2 shot', await until(async () => (await cards.count()) === 2));
  await page.getByLabel('Filter label').selectOption('');
  await grid.locator('[data-shot="IN1#00"]').getByRole('button', { name: /Kecualikan/ }).click();
  await grid.locator('[data-shot="IN2#01"]').getByRole('button', { name: /Kecualikan/ }).click();
  await grid.getByRole('button', { name: /Simpan pengecualian \(2\)/ }).click();
  const savedOk = await until(() => grid.getByRole('status').filter({ hasText: '2 shot dikecualikan' }).isVisible());
  check('U8-06 Kecualikan 2 shot + simpan → tersimpan di sisi app (bukan di folder mesin)', savedOk && (await core.readShotExclusions(ws, BATCH)).join(',') === 'IN1#00,IN2#01');
  await page.getByLabel('Filter status').selectOption('dikecualikan');
  check('U8-07 Filter "Dikecualikan" → 2 shot', await until(async () => (await cards.count()) === 2));
  await page.screenshot({ path: path.join(EVID, 'shot-library.png') });

  // ---- fitur 3 form + exclusions reach the engine
  await nav.getByRole('button', { name: /Batch/ }).click();
  await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();
  await until(async () => (await bform.getByLabel('Nama batch').inputValue()) === BATCH);
  check('U8-08 Form batch menyebut jumlah shot yang dikecualikan', await until(() => bform.getByLabel('Shot dikecualikan').filter({ hasText: '2 shot dikecualikan' }).isVisible()));
  await bform.getByLabel('Jumlah varian').fill('3');
  await bform.getByLabel('Preset').fill('aysilla-konversi');
  await bform.getByLabel('Izinkan musik tanpa lisensi').check();
  await bform.getByLabel('Buang urgensi').check();
  await bform.getByRole('button', { name: /Susun 3 varian/ }).click();
  const table = page.getByRole('region', { name: 'Tabel batch' });
  await until(() => table.isVisible(), 30000);
  let job = null;
  for (const id of await core.listProjectIds(ws)) {
    const dir = path.join(wsRoot, 'PROJECTS', id, '06_ENGINE');
    for (const j of await fsp.readdir(dir).catch(() => [])) {
      const x = JSON.parse(await fsp.readFile(path.join(dir, j, 'job.json'), 'utf8'));
      if (x.mode === 'batch') job = x;
    }
  }
  const sentText = await page.getByLabel('Pilihan yang dikirim').innerText().catch(() => '');
  check('U8-09b Kartu job menyebut pilihan yang dikirim (hak pakai, musik uji, buang otomatis)', sentText.includes('hak pakai jelas: tidak') && sentText.includes('musik tanpa lisensi (uji): ya') && sentText.includes('buang otomatis: urgensi'), sentText);
  check(
    'U8-09 job.json batch: kecualikan_shot dari app, izinkan musik tanpa lisensi, buang_otomatis',
    job && job.batch === BATCH && job.kecualikan_shot?.join(',') === 'IN1#00,IN2#01' && job.izinkan_musik_tanpa_lisensi === true && job.buang_otomatis?.join(',') === 'urgensi' && job.vo_batch === undefined,
    JSON.stringify(job && { batch: job.batch, kecualikan_shot: job.kecualikan_shot, buang: job.buang_otomatis }),
  );

  // ---- fitur 4: per-variant breakdown before approve / strike
  await table.getByRole('button', { name: 'Rincian varian-001' }).click();
  const d1 = table.getByLabel('Rincian varian-001', { exact: true }).last();
  const d1Ok = await until(() => d1.isVisible());
  const d1Text = d1Ok ? await d1.innerText() : '';
  check('U8-10 Rincian varian: kalimat VO + waktu + shot di bawahnya', d1Text.includes('Hook 1') && d1Text.includes('Cek keranjang') && d1Text.includes('0,8–1,1 dtk') && (await d1.locator('figcaption', { hasText: 'F1#01' }).count()) === 1, d1Text.replace(/\n/g, ' | ').slice(0, 160));
  await table.getByRole('button', { name: 'Rincian varian-002' }).click();
  const d2 = table.getByLabel('Rincian varian-002', { exact: true }).last();
  check('U8-11 Batch lama tanpa kalimat dari mesin: rincian dari caption rencana, diberi keterangan', await until(async () => (await d2.innerText()).includes('Dari caption rencana') && (await d2.innerText()).includes('Hook 2')));
  await page.screenshot({ path: path.join(EVID, 'batch-rincian.png') });

  // Phone width: Shot Library fits.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Shot/ }).click();
  await phone.getByRole('heading', { name: 'Shot Library' }).waitFor();
  await until(() => phone.locator('.shotCard').first().isVisible());
  const out = await phone.evaluate(() => [...document.querySelectorAll('input, select, textarea, button, .shotCard')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  check('U8-12 Layar HP: Shot Library tidak keluar layar', out === 0, `${out} keluar`);
  await phone.screenshot({ path: path.join(EVID, 'shot-phone.png') });
  check('U8-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('U8-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`U8 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
