// R38a (owner: "tambahkan fitur add aset: audio, transisi, efek, font — SEMUA jenis, ditambah manual
// dari luar"): Brand → Aset "＋ Tambah aset" per jenis (banyak file, tag, boleh iklan, semua brand),
// pratinjau (▶ video, contoh huruf, swatch LUT sebelum/sesudah), validasi file; font Aset dipakai teks
// (Inspector + Library tab Font + render), preset teks dari Inspector → tab Teks; video efek & stinger
// tersimpan + terlihat di Library (pasang = R38b) (real Chrome + render FFmpeg).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { findFont } = await import(pathToFileURL(path.join(root, 'packages/core/dist/storage/ffmpeg.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r38a-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const fontSrc = findFont();
if (!fontSrc) throw new Error('butuh font sistem (MOTION_FONT) untuk audit R38a');
const fontFile = path.join(work, `Huruf Iklan${path.extname(fontSrc)}`);
await fsp.copyFile(fontSrc, fontFile);
const fontShared = path.join(work, `Huruf Bersama${path.extname(fontSrc)}`);
await fsp.copyFile(fontSrc, fontShared);
const cube = (size, f) => {
  const lines = ['TITLE "Hangat Senja"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(5)).join(' '));
  return lines.join('\n') + '\n';
};
const lutFile = path.join(work, 'hangat-senja.cube');
await fsp.writeFile(lutFile, cube(5, (r, g, b) => [Math.min(1, r * 1.15 + 0.05), g, b * 0.7]));
const badLut = path.join(work, 'rusak.cube');
await fsp.writeFile(badLut, 'LUT_3D_SIZE 3\n0 0 0\n');
const leak = gen('light-leak.webm', ['-f', 'lavfi', '-i', 'color=c=orange:s=180x320:r=30:d=1', '-c:v', 'libvpx-vp9', '-b:v', '200k']);
const stinger = gen('stinger-swipe.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
const png = gen('bukan-font.png', ['-f', 'lavfi', '-i', 'color=c=red:s=20x20', '-frames:v', '1']);
const video = gen('klip.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

// Brand "Lain" shares a font with every brand; "Aysilla" is the default brand of the project.
const sh = await svc.importMedia({ sourcePath: fontShared, scope: { kind: 'shared' }, actor: 'user' });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
await svc.createBrand({ kit: { name: 'Lain Brand', kode: 'LAI', aset: [{ id: 'huruf-bersama', ref: { media_id: sh.media.media_id, version_id: sh.version.version_id }, jenis: 'font', nama: 'Huruf Bersama', tag: ['judul'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true }, semua_brand: true }] }, actor: 'user' });
const vr = await svc.importMedia({ sourcePath: video, scope: { kind: 'shared' }, actor: 'user' });
await core.createProject(ws, { project_id: 'r38', name: 'Uji Aset' });
await svc.editTimeline({ project_id: 'r38', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: { media_id: vr.media.media_id, version_id: vr.version.version_id }, start_ms: 0, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'text', text: 'DISKON 50%', style: { size: 9, bg: '#e53935' }, start_ms: 0, duration_ms: 2000 },
] });
const open = async () => core.openWorkspace(wsRoot);
const proj = async () => core.readProject(await open(), 'r38');
const ays = async () => (await new core.StorageService(await open()).listBrands()).find((b) => b.kode === 'AYS');
const textClip = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });

  // ---- Brand → Aset: ＋ Tambah aset per kind.
  await nav.getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await until(async () => (await form.getByLabel('Nama brand').inputValue()) === 'Aysilla Factory');
  const lib = form.getByRole('group', { name: 'Library aset brand' });
  await lib.getByRole('button', { name: '＋ Tambah aset' }).click();
  const add = lib.getByRole('group', { name: 'Tambah aset' });
  const kinds = await add.getByLabel('Jenis aset baru').locator('option').allInnerTexts();
  check('R38A-01 "＋ Tambah aset": semua jenis (SFX, Musik, VO, gambar, Video efek, Transisi, LUT, Font, Penutup, B-roll…)', ['SFX', 'Musik', 'VO (suara)', 'Logo', 'Stiker', 'Video efek', 'Transisi (stinger)', 'Filter warna (LUT)', 'Font', 'Penutup', 'B-roll'].every((k) => kinds.includes(k)), kinds.join(' | '));
  const put = async (jenis, files, tag = '') => {
    await add.getByLabel('Jenis aset baru').selectOption({ label: jenis });
    await add.getByLabel('Tag aset baru').fill(tag);
    await add.getByLabel('File aset baru').setInputFiles(files);
  };
  await put('Font', png);
  check('R38A-02 File salah jenis ditolak sebelum diunggah (PNG sebagai Font)', await until(() => lib.getByText(/bukan-font\.png: Font harus font \.ttf \/ \.otf/).isVisible()));
  await put('Filter warna (LUT)', badLut);
  check('R38A-03 LUT rusak ditolak dengan alasan jelas', await until(() => lib.getByText(/rusak\.cube: isi LUT harus 27 warna/).isVisible()));
  await put('Video efek', leak, 'light-leak, hangat');
  await lib.getByRole('group', { name: 'Aset light-leak' }).waitFor();
  await put('Transisi (stinger)', stinger, 'swipe');
  await put('Filter warna (LUT)', lutFile, 'hangat');
  await put('Font', fontFile, 'judul');
  await lib.getByRole('group', { name: 'Aset huruf-iklan' }).waitFor({ timeout: 15000 });
  const rowLeak = lib.getByRole('group', { name: 'Aset light-leak' });
  await rowLeak.getByRole('button', { name: 'Lihat video light-leak' }).click();
  check('R38A-04 Video efek: tag dari form, ▶ memutar pratinjau video', (await rowLeak.getByLabel(/^Tag aset /).inputValue()) === 'light-leak, hangat' && (await until(() => rowLeak.getByLabel('Pratinjau video aset').evaluate((v) => v.readyState >= 2))));
  const sw = lib.getByRole('group', { name: 'Aset hangat-senja' }).getByRole('img', { name: 'Contoh warna LUT sebelum dan sesudah' });
  const swatchOk = await until(async () => (await sw.getAttribute('data-lut-ready')) === '1');
  const diff = swatchOk
    ? await sw.evaluate((el) => {
        const [b, a] = el.querySelectorAll('canvas');
        const px = (c) => c.getContext('2d').getImageData(100, 35, 1, 1).data;
        return [px(b), px(a)].map((d) => [d[0], d[1], d[2]]);
      })
    : null;
  check('R38A-05 LUT: swatch sebelum/sesudah dihitung dari file (abu-abu terang jadi lebih hangat: biru turun)', swatchOk && diff[1][2] < diff[0][2] - 30, JSON.stringify(diff));
  const fs = lib.getByRole('group', { name: 'Aset huruf-iklan' }).locator('.fontSample');
  check('R38A-06 Font: contoh huruf memakai file font itu (@font-face terbaca)', await until(async () => (await fs.getAttribute('data-font-ready')) === '1'));
  await lib.getByRole('group', { name: 'Aset huruf-iklan' }).getByLabel('Semua brand huruf-iklan').check();
  await page.screenshot({ path: path.join(EVID, 'brand-tambah-aset.png'), fullPage: false });
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await until(() => form.getByText(/Tersimpan \(revisi/).isVisible(), 15000);
  const k1 = await ays();
  const by = Object.fromEntries((k1?.aset ?? []).map((a) => [a.id, a]));
  check(
    'R38A-07 Tersimpan: jenis video_efek / transisi / lut / font, tag, boleh iklan, font "semua brand"',
    by['light-leak']?.jenis === 'video_efek' && by['stinger-swipe']?.jenis === 'transisi' && by['hangat-senja']?.jenis === 'lut' && by['huruf-iklan']?.jenis === 'font' && by['light-leak'].tag.join() === 'light-leak,hangat' && by['light-leak'].lisensi.iklan && by['huruf-iklan'].semua_brand === true,
    Object.values(by).map((a) => `${a.id}:${a.jenis}`).join(','),
  );

  // ---- Editor: fonts, presets, Library tabs.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji Aset' }).waitFor();
  const L = page.getByRole('region', { name: 'Library efek' });
  const tabs = await L.getByRole('tab').allInnerTexts();
  check('R38A-08 Library Editor punya tab Musik & Font (selain SFX, VO, Transisi, Efek, Teks)', tabs.join('|') === 'SFX|Musik|VO|Transisi|Efek|Teks|Font', tabs.join('|'));
  await page.locator('.track[data-kind="text"] .clip').first().click();
  const fontOpts = await page.getByLabel('Font teks').locator('optgroup[label="Font dari Aset"] option').allInnerTexts();
  check('R38A-09 Inspector: pilihan font berisi font Aset brand + font bersama brand lain', fontOpts.includes('huruf-iklan') || fontOpts.includes('Huruf Iklan') ? fontOpts.some((o) => o.includes('Huruf Bersama · Lain Brand')) : false, fontOpts.join(' | '));
  await L.getByRole('tab', { name: 'Font' }).click();
  const fp = L.getByRole('tabpanel', { name: 'Font' });
  await fp.getByRole('button', { name: 'Pakai font huruf-iklan' }).click();
  check('R38A-10 Library → Font → Pakai: teks terpilih memakai font Aset (ref ke file itu)', await until(async () => (await textClip()).style?.font === `ref:${by['huruf-iklan'].ref.media_id}/${by['huruf-iklan'].ref.version_id}`));
  // The preview re-renders after the saved edit comes back, and the @font-face loads after that.
  const asetFam = `MotionAset_${by['huruf-iklan'].ref.version_id}`;
  const famOf = () => page.locator('.overlayText').first().evaluate((el) => getComputedStyle(el).fontFamily);
  const drawn = await until(async () => (await famOf()).includes(asetFam) && (await page.evaluate((f) => document.fonts.check(`16px '${f}'`), asetFam)));
  check('R38A-11 Pratinjau menggambar teks dengan font itu (@font-face Aset)', drawn, await famOf());
  // Save as preset → Teks tab.
  await page.getByRole('button', { name: 'Simpan sebagai preset' }).click();
  await page.getByLabel('Nama preset').fill('Diskon Merah');
  await page.getByRole('group', { name: 'Simpan preset teks' }).getByRole('button', { name: 'Simpan' }).click();
  const saved = await until(async () => (await ays())?.preset_teks.some((p) => p.nama === 'Diskon Merah' && p.teks === 'DISKON 50%' && p.style.bg === '#e53935' && p.style.font?.startsWith('ref:')), 10000);
  check('R38A-12 "Simpan sebagai preset" → Brand → Aset: preset teks (teks + gaya + font)', saved);
  await L.getByRole('tab', { name: 'Teks' }).click();
  await until(() => L.getByRole('button', { name: 'Preset brand Diskon Merah' }).isVisible());
  await page.locator('.track[data-kind="text"] .clip').first().click();
  await page.keyboard.press('End').catch(() => undefined);
  const nText = (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips.length;
  await L.getByRole('button', { name: 'Preset brand Diskon Merah' }).click();
  check('R38A-13 Tab Teks: preset brand menambah teks dengan gaya + font yang sama', await until(async () => {
    const cs = (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips;
    return cs.length === nText + 1 && cs.at(-1).style?.bg === '#e53935' && cs.at(-1).style?.font?.startsWith('ref:');
  }));
  // Video efek / stinger: listed + previewable; placing = R38b (button off until then).
  await L.getByRole('tab', { name: 'Efek' }).click();
  const ve = L.getByRole('group', { name: 'Video efek light-leak' });
  await ve.getByRole('button', { name: 'Lihat light-leak' }).click();
  // The <video> appears only after its stream link arrives (ucok: a direct count() raced it).
  const peekShown = await until(async () => (await ve.getByLabel('Pratinjau video aset').count()) === 1);
  check('R38A-14 Tab Efek: video efek dari Aset tampil + ▶ pratinjau; "＋" aktif (R38b: mode campur)', peekShown && (await L.getByRole('button', { name: 'Tambah video efek light-leak' }).isEnabled()));
  await L.getByRole('tab', { name: 'Transisi' }).click();
  check('R38A-15 Tab Transisi: stinger dari Aset tampil', (await L.getByRole('group', { name: 'Stinger stinger-swipe' }).count()) === 1);
  await page.screenshot({ path: path.join(EVID, 'editor-library.png') });

  // ---- Render with the Aset font.
  const res = await core.renderProject(await open(), { project_id: 'r38', output_name: 'r38.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  check('R38A-16 Render nyata dengan font Aset selesai (font disalin ke job, ikut di-lease)', res.status === 'completed');
  check('R38A-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R38A-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R38A UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
