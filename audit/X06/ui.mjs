// X06 acceptance run: Brand Kit page (colours, font, logo) → editor presets, inspector swatches,
// brand font in the preview, logo switch, Copilot brand words, render with logo (real Chrome + FFmpeg).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

/** A solid-colour RGB PNG (no external tools). */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x06-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'brand', name: 'Uji Brand' });
await svc.editTimeline({
  project_id: 'brand',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'text', text: 'Promo', start_ms: 0, duration_ms: 1000 },
  ],
});
const logoFile = path.join(work, 'logo-toko.png');
// Orange: a colour the colour-bar sample video does not contain, so only the logo can match.
await fsp.writeFile(logoFile, png(64, 64, [255, 140, 0]));
const fontFile = path.join(work, 'FontToko.ttf');
await fsp.copyFile(core.findFont(), fontFile);
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'brand');
const texts = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips;
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Brand' }).waitFor();
  check('X6-01 Tanpa Brand Kit: tidak ada preset Brand, logo tidak bisa dinyalakan', (await page.getByRole('button', { name: 'Tambah preset Brand' }).count()) === 0 && (await page.getByLabel('Logo brand').isDisabled()));

  // Brand Kit page.
  await page.getByRole('button', { name: /Brand/ }).first().click();
  await page.getByRole('heading', { name: 'Brand Kit' }).waitFor();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await form.getByLabel('Nama brand').fill('Toko Aysi');
  await form.getByRole('button', { name: '＋ Warna' }).click();
  await form.getByRole('button', { name: '＋ Warna' }).click();
  await form.getByLabel('File font brand').setInputFiles(fontFile);
  await until(async () => (await form.getByLabel('Font brand', { exact: true }).inputValue()) !== '');
  await form.getByLabel('File logo brand').setInputFiles(logoFile);
  await until(async () => (await form.getByLabel('Logo brand', { exact: true }).inputValue()) !== '');
  await form.getByLabel('Posisi logo').selectOption('tr');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText('Tersimpan (revisi 1)').waitFor();
  const kit = await new core.StorageService(await core.openWorkspace(wsRoot)).readBrandKit();
  check('X6-02 Simpan Brand Kit: nama, 2 warna, font, logo kanan atas tersimpan di workspace', kit.name === 'Toko Aysi' && kit.colors.join() === '#7a1f5c,#f4d35e' && !!kit.font && kit.logo?.corner === 'tr', JSON.stringify({ colors: kit.colors, font: !!kit.font, logo: kit.logo?.corner }));
  await page.locator('.brandSample img.brandLogo').waitFor();
  check('X6-03 Contoh tampilan memuat logo dari Brand Kit', await page.locator('.brandSample img.brandLogo').evaluate((img) => img.complete && img.naturalWidth === 64));
  await page.screenshot({ path: path.join(EVID, 'brand-kit.png') });

  // Editor: Brand preset, brand font in the preview, logo switch.
  await page.getByRole('button', { name: /^2\. Edit$/ }).first().click();
  await page.getByRole('heading', { name: 'Uji Brand' }).waitFor();
  await page.getByRole('button', { name: 'Tambah preset Brand' }).click();
  await page.locator('.track .clip', { hasText: 'Toko Aysi' }).waitFor();
  const bc = (await texts()).find((c) => c.text === 'Toko Aysi');
  check('X6-04 Preset Brand → klip teks bergaya brand (kotak warna utama, font brand)', bc?.style?.bg === '#7a1f5c' && bc.style.font === 'brand' && bc.style.color === '#ffffff');
  await page.locator('.track .clip', { hasText: 'Toko Aysi' }).click();
  // Seek to 1.5 s (the Brand clip runs 1–4 s) by clicking the ruler.
  const ruler = await page.getByRole('slider', { name: 'Posisi playhead' }).boundingBox();
  const total = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuemax'));
  await page.mouse.click(ruler.x + (ruler.width * 1500) / total, ruler.y + ruler.height / 2);
  await until(async () => (await page.locator('.overlayText.styled', { hasText: 'Toko Aysi' }).count()) === 1);
  const fam = await page.locator('.overlayText.styled', { hasText: 'Toko Aysi' }).first().evaluate((el) => getComputedStyle(el).fontFamily);
  const fontLoaded = await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('MotionBrandFont') && f.status === 'loaded'));
  check('X6-05 Pratinjau: teks brand memakai font brand (FontFace termuat)', fam.includes('MotionBrandFont') && fontLoaded, fam);

  await page.getByLabel('Logo brand').click();
  check('X6-06 Centang "Logo" → proyek menyimpan brand_logo (satu edit)', await until(async () => (await proj()).timeline.brand_logo === true));
  const logoBox = await page.locator('.canvas.live img.brandLogo').boundingBox();
  const canvasBox = await page.locator('.canvas.live').boundingBox();
  check('X6-07 Logo tampil di pojok kanan atas pratinjau', logoBox && canvasBox && logoBox.x > canvasBox.x + canvasBox.width / 2 && logoBox.y < canvasBox.y + canvasBox.height / 4, logoBox ? `x=${Math.round(logoBox.x - canvasBox.x)} y=${Math.round(logoBox.y - canvasBox.y)}` : 'tidak ada');

  // Inspector swatch on the plain "Promo" clip.
  await page.locator('.track .clip', { hasText: 'Promo' }).click();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  await insp.getByLabel('Pakai kotak latar').check();
  await insp.getByLabel('Pakai warna brand #f4d35e untuk kotak').click();
  check('X6-08 Inspector: klik swatch warna brand → kotak klip pakai warna brand', await until(async () => (await texts()).find((c) => c.text === 'Promo')?.style?.bg === '#f4d35e'));

  // Copilot brand words on the selected clip.
  const cp = page.getByRole('region', { name: 'Motion Copilot' });
  await cp.getByLabel('Perintah Copilot').fill('font brand; warna brand');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  const plan = cp.getByLabel('Rencana edit');
  await plan.waitFor();
  await plan.getByRole('button', { name: /Terapkan/ }).click();
  await cp.getByText(/Diterapkan/).waitFor();
  const promo = (await texts()).find((c) => c.text === 'Promo');
  check('X6-09 Copilot "font brand; warna brand" → font + warna dari Brand Kit', promo?.style?.font === 'brand' && promo.style.color === '#7a1f5c', JSON.stringify(promo?.style));
  check('X6-09b Logo tetap menyala setelah edit lain (inspector + Copilot), di disk dan di pratinjau', (await proj()).timeline.brand_logo === true && (await page.getByLabel('Logo brand').isChecked()) && (await page.locator('.canvas.live img.brandLogo').count()) === 1);
  await page.screenshot({ path: path.join(EVID, 'editor-brand.png') });

  // Render with logo + brand font: completes, logo pixels in the top-right corner.
  await page.getByRole('button', { name: '↧ Render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render MP4' });
  await dialog.getByLabel('Nama file output').fill('Brand');
  await dialog.getByRole('button', { name: /Mulai render/ }).click();
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 90_000 });
  const out = path.join(wsRoot, 'PROJECTS', 'brand', '05_OUTPUT', 'Brand.mp4');
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'scale=24:42', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 20 });
  // Same frame of the source, scaled the same way: only pixels that BECAME orange count as logo
  // (downscaled colour bars blend into orange-ish tones on their own).
  const srcRaw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1', '-i', path.join(FIX, 'sample_8s_9x16.mp4'), '-frames:v', '1', '-vf', 'scale=24:42', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 20 });
  const orange = (b, i) => b[i] > 200 && b[i + 1] > 90 && b[i + 1] < 190 && b[i + 2] < 70;
  const orangeIn = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * 24 + x) * 3;
        if (orange(raw, i) && !orange(srcRaw, i)) n++;
      }
    return n;
  };
  const tr = orangeIn(15, 24, 0, 8);
  const rest = orangeIn(0, 24, 0, 42) - tr;
  check('X6-10 Render: selesai, metadata bersih, logo oranye hanya di pojok kanan atas video', tr >= 3 && rest === 0 && (await dialog.getByText(/metadata bersih \(terverifikasi\)/).isVisible()), `${tr} piksel logo di kanan atas, ${rest} di tempat lain`);
  await page.keyboard.press('Escape');

  // Phone: Brand page fits.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: /Brand/ }).first().click();
  await phone.getByRole('heading', { name: 'Brand Kit' }).waitFor();
  await phone.getByLabel('Nama brand').waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X6-11 HP 390px: halaman Brand Kit tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: path.join(EVID, 'brand-phone.png'), fullPage: true });
  check('X6-12 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X6-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX06 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
