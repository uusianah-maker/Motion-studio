// X08 acceptance run: Brand guard — expired promo prices + banned claims block/warn before render,
// Copilot refuses them, warnings need an explicit "render anyway" that is audited (real Chrome + FFmpeg).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const day = (offset) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x08-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'guard', name: 'Uji Guard' });
await svc.editTimeline({
  project_id: 'guard',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'text', text: 'Cuma Rp 99.000', start_ms: 0, duration_ms: 1500 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'Ini paling murah lho', start_ms: 1500, duration_ms: 1500 },
  ],
});
const audit = async () => core.readAudit(await core.openWorkspace(wsRoot));

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Guard' }).waitFor();

  // Rules in the Brand Kit: a promo price that ended yesterday + one banned claim (block).
  await page.getByRole('button', { name: /Brand/ }).first().click();
  const guard = page.getByRole('group', { name: 'Brand guard' });
  await guard.waitFor();
  await page.getByLabel('Nama brand').fill('Toko Guard');
  await guard.getByRole('button', { name: '＋ Harga promo' }).click();
  await guard.getByLabel('Harga promo 1').fill('Rp99.000');
  await guard.getByLabel('Berlaku sampai 1').fill(day(-1));
  await guard.getByLabel('Klaim terlarang', { exact: true }).fill('paling murah\n\n100% menyembuhkan');
  await page.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await page.getByText('Tersimpan (revisi 1)').waitFor();
  const kit = await new core.StorageService(await core.openWorkspace(wsRoot)).readBrandKit();
  check('X8-01 Brand guard tersimpan: 1 harga + tanggal, 2 klaim (baris kosong diabaikan), level blokir', kit.guard.prices.length === 1 && kit.guard.prices[0].valid_until === day(-1) && kit.guard.banned.join('|') === 'paling murah|100% menyembuhkan' && kit.guard.banned_level === 'block', JSON.stringify(kit.guard));

  // Render dialog: red list, start disabled.
  await page.getByRole('button', { name: /Editor/ }).first().click();
  await page.getByRole('heading', { name: 'Uji Guard' }).waitFor();
  await page.getByRole('button', { name: '↧ Render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render MP4' });
  const red = dialog.getByRole('alert', { name: 'Brand guard memblokir' });
  await red.waitFor();
  const redItems = await red.locator('li').allInnerTexts();
  check('X8-02 Dialog render: harga kedaluwarsa + klaim terlarang terdaftar (klip & waktu)', redItems.length === 2 && redItems.some((t) => /Harga "Rp99.000" sudah lewat/.test(t) && /0:00/.test(t)) && redItems.some((t) => /Klaim terlarang "paling murah".*subtitle.*0:01/.test(t)), redItems.join(' | '));
  check('X8-03 Tombol Mulai render mati selama ada yang merah', await dialog.getByRole('button', { name: /Mulai render/ }).isDisabled());
  await dialog.screenshot({ path: path.join(EVID, 'render-blocked.png') });
  await page.keyboard.press('Escape');

  // Copilot refuses to write a banned claim.
  const cp = page.getByRole('region', { name: 'Motion Copilot' });
  await cp.getByLabel('Perintah Copilot').fill('tambah teks "100% menyembuhkan jerawat" detik 2-3');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  await cp.getByText(/Rencana ditolak Brand guard: klaim terlarang "100% menyembuhkan"/).waitFor();
  check('X8-04 Copilot menolak menulis klaim terlarang (pesan jelas, tidak ada rencana)', (await cp.getByLabel('Rencana edit').count()) === 0);

  // Fix the price in the inspector; switch banned claims to "warn".
  await page.locator('.track .clip', { hasText: 'Cuma Rp 99.000' }).click();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  await insp.getByLabel('Isi teks di inspector').fill('Harga spesial');
  await insp.getByLabel('Isi teks di inspector').press('Enter');
  await page.locator('.track .clip', { hasText: 'Harga spesial' }).waitFor();
  await page.getByRole('button', { name: /Brand/ }).first().click();
  await page.getByLabel('Tingkat klaim terlarang').selectOption('warn');
  await page.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await page.getByText('Tersimpan (revisi 2)').waitFor();
  await page.getByRole('button', { name: /Editor/ }).first().click();
  await page.getByRole('heading', { name: 'Uji Guard' }).waitFor();
  await page.getByRole('button', { name: '↧ Render' }).click();
  const yellow = dialog.getByRole('note', { name: 'Brand guard memperingatkan' });
  await yellow.waitFor();
  const startBtn = dialog.getByRole('button', { name: /Mulai render/ });
  check('X8-05 Harga diperbaiki + klaim jadi "peringatan": merah hilang, kuning tampil, tombol tetap mati sampai dicentang', (await dialog.getByRole('alert', { name: 'Brand guard memblokir' }).count()) === 0 && (await startBtn.isDisabled()));
  await dialog.getByLabel('Render tetap meski ada peringatan Brand guard').check();
  await startBtn.click();
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 90_000 });
  const pf = (await audit()).filter((a) => a.op === 'render.preflight' && a.project_id === 'guard').at(-1);
  check('X8-06 "Render tetap" → render selesai & tercatat di audit (peringatan diterima user)', pf?.outcome === 'ok' && pf.brand_warnings_accepted === true && pf.brand_issues?.some((i) => i.match === 'paling murah'), JSON.stringify({ outcome: pf?.outcome, accepted: pf?.brand_warnings_accepted }));
  await page.keyboard.press('Escape');

  // A price still in its window is fine.
  await page.getByRole('button', { name: /Brand/ }).first().click();
  await page.getByLabel('Berlaku sampai 1').fill(day(7));
  await page.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await page.getByText('Tersimpan (revisi 3)').waitFor();
  const chk = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/guard/brand-check`, { headers: { authorization: `Bearer ${server.app.token}` } })).json();
  check('X8-07 Harga yang masih berlaku tidak dipermasalahkan', !chk.issues.some((i) => i.kind === 'PRICE_EXPIRED'), JSON.stringify(chk.issues.map((i) => i.kind)));
  await page.screenshot({ path: path.join(EVID, 'brand-guard.png'), fullPage: true });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: /Brand/ }).first().click();
  await phone.getByRole('group', { name: 'Brand guard' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X8-08 HP 390px: Brand guard muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('X8-09 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X8-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX08 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
