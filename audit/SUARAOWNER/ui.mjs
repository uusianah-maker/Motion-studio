// Suara owner (owner 16 Nov; KONTRAK-ENGINE §23) — Chrome asli + server BUILD + mesin palsu:
// tab "Suara saya" di Suara dari Teks, tambah contoh (unggah, pilih dari Media, rekam mikrofon),
// dengar, hapus, indikator terkumpul, Periksa mutu, Latih suara, status + ▶ contoh hasil.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
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
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-suaraowner-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
const gen = (name, f) => {
  const p = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `sine=f=${f}:d=2`, p], { windowsHide: true });
  return p;
};
const up1 = gen('Owner bicara 1.wav', 300);
const up2 = gen('Owner bicara 2.mp3', 340);
for (const [n, f] of [['Owner live 3.wav', 380], ['Owner live 4.wav', 420]]) await svc.importMedia({ sourcePath: gen(n, f), scope: { kind: 'shared' }, actor: 'user' });
// Owner 17 Nov: audio only — a video in Media must not be offered.
const vid = path.join(work, 'Video live owner.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', vid], { windowsHide: true });
await svc.importMedia({ sourcePath: vid, scope: { kind: 'shared' }, actor: 'user' });
const lastJob = async () => {
  for (const p of await fsp.readdir(path.join(wsRoot, 'PROJECTS'))) {
    const dir = path.join(wsRoot, 'PROJECTS', p, '06_ENGINE');
    const jobs = (await fsp.readdir(dir).catch(() => [])).sort();
    if (jobs.length) return JSON.parse(await fsp.readFile(path.join(dir, jobs[jobs.length - 1], 'job.json'), 'utf8'));
  }
  return null;
};

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.grantPermissions(['microphone']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Suara dari Teks/ }).click();
  await page.getByRole('tab', { name: 'Suara saya' }).click();
  const card = page.getByRole('region', { name: 'Contoh suara owner' });
  await card.waitFor();
  check('SO-01 Tab "Suara saya" di Suara dari Teks: belum ada contoh, Latih nonaktif', (await card.getByText('Belum ada contoh suara.').count()) === 1 && (await card.getByRole('button', { name: 'Latih suara' }).isDisabled()));

  const accept = await card.getByLabel('File contoh suara').getAttribute('accept');
  const opts = (await card.getByLabel('Pilih dari Media').locator('option').allInnerTexts()).join('|');
  check('SO-01b Audio saja: unggah hanya file suara, "Pilih dari Media" tanpa video, petunjuk m4a/mp3/wav', !accept.includes('video') && accept.includes('.m4a') && !opts.includes('Video live owner') && opts.includes('Owner live 3.wav') && (await card.getByText(/rekaman HP: m4a\/mp3\/wav/).count()) === 1, `${accept} · ${opts}`);
  await card.getByLabel('File contoh suara').setInputFiles([up1, up2]);
  const rows = card.getByRole('table', { name: 'Daftar contoh suara' }).locator('tbody tr');
  check('SO-02 ＋ Tambahkan contoh suara: 2 file diunggah → 2 baris + durasi', await until(async () => (await rows.count()) === 2 && (await rows.first().innerText()).includes('2 dtk')));
  for (const n of ['Owner live 3.wav', 'Owner live 4.wav']) {
    await card.getByLabel('Pilih dari Media').selectOption({ label: n });
    await card.getByRole('button', { name: 'Tambahkan', exact: true }).click();
    await until(async () => (await card.getByText(n).count()) > 0);
  }
  check('SO-03 Pilih dari Media → 4 contoh', await until(async () => (await rows.count()) === 4));

  await card.getByRole('button', { name: /Rekam/ }).click();
  await card.getByRole('button', { name: 'Berhenti merekam' }).waitFor();
  await page.waitForTimeout(2200);
  await card.getByRole('button', { name: 'Berhenti merekam' }).click();
  check('SO-04 🎙 Rekam (mikrofon) → rekaman masuk sebagai contoh ke-5', await until(async () => (await rows.count()) === 5 && (await card.getByText(/Rekaman suara owner/).count()) > 0), (await page.locator('.notice').allInnerTexts()).join(' / ').slice(0, 300));
  await card.getByRole('button', { name: /^Hapus contoh Rekaman suara owner/ }).click();
  check('SO-05 Hapus contoh → 4 baris (media tetap di Media)', await until(async () => (await rows.count()) === 4));

  await card.getByRole('button', { name: 'Dengar Owner live 3.wav' }).click();
  check('SO-06 ▶ Dengar contoh memutar audio', await until(async () => (await card.locator('audio[aria-label="Dengar Owner live 3.wav"]').count()) === 1));
  check('SO-07 Indikator terkumpul tampil; Latih masih nonaktif (< 5 mnt)', (await card.getByLabel('Terkumpul').innerText()).includes('dari 10–15 mnt') && (await card.getByRole('button', { name: 'Latih suara' }).isDisabled()));

  await card.getByRole('button', { name: 'Periksa mutu' }).click();
  const stat = page.getByRole('region', { name: 'Status latihan suara' });
  check('SO-08 Periksa mutu → tiap contoh dinilai (dipakai · SNR), suara bersih 6,3 mnt', await until(async () => (await stat.innerText()).includes('belum dilatih') && (await card.getByText(/dipakai · SNR 30 dB/).count()) === 4 && (await card.getByLabel('Terkumpul').innerText()).includes('6,3 mnt')));
  const job1 = await lastJob();
  check('SO-09 job.json: profil owner, 4 contoh $media:…, hapus_contoh (rekaman yang dihapus), latih false', job1?.suara_profil?.profil === 'owner' && job1.suara_profil.tambah_contoh.length === 4 && job1.suara_profil.latih === false && job1.suara_profil.hapus_contoh?.length === 1, JSON.stringify(job1?.suara_profil));

  await card.getByRole('button', { name: 'Latih suara' }).click();
  check('SO-10 Latih suara → "Suara owner siap" + ▶ contoh hasil', await until(async () => (await stat.getByText(/Suara owner siap/).count()) === 1 && (await stat.getByRole('button', { name: 'Dengar hasil 1' }).count()) === 1));
  await card.getByRole('button', { name: 'Hapus contoh Owner live 4.wav' }).click();
  await until(async () => (await rows.count()) === 3);
  await card.getByRole('button', { name: 'Periksa mutu' }).click();
  check('SO-11 Hapus contoh setelah dilatih → Periksa mutu → "perlu latih ulang" tampil', await until(async () => (await stat.getByText(/Tekan Latih suara lagi/).count()) === 1));
  check('SO-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('SO-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`SUARAOWNER UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
