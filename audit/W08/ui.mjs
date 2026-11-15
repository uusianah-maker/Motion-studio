// W08 acceptance run: render MP4 from the real UI (built server + UI, real Chrome, real FFmpeg).
// Proves the owner rule end to end: the source carries identifying metadata, the render has none.
// Evidence → audit/W08/evidence/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const sha = async (f) => createHash('sha256').update(await fsp.readFile(f)).digest('hex');

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w08-'));
const wsRoot = path.join(work, 'ws');
const renderTmp = path.join(work, 'render-tmp');
await fsp.mkdir(renderTmp);
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);

// Source with identifying metadata (what a phone/camera/editor would leave behind).
const tagged = path.join(work, 'Lucy-8s.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-i', path.join(FIX, 'sample_8s_9x16.mp4'), '-c', 'copy', '-metadata', 'title=JUDUL-RAHASIA-OWNER-5521', '-metadata', 'location=+06.1754+106.8272/', '-metadata', 'artist=Nama Asli Owner', tagged], { windowsHide: true });
const lucy = await svc.importMedia({ sourcePath: tagged, scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
const ref = { media_id: lucy.media.media_id, version_id: lucy.version.version_id };
await core.createProject(ws, { project_id: 'lucy', name: 'Lucy Promo' });
await svc.editTimeline({
  project_id: 'lucy',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: ref, start_ms: 0, duration_ms: 3000, in_ms: 500 },
    { op: 'add_clip', track_kind: 'text', text: 'Diskon 50% hari ini!', start_ms: 0, duration_ms: 2000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'Cek keranjang kuning ya', start_ms: 1000, duration_ms: 2000 },
  ],
});
await core.createProject(ws, { project_id: 'kosong', name: 'Proyek Kosong' });
const sourceHash = (await core.loadRegistry(ws)).versions[ref.version_id].content_hash;

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_RENDER_TMP: renderTmp }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const outDir = path.join(wsRoot, 'PROJECTS/lucy/05_OUTPUT');
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('button', { name: /Lucy Promo/ }).first().click();
  await page.getByRole('heading', { name: 'Lucy Promo' }).waitFor();
  const dialog = page.getByRole('dialog', { name: 'Render MP4' });

  await page.getByRole('button', { name: '↧ Render' }).click();
  await dialog.waitFor();
  const startBtn = dialog.getByRole('button', { name: /Mulai render/ });
  // The button waits for the tools check and the Brand guard check (X08); give it up to 5 s.
  let enabled = false;
  for (let i = 0; i < 50 && !enabled; i++) {
    enabled = await startBtn.isEnabled();
    if (!enabled) await page.waitForTimeout(100);
  }
  check('RD-01 Dialog render terbuka; alat render siap', enabled, 'tombol Mulai render aktif');
  check('RD-02 Info metadata dihapus tampil', await dialog.getByText(/dihapus otomatis/).isVisible());

  const revBefore = (await core.readProject(await core.openWorkspace(wsRoot), 'lucy')).revision;
  await page.keyboard.press('Delete');
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  check('RD-03 Shortcut editor mati saat dialog terbuka', (await core.readProject(await core.openWorkspace(wsRoot), 'lucy')).revision === revBefore);

  await dialog.getByLabel('Nama file output').fill('Hasil Promo');
  await dialog.getByLabel('Resolusi render').selectOption('720');
  check('RD-04 Ukuran sesuai rasio & resolusi', await dialog.getByText('9:16 · 720×1280').isVisible());
  // Owner 14 Nov: begitu render selesai, video otomatis terunduh (tanpa klik Unduh).
  const autoDl = page.waitForEvent('download', { timeout: 90_000 }).then((d) => d, () => null);
  await startBtn.click();
  const sawProgress = await dialog.getByRole('progressbar').waitFor({ timeout: 5000 }).then(() => true, () => false);
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 60_000 });
  check('RD-05 Progres tampil lalu selesai', sawProgress);
  const auto = await autoDl;
  check('RD-05b Selesai render → video otomatis terunduh', auto?.suggestedFilename() === 'Hasil Promo.mp4', auto?.suggestedFilename() ?? 'tidak ada unduhan');
  check('RD-06 Status "metadata bersih (terverifikasi)"', await dialog.getByText(/metadata bersih \(terverifikasi\)/).isVisible());
  await page.screenshot({ path: path.join(EVID, 'render-done.png') });

  const out = path.join(outDir, 'Hasil Promo.mp4');
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', out], { encoding: 'utf8', windowsHide: true }));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  check('RD-07 File di 05_OUTPUT: H.264 720×1280 + AAC, 3 dtk', v.codec_name === 'h264' && v.width === 720 && v.height === 1280 && probe.streams.some((s) => s.codec_name === 'aac') && Math.abs(Number(probe.format.duration) - 3) < 0.15, `${v.width}×${v.height} ${probe.format.duration}s`);
  const fmtTags = Object.keys(probe.format.tags ?? {}).sort().join(',');
  const bytes = (await fsp.readFile(out)).toString('latin1');
  const leaks = ['JUDUL-RAHASIA', '106.8272', 'Nama Asli', 'Lavf', 'Lavc', 'x264'].filter((m) => bytes.includes(m));
  const srcHad = (await fsp.readFile(path.join(wsRoot, lucy.version.rel_path))).toString('latin1').includes('JUDUL-RAHASIA-OWNER-5521');
  check('RD-08 Metadata bersih (cek ffprobe + byte, independen)', fmtTags === 'compatible_brands,major_brand,minor_version' && leaks.length === 0 && srcHad, `tag format: ${fmtTags}; bocor: ${leaks.join(',') || 'tidak ada'}; sumber punya judul: ${srcHad}`);
  check('RD-09 File asli tidak berubah', (await core.loadRegistry(await core.openWorkspace(wsRoot))).versions[ref.version_id].content_hash === sourceHash);

  // Play inside the dialog (signed link + Range).
  await dialog.getByRole('button', { name: 'Putar Hasil Promo.mp4' }).click();
  const player = dialog.getByLabel('Putar hasil render');
  await player.waitFor();
  let dur = 0;
  for (let i = 0; i < 60 && !(dur > 0); i++) {
    dur = await player.evaluate((el) => el.duration);
    await page.waitForTimeout(100);
  }
  check('RD-10 Hasil bisa diputar di dialog', Math.abs(dur - 3) < 0.2, `durasi ${dur}`);

  // Download = byte-identical copy of the verified output.
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Unduh Hasil Promo.mp4' }).click()]);
  const saved = path.join(work, 'downloaded.mp4');
  await dl.saveAs(saved);
  check('RD-11 Unduh: nama & byte identik', dl.suggestedFilename() === 'Hasil Promo.mp4' && (await sha(saved)) === (await sha(out)), dl.suggestedFilename());

  // Same name again → versioned, first file untouched.
  const firstHash = await sha(out);
  await startBtn.click();
  await dialog.getByText('Hasil Promo_v2.mp4', { exact: true }).first().waitFor({ timeout: 60_000 });
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 60_000 });
  check('RD-12 Nama sama → _v2, file pertama tidak ditimpa', (await fsp.readdir(outDir)).sort().join(',') === 'Hasil Promo.mp4,Hasil Promo_v2.mp4' && (await sha(out)) === firstHash);

  // Cancel a longer 1080p render.
  await svc.editTimeline({ project_id: 'lucy', expected_revision: (await core.readProject(ws, 'lucy')).revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 3000, duration_ms: 8000 }] });
  await dialog.getByLabel('Nama file output').fill('Dibatalkan');
  await dialog.getByLabel('Resolusi render').selectOption('1080');
  await startBtn.click();
  await dialog.getByRole('button', { name: 'Batalkan' }).click({ timeout: 10_000 });
  await dialog.getByText('Dibatalkan', { exact: true }).waitFor({ timeout: 20_000 });
  const leases = (await core.loadLeases(await core.openWorkspace(wsRoot))).leases;
  check('RD-13 Batalkan: tidak ada file, lease dilepas, temp bersih', !(await fsp.readdir(outDir)).some((n) => n.startsWith('Dibatalkan')) && leases.length === 0 && (await fsp.readdir(renderTmp)).length === 0);
  await page.screenshot({ path: path.join(EVID, 'render-cancelled.png') });
  await dialog.getByRole('button', { name: 'Tutup' }).last().click();

  // Empty project → blocked with a human reason.
  await page.getByRole('button', { name: /Proyek Kosong/ }).first().click();
  await page.getByRole('heading', { name: 'Proyek Kosong' }).waitFor();
  await page.getByRole('button', { name: '↧ Render' }).click();
  await dialog.getByRole('button', { name: /Mulai render/ }).click();
  await dialog.getByText('Tertahan', { exact: true }).waitFor({ timeout: 15_000 });
  check('RD-14 Linimasa kosong → tertahan dengan alasan jelas', await dialog.getByText('Linimasa belum berisi media.').isVisible());
  await dialog.getByRole('button', { name: 'Tutup' }).last().click();

  // Phone.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByText('Ganti proyek').click().catch(() => undefined);
  await phone.getByRole('button', { name: /Lucy Promo/ }).first().click();
  await phone.getByRole('heading', { name: 'Lucy Promo' }).waitFor();
  await phone.getByRole('button', { name: '↧ Render' }).click();
  await phone.getByRole('dialog', { name: 'Render MP4' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'render-phone.png') });
  check('RD-15 HP 390px: dialog muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);

  check('RD-16 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('RD-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW08 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
