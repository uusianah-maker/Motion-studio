// U4 + U5 acceptance run (Generate Otomatis, Batch Remix) with the U6 runner: real server, real
// Chrome, real FFmpeg; the engine CLI is the contract stand-in (packages/core/test/fixtures/
// fake-engine.mjs: same arguments, exit codes, JSON-lines progress and output files).
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
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u4-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
// Engine folder: its own music + batch footage (outside the workspace, like D:\VIBECODING\remotion).
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
await fsp.mkdir(path.join(engine, 'konten'));
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=2', '-af', 'volume=0.05', path.join(engine, 'aset', 'musik-lokal.wav')]);
ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(engine, 'konten', 'f1.mp4')]);
ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3', '-af', 'volume=0.1', path.join(engine, 'konten', 'f1-vokal.wav')]);
// The batch already split by the engine (konten/2-dipisah): it shows up in the batch dropdown.
const dipisah = path.join(engine, 'konten', '2-dipisah', '2026-11-13_winning');
for (const d of ['video-bisu', 'vokal']) await fsp.mkdir(path.join(dipisah, d), { recursive: true });
await fsp.copyFile(path.join(engine, 'konten', 'f1.mp4'), path.join(dipisah, 'video-bisu', 'F1.mp4'));
await fsp.copyFile(path.join(engine, 'konten', 'f1-vokal.wav'), path.join(dipisah, 'vokal', 'F1.wav'));
await fsp.writeFile(path.join(dipisah, 'shots.json'), JSON.stringify({ schema: 'shots/1', batch: '2026-11-13_winning', footage: { F1: { durasi: 3 } }, shots: [{ id: 'F1#00', footage: 'F1', dari: 0, sampai: 1.5 }] }));
const talk = path.join(work, 'rekaman-bicara.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', produk: [{ nama: 'Loose Pants', varian: ['Espresso', 'Black'] }] }, actor: 'user' });

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
  await nav.getByRole('button', { name: /Buat video/ }).waitFor();
  // R17: Generate (Video iklan) and Batch Remix live inside "1. Buat video", next to "2. Edit".
  await nav.getByRole('button', { name: /Buat video/ }).click();
  check('U4-01 Menu R17: "1. Buat video" berisi Video iklan + Batch Remix; "2. Edit" di navigasi utama', (await page.getByRole('button', { name: /^Buka Video iklan/ }).isVisible()) && (await page.getByRole('button', { name: /^Buka Batch Remix/ }).isVisible()) && (await nav.getByRole('button', { name: /^2\. Edit$/ }).isVisible()));

  // ---- U4 Generate Otomatis
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const form = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Video bicara').setInputFiles(talk);
  await form.getByLabel('Produk').selectOption('Loose Pants');
  await form.getByLabel('Varian').selectOption('Espresso');
  await form.getByLabel('Preset').fill('aysilla-konversi');
  await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
  const card = page.getByRole('region', { name: 'Rencana edit' });
  const shown = await until(() => card.isVisible(), 30000);
  check('U4-02 Upload + brief → mesin jalan (progres) → kartu "Rencana edit siap, render ditahan"', shown);
  const status = page.getByRole('status', { name: 'Status mesin' });
  check('U4-03 Status job: Rencana siap (job id AYS-YYYYMMDD-001)', /AYS-\d{8}-001/.test(await status.innerText()) && (await status.getAttribute('data-state')) === 'siap');
  const cardText = await card.innerText();
  check('U4-04 Kartu rencana: hook, durasi mentah → akhir, kata yang perlu dicek', cardText.includes('tanpa batas durasi · saran 15–30 dtk') && cardText.includes('Celana adem') && /3,0 dtk → 1,5 dtk/.test(cardText) && cardText.includes('Periksa kata "adem"'), cardText.split('\n').slice(0, 6).join(' | '));
  const qcList = card.getByRole('list', { name: 'Cek rencana mesin' });
  check('U4-04b Kartu rencana: cek mesin (qc_rencana), posisi caption, musik + lisensi', (await qcList.getByText('⚠ durasi sesuai target (1.5)').isVisible()) && (await qcList.getByText('✓ hook di 3 detik pertama').isVisible()) && cardText.includes('Posisi caption: 72%') && cardText.includes('lisensi: milik_sendiri'));
  const projects = await core.listProjectIds(ws);
  const pid = projects.find((p) => p !== 'u3');
  const before = await core.readProject(ws, pid);
  check('U4-05 Sebelum disetujui timeline tidak berubah (brand proyek = brand terpilih)', before.revision <= 1 && !before.timeline.tracks.some((t) => t.clips.length) && !!before.brand_id);
  await page.screenshot({ path: path.join(EVID, 'generate-plan.png') });
  await card.getByRole('button', { name: /Setujui/ }).click();
  await page.getByRole('region', { name: 'Draf diterapkan' }).waitFor();
  const after = await core.readProject(ws, pid);
  check('U4-06 Setujui = diterapkan ke timeline sebagai satu langkah (video + subtitle kata + musik mesin)', after.revision === before.revision + 1 && after.timeline.tracks.map((t) => t.kind).join(',') === 'video,subtitle,music', after.timeline.tracks.map((t) => t.kind).join(','));
  const sub = after.timeline.tracks.find((t) => t.kind === 'subtitle').clips[0];
  check('U4-07 Caption per kata + sorot dari mesin terbawa (words + pop + highlight)', sub.words?.length === 2 && sub.style?.anim === 'pop' && sub.style?.highlight?.words?.[0] === 'adem');
  check('U4-08 Riwayat job proyek tampil', await until(() => page.getByRole('region', { name: 'Riwayat job mesin' }).getByRole('cell', { name: /AYS-\d{8}-001/ }).isVisible()));
  await page.getByRole('button', { name: /Buka di Edit/ }).click();
  check('U4-09 "Buka di Editor" membuka proyek draf untuk render & QC', await until(() => page.getByRole('heading', { name: before.name }).isVisible()));

  // ---- U5 Batch Remix
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Batch Remix/ }).click();
  await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();
  const bform = page.getByRole('region', { name: 'Susun batch' });
  await until(async () => (await bform.getByLabel('Brand').inputValue()) !== '');
  await until(async () => (await bform.getByLabel('Nama batch').inputValue()) === '2026-11-13_winning');
  await bform.getByLabel('Nama batch').selectOption('2026-11-13_winning');
  await bform.getByLabel('Jumlah varian').fill('3');
  await bform.getByLabel('Preset').fill('aysilla-konversi');
  await bform.getByLabel('Hak pakai footage jelas').check();
  await bform.getByRole('button', { name: /Susun 3 varian/ }).click();
  const table = page.getByRole('region', { name: 'Tabel batch' });
  check('U5-01 Mesin menyusun batch → tabel 3 varian (hook, VO, shot, durasi, QC)', await until(() => table.isVisible(), 30000) && (await table.locator('tbody tr').count()) === 3);
  check('U5-02 Varian bermusik tanpa lisensi ditandai UJI (bukan iklan)', (await table.locator('tbody tr').nth(2).getByText('UJI').isVisible()) && (await table.locator('tbody tr').nth(0).getByText('UJI').count()) === 0);
  await table.getByRole('group', { name: 'Keputusan varian-001' }).getByRole('button', { name: /Setujui/ }).click();
  await table.getByRole('group', { name: 'Keputusan varian-002' }).getByRole('button', { name: /Coret/ }).click();
  await table.getByRole('group', { name: 'Keputusan varian-003' }).getByRole('button', { name: /Setujui/ }).click();
  check('U5-03 Baris dicoret tampil dicoret sebelum disimpan', (await table.locator('tbody tr').nth(1).getAttribute('class')) === 'struck');
  await table.getByRole('button', { name: /Simpan keputusan \(3\)/ }).click();
  const variantProjects = async () => {
    const out = [];
    for (const id of await core.listProjectIds(ws)) {
      const p = await core.readProject(ws, id).catch(() => null);
      if (p?.variant) out.push(p);
    }
    return out;
  };
  const variantsOk = await until(async () => {
    const vs = await variantProjects();
    return vs.length === 2 && vs.every((p) => p.variant.approved_revision === p.revision);
  });
  check('U5-04 Simpan: 2 baris disetujui jadi proyek varian yang sudah disetujui; yang dicoret tidak', variantsOk, (await variantProjects()).map((p) => p.variant.label).join(' | '));
  await page.screenshot({ path: path.join(EVID, 'batch-table.png') });
  await table.getByRole('button', { name: /Render 2 varian disetujui/ }).click();
  check('U5-05 "Render varian disetujui" memasukkan tepat 2 render ke antrean', await until(() => table.getByRole('status').filter({ hasText: '2 render masuk antrean' }).isVisible()));
  // Real renders of the approved variants (crop + blur + VO + subtitle) finish with clean metadata.
  const outputs = async () => {
    let n = 0;
    for (const id of await core.listProjectIds(ws)) n += (await core.listOutputs(ws, id).catch(() => [])).length;
    return n;
  };
  check('U5-06 Dua varian benar-benar dirender (FFmpeg, crop & blur area, VO terpisah)', await until(async () => (await outputs()) === 2, 120000), `${await outputs()} output`);
  const jobs = page.getByRole('region', { name: 'Batch sebelumnya' });
  // R4 (G4): one count per brand per day over all projects — the batch is this brand's 2nd job today.
  check('U5-07 Batch sebelumnya bisa dibuka lagi (nomor job lanjut per brand: -002)', await until(() => jobs.getByRole('cell', { name: /AYS-\d{8}-002/ }).isVisible()));

  // Phone width: no field sticks out of the page.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Buat video/ }).click();
  await phone.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await phone.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const out = await phone.evaluate(() => [...document.querySelectorAll('input, select, textarea, button')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  check('U4-10 Layar HP: tidak ada isian yang keluar layar', out === 0, `${out} keluar`);
  await phone.screenshot({ path: path.join(EVID, 'generate-phone.png') });
  check('U4-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('U4-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`U4 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
