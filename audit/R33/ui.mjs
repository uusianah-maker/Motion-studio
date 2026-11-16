// R33 (owner 16 Nov): multi-select subtitle/teks — Shift+klik rentang, Ctrl+klik, kotak pilih,
// Ctrl+A per lajur → geser / hapus / ubah gaya bersama (satu undo). Plus tombol hapus yang TERLIHAT:
// 🗑 di klip terpilih, "🗑 Hapus klip" di toolbar, menu klik kanan (Hapus, Duplikat, Split di playhead).
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
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r33-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'r33', name: 'Uji Pilih Banyak' });
const WORDS = ['satu', 'dua', 'tiga', 'empat', 'lima', 'enam'];
await svc.editTimeline({ project_id: 'r33', expected_revision: 0, actor: 'user', ops: [
  ...WORDS.map((w, i) => ({ op: 'add_clip', track_kind: 'subtitle', text: w, start_ms: 1000 + i * 2000, duration_ms: 1200 })),
  { op: 'add_clip', track_kind: 'text', text: 'Judul', start_ms: 0, duration_ms: 4000 },
] });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'r33');
const subs = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'subtitle')?.clips ?? [];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Pilih Banyak' }).waitFor();
  const lane = page.locator('.track[data-kind="subtitle"]');
  const clip = (w) => lane.locator('.clip').filter({ hasText: w }).first();
  const pressed = async () => lane.locator('.clip[aria-pressed="true"]').count();
  const group = page.getByRole('region', { name: 'Pilihan beberapa klip' });

  // 1. Shift = range, Ctrl = add/remove, Ctrl+A = whole lane.
  await clip('satu').click();
  await clip('empat').click({ modifiers: ['Shift'] });
  check('R33-01 Shift+klik: rentang satu…empat terpilih (4) + panel "4 klip dipilih"', (await until(async () => (await pressed()) === 4)) && (await group.getByText('4 klip dipilih').isVisible()));
  await clip('dua').click({ modifiers: ['Control'] });
  check('R33-02 Ctrl+klik mengeluarkan "dua" dari pilihan (3)', await until(async () => (await pressed()) === 3));
  await page.keyboard.press('Control+a');
  check('R33-03 Ctrl+A: semua subtitle di lajur (6), teks lain tidak ikut', (await until(async () => (await pressed()) === 6)) && (await page.locator('.track[data-kind="text"] .clip[aria-pressed="true"]').count()) === 0);
  await page.screenshot({ path: path.join(EVID, 'pilih-banyak.png') });

  // 2. Style together (one edit), move together (one edit), with undo.
  const rev0 = (await proj()).revision;
  await group.getByLabel('Ukuran bersama').fill('9');
  check('R33-04 Ubah ukuran bersama → 6 subtitle ukuran 9, satu revisi', await until(async () => (await subs()).every((c) => c.style?.size === 9)) && (await proj()).revision === rev0 + 1);
  await group.getByLabel('Posisi Y bersama').fill('60');
  check('R33-05 Ubah posisi Y bersama → semua y 0,6', await until(async () => (await subs()).every((c) => c.style?.y === 0.6)));
  const rev1 = (await proj()).revision;
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Control+a');
  await until(async () => (await pressed()) === 6);
  await page.keyboard.press('Shift+ArrowRight');
  check('R33-06 Shift+→ menggeser 6 subtitle bersama +1 dtk, satu revisi', await until(async () => (await subs())[0].start_ms === 2000 && (await subs())[5].start_ms === 12000) && (await proj()).revision === rev1 + 1, (await subs()).map((c) => c.start_ms).join(','));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R33-07 Undo mengembalikan geser bersama', await until(async () => (await subs())[0].start_ms === 1000 && (await subs())[5].start_ms === 11000));

  // 3. Box select on empty lane space: from before "satu" to inside "tiga".
  await lane.scrollIntoViewIfNeeded();
  const lb = await lane.locator('.trackSurface').boundingBox();
  const total = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuemax'));
  const xAt = (ms) => lb.x + (lb.width * ms) / total;
  await page.mouse.move(xAt(500), lb.y + lb.height / 2);
  await page.mouse.down();
  await page.mouse.move(xAt(3000), lb.y + lb.height / 2 + 4, { steps: 6 });
  await page.mouse.move(xAt(5500), lb.y + lb.height / 2 + 6, { steps: 6 });
  await page.mouse.up();
  check('R33-08 Seret kotak di lajur subtitle → satu, dua, tiga terpilih', await until(async () => (await pressed()) === 3));

  // 4. Delete together (Del) + undo.
  await page.keyboard.press('Delete');
  check('R33-09 Del menghapus 3 klip terpilih sekaligus', await until(async () => (await subs()).map((c) => c.text).join(',') === 'empat,lima,enam'));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R33-10 Undo mengembalikan ketiganya (satu langkah)', await until(async () => (await subs()).length === 6));

  // 5. Delete must be VISIBLE: 🗑 on the selected clip, labelled toolbar button, right-click menu.
  // (on a wide enough clip: on a narrow one the 🗑 would cover the clip itself)
  await page.locator('.track[data-kind="text"] .clip').filter({ hasText: 'Judul' }).first().click();
  const trash = page.getByRole('button', { name: 'Hapus klip Judul' });
  const toolbar = page.getByRole('button', { name: '🗑 Hapus klip', exact: true });
  check('R33-11 Klip terpilih menampilkan tombol 🗑; toolbar "🗑 Hapus klip" bertooltip "Hapus klip (Delete)"', (await trash.isVisible()) && (await toolbar.getAttribute('title')) === 'Hapus klip (Delete)');
  await trash.click();
  check('R33-12 Klik 🗑 di klip → terhapus', await until(async () => !(await proj()).timeline.tracks.find((t) => t.kind === 'text')?.clips.length));
  await clip('enam').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Menu klip' });
  check('R33-13 Klik kanan klip → menu Hapus / Duplikat / Split di playhead', (await menu.isVisible()) && (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim()).join('|') === '🗑 Hapus|⧉ Duplikat|✂ Split di playhead');
  await page.screenshot({ path: path.join(EVID, 'menu-klik-kanan.png') });
  await menu.getByRole('menuitem', { name: '⧉ Duplikat' }).click();
  check('R33-14 Duplikat → salinan "enam" tepat sesudahnya', await until(async () => (await subs()).filter((c) => c.text === 'enam').map((c) => c.start_ms).join(',') === '11000,12200'));
  await clip('empat').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '🗑 Hapus' }).click();
  check('R33-15 Menu klik kanan → Hapus', await until(async () => !(await subs()).some((c) => c.text === 'empat')));
  check('R33-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R33-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R33 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
