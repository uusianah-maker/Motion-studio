// X04 acceptance run: clip volume + track mute in the inspector/timeline, preview obeys, Copilot command (real Chrome).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x04-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'aud', name: 'Uji Audio' });
await svc.editTimeline({
  project_id: 'aud',
  expected_revision: 0,
  actor: 'user',
  ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 6000 }],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'aud');
const videoTrack = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video');
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
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
  await page.getByRole('heading', { name: 'Uji Audio' }).waitFor();
  const videoVol = () => page.evaluate(() => document.querySelector('video[aria-label="Video pratinjau"]').volume);

  await page.locator('.track .clip.video').first().click();
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  const slider = insp.getByLabel('Volume klip');
  check('X4-01 Inspector klip video: slider volume 100%', (await slider.inputValue()) === '100');

  await slider.fill('40');
  check('X4-02 Geser slider → tersimpan sebagai satu edit volume 0.4', await until(async () => (await videoTrack()).clips[0].volume === 0.4));
  check('X4-03 Pratinjau ikut: elemen video volume 0.4', await until(async () => Math.abs((await videoVol()) - 0.4) < 0.01), String(await videoVol()));
  const hist = (await proj()).snapshots?.length;

  await insp.getByRole('button', { name: 'Bisukan klip' }).click();
  check('X4-04 Tombol "Bisukan klip" → volume 0', await until(async () => (await videoTrack()).clips[0].volume === 0));

  const trackBtn = page.getByRole('button', { name: 'Bisukan track Video' });
  await insp.getByRole('button', { name: 'Nyalakan suara klip' }).click();
  await until(async () => (await videoTrack()).clips[0].volume === undefined);
  await trackBtn.click();
  check('X4-05 Tombol mute di label track Video → track.muted = true', await until(async () => (await videoTrack()).muted === true));
  check('X4-06 Pratinjau: track dibisukan → volume video 0', await until(async () => (await videoVol()) === 0));
  check('X4-07 Tombol berubah jadi "Nyalakan suara track Video" (aria-pressed)', (await page.getByRole('button', { name: 'Nyalakan suara track Video' }).getAttribute('aria-pressed')) === 'true');

  await page.keyboard.press('Control+z');
  check('X4-08 Ctrl+Z membatalkan mute track (satu langkah undo)', await until(async () => !(await videoTrack()).muted));

  // Copilot: volume command on the selected clip.
  await page.locator('.track .clip.video').first().click();
  const cp = page.getByRole('region', { name: 'Motion Copilot' });
  await cp.getByLabel('Perintah Copilot').fill('volume 25%; bisukan track audio');
  await cp.getByRole('button', { name: 'Buat rencana' }).click();
  const plan = cp.getByLabel('Rencana edit');
  await plan.waitFor();
  const labels = await plan.locator('.planOps li').allInnerTexts();
  await plan.getByRole('button', { name: /Terapkan/ }).click();
  await cp.getByText(/Diterapkan/).waitFor();
  const p = await proj();
  check(
    'X4-09 Copilot "volume 25%; bisukan track audio" → rencana jelas → volume & mute berubah',
    p.timeline.tracks.find((t) => t.kind === 'video').clips[0].volume === 0.25 && p.timeline.tracks.find((t) => t.kind === 'audio')?.muted === true && labels.some((l) => /25%/.test(l)),
    labels.join(' | '),
  );
  check('X4-10 Riwayat bertambah per edit (bukan per gerakan slider)', typeof hist === 'number' && (await proj()).snapshots.length - hist <= 6, `${hist} → ${(await proj()).snapshots?.length}`);
  await page.screenshot({ path: path.join(EVID, 'audio.png') });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Uji Audio' }).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X4-11 HP 390px: tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('X4-12 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X4-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX04 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
