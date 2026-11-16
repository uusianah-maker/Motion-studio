// R34 "Suara dari Teks" (owner 16 Nov; KONTRAK-ENGINE §21) — Chrome asli + server BUILD + mesin palsu:
// kartu di Buat video, daftar suara, pelafalan Brand Kit terkirim, VO per kalimat + lengkap masuk
// Media & Brand → Aset (VO), ulang satu kalimat, tambah ke linimasa + subtitle dari teks (tanpa
// Whisper), di Edit klip VO bisa membuat subtitle dari teksnya.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
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
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r34-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const brandId = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' })).result.brand_id;

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });

  // 0. Brand → C: pronunciation.
  await nav.getByRole('button', { name: /Brand/ }).first().click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await form.getByRole('button', { name: '＋ Pelafalan' }).click();
  await form.getByLabel('Pelafalan tulisan 1').fill('Aysilla');
  await form.getByLabel('Pelafalan ucapan 1').fill('Ay-si-la');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText(/Tersimpan \(revisi/).waitFor();
  const kit = await core.readBrandFor(await core.openWorkspace(wsRoot), brandId);
  check('R34-01 Brand → C: pelafalan "Aysilla → Ay-si-la" tersimpan', JSON.stringify(kit.pelafalan) === JSON.stringify([{ tulisan: 'Aysilla', ucapan: 'Ay-si-la' }]));

  // 1. Buat video → card → page.
  await nav.getByRole('button', { name: /Buat video/ }).click();
  check('R34-02 Kartu "Suara dari Teks" ada di 1. Buat video', await page.getByRole('region', { name: 'Suara dari Teks' }).isVisible());
  await page.getByRole('button', { name: /^Buka Suara dari Teks/ }).click();
  await page.getByRole('heading', { name: 'Suara dari Teks', level: 1 }).waitFor();
  check('R34-03 Alamat #/buat/suara-dari-teks', (await page.evaluate(() => location.hash)) === '#/buat/suara-dari-teks');
  const sec = page.getByRole('region', { name: 'Teks dan suara' });
  check('R34-04 Daftar suara dari mesin (Andika id-ID terpilih)', await until(async () => (await sec.getByLabel('Suara').locator('option').allInnerTexts()).join('|').includes('Microsoft Andika (id-ID)')) && (await sec.getByLabel('Suara').inputValue()) === 'windows:Andika');
  await sec.getByLabel('Teks yang diucapkan').fill('Halo kak, ini Aysilla. Bahannya adem banget! Cek keranjang kuning sekarang.');
  check('R34-05 Teks dipecah jadi 3 kalimat; pelafalan brand terlihat', (await sec.getByText('3 kalimat').isVisible()) && (await sec.getByText(/Aysilla → Ay-si-la/).isVisible()));
  await sec.getByRole('button', { name: /Buat suara/ }).click();
  const hasil = page.getByRole('region', { name: 'Hasil suara' });
  check('R34-06 Mesin selesai → hasil: suara lengkap + 3 kalimat dengan ▶', await until(() => hasil.isVisible(), 30000) && (await hasil.getByRole('table', { name: 'Kalimat suara' }).locator('tr').count()) === 3 && (await hasil.locator('audio').count()) >= 4);
  await page.screenshot({ path: path.join(EVID, 'suara-dari-teks.png') });
  const w2 = await core.openWorkspace(wsRoot);
  const pid = (await core.listProjectIds(w2))[0];
  const jobId = (await core.listEngineJobs(w2, pid))[0].job_id;
  const kitJob = JSON.parse(await fsp.readFile(path.join(wsRoot, 'PROJECTS', pid, '06_ENGINE', jobId, 'brand_kit.json'), 'utf8'));
  check('R34-07 Pelafalan brand terkirim ke mesin (teks.pelafalan)', kitJob.teks?.pelafalan?.Aysilla === 'Ay-si-la');
  const kit2 = await core.readBrandFor(w2, brandId);
  const media = Object.values((await core.loadRegistry(w2)).media).map((m) => m.display_name);
  check('R34-08 VO masuk Brand → Aset (jenis vo) + Media (lengkap + 3 kalimat)', kit2.aset.filter((a) => a.jenis === 'vo').length === 1 && media.filter((n) => n.startsWith(`VO ${jobId}`)).length === 4, media.filter((n) => n.startsWith('VO')).join(', '));

  // 2. Redo one sentence with new text.
  const row2 = hasil.getByRole('table', { name: 'Kalimat suara' }).locator('tr').nth(1);
  await row2.getByRole('button', { name: 'Ulang' }).click();
  await row2.getByLabel('Teks ulang kalimat 2').fill('Bahannya adem dan tidak menerawang!');
  await row2.getByRole('button', { name: /Buat ulang/ }).click();
  check('R34-09 Ulang kalimat 2 → pengganti dengan ▶ (hybrid)', await until(() => row2.getByLabel('Dengar pengganti kalimat 2').isVisible(), 30000));

  // 3. Onto the project's timeline with subtitles from the text.
  const revBefore = (await core.readProject(await core.openWorkspace(wsRoot), pid)).revision;
  await hasil.getByRole('button', { name: /Tambah ke linimasa proyek/ }).click();
  const placed = await until(async () => (await core.readProject(await core.openWorkspace(wsRoot), pid)).timeline.tracks.some((t) => t.kind === 'subtitle' && t.clips.length === 3));
  const p = await core.readProject(await core.openWorkspace(wsRoot), pid);
  const subs = p.timeline.tracks.find((t) => t.kind === 'subtitle')?.clips ?? [];
  check('R34-10 Linimasa: 1 klip audio VO + 3 subtitle dari teks (dengan waktu per kata), satu revisi', placed && p.timeline.tracks.find((t) => t.kind === 'audio')?.clips.length === 1 && subs[0]?.text === 'Halo kak, ini Aysilla.' && (subs[0]?.words?.length ?? 0) === 4 && p.revision === revBefore + 1, subs.map((c) => c.text).join(' | '));

  // 4. Edit: the VO clip offers subtitles from its text; delete subtitles first, then add them back.
  await hasil.getByRole('button', { name: /Buka di Edit/ }).click();
  await page.getByRole('heading', { name: p.name }).waitFor();
  await page.locator('.track[data-kind="audio"] .clip').first().click();
  const voNote = page.getByRole('status', { name: 'VO dari teks' });
  check('R34-11 Edit: klip VO dikenali ("VO dari Suara dari Teks, 3 kalimat")', await until(() => voNote.isVisible()) && (await voNote.innerText()).includes('3 kalimat'));
  await page.locator('.track[data-kind="subtitle"] .clip').first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await until(async () => !(await core.readProject(await core.openWorkspace(wsRoot), pid)).timeline.tracks.find((t) => t.kind === 'subtitle')?.clips.length);
  await page.locator('.track[data-kind="audio"] .clip').first().click();
  await voNote.getByRole('button', { name: '＋ Subtitle dari teks' }).click();
  check('R34-12 "＋ Subtitle dari teks" membuat lagi 3 subtitle tanpa Whisper', await until(async () => (await core.readProject(await core.openWorkspace(wsRoot), pid)).timeline.tracks.find((t) => t.kind === 'subtitle')?.clips.length === 3));

  // 5. Brand → Aset lists the VO.
  await nav.getByRole('button', { name: /Brand/ }).first().click();
  check('R34-13 Brand → Aset: jenis "VO (suara)" tersedia', (await page.getByText('VO (suara)').count()) > 0);
  check('R34-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R34-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R34 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
