// X07 acceptance run: silence + scene detection → review cuts → plan → apply (one undo) (real Chrome + FFmpeg).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x07-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
// "Talking head": tone 1 s · silence 1.5 s · tone 1 s; picture red → blue at 0.6 s (while talking).
const talk = path.join(work, 'bicara.mp4');
execFileSync(
  FFMPEG,
  ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=360x640:r=30:d=0.6', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=2.9',
    '-filter_complex', '[1]atrim=0:1.5[s];[0][s][2]concat=n=3:v=0:a=1[a];[3][4]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', talk],
  { windowsHide: true },
);
const imp = await svc.importMedia({ sourcePath: talk, scope: { kind: 'shared' }, display_name: 'bicara.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'cut', name: 'Uji Potong' });
await svc.editTimeline({
  project_id: 'cut',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 3500 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'Akhir kalimat', start_ms: 2600, duration_ms: 800 },
  ],
});
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'cut');

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Potong' }).waitFor();

  await page.locator('.track .clip.video').first().click();
  await page.getByRole('button', { name: /Deteksi jeda & adegan/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Deteksi jeda & adegan' });
  await dlg.waitFor();
  const rev0 = (await proj()).revision;
  await dlg.getByRole('button', { name: 'Analisis' }).click();
  const lists = dlg.getByLabel('Hasil deteksi');
  await lists.waitFor({ timeout: 30_000 });
  const silBoxes = lists.getByRole('checkbox', { name: /Potong jeda/ });
  const sceneBoxes = lists.getByRole('checkbox', { name: /Potong di adegan/ });
  const silLabel = (await lists.locator('.cutRow').first().innerText()).replace(/\s+/g, ' ');
  check('X7-01 Analisis menemukan 1 jeda (±1,0–2,5 dtk) + 1 pergantian adegan', (await silBoxes.count()) === 1 && (await sceneBoxes.count()) === 1 && /0:01,\d–0:02,\d/.test(silLabel), silLabel);
  check('X7-02 Jeda tercentang otomatis, potong-adegan tidak (opt-in); perkiraan hemat tampil', (await silBoxes.first().isChecked()) && !(await sceneBoxes.first().isChecked()) && (await dlg.getByText(/Hemat ±1,\d dtk/).isVisible()));

  await lists.getByRole('button', { name: /Lihat jeda/ }).click();
  const ph = Number(await page.getByRole('slider', { name: 'Posisi playhead' }).getAttribute('aria-valuenow'));
  check('X7-03 Tombol ▶ memindah playhead ke jeda (untuk dicek dulu)', ph > 900 && ph < 1200, `${ph} ms`);

  await sceneBoxes.first().check();
  await dlg.getByRole('button', { name: /Buat rencana \(2\)/ }).click();
  const planCard = dlg.getByLabel('Rencana potongan');
  await planCard.waitFor();
  const labels = await planCard.locator('.planOps li').allInnerTexts();
  check('X7-04 Rencana jelas: hapus jeda di semua track + potong video di adegan', labels.length === 2 && /^Hapus 0:01,\d–0:02,\d \(1,\d dtk\) di semua track$/.test(labels[0]) && /^Potong video di 0:00,6$/.test(labels[1]), labels.join(' | '));
  check('X7-05 Menyusun rencana tidak mengubah proyek', (await proj()).revision === rev0);
  await dlg.screenshot({ path: path.join(EVID, 'review.png') });

  await planCard.getByRole('button', { name: /Terapkan/ }).click();
  await dlg.waitFor({ state: 'detached' });
  const p = await proj();
  const vids = p.timeline.tracks.find((t) => t.kind === 'video').clips;
  const sub = p.timeline.tracks.find((t) => t.kind === 'subtitle').clips[0];
  const end = Math.max(...vids.map((c) => c.end_ms));
  check('X7-06 Diterapkan: video jadi 3 potongan, total ±2,3 dtk (dari 3,5)', vids.length === 3 && end > 2100 && end < 2500 && p.revision === rev0 + 1, `${vids.length} klip, akhir ${end} ms`);
  check('X7-07 Subtitle ikut bergeser bersama jeda yang dihapus (tetap sinkron)', sub.start_ms < 1700 && sub.end_ms - sub.start_ms === 800, `${sub.start_ms}–${sub.end_ms}`);
  await page.screenshot({ path: path.join(EVID, 'applied.png') });

  await page.keyboard.press('Control+z');
  const undone = await (async () => {
    for (let i = 0; i < 30; i++) {
      const q = await proj();
      if (q.timeline.tracks.find((t) => t.kind === 'video').clips.length === 1) return q;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  })();
  check('X7-08 Ctrl+Z sekali → kembali utuh (1 klip 3,5 dtk, subtitle di tempat semula)', undone && undone.timeline.tracks.find((t) => t.kind === 'subtitle').clips[0].start_ms === 2600);

  // Second analysis of the same file is instant (cached per version).
  await page.locator('.track .clip.video').first().click();
  await page.getByRole('button', { name: /Deteksi jeda & adegan/ }).click();
  await dlg.getByRole('button', { name: 'Analisis' }).click();
  await dlg.getByText(/Hasil tersimpan/).waitFor();
  check('X7-09 Analisis ulang file yang sama memakai hasil tersimpan', true);
  await dlg.getByRole('button', { name: 'Tutup' }).click();

  // A text clip has no cut button; no AI provider was involved.
  await page.locator('.track .clip.subtitle').first().click();
  check('X7-10 Klip teks/subtitle tidak punya tombol deteksi', (await page.getByRole('button', { name: /Deteksi jeda & adegan/ }).count()) === 0);
  const audits = (await core.readAudit(await core.openWorkspace(wsRoot))).filter((a) => a.op === 'media.analyze');
  check('X7-11 Tercatat di audit (media.analyze), tanpa panggilan AI', audits.length === 2 && !(await core.readAudit(await core.openWorkspace(wsRoot))).some((a) => String(a.op).startsWith('ai.')), `${audits.length} analisis`);

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.locator('.track .clip.video').first().click();
  await phone.getByRole('button', { name: /Deteksi jeda & adegan/ }).click();
  await phone.getByRole('dialog', { name: 'Deteksi jeda & adegan' }).getByRole('button', { name: 'Analisis' }).click();
  await phone.getByLabel('Hasil deteksi').waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X7-12 HP 390px: dialog muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: path.join(EVID, 'phone.png') });
  check('X7-13 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X7-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX07 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
