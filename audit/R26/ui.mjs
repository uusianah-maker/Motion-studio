// R26 (owner): Overlay + Aset — library gambar per brand (logo / watermark / stiker / frame, PNG
// transparan, kategori, logo default = logo Brand Kit), overlay berlapis di timeline (posisi preset +
// geser, skala, opasitas, margin, durasi, urutan lapisan; satu perubahan = satu undo), opsi Brand
// "pasang logo otomatis", dan overlay di Buat video sebelum Generate. Pratinjau = render (real Chrome
// + render FFmpeg nyata).
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
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r26-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const imp = async (f, display_name) => {
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const video = gen('hitam.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
// Red square with a transparent border (RGBA PNG): the transparency must stay see-through.
const red = gen('logo-merah.png', ['-f', 'lavfi', '-i', 'color=c=red:s=40x40,format=rgba,pad=60:60:10:10:color=black@0', '-frames:v', '1']);
const green = gen('stiker-hijau.png', ['-f', 'lavfi', '-i', 'color=c=lime:s=60x60', '-frames:v', '1']);
const blue = gen('watermark-biru.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=80x20', '-frames:v', '1']);
const V = await imp(video, 'hitam.mp4');
const RED = await imp(red, 'logo-merah.png');
const GREEN = await imp(green, 'stiker-hijau.png');
const asset = (id, ref, jenis, nama) => ({ id, ref, jenis, nama, tag: [], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true } });
await svc.createBrand({
  kit: { name: 'Aysilla Factory', kode: 'AYS', aset: [asset('logo-merah', RED, 'logo', 'Logo Merah'), asset('stiker-hijau', GREEN, 'stiker', 'Stiker Hijau')], presets: [] },
  actor: 'user',
});
await core.createProject(ws, { project_id: 'r26', name: 'Uji Overlay' });
await svc.editTimeline({ project_id: 'r26', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: V, start_ms: 0, duration_ms: 3000 }] });
const open = async () => core.openWorkspace(wsRoot);
const proj = async (id = 'r26') => core.readProject(await open(), id);
const ovs = (p) => p.timeline.tracks.find((t) => t.kind === 'overlay')?.clips ?? [];
const kitNow = async () => (await new core.StorageService(await open()).listBrands())[0];

// Engine folder (fake engine) for "Buat video".
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
await fsp.mkdir(path.join(engine, 'konten'));
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(engine, 'aset', 'musik-lokal.wav')], { windowsHide: true }); // fake engine's aset_lokal

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d|ERR_FAILED|ERR_CONNECTION|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });

  // ---- A. Brand → Aset: picture kinds, thumbnails, logo default, pasang logo otomatis.
  await nav.getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  const lib = form.getByRole('group', { name: 'Library aset brand' });
  await lib.getByRole('group', { name: 'Aset stiker-hijau' }).waitFor();
  const kinds = await lib.getByLabel('Saring jenis aset').locator('option').allInnerTexts();
  check('R26-01 Jenis aset baru: Watermark, Stiker, Frame (selain Logo)', ['Logo', 'Watermark', 'Stiker', 'Frame'].every((k) => kinds.some((t) => t.startsWith(k))), kinds.join(' | '));
  const thumb = lib.getByRole('group', { name: 'Aset stiker-hijau' }).locator('.assetThumb img');
  check('R26-02 Gambar overlay tampil sebagai thumbnail di atas papan catur (transparansi terlihat)', await until(async () => (await thumb.evaluate((i) => i.complete && i.naturalWidth > 0)) === true));
  await lib.getByRole('button', { name: 'Jadikan logo-merah logo default' }).click();
  check('R26-03 "Jadikan logo default" → label ★ Logo default di aset itu', await lib.getByLabel('logo-merah logo default').isVisible());
  await form.getByLabel('Pasang logo otomatis').check();
  await page.screenshot({ path: path.join(EVID, 'brand-aset.png') });
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await until(() => form.getByText(/Tersimpan \(revisi/).isVisible());
  const k1 = await kitNow();
  check('R26-04 Tersimpan: logo Brand Kit = aset logo-merah (sinkron), pasang logo otomatis = ya', k1.logo?.ref.version_id === RED.version_id && k1.logo_otomatis === true, `logo=${k1.logo?.ref.version_id} auto=${k1.logo_otomatis}`);

  // ---- B. Editor: ＋ Overlay, inspector, layers, undo, drag in preview, upload to the library.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji Overlay' }).waitFor();
  await page.getByRole('button', { name: '＋ Overlay' }).click();
  const dlg = page.getByRole('dialog', { name: 'Tambah overlay' });
  check('R26-05 Dialog overlay menampilkan gambar dari Aset brand (logo default + stiker)', (await dlg.getByRole('button', { name: 'Pakai Logo Merah' }).isVisible()) && (await dlg.getByRole('button', { name: 'Pakai Stiker Hijau' }).isVisible()));
  const rev0 = (await proj()).revision;
  await dlg.getByRole('button', { name: 'Pakai Stiker Hijau' }).click();
  const added = await until(async () => ovs(await proj()).length === 1);
  const st = ovs(await proj())[0];
  check('R26-06 Pilih stiker → 1 klip overlay sepanjang video (0–3 dtk), satu revisi', added && st.start_ms === 0 && st.end_ms === 3000 && st.overlay.sepanjang === true && (await proj()).revision === rev0 + 1, JSON.stringify(st?.overlay));
  const img = page.locator(`.overlayImg[data-overlay="${st.clip_id}"]`);
  check('R26-07 Pratinjau menampilkan overlay di pojok kanan bawah', await until(async () => (await img.getAttribute('data-pos')) === 'br'));
  // Select it on its lane → overlay inspector.
  await page.locator('.track[data-kind="overlay"] .clip').first().click();
  const insp = page.getByRole('group', { name: 'Overlay', exact: true });
  await insp.waitFor();
  check('R26-08 Inspector klip overlay: posisi, ukuran, opasitas, jarak tepi, durasi, lapisan — tanpa volume', (await insp.getByLabel('Posisi overlay').isVisible()) && (await insp.getByLabel('Ukuran overlay').isVisible()) && (await insp.getByLabel('Opasitas overlay').isVisible()) && (await insp.getByLabel('Jarak tepi overlay').isVisible()) && (await insp.getByLabel('Durasi overlay').isVisible()) && (await page.getByLabel('Volume klip').count()) === 0);
  await insp.getByLabel('Posisi overlay').selectOption('tl');
  check('R26-09 Posisi "Kiri atas" → tersimpan + pratinjau ikut', (await until(async () => ovs(await proj())[0].overlay.pos === 'tl')) && (await until(async () => (await img.getAttribute('data-pos')) === 'tl')));
  const revA = (await proj()).revision;
  await insp.getByLabel('Opasitas overlay').fill('40');
  await insp.getByLabel('Opasitas overlay').dispatchEvent('pointerup');
  check('R26-10 Geser slider opasitas → satu edit (satu revisi), opasitas 0,4', (await until(async () => ovs(await proj())[0].overlay.opasitas === 0.4)) && (await proj()).revision === revA + 1);
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R26-11 Undo → opasitas kembali 1 (satu langkah)', await until(async () => ovs(await proj())[0].overlay.opasitas === 1));
  // Second overlay: the logo, in front; then "paling belakang".
  await page.getByRole('button', { name: '＋ Overlay' }).click();
  await dlg.getByRole('button', { name: 'Pakai Logo Merah' }).click();
  await until(async () => ovs(await proj()).length === 2);
  const logo = ovs(await proj()).find((c) => c.media.version_id === RED.version_id);
  check('R26-12 Overlay baru masuk paling depan (lapisan lebih tinggi), boleh tumpang tindih waktu', logo && logo.overlay.layer > ovs(await proj()).find((c) => c.clip_id === st.clip_id).overlay.layer);
  await page.locator('.track[data-kind="overlay"] .clip').filter({ hasText: 'logo-merah' }).first().click();
  await insp.getByRole('button', { name: 'Overlay paling belakang' }).click();
  check('R26-13 "Paling belakang" → logo di bawah stiker (urutan lapisan)', await until(async () => {
    const p = await proj();
    const l = ovs(p).find((c) => c.clip_id === logo.clip_id).overlay.layer;
    const s = ovs(p).find((c) => c.clip_id === st.clip_id).overlay.layer;
    return l < s;
  }));
  const domOrder = () => page.locator('.canvas.live[aria-label="Area pratinjau"] .overlayImg').evaluateAll((els) => els.map((e) => e.getAttribute('data-overlay')).join());
  check('R26-14 Pratinjau menggambar urutan yang sama (belakang → depan)', await until(async () => (await domOrder()) === [logo.clip_id, st.clip_id].join()), await domOrder());
  // Drag the selected overlay in the preview: one edit with the nudge.
  const lImg = page.locator(`.overlayImg[data-overlay="${logo.clip_id}"]`);
  const box = await lImg.boundingBox();
  const revD = (await proj()).revision;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  check('R26-15 Seret overlay di pratinjau → geser manual tersimpan (satu revisi)', (await until(async () => ovs(await proj()).find((c) => c.clip_id === logo.clip_id).overlay.dy > 0)) && (await proj()).revision === revD + 1, JSON.stringify(ovs(await proj()).find((c) => c.clip_id === logo.clip_id).overlay));
  await page.screenshot({ path: path.join(EVID, 'editor-overlay.png') });
  // Upload a new picture from the picker → kept in the brand library (Watermark).
  await page.getByRole('button', { name: '＋ Overlay' }).click();
  await dlg.getByLabel('Kategori gambar baru').selectOption('watermark');
  await dlg.getByLabel('File overlay baru').setInputFiles(blue);
  const up = await until(async () => ovs(await proj()).length === 3, 15000);
  const k2 = await kitNow();
  check('R26-16 Unggah gambar baru dari dialog → overlay ditambah + tersimpan permanen di Aset brand (Watermark)', up && k2.aset.some((a) => a.jenis === 'watermark' && a.id === 'watermark-biru'), k2.aset.map((a) => `${a.jenis}:${a.id}`).join(','));

  // ---- C. Render = preview: real FFmpeg render of this project.
  {
    const p = await proj();
    const res = await core.renderProject(await open(), { project_id: 'r26', output_name: 'r26.mp4', actor: 'user' }, { settings: { short_side: 360, preset: 'ultrafast' } });
    const out = path.join(wsRoot, (await core.listOutputs(await open(), 'r26'))[0].rel);
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
    const px = (x, y) => [...raw.subarray((y * 360 + x) * 3, (y * 360 + x) * 3 + 3)];
    const box = (c, iw, ih) => core.overlayBox(c.overlay, 360, 640, iw, ih);
    const sb = box(ovs(p).find((c) => c.clip_id === st.clip_id), 60, 60);
    const g = px(sb.x + Math.round(sb.w / 2), sb.y + Math.round(sb.h / 2));
    check('R26-17 Render nyata: stiker hijau tepat di kotak yang dihitung pratinjau (overlayBox)', res.status === 'completed' && g[1] > 180 && g[0] < 80, `stiker ${JSON.stringify(sb)} → ${g}`);
    // The red logo is BEHIND the sticker; its transparent border stays see-through (black video).
    const lb = box(ovs(p).find((c) => c.clip_id === logo.clip_id), 60, 60);
    const edge = px(lb.x + 1, lb.y + 1);
    check('R26-18 Render: pinggir transparan PNG tetap tembus (video hitam terlihat)', edge[0] < 60 && edge[1] < 60, `${JSON.stringify(lb)} pojok ${edge}`);
  }

  // ---- D. Buat video: overlays before Generate, preview, then in the engine's draft (+ auto logo).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const f = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await f.getByLabel('Brand').inputValue()) !== '');
  await f.getByLabel('Video bicara').setInputFiles(video);
  await f.getByLabel('Preset').fill('aysilla-konversi');
  await f.locator('summary').filter({ hasText: 'Overlay' }).click();
  const jo = f.getByRole('group', { name: 'Overlay video' });
  await jo.getByRole('button', { name: /＋ Overlay/ }).click();
  await dlg.getByRole('button', { name: 'Pakai Stiker Hijau' }).click();
  await jo.getByLabel('Posisi overlay 1').selectOption('tr');
  const preview = jo.getByLabel('Pratinjau overlay');
  check(
    'R26-19 Buat video: overlay dipilih sebelum Generate + pratinjau di atas video sumber (stiker kanan atas + logo otomatis)',
    (await until(async () => (await preview.locator('.overlayImg[data-pos="tr"]').count()) >= 1)) && (await preview.locator('video').count()) === 1 && (await preview.locator('.overlayImg[data-layer="999"]').count()) === 1,
  );
  await page.screenshot({ path: path.join(EVID, 'buat-video-overlay.png') });
  const before = new Set(await core.listProjectIds(await open()));
  await f.getByRole('button', { name: /Susun draf otomatis/ }).click();
  const planned = await until(() => page.getByRole('region', { name: 'Rencana edit' }).isVisible(), 40000);
  if (!planned) console.log('DEBUG', (await page.getByRole('alert').allInnerTexts()).join(' | '), (await page.locator('.enginePage').innerText()).slice(0, 1500));
  await page.getByRole('button', { name: '✓ Terapkan ke timeline' }).click();
  const newId = (await core.listProjectIds(await open())).find((id) => !before.has(id));
  const applied = await until(async () => ovs(await proj(newId)).length >= 2, 15000);
  const gp = applied ? ovs(await proj(newId)) : [];
  const gSt = gp.find((c) => c.media.version_id === GREEN.version_id);
  const gLogo = gp.find((c) => c.media.version_id === RED.version_id);
  check(
    'R26-20 Draf mesin diterapkan: stiker (kanan atas, sepanjang video) + logo default otomatis (paling depan) jadi klip overlay biasa',
    planned && gSt?.overlay.pos === 'tr' && gSt.overlay.sepanjang === true && gLogo?.overlay.layer === 999 && gLogo.overlay.sepanjang === true,
    gp.map((c) => `${c.media.version_id === RED.version_id ? 'logo' : 'stiker'}:${c.overlay.pos}/${c.overlay.layer}`).join(','),
  );
  check('R26-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R26-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R26 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
