// R32 (owner 16 Nov, bug): klip Teks & CTA di linimasa tidak bisa dihapus. Repro + bukti perbaikan:
// teks biasa, preset CTA, subtitle — lewat tombol 🗑 Hapus dan tombol Del, lalu undo.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r32-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'r32', name: 'Uji Hapus Teks' });
await svc.editTimeline({ project_id: 'r32', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'text', text: 'Diskon 50%', start_ms: 0, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'subtitle', text: 'halo semua', start_ms: 0, duration_ms: 2000 },
] });
const texts = async (k) => (await core.readProject(await core.openWorkspace(wsRoot), 'r32')).timeline.tracks.find((t) => t.kind === k)?.clips ?? [];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Hapus Teks' }).waitFor();
  // R33: the toolbar button now reads "🗑 Hapus klip".
  const hapus = page.getByRole('button', { name: '🗑 Hapus klip', exact: true });
  const alert = async () => (await page.locator('.notice, [role="alert"]').allInnerTexts()).join(' | ');

  // 1. CTA preset at the playhead, then delete it with the button.
  await page.getByRole('button', { name: 'Tambah preset CTA' }).click();
  const added = await until(async () => (await texts('text')).length === 2);
  const cta = (await texts('text')).find((c) => c.text !== 'Diskon 50%');
  check('R32-01 Preset CTA menambah klip teks', added, cta?.text);
  await page.locator(`.track .clip[data-clip="${cta?.clip_id}"], .track .clip`).filter({ hasText: cta?.text?.slice(0, 6) ?? 'x' }).first().click();
  await page.waitForTimeout(300);
  await hapus.click();
  const goneBtn = await until(async () => !(await texts('text')).some((c) => c.clip_id === cta?.clip_id));
  check('R32-02 Klip CTA terhapus lewat tombol 🗑 Hapus', goneBtn, await alert());

  // 2. Plain text clip: select it in the timeline, press Del.
  await page.locator('.track .clip').filter({ hasText: 'Diskon' }).first().click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  const goneKey = await until(async () => (await texts('text')).length === 0);
  check('R32-03 Klip Teks terhapus lewat tombol Del (fokus tidak tersangkut di kolom teks Inspector)', goneKey, `${(await texts('text')).length} teks tersisa · ${await alert()}`);

  // 3. Subtitle too; then Undo brings it back.
  await page.locator('.track .clip').filter({ hasText: 'halo' }).first().click();
  await page.waitForTimeout(300);
  await hapus.click();
  check('R32-04 Klip Subtitle terhapus', await until(async () => (await texts('subtitle')).length === 0), await alert());
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R32-05 Undo mengembalikan subtitle', await until(async () => (await texts('subtitle')).length === 1));

  // 4. Text clip selected by clicking its box on the PREVIEW (not the timeline), then Hapus.
  await page.getByRole('button', { name: 'Tambah preset CTA' }).click();
  await until(async () => (await texts('text')).length === 1);
  const box = page.getByLabel(/^Teks di pratinjau:/).first();
  if (await box.count()) {
    await box.click();
    await page.waitForTimeout(300);
    await hapus.click();
    check('R32-06 Teks dipilih dari kotak di pratinjau → terhapus', await until(async () => (await texts('text')).length === 0), await alert());
  } else check('R32-06 Teks dipilih dari kotak di pratinjau → terhapus', false, 'kotak teks pratinjau tidak ditemukan');
  // 5. The team's flow: change the CTA's style in the Inspector (focus stays on the checkbox /
  // slider), then press Del → the clip must go (before R32 the shortcut was swallowed).
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  for (const [id, control] of [['R32-07', 'Tebal'], ['R32-08', 'Ukuran teks']]) {
    await page.getByRole('button', { name: 'Tambah preset CTA' }).click();
    await until(async () => (await texts('text')).length === 1);
    await page.getByLabel(/^Teks di pratinjau:/).first().click();
    await insp.waitFor();
    const c = insp.getByLabel(control, { exact: true });
    if (control === 'Tebal') await c.click();
    else {
      await c.focus();
      await page.keyboard.press('ArrowRight');
    }
    await page.waitForTimeout(900); // style saved (one edit)
    const focused = await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('type') ?? ''}`);
    await page.keyboard.press('Delete');
    check(`${id} Ubah gaya CTA (${control}) lalu Del → klip terhapus (fokus ${focused})`, await until(async () => (await texts('text')).length === 0), `${(await texts('text')).length} teks tersisa · ${await alert()}`);
  }
  // 6. The Inspector's own 🗑 button.
  await page.getByRole('button', { name: 'Tambah preset CTA' }).click();
  await until(async () => (await texts('text')).length === 1);
  await page.getByLabel(/^Teks di pratinjau:/).first().click();
  await insp.getByRole('button', { name: 'Hapus klip ini' }).click();
  check('R32-09 Tombol 🗑 di Inspector menghapus klip teks', await until(async () => (await texts('text')).length === 0), await alert());
  await page.screenshot({ path: path.join(EVID, 'sesudah-hapus.png') });
  check('R32-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R32-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R32 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
