// Malam 15 Nov — fitur pilihan owner dari audit CapCut, diuji di Chrome asli + server BUILD + FFmpeg:
// fade + ducking + reduksi noise, latar blur / isi / warna, filter warna + adjust, transisi, undo,
// Brand Kit "Filter bawaan video", render nyata.
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
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-m15-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
// 16:9 source (red left / blue right) with sound, a 9:16 gray one, and music.
const wide = await gen('lebar.mp4', ['-f', 'lavfi', '-i', "nullsrc=s=640x360:r=30:d=4,geq=r='if(lt(X\\,320)\\,220\\,30)':g='30':b='if(lt(X\\,320)\\,30\\,220)'", '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const tall = await gen('tegak.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=360x640:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=330:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const music = await gen('musik.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', 'volume=0.3']);
await core.createProject(ws, { project_id: 'm15', name: 'Uji Fitur Malam' });
await svc.editTimeline({
  project_id: 'm15',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: wide, start_ms: 0, duration_ms: 2000 },
    { op: 'add_clip', track_kind: 'video', media: tall, start_ms: 2000, duration_ms: 2000 },
    { op: 'add_clip', track_kind: 'music', media: music, start_ms: 0, duration_ms: 4000 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'm15');
const vclips = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips;
const until = async (fn, ms = 6000) => {
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Fitur Malam' }).waitFor();
  const total = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuemax'));
  const seek = async (ms) => {
    const ruler = await page.getByRole('slider', { name: 'Posisi playhead' }).boundingBox();
    await page.mouse.click(ruler.x + (ruler.width * ms) / total, ruler.y + ruler.height / 2);
    await page.waitForTimeout(300);
  };
  const video = page.locator('video[aria-label="Video pratinjau"]');
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const pick = async (i) => {
    await page.locator('.track .clip.video').nth(i).click();
    await insp.waitFor();
  };

  // 1. Gambar: latar blur + filter warna + adjust (clip 1, 16:9 on a 9:16 canvas).
  await pick(0);
  const look = insp.getByRole('group', { name: 'Tampilan gambar' });
  await look.getByLabel('Tampilan di canvas').selectOption('blur');
  check('M15-01 Inspector "Di canvas: Pas + latar blur" tersimpan di klip', await until(async () => (await vclips())[0].fit === 'blur'));
  await seek(500);
  check('M15-02 Pratinjau: latar blur di belakang video (canvas blur + video data-fit)', (await video.getAttribute('data-fit')) === 'blur' && (await page.locator('canvas.fitBlurBg').count()) === 1);
  await pick(0);
  await look.getByLabel('Filter warna').selectOption('hitamputih');
  check('M15-03 Filter warna "Hitam Putih" tersimpan (preset buatan sendiri)', await until(async () => (await vclips())[0].look === 'hitamputih'));
  await seek(500);
  const f1 = await video.evaluate((v) => getComputedStyle(v).filter);
  check('M15-04 Pratinjau: filter CSS mendekati render (grayscale + kontras)', /grayscale\(1\)/.test(f1) && /contrast/.test(f1), f1);
  await pick(0);
  const adj = insp.getByRole('group', { name: 'Adjust gambar' });
  await adj.getByLabel('Vignette').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  check('M15-05 Slider Adjust (Vignette): 3 langkah tombol panah = satu simpan', await until(async () => (await vclips())[0].adjust?.vignette === 3), JSON.stringify((await vclips())[0].adjust));
  const before = 3;
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('M15-06 Undo mengembalikan Adjust (satu langkah undo)', await until(async () => (await vclips())[0].adjust === undefined), JSON.stringify((await vclips())[0].adjust ?? null));
  await page.getByRole('button', { name: /Redo/ }).click();
  check('M15-07 Redo memakai lagi', await until(async () => ((await vclips())[0].adjust?.vignette ?? 0) === before));
  await page.screenshot({ path: path.join(EVID, 'gambar.png') });

  // 2. Suara: fade + reduksi noise (clip 1), ducking (musik).
  await pick(0);
  const sound = insp.getByRole('group', { name: 'Suara klip' });
  await sound.getByLabel('Fade masuk (detik)').fill('0,5');
  await sound.getByLabel('Fade masuk (detik)').press('Enter');
  check('M15-08 Fade masuk 0,5 dtk tersimpan', await until(async () => (await vclips())[0].fade_in_ms === 500));
  await sound.getByLabel('Reduksi noise').selectOption('sedang');
  check('M15-09 Reduksi noise "Sedang" tersimpan', await until(async () => (await vclips())[0].denoise === 'sedang'));
  await seek(100);
  const vol = await video.evaluate((v) => v.volume);
  check('M15-10 Pratinjau: suara mengecil di awal fade masuk', vol < 0.4, String(vol));
  await page.locator('.track .clip.music').first().click();
  await insp.getByRole('group', { name: 'Ducking musik' }).getByLabel('Ducking musik').click();
  check('M15-11 Ducking musik aktif di track Musik (30%)', await until(async () => (await proj()).timeline.tracks.find((t) => t.kind === 'music').duck === 0.3));
  await seek(1000);
  const mv = await page.locator('audio[data-layer="music"]').evaluate((a) => a.volume);
  check('M15-12 Pratinjau: musik turun saat ada suara bicara (video)', Math.abs(mv - 0.3) < 0.02, String(mv));

  // 3. Transisi masuk (clip 2) + latar warna.
  await pick(1);
  const tr = insp.getByRole('group', { name: 'Transisi masuk' });
  await tr.getByLabel('Transisi masuk').selectOption('dissolve');
  check('M15-13 Transisi "Dissolve" tersimpan di klip kedua', await until(async () => (await vclips())[1].transition?.type === 'dissolve'));
  await pick(1);
  await tr.getByLabel('Durasi transisi').fill('800');
  await tr.getByLabel('Durasi transisi').press('Enter');
  check('M15-14 Durasi transisi 800 ms tersimpan', await until(async () => (await vclips())[1].transition?.ms === 800));
  await seek(2100);
  const op = Number(await video.evaluate((v) => getComputedStyle(v).opacity));
  check('M15-15 Pratinjau: perkiraan dissolve di titik potong', op < 0.9, String(op));
  await pick(1);
  await look.getByLabel('Tampilan di canvas').selectOption('isi');
  check('M15-16 "Isi layar (crop)" tersimpan', await until(async () => (await vclips())[1].fit === 'isi'));

  // 3b. Keyframe (posisi / skala / opasitas) di klip 2.
  await pick(1);
  const kfp = insp.getByRole('group', { name: 'Keyframe' });
  await kfp.getByLabel('Gerak cepat').selectOption('kenburns');
  check('M15-K1 "Gerak cepat: Zoom pelan" menyimpan 2 keyframe (skala 1 → 1,15)', await until(async () => (await vclips())[1].keyframes?.length === 2 && (await vclips())[1].keyframes[1].scale === 1.15));
  await seek(3900);
  const tf = await video.evaluate((v) => v.style.transform);
  check('M15-K2 Pratinjau: video membesar mengikuti keyframe di akhir klip', /scale\(1\.1[0-5]/.test(tf), tf);
  await pick(1);
  await kfp.getByLabel('Opasitas % keyframe 2').fill('40');
  await kfp.getByLabel('Opasitas % keyframe 2').press('Enter');
  check('M15-K3 Ubah Opasitas titik 2 → 40 % tersimpan', await until(async () => (await vclips())[1].keyframes?.[1]?.opacity === 0.4));
  await seek(3800);
  const vop = Number(await video.evaluate((v) => getComputedStyle(v).opacity));
  check('M15-K4 Pratinjau: video memudar mengikuti keyframe', vop < 0.6, String(vop));
  const undoTitle = await page.getByRole('button', { name: '↶ Undo' }).getAttribute('title');
  const revK = (await proj()).revision;
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('M15-K5 Undo mengembalikan opasitas keyframe', await until(async () => (await vclips())[1].keyframes?.[1]?.opacity === 1), `undo="${undoTitle}" rev=${revK} kf=${JSON.stringify((await vclips())[1].keyframes)}`);
  await pick(1);
  await kfp.scrollIntoViewIfNeeded();
  await insp.screenshot({ path: path.join(EVID, 'keyframe.png') });

  // 4. Brand Kit: Filter bawaan video.
  await page.getByRole('button', { name: /Brand/ }).first().click();
  await page.getByRole('heading', { name: 'Brand Kit' }).waitFor();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await form.getByLabel('Nama brand').fill('Brand Uji');
  await form.getByLabel('Filter bawaan video').selectOption('hangat');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText(/Tersimpan \(revisi/).waitFor();
  const kit = await new core.StorageService(await core.openWorkspace(wsRoot)).readBrandKit();
  check('M15-17 Brand Kit: "Filter bawaan video" tersimpan per brand', kit.filter_bawaan === 'hangat', String(kit.filter_bawaan));
  await page.screenshot({ path: path.join(EVID, 'brand-filter.png') });

  // 5. Render nyata dari aplikasi.
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Fitur Malam' }).waitFor();
  await page.getByRole('button', { name: '↧ Render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Render MP4' });
  await dialog.getByLabel('Nama file output').fill('m15');
  await dialog.getByLabel('Resolusi render').selectOption('720');
  const startBtn = dialog.getByRole('button', { name: /Mulai render/ });
  await until(() => startBtn.isEnabled());
  await startBtn.click();
  await dialog.getByText('Selesai', { exact: true }).waitFor({ timeout: 120_000 });
  const outs = await core.listOutputs(await core.openWorkspace(wsRoot), 'm15');
  const out = path.join(wsRoot, outs[0].rel);
  const frame = (t) => execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=72:128', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const px = (b, x, y) => [b[(y * 72 + x) * 3], b[(y * 72 + x) * 3 + 1], b[(y * 72 + x) * 3 + 2]];
  const f0 = frame(0.8);
  const topBand = px(f0, 36, 6);
  const centre = px(f0, 18, 64);
  check('M15-18 Render: latar blur (bukan bar hitam) + hitam putih di klip 1', topBand.reduce((a, b) => a + b, 0) > 60 && Math.max(...centre) - Math.min(...centre) < 14, `atas ${topBand} tengah ${centre}`);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { windowsHide: true }).toString().trim());
  check('M15-19 Render: durasi tetap 4 dtk walau ada transisi', Math.abs(dur - 4) < 0.1, String(dur));
  const f2 = px(frame(3.5), 36, 64);
  check('M15-19b Render: klip 2 tanpa filter sendiri memakai filter bawaan brand (Hangat: lebih merah dari biru)', f2[0] - f2[2] > 8, String(f2));
  check('M15-20 Render: metadata bersih', await dialog.getByText(/metadata bersih \(terverifikasi\)/).isVisible());
  await page.keyboard.press('Escape');

  // 6. HP: inspector tanpa scroll horizontal.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Uji Fitur Malam' }).waitFor();
  await phone.locator('.track .clip.video').first().click();
  await phone.getByRole('region', { name: 'Inspector klip' }).getByRole('group', { name: 'Adjust gambar' }).scrollIntoViewIfNeeded();
  const sw = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('M15-21 HP 390 px: inspector tampil tanpa scroll horizontal', sw <= 1, `lebih ${sw}px`);
  await phone.screenshot({ path: path.join(EVID, 'inspector-phone.png') });

  check('M15-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('M15-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nM15 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
