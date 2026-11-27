// W07 acceptance run: synchronized preview in real Chrome against the BUILT server + UI.
// Real MP4s (probed with ffprobe), real playback, seek accuracy, text overlay, ratio, safe area.
// Evidence → audit/W07/evidence/.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w07-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'lucy', name: 'Lucy — Elegant Look' });
const imp = async (file, name) => {
  const p = path.join(work, name);
  await fsp.copyFile(path.join(FIX, file), p);
  return svc.importMedia({ sourcePath: p, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
};
const eight = await imp('sample_8s_9x16.mp4', 'Lucy-8s.mp4');
await imp('sample_3s_16x9.mp4', 'Musik-3s.mp4');
check('PV-00 Probe saat import (ffprobe)', eight.version.probe?.duration_ms === 8000, JSON.stringify(eight.version.probe));

const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'lucy');
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  // 409/422 from deliberate invalid edits are expected; anything else counts.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Lucy — Elegant Look' }).waitFor();
  const saved = () => page.getByText('Tersimpan', { exact: true }).waitFor();
  // Poll with page.evaluate (CDP): waitForFunction uses eval, which our strict CSP correctly blocks.
  const waitUntil = async (fn, arg, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg)) return true;
      await page.waitForTimeout(50);
    }
    return false;
  };
  const videoState = () => page.evaluate(() => {
    const v = document.querySelector('.canvas video[aria-label="Video pratinjau"]');
    return { t: v.currentTime, paused: v.paused, ready: v.readyState, src: !!v.getAttribute('src') };
  });
  const rulerAt = async (ms) => {
    const b = await page.locator('.trackSurface.ruler').boundingBox();
    const total = Number(await page.locator('.trackSurface.ruler').getAttribute('aria-valuemax'));
    await page.mouse.click(b.x + (ms / total) * b.width, b.y + b.height / 2);
  };

  // Real duration from the probe.
  await page.getByRole('button', { name: 'Tambah Lucy-8s.mp4 ke linimasa' }).click();
  await saved();
  let v = (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips;
  check('PV-01 Klip masuk dengan durasi asli 8 dtk', v[0].end_ms === 8000, `end=${v[0].end_ms}`);

  // Trim-end past the source end is clamped by the UI (and would be refused by the server).
  const clip = page.locator('.track').filter({ hasText: 'Video' }).locator('.clip').first();
  const hb = await clip.locator('.handle.end').boundingBox();
  await page.mouse.move(hb.x + 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 300, hb.y + hb.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  v = (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips;
  check('PV-02 Trim kanan mentok di ujung sumber', v[0].end_ms === 8000, `end=${v[0].end_ms}`);

  // Real playback.
  await page.getByRole('button', { name: 'Putar' }).click();
  await waitUntil(() => document.querySelector('.canvas video[aria-label="Video pratinjau"]').currentTime > 1, null, 8000);
  const playing = await videoState();
  const shown = await page.locator('.player .time').innerText();
  check('PV-03 Putar: video jalan + jam timeline maju', !playing.paused && playing.t > 1 && !shown.startsWith('00:00:00'), `${JSON.stringify(playing)} time=${shown}`);
  await page.getByRole('button', { name: 'Jeda', exact: true }).click();
  await page.waitForTimeout(200);
  check('PV-04 Jeda: video berhenti', (await videoState()).paused);
  await page.screenshot({ path: path.join(EVID, 'w07_preview_playing.png') });

  // Split at 4 s, then seek into the right half: source time = in_ms + offset.
  await rulerAt(4000);
  await clip.click();
  await page.keyboard.press('s');
  await saved();
  await rulerAt(5500);
  await waitUntil(() => Math.abs(document.querySelector('.canvas video[aria-label="Video pratinjau"]').currentTime - 5.5) < 0.15, null, 5000);
  const seek = await videoState();
  check('PV-05 Seek setelah split: waktu sumber tepat (in_ms + offset)', Math.abs(seek.t - 5.5) < 0.15, `t=${seek.t.toFixed(3)}`);

  // Text overlay at the playhead.
  await rulerAt(1000);
  await page.getByRole('button', { name: '＋ Teks' }).click();
  await saved();
  await page.locator('.track').filter({ hasText: 'Teks & CTA' }).locator('.clip').first().click();
  await page.getByLabel('Teks klip').fill('Hook elegan 3 detik');
  await page.getByLabel('Teks klip').press('Enter');
  await saved();
  await rulerAt(2000);
  check('PV-06 Overlay teks tampil di playhead', await page.locator('.overlayText', { hasText: 'Hook elegan 3 detik' }).isVisible());
  await rulerAt(4500);
  check('PV-07 Overlay teks hilang di luar klipnya', (await page.locator('.overlayText').count()) === 0);

  // Ratio: saved in the project, part of undo.
  await page.getByLabel('Rasio canvas').selectOption('1:1');
  await saved();
  const box = await page.locator('.canvas.live').boundingBox();
  check('PV-08 Rasio 1:1 → canvas persegi + tersimpan', Math.abs(box.width - box.height) < 3 && (await proj()).timeline.canvas?.ratio === '1:1', `${box.width.toFixed(0)}x${box.height.toFixed(0)}`);
  await page.locator('body').click({ position: { x: 5, y: 890 } });
  await page.keyboard.press('Control+z');
  await saved();
  check('PV-09 Undo mengembalikan rasio 9:16', (await proj()).timeline.canvas === undefined && (await page.getByLabel('Rasio canvas').inputValue()) === '9:16');

  // Safe area toggle.
  check('PV-10 Garis area aman tampil', await page.locator('.safeArea').isVisible());
  await page.getByLabel('Area aman').uncheck();
  check('PV-11 Area aman bisa disembunyikan', (await page.locator('.safeArea').count()) === 0);
  await page.getByLabel('Area aman').check();

  // Audio track follows the same clock.
  check('PV-12a ＋ Audio mati untuk file tanpa stream audio', await page.getByRole('button', { name: 'Tambah audio Musik-3s.mp4' }).isDisabled());
  await page.getByRole('button', { name: 'Tambah audio Lucy-8s.mp4' }).click();
  await saved();
  await rulerAt(1500);
  await waitUntil(() => {
    const a = document.querySelector('.canvas audio');
    return a.getAttribute('src') && Math.abs(a.currentTime - 1.5) < 0.15;
  }, null, 5000);
  const aud = await page.evaluate(() => ({ t: document.querySelector('.canvas audio').currentTime, src: !!document.querySelector('.canvas audio').getAttribute('src') }));
  check('PV-12 Track audio ikut playhead', aud.src && Math.abs(aud.t - 1.5) < 0.15, JSON.stringify(aud));

  // Space toggles playback.
  await page.locator('body').click({ position: { x: 5, y: 890 } });
  await page.keyboard.press('Space');
  await waitUntil(() => !document.querySelector('.canvas video[aria-label="Video pratinjau"]').paused, null, 5000);
  check('PV-13 Spasi = putar', !(await videoState()).paused);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  check('PV-14 Spasi lagi = jeda', (await videoState()).paused);
  await rulerAt(2000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(EVID, 'w07_preview_text_safe.png') });

  // The signed URL is the only way in: no token, wrong signature → refused.
  const probe = await page.evaluate(async (vid) => {
    const bad = await fetch(`/api/stream/${vid}?exp=${Date.now() + 60000}&sig=${'0'.repeat(64)}`);
    return bad.status;
  }, eight.version.version_id);
  check('PV-15 Stream tanpa tanda tangan sah ditolak', probe === 401, `status=${probe}`);

  // Phone layout.
  const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await p2.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await p2.getByRole('heading', { name: 'Lucy — Elegant Look' }).waitFor();
  check('PV-16 HP 390px tanpa scroll horizontal', await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p2.screenshot({ path: path.join(EVID, 'w07_preview_phone.png'), fullPage: true });

  check('PV-17 Tidak ada error JS', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('PV-RUN tanpa exception', false, String(e).slice(0, 500));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const summary = results.reduce((a, r) => ((a[r.ok ? 'PASS' : 'FAIL'] = (a[r.ok ? 'PASS' : 'FAIL'] ?? 0) + 1), a), {});
await fsp.writeFile(path.join(EVID, 'ui_results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
process.exit(summary.FAIL ? 1 : 0);
