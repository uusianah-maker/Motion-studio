// W05 acceptance run: the BUILT web UI served by the BUILT server, driven in real Chrome
// (playwright-core, channel 'chrome'). Real MP4 upload, restore, manual purge dialog, dashboard,
// desktop + phone screenshots. Evidence → audit/W05/evidence/.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-ui-'));
const wsRoot = path.join(work, 'ws');

// ---- Workspace with two versions already in Trash (made with a clock 40 days in the past).
const DAY = 86_400_000;
const clock = new core.ManualClock(Date.now() - 40 * DAY);
const ws = await core.initWorkspace(wsRoot, { clock });
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'lucy', name: 'Lucy — Elegant Look' });
const variant = async (tag) => {
  const p = path.join(work, `${tag}.mp4`);
  await fsp.writeFile(p, Buffer.concat([await fsp.readFile(path.join(FIX, 'sample_8s_9x16.mp4')), Buffer.from(`#${tag}`)]));
  return p;
};
const trashed = [];
for (const tag of ['lama-a', 'lama-b']) {
  const first = await svc.importMedia({ sourcePath: await variant(tag), scope: { kind: 'shared' }, display_name: `${tag}.mp4`, actor: 'user' });
  await svc.addVersion({ media_id: first.media.media_id, sourcePath: await variant(`${tag}-recut`), actor: 'user' });
  trashed.push(first.version.version_id);
  const base = await core.readProject(ws, 'lucy');
  const clip = { clip_id: `c-${tag}`, start_ms: 0, end_ms: 8000, media: { media_id: first.media.media_id, version_id: first.version.version_id } };
  await svc.commitProject({ manifest: { ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', clips: [clip] }] } }, expected_revision: base.revision, actor: 'user' });
  const again = await core.readProject(ws, 'lucy');
  await svc.commitProject({ manifest: { ...again, timeline: { tracks: [] } }, expected_revision: again.revision, actor: 'user' });
}
// Keep one clip on the timeline so the editor shows real data.
{
  const reg = await core.loadRegistry(ws);
  const keepMedia = Object.values(reg.media).find((m) => m.display_name === 'lama-a.mp4');
  const base = await core.readProject(ws, 'lucy');
  const clips = [{ clip_id: 'hook', start_ms: 0, end_ms: 8000, media: { media_id: keepMedia.media_id, version_id: keepMedia.current_version_id } }];
  await svc.commitProject({ manifest: { ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', clips }] } }, expected_revision: base.revision, actor: 'user' });
}
clock.advance(31 * DAY);
const t = await svc.autoTrash({ actor: 'scheduler' });
check('SETUP two old versions in Trash', t.moved.length === 2, `moved=${t.moved.length}`);

// ---- Built server (system clock, GC off for a deterministic run).
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Without a token: gate, no data.
  await page.goto(`${base}/`);
  check('UI-01 Tanpa token → layar gerbang', await page.getByText('Sesi tidak ada atau sudah kedaluwarsa').isVisible());

  await page.goto(`${base}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Lucy — Elegant Look' }).waitFor();
  check('UI-02 Token dihapus dari address bar', (await page.evaluate(() => location.hash)) === '', await page.evaluate(() => location.href));
  check('UI-03 Editor memuat proyek + linimasa asli', await page.getByText('1 klip').isVisible());
  await page.screenshot({ path: path.join(EVID, 'w05_editor_desktop.png') });

  // Create a project from the sidebar.
  await page.getByLabel('Nama proyek baru').fill('Iklan Payday');
  await page.getByTitle('Buat proyek').click();
  await page.getByRole('heading', { name: 'Iklan Payday' }).waitFor();
  check('UI-04 Buat proyek dari sidebar', await page.getByRole('button', { name: /Iklan Payday/ }).isVisible());

  // Upload a real MP4 into that project.
  await page.getByRole('button', { name: /Media/ }).first().click();
  await page.getByLabel('Tujuan import').selectOption({ label: 'Proyek: Iklan Payday' });
  await page.getByLabel('Pilih file media').setInputFiles(path.join(FIX, 'sample_3s_16x9.mp4'));
  await page.getByText('Selesai', { exact: true }).waitFor({ timeout: 15000 });
  check('UI-05 Upload MP4 nyata → Selesai', true);
  check('UI-06 Media muncul di library', await page.getByRole('cell', { name: /sample_3s_16x9\.mp4/ }).first().isVisible());
  await page.getByLabel('Pilih file media').setInputFiles(path.join(FIX, 'sample_3s_16x9.mp4'));
  await page.getByText('Duplikat', { exact: true }).waitFor({ timeout: 15000 });
  check('UI-07 Upload file sama → ditandai duplikat', true);
  await page.screenshot({ path: path.join(EVID, 'w05_media_desktop.png') });

  // Editor side panel shows the project's media.
  await page.getByRole('button', { name: /Editor/ }).click();
  await page.getByRole('button', { name: /Iklan Payday/ }).click();
  await page.getByText('sample_3s_16x9.mp4').first().waitFor();
  check('UI-08 Panel media proyek di editor', true);

  // Trash: restore one.
  await page.getByRole('button', { name: /Trash/ }).click();
  await page.getByLabel('Pilih lama-b.mp4').waitFor();
  const rows = await page.locator('tbody tr:visible').count(); // halaman lain tetap hidup tapi tersembunyi (04afb25)
  check('UI-09 Trash menampilkan 2 item', rows === 2, `rows=${rows}`);
  await page.locator('tr', { hasText: 'lama-b.mp4' }).getByRole('button', { name: /Pulihkan/ }).click();
  await page.getByText(/dipulihkan\. Periode 30 hari dimulai dari nol/).waitFor();
  check('UI-10 Restore dari Trash', (await page.locator('tbody tr:visible').count()) === 1);

  // Purge: phrase gate, then permanent delete.
  await page.getByLabel('Pilih lama-a.mp4').check();
  await page.getByRole('button', { name: /Hapus permanen…/ }).click();
  await page.getByText('Tidak bisa dibatalkan.').waitFor();
  const runBtn = page.getByRole('dialog').getByRole('button', { name: 'Hapus permanen' });
  await page.getByLabel('Frasa konfirmasi').fill('hapus permanen');
  check('UI-11 Frasa salah → tombol tetap mati', await runBtn.isDisabled());
  await page.screenshot({ path: path.join(EVID, 'w05_purge_dialog.png') });
  await page.getByLabel('Frasa konfirmasi').fill('HAPUS PERMANEN');
  check('UI-12 Frasa benar → tombol aktif', await runBtn.isEnabled());
  await runBtn.click();
  await page.getByText(/1 item dihapus permanen/).waitFor();
  check('UI-13 Hapus permanen sukses', true);
  await page.getByRole('dialog').getByRole('button', { name: 'Tutup' }).click();
  await page.getByText('Trash kosong.').waitFor();
  const reg = await core.loadRegistry(await core.openWorkspace(wsRoot));
  check('UI-14 Registry: satu purged, satu aktif lagi', reg.versions[trashed[0]].lifecycle === 'purged' && reg.versions[trashed[1]].lifecycle === 'active', `${reg.versions[trashed[0]].lifecycle}/${reg.versions[trashed[1]].lifecycle}`);

  // Storage dashboard.
  await page.getByRole('button', { name: /Storage/ }).click();
  await page.getByText('Disk kosong').waitFor();
  check('UI-15 Dashboard storage tampil', await page.getByText('Pemakaian per area').isVisible());
  await page.screenshot({ path: path.join(EVID, 'w05_storage_desktop.png'), fullPage: true });

  // Phone width: no horizontal scroll, main actions reachable.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  p2.on('pageerror', (e) => consoleErrors.push(String(e)));
  await p2.goto(`${base}/#token=${server.app.token}`);
  await p2.getByRole('heading', { name: /Lucy|Iklan/ }).waitFor();
  const noScroll = async () => p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('UI-16 HP 390px editor tanpa scroll horizontal', await noScroll());
  await p2.screenshot({ path: path.join(EVID, 'w05_editor_phone.png'), fullPage: true });
  await p2.getByRole('button', { name: /Media/ }).first().click();
  await p2.getByText('Library').waitFor();
  check('UI-17 HP 390px media tanpa scroll horizontal', await noScroll());
  check('UI-18 Tombol import terlihat di HP', await p2.getByRole('button', { name: /Import Media/ }).isVisible());
  await p2.screenshot({ path: path.join(EVID, 'w05_media_phone.png'), fullPage: true });

  check('UI-19 Tidak ada error console / pelanggaran CSP', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
} catch (e) {
  check('UI-RUN tanpa exception', false, String(e).slice(0, 400));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

const summary = results.reduce((a, r) => ((a[r.ok ? 'PASS' : 'FAIL'] = (a[r.ok ? 'PASS' : 'FAIL'] ?? 0) + 1), a), {});
await fsp.writeFile(path.join(EVID, 'ui_results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
process.exit(summary.FAIL ? 1 : 0);
