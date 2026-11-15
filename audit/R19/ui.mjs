// R19 "Kirim ke PIC" (owner: "Ya, buat"): one click in Edit renders the newest revision; the video
// then waits in 3. Setujui as "Revisi n"; no double send; a Batch variant changed after approval
// loses that approval and goes to the PIC for review. After a manual render: "Lanjut ke 3. Setujui".
// Real server, Chrome and FFmpeg.
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
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r19-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const clip = path.join(work, 'klip.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { windowsHide: true });
const v = await svc.importMedia({ sourcePath: clip, scope: { kind: 'shared' }, actor: 'user' });
const media = { media_id: v.media.media_id, version_id: v.version.version_id };
await core.createProject(ws, { project_id: 'promo', name: 'Promo Kirim' });
await svc.editTimeline({ project_id: 'promo', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 0, duration_ms: 1000 }] });
// A variant approved for mass render, then changed by the editor.
const variant = (await svc.createVariants({ master_id: 'promo', briefs: [{ label: 'Varian Kotak', hook: 'Hook B' }], actor: 'user' })).result[0];
const vp0 = await core.readProject(ws, variant.project_id);
await svc.setVariantApproval({ project_id: variant.project_id, expected_revision: vp0.revision, approved: true, actor: 'user' });
const vp1 = await core.readProject(ws, variant.project_id);
await svc.editTimeline({ project_id: variant.project_id, expected_revision: vp1.revision, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media, start_ms: 1000, duration_ms: 500 }] });

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByText('Promo Kirim', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Promo Kirim' }).waitFor();
  const kirim = page.getByRole('button', { name: 'Kirim ke PIC' });
  await kirim.click();
  const rendering = await until(async () => /Merender|Mengirim/.test(await kirim.innerText()), 5000);
  const sent = await until(async () => (await kirim.innerText()).includes('Terkirim ke PIC'), 90000);
  check('R19-01 "Kirim ke PIC": tombol menampilkan status (Merender… → Terkirim ke PIC ✓)', rendering && sent, await kirim.innerText());
  await kirim.click();
  const dup = page.getByRole('status', { name: 'Pesan kirim ke PIC' });
  check('R19-02 Klik lagi tanpa perubahan → "Sudah dikirim, tidak ada perubahan" (tidak render dobel)', await until(async () => (await dup.innerText()).includes('Sudah dikirim, tidak ada perubahan')), (await core.listOutputs(ws, 'promo')).length + ' output');

  // In 3. Setujui as "Revisi 1".
  await nav.getByRole('button', { name: /Setujui/ }).click();
  const queue = page.getByRole('heading', { name: /Setujui|Persetujuan/ }).first();
  await queue.waitFor();
  const inQueue = await until(async () => (await page.locator('main, .page').first().innerText()).includes('Promo Kirim') && (await page.getByText('Revisi 1', { exact: true }).count()) > 0);
  check('R19-03 Video masuk antrean 3. Setujui dengan tanda "Revisi 1"', inQueue);
  await page.screenshot({ path: path.join(EVID, 'antrean-pic.png') });

  // The changed variant: old approval withdrawn, sent for review anyway.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByText(variant.name, { exact: true }).first().click();
  await page.getByRole('heading', { name: variant.name }).waitFor();
  await page.getByRole('button', { name: 'Kirim ke PIC' }).click();
  const vSent = await until(async () => (await page.getByRole('button', { name: 'Kirim ke PIC' }).innerText()).includes('Terkirim ke PIC'), 90000);
  const vp = await core.readProject(ws, variant.project_id);
  const q = await core.approvalQueue(ws);
  check('R19-04 Varian yang diubah setelah disetujui: persetujuan lama batal, tetap dikirim ke PIC untuk ditinjau', vSent && vp.variant.approved_revision === null && q.some((x) => x.project_id === variant.project_id && x.kiriman === 1), `approved_revision=${vp.variant.approved_revision}`);

  // After a manual render: the next steps.
  await page.getByText('Promo Kirim', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Promo Kirim' }).waitFor();
  await page.getByRole('button', { name: /Render/ }).first().click();
  await page.getByRole('button', { name: /Mulai render/ }).click();
  const next = page.getByRole('group', { name: 'Langkah berikutnya' });
  const shown = await until(() => next.isVisible(), 90000);
  check('R19-05 Setelah render manual selesai: "Lanjut ke 3. Setujui →" dan "Lihat di 4. Hasil →"', shown && (await next.getByRole('link', { name: /Lanjut ke 3\. Setujui/ }).isVisible()) && (await next.getByRole('link', { name: /Lihat di 4\. Hasil/ }).isVisible()));
  await next.getByRole('link', { name: /Lanjut ke 3\. Setujui/ }).click();
  check('R19-06 "Lanjut ke 3. Setujui" membuka menu 3. Setujui', await until(async () => (await page.evaluate(() => location.hash)) === '#/setujui'));
  check('R19-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R19-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R19 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
