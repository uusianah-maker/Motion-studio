// X05 acceptance run: project management — rename, duplicate, archive, export/import JSON (real Chrome).
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x05-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'promo', name: 'Promo Lebaran' });
await svc.editTimeline({
  project_id: 'promo',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 6000 },
    { op: 'add_clip', track_kind: 'text', text: 'Diskon', start_ms: 0, duration_ms: 2000 },
  ],
});
const ids = async () => core.listProjectIds(await core.openWorkspace(wsRoot));
const read = async (id) => core.readProject(await core.openWorkspace(wsRoot), id);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  const side = page.getByRole('complementary', { name: 'Proyek' });
  const menu = () => page.locator('summary[aria-label="Kelola proyek"]');
  const menuBody = page.getByRole('group', { name: 'Kelola proyek' });

  // Rename.
  await menu().click();
  await menuBody.getByLabel('Nama proyek').fill('Promo Ramadan');
  await menuBody.getByRole('button', { name: 'Simpan nama' }).click();
  await page.getByRole('heading', { name: 'Promo Ramadan' }).waitFor();
  check('X5-01 Ganti nama → judul editor + daftar proyek ikut, tersimpan di disk', (await side.getByText('Promo Ramadan').count()) === 1 && (await read('promo')).name === 'Promo Ramadan');
  check('X5-02 Undo history tetap setelah ganti nama', (await read('promo')).snapshots.some((s) => s.kind === 'undo'));

  // Export (download).
  await menu().click();
  const [dl] = await Promise.all([page.waitForEvent('download'), menuBody.getByRole('button', { name: /Ekspor/ }).click()]);
  const exportPath = path.join(work, dl.suggestedFilename());
  await dl.saveAs(exportPath);
  const exported = JSON.parse(await fsp.readFile(exportPath, 'utf8'));
  const text = JSON.stringify(exported);
  check('X5-03 Ekspor .json: format proyek, nama file rapi, 1 media dengan hash', exported.format === 'motion-studio-project' && dl.suggestedFilename() === 'Promo-Ramadan.motion.json' && exported.media.length === 1 && /^sha256:/.test(exported.media[0].content_hash), dl.suggestedFilename());
  check('X5-04 Ekspor tanpa path lokal, tanpa riwayat, tanpa file video', !/snapshots|rel_path|msc-x05-|\\\\/.test(text) && text.length < 20_000, `${text.length} byte`);

  // Duplicate.
  await menu().click();
  await menuBody.getByRole('button', { name: /Duplikat/ }).click();
  await page.getByRole('heading', { name: 'Promo Ramadan (salinan)' }).waitFor();
  const after = await ids();
  const dupId = after.find((i) => i !== 'promo');
  check('X5-05 Duplikat → proyek baru terbuka, linimasa sama, riwayat kosong', after.length === 2 && JSON.stringify((await read(dupId)).timeline) === JSON.stringify((await read('promo')).timeline) && (await read(dupId)).snapshots.length === 0);

  // Archive the duplicate: read-only banner, edits refused, list section.
  await menu().click();
  await menuBody.getByRole('button', { name: /Arsipkan/ }).click();
  await page.getByText('Proyek ini diarsipkan (hanya-baca)').waitFor();
  check('X5-06 Arsipkan → banner hanya-baca + bagian ARSIP (1) di daftar', (await side.getByText('ARSIP (1)').count()) === 1 && (await read(dupId)).status === 'archived');
  // Read-only in the UI too (Checkpoint G G-5): edit controls are off, the inspector is locked.
  await page.locator('.track .clip.text').first().click();
  const presetOff = await page.getByRole('region', { name: 'Preset teks' }).getByRole('button', { name: 'Tambah preset Sale' }).isDisabled();
  const inspOff = await page.getByRole('region', { name: 'Inspector klip' }).getByLabel('Isi teks di inspector').isDisabled();
  const splitOff = await page.getByTitle(/Split klip terpilih/).isDisabled();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  check('X5-07 Proyek arsip hanya-baca di UI: preset, inspector, split mati; Del tidak menghapus', presetOff && inspOff && splitOff && JSON.stringify((await read(dupId)).timeline) === JSON.stringify((await read('promo')).timeline), `preset ${presetOff} insp ${inspOff} split ${splitOff}`);
  await page.getByRole('button', { name: 'Aktifkan lagi' }).first().click();
  await page.getByText('Proyek ini diarsipkan (hanya-baca)').waitFor({ state: 'detached' });
  check('X5-08 "Aktifkan lagi" → bisa diedit lagi, keluar dari ARSIP', (await read(dupId)).status === 'active' && (await side.getByText(/ARSIP/).count()) === 0);

  // Import the exported file → new project opens.
  await side.getByLabel('File proyek untuk diimpor').setInputFiles(exportPath);
  await side.locator('.project').nth(2).waitFor();
  const all = await ids();
  const impId = all.find((i) => i !== 'promo' && i !== dupId);
  check('X5-09 Impor .json → proyek baru (nama dari file) terbuka, linimasa sama', (await read(impId)).name === 'Promo Ramadan' && JSON.stringify((await read(impId)).timeline) === JSON.stringify((await read('promo')).timeline) && (await page.locator('.project.active').innerText()).includes('Promo Ramadan'));

  // Junk import: clear error, nothing created.
  const junk = path.join(work, 'bukan.json');
  await fsp.writeFile(junk, '{"format":"capcut"}');
  await side.getByLabel('File proyek untuk diimpor').setInputFiles(junk);
  await side.getByText(/bukan proyek Motion Studio/).waitFor();
  check('X5-10 Impor file salah → pesan jelas, tidak ada proyek baru', (await ids()).length === 3);
  await page.screenshot({ path: path.join(EVID, 'projects.png') });

  // Phone: no sideways scroll, menu fits the screen.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.locator('summary[aria-label="Kelola proyek"]').waitFor();
  await phone.locator('summary[aria-label="Kelola proyek"]').click();
  const box = await phone.getByRole('group', { name: 'Kelola proyek' }).boundingBox();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X5-11 HP 390px: menu proyek muat di layar, tanpa scroll samping', box && box.x >= 0 && box.x + box.width <= 390 && overflow <= 0, `menu x=${box?.x?.toFixed(0)} w=${box?.width?.toFixed(0)}, overflow ${overflow}px`);
  await phone.screenshot({ path: path.join(EVID, 'projects-phone.png') });
  check('X5-12 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X5-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX05 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
