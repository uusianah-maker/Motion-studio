// W11 acceptance run: Motion Copilot in the real UI (built server + UI, real Chrome).
// prompt → plan (no change) → review ops + diff → approve some → one undo step → undo.
// Evidence → audit/W11/evidence/.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w11-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
await core.createProject(ws, { project_id: 'promo', name: 'Promo Lebaran' });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'promo');
const texts = async (kind) => ((await proj()).timeline.tracks.find((t) => t.kind === kind)?.clips ?? []).map((c) => c.text);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  const panel = page.getByRole('region', { name: 'Motion Copilot' });
  const box = panel.getByLabel('Perintah Copilot');
  const planCard = panel.getByLabel('Rencana edit');

  // Unknown command: refused with examples, nothing changes.
  await box.fill('bikin video ini viral');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await panel.getByText(/belum dikenali planner lokal/).waitFor();
  check('CP-01 Perintah tak dikenal: ditolak jelas + contoh, proyek tidak berubah', (await panel.locator('.notice.warn .chip').count()) >= 5 && (await proj()).revision === 0);

  // Typing in the box never triggers editor shortcuts (Space = play, Delete = delete clip).
  const playBefore = await page.locator('[aria-label="Putar"], [aria-label="Jeda"]').first().getAttribute('aria-label').catch(() => null);
  await box.fill('');
  await box.type('hook "Diskon 50%" 2 detik; subtitle "Cek keranjang" detik 2-5');
  const playAfter = await page.locator('[aria-label="Putar"], [aria-label="Jeda"]').first().getAttribute('aria-label').catch(() => null);
  check('CP-02 Mengetik di Copilot tidak memicu shortcut editor', playBefore === playAfter && (await proj()).revision === 0, `${playBefore} → ${playAfter}`);

  await box.press('Control+Enter');
  await planCard.waitFor();
  const opLabels = await planCard.locator('.planOps li').allInnerTexts();
  const diffLines = await planCard.locator('.planDiff .diff').allInnerTexts();
  await page.screenshot({ path: path.join(EVID, 'plan.png') });
  check(
    'CP-03 Rencana: 2 operasi + diff tampil, proyek belum berubah',
    opLabels.length === 2 && /Tambah teks “Diskon 50%” di 0:00–0:02/.test(opLabels[0]) && diffLines.length === 2 && diffLines[1].startsWith('+ subtitle') && (await proj()).revision === 0,
    `${opLabels.join(' | ')} // ${diffLines.join(' | ')}`,
  );

  // Approve only the first operation.
  await planCard.getByRole('checkbox', { name: /Cek keranjang/ }).uncheck();
  await planCard.getByRole('button', { name: 'Terapkan (1)' }).click();
  await panel.getByText(/Diterapkan 1 dari 2 operasi/).waitFor();
  const p1 = await proj();
  check('CP-04 Setujui sebagian: hanya hook masuk, satu revisi, satu langkah undo berlabel Copilot', p1.revision === 1 && JSON.stringify(await texts('text')) === '["Diskon 50%"]' && (await texts('subtitle')).length === 0 && p1.snapshots.filter((s) => s.kind === 'undo').length === 1 && /^Copilot: hook/.test(p1.snapshots.at(-1).label), `rev ${p1.revision}`);
  await page.locator('.track .clip', { hasText: 'Diskon 50%' }).waitFor();
  await page.screenshot({ path: path.join(EVID, 'applied.png') });

  await panel.getByRole('button', { name: '↶ Undo' }).click();
  await page.locator('.track .clip', { hasText: 'Diskon 50%' }).waitFor({ state: 'detached' });
  check('CP-05 Undo dari panel: linimasa kembali kosong', (await texts('text')).length === 0 && (await proj()).revision === 2);

  // Selection-aware command: select a text clip, replace its text.
  await page.getByRole('button', { name: '＋ Teks' }).click();
  const clip = page.locator('.track .clip', { hasText: 'Teks baru' });
  await clip.waitFor();
  await clip.click();
  await box.fill('ganti teks jadi "Promo terbatas"');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await planCard.waitFor();
  await planCard.getByRole('button', { name: 'Terapkan (1)' }).click();
  await panel.getByText(/Diterapkan 1 dari 1/).waitFor();
  check('CP-06 Perintah berbasis klip terpilih: teks diganti', JSON.stringify(await texts('text')) === '["Promo terbatas"]');

  // Stale plan: the project changes after the plan was made → cannot apply.
  await box.fill('ubah rasio ke 1:1');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await planCard.waitFor();
  await page.getByRole('button', { name: '＋ Subtitle' }).click();
  await planCard.getByText(/Proyek berubah sejak rencana ini dibuat/).waitFor();
  const disabled = await planCard.getByRole('button', { name: /Terapkan/ }).isDisabled();
  check('CP-07 Rencana basi (proyek berubah) tidak bisa diterapkan', disabled && (await proj()).timeline.canvas === undefined);
  await planCard.getByRole('button', { name: 'Tolak' }).click();
  await planCard.waitFor({ state: 'detached' });

  // Fresh plan for the ratio: preview follows.
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await planCard.waitFor();
  await planCard.getByRole('button', { name: 'Terapkan (1)' }).click();
  await panel.getByText(/Diterapkan 1 dari 1/).waitFor();
  check('CP-08 Rasio lewat Copilot: tersimpan 1:1', (await proj()).timeline.canvas?.ratio === '1:1');

  const log = await core.readAudit(await core.openWorkspace(wsRoot), (e) => e.op.startsWith('copilot.'));
  const actors = [...new Set(log.map((e) => `${e.op}:${e.actor}`))].sort().join(',');
  check('CP-09 Audit: rencana oleh aktor ai, terapkan/tolak oleh user', actors === 'copilot.apply:user,copilot.plan:ai,copilot.reject:user', actors);

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  const cp = phone.getByRole('region', { name: 'Motion Copilot' });
  await cp.getByLabel('Perintah Copilot').fill('tambah teks "Halo" detik 20-22');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  await cp.getByLabel('Rencana edit').waitFor();
  await cp.scrollIntoViewIfNeeded();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'copilot-phone.png'), fullPage: false });
  check('CP-10 HP 390px: panel + rencana muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);

  check('CP-11 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('CP-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW11 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
