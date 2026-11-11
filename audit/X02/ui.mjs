// X02 acceptance run: clip inspector + dragging text on the preview (built server + UI, real Chrome).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x02-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'insp', name: 'Uji Inspector' });
await svc.editTimeline({
  project_id: 'insp',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 6000 },
    { op: 'add_clip', track_kind: 'text', text: 'Promo Spesial', start_ms: 0, duration_ms: 4000 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'insp');
const textClip = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const overlay = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.canvas.live').getBoundingClientRect();
    const el = document.querySelector('.overlayText.styled[data-kind="text"]');
    const r = el.getBoundingClientRect();
    return { cx: (r.left + r.width / 2 - c.left) / c.width, cy: (r.top + r.height / 2 - c.top) / c.height, color: getComputedStyle(el).color, w: c.width, h: c.height, x0: r.left + r.width / 2, y0: r.top + r.height / 2 };
  });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Inspector' }).waitFor();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  check('X2-01 Tanpa klip terpilih: inspector tidak tampil', (await insp.count()) === 0);

  // Media clip: timing + source, no style controls.
  await page.locator('.track .clip', { hasText: 'Lucy-8s.mp4' }).click();
  await insp.waitFor();
  check('X2-02 Klip video: waktu + info sumber, tanpa kontrol gaya', (await insp.getByText(/Sumber mulai 00:00 dari 00:08/).isVisible()) && (await insp.getByLabel('Warna teks').count()) === 0);

  // Text clip: timing commit.
  await page.locator('.track .clip', { hasText: 'Promo Spesial' }).click();
  await insp.getByLabel('Warna teks').waitFor();
  const rev0 = (await proj()).revision;
  await insp.getByLabel('Mulai klip (detik)').fill('1.5');
  await insp.getByLabel('Durasi klip (detik)').fill('2');
  await insp.getByLabel('Durasi klip (detik)').press('Enter');
  await page.waitForTimeout(600);
  let c = await textClip();
  check('X2-03 Mulai & durasi dari inspector (1,5 dtk, 2 dtk)', c.start_ms === 1500 && c.end_ms === 3500, `${c.start_ms}–${c.end_ms}`);

  // Put the playhead on the text so it shows on the preview.
  await page.evaluate(() => undefined);
  await page.locator('.track .clip', { hasText: 'Promo Spesial' }).click();
  const ruler = await page.locator('.trackSurface.ruler').boundingBox();
  await page.mouse.click(ruler.x + ruler.width * (2000 / 30000), ruler.y + ruler.height / 2);
  await page.locator('.track .clip', { hasText: 'Promo Spesial' }).click();
  await page.locator('.overlayText.styled[data-kind="text"]').waitFor();

  // Slider moves: live on the preview, saved once after the pause.
  const revA = (await proj()).revision;
  for (const v of ['40', '50', '60']) await insp.getByLabel('Posisi vertikal').fill(v);
  const live = await overlay(page);
  await page.waitForTimeout(900);
  c = await textClip();
  const revB = (await proj()).revision;
  check('X2-04 Geser slider Y: pratinjau langsung ikut, tersimpan sebagai SATU revisi', Math.abs(live.cy - 0.6) < 0.03 && c.style?.y === 0.6 && revB === revA + 1, `live ${live.cy.toFixed(3)}, rev ${revA}→${revB}`);

  await insp.getByLabel('Warna teks').fill('#00ff00');
  await insp.getByLabel('Pakai kotak latar').check();
  await insp.getByRole('button', { name: 'Kiri' }).click();
  await page.waitForTimeout(900);
  c = await textClip();
  check('X2-05 Warna, kotak latar, perataan dari inspector', c.style?.color === '#00ff00' && c.style?.bg === '#000000' && c.style?.align === 'left', JSON.stringify(c.style));
  await page.screenshot({ path: path.join(EVID, 'inspector.png') });

  // Drag the text on the preview.
  const before = await overlay(page);
  const revD = (await proj()).revision;
  await page.mouse.move(before.x0, before.y0);
  await page.mouse.down();
  await page.mouse.move(before.x0 + before.w * 0.1, before.y0 - before.h * 0.2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  c = await textClip();
  const p = await proj();
  check('X2-06 Seret teks di pratinjau → posisi baru tersimpan (satu langkah undo "Ubah gaya teks")', Math.abs(c.style.x - (before.cx + 0.1)) < 0.03 && Math.abs(c.style.y - (before.cy - 0.2)) < 0.03 && p.revision === revD + 1 && p.snapshots.filter((x) => x.kind === 'undo').at(-1)?.label === 'Ubah gaya teks', `x ${c.style.x} y ${c.style.y}`);

  await insp.getByLabel('Isi teks di inspector').fill('Promo Akhir Pekan');
  await insp.getByLabel('Isi teks di inspector').press('Enter');
  await page.waitForTimeout(600);
  check('X2-07 Ubah teks dari inspector', (await textClip()).text === 'Promo Akhir Pekan');

  await insp.getByRole('button', { name: 'Reset gaya' }).click();
  await page.waitForTimeout(900);
  c = await textClip();
  const eff = core.effectiveStyle('text', c.style);
  check('X2-08 Reset gaya → kembali ke bawaan track', JSON.stringify(eff) === JSON.stringify(core.DEFAULT_STYLES.text), JSON.stringify(c.style));

  await page.getByRole('button', { name: '↶ Undo' }).first().click();
  await page.waitForTimeout(500);
  check('X2-09 Undo membatalkan reset (gaya hijau kembali)', (await textClip()).style?.color === '#00ff00');

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Uji Inspector' }).waitFor();
  await phone.locator('.track .clip', { hasText: 'Promo Akhir Pekan' }).click();
  await phone.getByRole('region', { name: 'Inspector klip' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.getByRole('region', { name: 'Inspector klip' }).screenshot({ path: path.join(EVID, 'inspector-phone.png') });
  check('X2-10 HP 390px: inspector tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('X2-11 0 error JS', errors.length === 0, errors.join(' | '));
  void rev0;
} catch (e) {
  check('X2-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX02 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
