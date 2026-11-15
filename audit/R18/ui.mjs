// R18 presets (owner: "Ya, pasang"; KONTRAK-ENGINE §17): Brand gets tagline + watermark and
// "Isi contoh preset Aysilla" (4 presets, never overwriting); the job forms send the audio choice
// (and Beat Spot a preset) to job.json. The engine is the contract stand-in (fake-engine.mjs).
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
const { exportBrandKit } = await import(pathToFileURL(path.join(root, 'packages/core/dist/storage/brand.js')).href);
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r18-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', '-af', 'volume=0.05', path.join(engine, 'aset', 'musik-lokal.wav')]);
const talk = path.join(work, 'rekaman-bicara.mp4');
const mall = path.join(work, 'mall.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
ff(['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mall]);
const own = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: [], ukuran: '' }], presets: [{ id: 'aysilla-harian', nama: 'Harian versi tim', tujuan: 'punya tim' }] }, actor: 'user' })).result;

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
/** The newest engine job of a mode, over all projects (project ids are random: no order to rely on). */
const jobOf = async (mode) => {
  for (const pid of await core.listProjectIds(ws)) {
    const j = (await core.listEngineJobs(ws, pid)).find((x) => x.mode === mode);
    if (j) return JSON.parse(await fsp.readFile(path.join(wsRoot, 'PROJECTS', pid, '06_ENGINE', j.job_id, 'job.json'), 'utf8'));
  }
  return null;
};
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Brand/ }).click();
  await page.getByLabel('Tagline', { exact: true }).waitFor();
  await page.getByLabel('Tagline', { exact: true }).fill('CUCI · JEMUR · LANGSUNG PAKAI');
  await page.getByLabel('Watermark teks').fill('AYSILLA FACTORY');
  await page.getByRole('button', { name: /Isi contoh preset Aysilla/ }).click();
  const note = page.getByRole('status', { name: 'Preset contoh' });
  await note.waitFor();
  const n1 = await note.innerText();
  check('R18-01 "Isi contoh preset Aysilla" menambah 3 preset (aysilla-harian milik tim tidak ditimpa)', n1.startsWith('3 preset contoh ditambahkan'), n1);
  await page.getByRole('button', { name: /Simpan Brand Kit/ }).click();
  const saved = await until(async () => (await core.readBrandFor(ws, own.brand_id)).revision > own.revision);
  const kit = await core.readBrandFor(ws, own.brand_id);
  const ids = kit.presets.map((p) => p.id);
  const harian = kit.presets.find((p) => p.id === 'aysilla-harian');
  const inter = kit.presets.find((p) => p.id === 'aysilla-interview');
  check(
    'R18-02 Tersimpan: tagline + watermark, 4 preset; angka contoh (interview caption 0,76 / hook 0,18 / flash) ikut',
    saved && kit.tagline === 'CUCI · JEMUR · LANGSUNG PAKAI' && kit.watermark?.teks === 'AYSILLA FACTORY' && kit.watermark?.y === 0.07 && kit.watermark?.lebar === 0.25 && kit.watermark?.opasitas === 0.85 && ids.length === 4 && harian?.nama === 'Harian versi tim' && inter?.caption.y === 0.76 && inter?.hook.y === 0.18 && inter?.transisi?.ganti_orang === 'flash',
    ids.join(','),
  );
  const exp = await exportBrandKit(ws, own.brand_id, { paths: false });
  check('R18-03 Ekspor Brand Kit ke mesin: teks.tagline + visual.watermark (nama field kontrak §17.3)', exp.teks.tagline === 'CUCI · JEMUR · LANGSUNG PAKAI' && exp.visual.watermark?.teks === 'AYSILLA FACTORY');
  await page.getByRole('button', { name: /Isi contoh preset Aysilla/ }).click();
  check('R18-04 Klik lagi: tidak ada yang ditimpa', await until(async () => (await note.innerText()).includes('tidak ada yang ditimpa')));
  // The style block of a preset shows the learnt numbers and stays editable.
  const posCap = page.getByLabel('Preset 2 posisi caption');
  check('R18-05 Field gaya hasil belajar tampil & bisa diubah (posisi caption preset interview = 0.76)', (await posCap.inputValue()) === '0.76');
  await page.screenshot({ path: path.join(EVID, 'brand-preset.png'), fullPage: true });

  // Video iklan: Audio "Voice over" → job.audio_pilihan "vo".
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  const form = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Video bicara').setInputFiles(talk);
  await form.getByLabel('Produk').selectOption('Loose Pants');
  await form.getByLabel('Audio').selectOption('vo');
  await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
  const j1 = (await until(async () => !!(await jobOf('generate')), 20000)) ? await jobOf('generate') : null;
  check('R18-06 Video iklan: pilihan "Voice over" → job.json audio_pilihan "vo"', j1?.audio_pilihan === 'vo', JSON.stringify(j1?.audio_pilihan));

  // Beat Spot: preset + "Keduanya" → job.json preset + audio_pilihan.
  await page.getByRole('navigation', { name: 'Cara membuat video' }).getByRole('button', { name: /Beat Spot/ }).click();
  const bs = page.getByRole('region', { name: 'Footage dan sound' });
  await until(async () => (await bs.getByLabel('Preset').locator('option').count()) > 1);
  await bs.getByLabel('Footage orang').setInputFiles(mall);
  await bs.getByLabel('Preset').selectOption('aysilla-beatspot');
  await bs.getByLabel('Audio').selectOption('keduanya');
  await bs.getByRole('button', { name: /Susun Beat Spot/ }).click();
  const j2 = (await until(async () => !!(await jobOf('beatspot')), 20000)) ? await jobOf('beatspot') : null;
  check('R18-07 Beat Spot: preset + "Keduanya" → job.json preset aysilla-beatspot, audio_pilihan keduanya, durasi preset 15–18; "auto" tidak dikirim', j2?.preset === 'aysilla-beatspot' && j2?.audio_pilihan === 'keduanya' && j2?.beatspot && !('ketukan_per_potong' in j2.beatspot) && j2.beatspot.durasi.join('-') === '15-18', JSON.stringify({ preset: j2?.preset, audio: j2?.audio_pilihan, bs: j2?.beatspot }));
  check('R18-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R18-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R18 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
