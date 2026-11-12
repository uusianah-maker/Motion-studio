// U1 acceptance run: Brand Kit per brand (A–F) — create two brands, unique codes, export for the
// engine (no paths), choose a brand per project, brand guard follows the project's brand (real Chrome).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u1-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'promo', name: 'Promo Brand' });
await svc.editTimeline({
  project_id: 'promo',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'text', text: 'Harga termurah!', start_ms: 0, duration_ms: 1500 },
  ],
});
const open = async () => new core.StorageService(await core.openWorkspace(wsRoot));

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Promo Brand' }).waitFor();
  await page.getByRole('button', { name: /Brand/ }).first().click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await form.waitFor();

  // Brand 1: Aysilla, filled across sections A–F.
  await form.getByLabel('Nama brand').fill('Aysilla Factory');
  await form.getByLabel('Kode brand').fill('ays');
  await form.getByLabel('Handle TikTok').fill('@aysillafactoryid');
  await form.getByLabel('Target penonton').fill('Wanita 20–35, kantoran');
  await form.getByLabel('Nada bicara').fill('santai, meyakinkan, ceria');
  await form.getByLabel('Bahasa teks').selectOption('campur');
  await form.getByRole('button', { name: '＋ Produk' }).click();
  await form.getByLabel('Produk 1', { exact: true }).fill('Loose Pants');
  await form.getByLabel('Varian produk 1').fill('Espresso, Black');
  await form.getByRole('button', { name: '＋ Warna' }).click();
  await form.getByLabel('Tebal outline (px)').fill('4');
  await form.getByLabel('CTA TikTok').fill('Cek keranjang kuning sekarang');
  await form.getByLabel('Disclaimer', { exact: true }).fill('Warna dapat sedikit berbeda karena cahaya');
  await form.getByLabel('Kapan disclaimer tampil').selectOption('varian_warna');
  await form.getByRole('button', { name: '＋ Pasangan kamus' }).click();
  await form.getByLabel('Kamus salah 1').fill('Icila Factory');
  await form.getByLabel('Kamus benar 1').fill('Aysilla Factory');
  await form.getByLabel('Kata kunci').fill('anti kusut, flowy');
  await form.getByLabel('Aturan kapital').selectOption('kata_kunci');
  await form.getByLabel('Klaim terlarang', { exact: true }).fill('paling murah');
  await form.getByLabel('Area bebas teks: Wajah').check();
  await form.getByRole('button', { name: '＋ Preset' }).click();
  await form.getByLabel('ID preset 1').fill('aysilla-konversi');
  await form.getByRole('button', { name: '＋ Babak' }).click();
  await form.getByLabel('Preset 1 babak 1 isi').fill('Hook');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText('Tersimpan (revisi 1)').waitFor();
  const list = page.getByRole('navigation', { name: 'Daftar brand' });
  check('X-U1-01 Brand pertama tersimpan & jadi bawaan (★); kode jadi huruf besar', /AYS · Aysilla Factory ★/.test(await list.innerText()), (await list.innerText()).replace(/\s+/g, ' '));
  const ays = (await (await open()).listBrands()).find((b) => b.kode === 'AYS');
  check(
    'X-U1-02 Isian A–F tersimpan (handle, produk, outline, CTA, disclaimer, kamus, kata kunci, kapital, klaim, area, preset)',
    ays.handles.tiktok === '@aysillafactoryid' && ays.bahasa === 'campur' && ays.produk[0].varian.join() === 'Espresso,Black' && ays.outline.px === 4 && ays.cta.tiktok && ays.disclaimer?.kapan === 'varian_warna' && ays.kamus[0].benar === 'Aysilla Factory' && ays.kata_kunci.join() === 'anti kusut,flowy' && ays.kapital === 'kata_kunci' && ays.area_bebas_teks.join() === 'wajah' && ays.presets[0].id === 'aysilla-konversi' && ays.presets[0].babak[0].isi === 'Hook',
    JSON.stringify({ nada: ays.nada, preset: ays.presets[0]?.id }),
  );

  // Brand 2 + duplicate code refused.
  await list.getByRole('button', { name: '＋ Brand baru' }).click();
  await form.getByLabel('Nama brand').fill('Lucy Pants');
  await form.getByLabel('Kode brand').fill('AYS');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await page.getByText(/kode AYS sudah dipakai brand "Aysilla Factory"/).waitFor();
  check('X-U1-03 Kode brand dobel ditolak dengan pesan jelas', true);
  await form.getByLabel('Kode brand').fill('LCY');
  await form.getByLabel('Klaim terlarang', { exact: true }).fill('termurah');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText('Tersimpan (revisi 1)').waitFor();
  check('X-U1-04 Brand kedua (LCY) tersimpan; daftar berisi 2 brand', (await list.getByRole('button').count()) === 3);

  // Export for the engine (Aysilla).
  await list.getByRole('button', { name: /AYS · Aysilla/ }).click();
  await form.getByLabel('Nama brand').and(page.locator('[value="Aysilla Factory"]')).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: /Ekspor JSON/ }).click()]);
  const exportPath = path.join(work, dl.suggestedFilename());
  await dl.saveAs(exportPath);
  const ex = JSON.parse(await fsp.readFile(exportPath, 'utf8'));
  check(
    'X-U1-05 Ekspor brand_kit-AYS.json bentuk kontrak (brand-kit-export/1), tanpa path file',
    dl.suggestedFilename() === 'brand_kit-AYS.json' && ex.schema === 'brand-kit-export/1' && ex.brand.kode === 'AYS' && ex.teks.kamus['Icila Factory'] === 'Aysilla Factory' && ex.aturan.terlarang.join() === 'paling murah' && ex.preset['aysilla-konversi'] && !/[A-Za-z]:[\\/]|"path"/.test(JSON.stringify(ex)),
    dl.suggestedFilename(),
  );

  // Per-project brand: default (AYS) does not ban "termurah", Lucy does.
  const issues = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/projects/promo/brand-check`, { headers: { authorization: `Bearer ${server.app.token}` } })).json()).issues;
  check('X-U1-06 Proyek tanpa pilihan → brand bawaan (AYS): "termurah" tidak dilarang', (await issues()).length === 0);
  await page.getByRole('button', { name: /Editor/ }).first().click();
  await page.getByRole('heading', { name: 'Promo Brand' }).waitFor();
  await page.locator('summary[aria-label="Kelola proyek"]').click();
  const menu = page.getByRole('group', { name: 'Kelola proyek' });
  await menu.getByLabel('Brand proyek').locator('option', { hasText: 'LCY · Lucy Pants' }).waitFor({ state: 'attached' });
  const lucyId = (await (await open()).listBrands()).find((b) => b.kode === 'LCY').brand_id;
  await menu.getByLabel('Brand proyek').selectOption(lucyId);
  const ok = await (async () => {
    for (let i = 0; i < 30; i++) {
      if ((await core.readProject(await core.openWorkspace(wsRoot), 'promo')).brand_id === lucyId) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })();
  check('X-U1-07 Pilih brand proyek "LCY" di menu ⋯ Proyek → tersimpan di proyek', ok);
  const after = await issues();
  check('X-U1-08 Brand guard kini memakai aturan LCY: "termurah" diblokir', after.length === 1 && after[0].match === 'termurah' && after[0].level === 'block', JSON.stringify(after.map((i) => i.match)));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '↧ Render' }).click();
  await page.getByRole('dialog', { name: 'Render MP4' }).getByRole('alert', { name: 'Brand guard memblokir' }).waitFor();
  check('X-U1-09 Dialog render ikut brand proyek (merah: klaim "termurah")', true);
  await page.keyboard.press('Escape');

  // Default brand switch.
  await page.getByRole('button', { name: /Brand/ }).first().click();
  await list.getByRole('button', { name: /LCY · Lucy/ }).click();
  await form.getByRole('button', { name: '★ Jadikan bawaan' }).click();
  await list.getByRole('button', { name: /LCY · Lucy Pants ★/ }).waitFor();
  check('X-U1-10 "Jadikan bawaan" memindah ★ ke LCY', (await (await open()).defaultBrandId()) === lucyId);
  await page.screenshot({ path: path.join(EVID, 'brands.png'), fullPage: true });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: /Brand/ }).first().click();
  await phone.getByRole('region', { name: 'Pengaturan Brand Kit' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // Nothing may stick out of the form card (hidden overflow would cut fields off).
  const sticking = await phone.evaluate(() => {
    const card = document.querySelector('.brandForm').getBoundingClientRect();
    return [...document.querySelectorAll('.brandForm input, .brandForm select, .brandForm textarea, .brandForm button')]
      .filter((el) => el.getAttribute('type') !== 'file' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > card.right + 1)
      .map((el) => el.getAttribute('aria-label') ?? el.textContent);
  });
  check('X-U1-11 HP 390px: halaman Brand Kit tanpa scroll samping & tidak ada isian terpotong', overflow <= 0 && sticking.length === 0, `overflow ${overflow}px; terpotong: ${sticking.slice(0, 5).join(', ')}`);
  await phone.screenshot({ path: path.join(EVID, 'brands-phone.png') });
  check('X-U1-12 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X-U1-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nU1 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
