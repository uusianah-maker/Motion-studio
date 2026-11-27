// P27 (keluhan owner 27 Nov): pratinjau linimasa kosong / patah saat potongan berganti sumber, SFX hilang,
// padahal render lancar. Linimasa uji: 12 potongan 0,8 dtk bergantian dari 3 file (merah / hijau / biru),
// 6 SFX pendek. Saat diputar, layar pratinjau dicicipi tiap ~30 ms: video siap (readyState >= 2) dan
// warnanya sesuai sumber potongan di titik itu. Bukti -> audit/P27/evidence/ (atau EVID_OUT).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = process.env.EVID_OUT || path.join(here, 'evidence');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-p27-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, args) => {
  const p = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, p], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: p, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
// 540x960 30 fps h264 with sound (like the light preview copies), keyframe every second.
const warna = { merah: [220, 30, 30], hijau: [30, 200, 30], biru: [30, 30, 220] };
const src = {};
for (const [n, [r, g, b]] of Object.entries(warna)) {
  const hex = [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  src[n] = await gen(`${n}.mp4`, ['-f', 'lavfi', '-i', `color=c=0x${hex}:s=540x960:r=30:d=12`, '-f', 'lavfi', '-i', 'sine=f=200:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest']);
}
const bip = await gen('bip.wav', ['-f', 'lavfi', '-i', 'sine=f=1200:d=0.3', '-af', 'volume=0.5']);
const urut = ['merah', 'hijau', 'biru', 'hijau', 'merah', 'biru', 'merah', 'hijau', 'biru', 'merah', 'biru', 'hijau'];
const POT = 800;
await core.createProject(ws, { project_id: 'p27', name: 'Uji Pratinjau Potongan' });
await svc.editTimeline({
  project_id: 'p27',
  expected_revision: 0,
  actor: 'user',
  ops: [
    ...urut.map((n, i) => ({ op: 'add_clip', track_kind: 'video', media: src[n], start_ms: i * POT, duration_ms: POT, in_ms: 1000 + i * 700 })),
    ...[1, 3, 5, 7, 9, 11].map((k) => ({ op: 'add_clip', track_kind: 'sfx', media: bip, start_ms: k * POT + 200, duration_ms: 300 })),
  ],
});

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Pratinjau Potongan' }).waitFor();
  await page.waitForTimeout(1500);
  const sample = () =>
    page.evaluate(() => {
      const v = document.querySelector('.canvas video[aria-label="Video pratinjau"]');
      const time = document.querySelector('.player .time')?.textContent ?? '';
      const sfx = [...document.querySelectorAll('audio[data-layer^="sfx"]')].map((a) => ({ playing: !a.paused, ready: a.readyState }));
      if (!v) return { ok: false, why: 'tanpa video', time, sfx };
      let rgb = null;
      if (v.readyState >= 2 && v.videoWidth) {
        const c = document.createElement('canvas');
        c.width = 8;
        c.height = 8;
        const x = c.getContext('2d');
        x.drawImage(v, 0, 0, 8, 8);
        rgb = [...x.getImageData(4, 4, 1, 1).data].slice(0, 3);
      }
      return { ready: v.readyState, seeking: v.seeking, rgb, n: document.querySelectorAll('.canvas video').length, time, sfx };
    });
  const nearest = (rgb) => {
    let best = null;
    let d0 = Infinity;
    for (const [n, c] of Object.entries(warna)) {
      const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]);
      if (d < d0) [best, d0] = [n, d];
    }
    return d0 < 90 ? best : null;
  };
  const samples = [];
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Putar' }).click();
  while (Date.now() - t0 < urut.length * POT + 300) {
    const s = await sample();
    s.at = Date.now() - t0;
    samples.push(s);
  }
  // Ignore the first 400 ms (first load) and samples near a cut (±120 ms: the clock and the picture
  // are measured a few ms apart).
  // Player clock "HH:MM:SS:FF" (30 frames per second).
  const playheadMs = (s) => {
    const m = /^(\d+):(\d+):(\d+):(\d+)/.exec(s.time);
    return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round((Number(m[4]) * 1000) / 30) : null;
  };
  for (const s of samples) s.ph = playheadMs(s);
  const judged = samples.filter((s) => s.ph !== null && s.ph > 300 && s.ph < urut.length * POT - 100 && s.ph % POT > 120 && s.ph % POT < POT - 120);
  const blank = judged.filter((s) => !(s.ready >= 2) || !s.rgb);
  const wrong = judged.filter((s) => s.rgb && nearest(s.rgb) !== urut[Math.min(urut.length - 1, Math.floor(s.ph / POT))]);
  const pct = (a) => `${((100 * a.length) / Math.max(1, judged.length)).toFixed(1)}%`;
  check('P27-01 Diputar melewati 11 pergantian sumber: layar tidak kosong (≤ 3% cicipan)', blank.length <= judged.length * 0.03, `${blank.length}/${judged.length} kosong (${pct(blank)})`);
  check('P27-02 Gambar sesuai sumber potongan (≤ 10% cicipan; selisih jam ±ms)', wrong.length <= judged.length * 0.1, `${wrong.length}/${judged.length} beda (${pct(wrong)})`);
  const sfxPlayed = samples.filter((s) => s.sfx.some((x) => x.playing)).length;
  check('P27-03 SFX pendek berbunyi (ada cicipan SFX sedang diputar)', sfxPlayed >= 6, `${sfxPlayed} cicipan`);
  check('P27-04 Hanya satu video bernama "Video pratinjau" (sisanya cadangan tersembunyi)', (await page.locator('video[aria-label="Video pratinjau"]').count()) === 1);
  await page.screenshot({ path: path.join(EVID, 'pratinjau.png') });
  await fsp.writeFile(path.join(EVID, 'cicipan.json'), JSON.stringify(samples.map(({ ph, ready, rgb, time }) => ({ ph, ready, rgb, time }))));
  check('P27-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('P27-XX run selesai tanpa exception', false, String(e).slice(0, 400));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  const pass = results.filter((r) => r.ok).length;
  console.log(`P27: ${pass}/${results.length} lulus`);
  process.exit(pass === results.length ? 0 : 1);
}
