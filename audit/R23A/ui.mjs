// R23a (owner 16 Nov, alat edit gaya CapCut) — diuji di Chrome asli + server BUILD + FFmpeg:
// putar / balik, kecepatan (durasi ikut, klip sesudahnya bergeser), mundur (batas 10 dtk),
// bekukan frame di playhead, reduksi noise gambar, undo, pratinjau (playbackRate, rotasi) dan
// render nyata (durasi + frame benar).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23a-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
// Portrait source, 6 s: red top / blue bottom, sound; a 14 s one for the reverse limit.
const tb = await gen('atasbawah.mp4', ['-f', 'lavfi', '-i', "nullsrc=s=360x640:r=30:d=6,geq=r='if(lt(Y\\,320)\\,220\\,30)':g='30':b='if(lt(Y\\,320)\\,30\\,220)'", '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const long = await gen('panjang.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=360x640:r=30:d=14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
await core.createProject(ws, { project_id: 'r23a', name: 'Uji Alat CapCut' });
await svc.editTimeline({
  project_id: 'r23a',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: tb, start_ms: 0, duration_ms: 2000 },
    { op: 'add_clip', track_kind: 'video', media: tb, start_ms: 2000, duration_ms: 2000, in_ms: 2000 },
    { op: 'add_clip', track_kind: 'video', media: long, start_ms: 4000, duration_ms: 12000 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'r23a');
const vclips = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips;
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
const spans = async () => (await vclips()).map((c) => `${c.start_ms}-${c.end_ms}${c.freeze ? 'F' : ''}`).join(' ');

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Alat CapCut' }).waitFor();
  const slider = page.getByRole('slider', { name: 'Posisi playhead' });
  const seek = async (ms) => {
    const total = Number(await slider.getAttribute('aria-valuemax'));
    const ruler = await slider.boundingBox();
    await page.mouse.click(ruler.x + (ruler.width * ms) / total, ruler.y + ruler.height / 2);
    await page.waitForTimeout(300);
  };
  const video = page.locator('video[aria-label="Video pratinjau"]');
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const motion = insp.getByRole('group', { name: 'Arah dan kecepatan' });
  const pick = async (i) => {
    await page.locator('.track .clip.video').nth(i).click();
    await motion.waitFor();
  };

  // 1. Kecepatan 2×: klip 1 jadi 1 dtk, klip sesudahnya bergeser; pratinjau playbackRate 2.
  await pick(0);
  check('R23A-01 Inspector klip video punya grup "Arah dan kecepatan"', await motion.isVisible());
  await motion.getByLabel('Pilihan kecepatan').selectOption('2');
  check('R23A-02 Kecepatan 2× → durasi klip 2→1 dtk, klip sesudahnya ikut maju', await until(async () => (await spans()) === '0-1000 1000-3000 3000-15000'), await spans());
  await seek(500);
  const rate = await video.evaluate((v) => v.playbackRate);
  check('R23A-03 Pratinjau: video diputar 2× (playbackRate), posisi sumber = 2 × waktu', rate === 2 && Math.abs((await video.evaluate((v) => v.currentTime)) - 1) < 0.15, `rate ${rate}`);
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23A-04 Undo mengembalikan kecepatan + durasi (satu langkah)', await until(async () => (await spans()) === '0-2000 2000-4000 4000-16000' && (await vclips())[0].speed === undefined), await spans());
  await pick(0);
  await motion.getByLabel('Kecepatan (×)').fill('0,25');
  await motion.getByLabel('Kecepatan (×)').press('Enter');
  check('R23A-05 Ketik kecepatan 0,25× → durasi 8 dtk; opsi "Tanpa suara" muncul (kecepatan ekstrem)', await until(async () => (await vclips())[0].end_ms === 8000 && (await motion.getByLabel('Tanpa suara').count()) === 1), await spans());
  await motion.getByLabel('Tanpa suara').click();
  check('R23A-06 "Tanpa suara" = volume klip 0', await until(async () => (await vclips())[0].volume === 0));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await until(async () => (await vclips())[0].end_ms === 2000);

  // 2. Putar 90° + balik.
  await pick(0);
  await motion.getByLabel('Putar gambar').selectOption('90');
  check('R23A-07 Putar 90° tersimpan', await until(async () => (await vclips())[0].rotate === 90));
  await seek(500);
  const box = await video.boundingBox();
  const canvas = await page.getByLabel('Area pratinjau').boundingBox();
  check('R23A-08 Pratinjau: video diputar 90° (kotak ditukar lebar↔tinggi, transform rotate)', /rotate\(90deg\)/.test((await video.getAttribute('data-orient')) ?? '') && Math.abs(box.width - canvas.width) < 3 && Math.abs(box.x - canvas.x) < 3 && Math.abs(box.y - canvas.y) < 3, `${(await video.getAttribute('data-orient')) ?? '-'} · ${Math.round(box.width)}×${Math.round(box.height)} di ${Math.round(canvas.width)}×${Math.round(canvas.height)}`);
  await page.screenshot({ path: path.join(EVID, 'putar.png') });
  await pick(0);
  await motion.getByLabel('Balik kiri-kanan').click();
  check('R23A-09 Balik kiri-kanan tersimpan', await until(async () => (await vclips())[0].flip_h === true));
  await pick(0);
  await motion.getByLabel('Reduksi noise gambar').selectOption('ringan');
  check('R23A-10 Noise gambar "Ringan" tersimpan', await until(async () => (await vclips())[0].vdenoise === 'ringan'));

  // 3. Mundur: klip 14 dtk ditolak dengan alasan; klip 2 dtk boleh.
  await pick(2);
  const rev = motion.getByLabel('Putar mundur');
  check('R23A-11 Mundur untuk klip 12 dtk dikunci + pesan batas 10 dtk', (await rev.isDisabled()) && /maks 10 dtk sumber/.test(await motion.innerText()));
  await pick(1);
  await motion.getByLabel('Putar mundur').click();
  check('R23A-12 Mundur klip 2 dtk tersimpan', await until(async () => (await vclips())[1].reverse === true));
  await seek(2500);
  const want = await video.evaluate((v) => v.currentTime);
  check('R23A-13 Pratinjau mundur: di 0,5 dtk klip, sumber di 3,5 dtk (dari akhir); video diam, suara dimatikan', Math.abs(want - 3.5) < 0.15 && (await video.evaluate((v) => v.paused && v.volume === 0)), `currentTime ${want.toFixed(2)}`);

  // 4. Bekukan frame di playhead (1 dtk di dalam klip 2).
  await seek(3000);
  await pick(1);
  await motion.getByLabel('Lama bekukan (detik)').fill('1,5');
  await motion.getByRole('button', { name: 'Bekukan frame di playhead' }).click();
  const okF = await until(async () => (await vclips()).some((c) => c.freeze));
  const still = (await vclips()).find((c) => c.freeze);
  check('R23A-14 Bekukan 1,5 dtk di playhead: potongan diam disisipkan, klip sesudahnya bergeser 1,5 dtk', okF && still.end_ms - still.start_ms === 1500 && (await vclips()).at(-1).start_ms === 5500 && still.volume === 0, await spans());
  check('R23A-15 Potongan diam memakai frame di playhead (mundur: sumber 3 dtk)', still?.in_ms === 3000 && !!still?.reverse === false, `in_ms ${still?.in_ms}`);

  // 5. Render nyata: durasi total + putar 90° (merah di kanan) + frame beku.
  const p = await proj();
  const res = await core.renderProject(await core.openWorkspace(wsRoot), { project_id: 'r23a', output_name: 'r23a.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  const out = res.status === 'completed' ? path.join(wsRoot, (await core.listOutputs(await core.openWorkspace(wsRoot), 'r23a'))[0].rel) : null;
  const end = Math.max(...p.timeline.tracks.flatMap((t) => t.clips.map((c) => c.end_ms)));
  const dur = out ? Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString()) : 0;
  check('R23A-16 Render nyata selesai, durasi = linimasa', res.status === 'completed' && Math.abs(dur - end / 1000) < 0.1, `${dur.toFixed(2)} dtk vs ${end / 1000}`);
  if (out) {
    const px = (t, x, y) => {
      const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const i = (y * 180 + x) * 3;
      return [b[i], b[i + 1], b[i + 2]];
    };
    // Clip 1: rotate 90° + flip kiri-kanan → top (red) goes right, then mirrored to the left.
    const r = px(1.0, 20, 160);
    const l = px(1.0, 160, 160);
    check('R23A-17 Render: putar 90° + balik kiri-kanan sesuai pratinjau (merah kiri, biru kanan)', r[0] > 150 && l[2] > 150, `kiri ${r} · kanan ${l}`);
  }
  check('R23A-99 0 error JS', errors.length === 0, errors.join(' | '));

  // 6. HP 390 px: panel muat tanpa scroll samping.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Uji Alat CapCut' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('R23A-18 HP 390 px: tanpa scroll samping', overflow <= 0, `${overflow}px`);
} catch (e) {
  check('R23A-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23A UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
