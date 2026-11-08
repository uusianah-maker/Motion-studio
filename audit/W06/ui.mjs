// W06 acceptance run: timeline editing in real Chrome against the BUILT server + UI.
// Checks every edit against the authoritative project on disk. Evidence → audit/W06/evidence/.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w06-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'lucy', name: 'Lucy — Elegant Look' });
for (const tag of ['Hook', 'Produk']) {
  const p = path.join(work, `${tag}.mp4`);
  await fsp.writeFile(p, Buffer.concat([await fsp.readFile(path.join(FIX, 'sample_8s_9x16.mp4')), Buffer.from(`#${tag}`)]));
  await svc.importMedia({ sourcePath: p, scope: { kind: 'shared' }, display_name: `${tag}.mp4`, actor: 'user' });
}
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'lucy');
const video = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video')?.clips ?? [];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  // 409/422 responses from the overlap and conflict checks are expected; anything else counts.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Lucy — Elegant Look' }).waitFor();
  const saved = () => page.getByText('Tersimpan', { exact: true }).waitFor();
  const clip = (name, n = 0) => page.locator('.track').filter({ hasText: 'Video' }).locator('.clip', { hasText: name }).nth(n);

  // Add two clips.
  await page.getByRole('button', { name: 'Tambah Hook.mp4 ke linimasa' }).click();
  await clip('Hook.mp4').waitFor();
  await saved();
  await page.getByRole('button', { name: 'Tambah Produk.mp4 ke linimasa' }).click();
  await clip('Produk.mp4').waitFor();
  await saved();
  let v = await video();
  // Clip length = the real source duration since W07 (8 s fixture), or 5 s when ffprobe is unavailable.
  const LEN = v[0].end_ms - v[0].start_ms;
  check('ED-01 Tambah dua klip berurutan', v.length === 2 && v[0].start_ms === 0 && v[1].start_ms === LEN && (await proj()).revision === 2, JSON.stringify(v.map((c) => [c.start_ms, c.end_ms])));

  const surface = await page.locator('.trackSurface.ruler').boundingBox();
  const pxPerMs = surface.width / 30_000; // empty-ish project: visible duration 30 s → but last end 10 s + 5 s → 30 s
  const dragBy = async (locator, dx) => {
    const b = await locator.boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    await page.mouse.up();
  };

  // Move B right by 3 s.
  const bBefore = v[1].start_ms;
  await dragBy(clip('Produk.mp4'), 3000 * pxPerMs);
  await saved();
  v = await video();
  check('ED-02 Seret klip → geser (snap 100 ms)', Math.abs(v[1].start_ms - (bBefore + 3000)) <= 200 && v[1].end_ms - v[1].start_ms === LEN && v[1].start_ms % 100 === 0, `start=${v[1].start_ms}`);

  // Trim end of A by -1.5 s using its end handle.
  await dragBy(clip('Hook.mp4').locator('.handle.end'), -1500 * pxPerMs);
  await saved();
  v = await video();
  check('ED-03 Seret pinggir kanan → trim akhir', v[0].start_ms === 0 && Math.abs(v[0].end_ms - (LEN - 1500)) <= 200, `end=${v[0].end_ms}`);

  // Trim start of B by +1 s using its start handle: in-point moves too.
  const bStart = v[1].start_ms;
  await dragBy(clip('Produk.mp4').locator('.handle.start'), 1000 * pxPerMs);
  await saved();
  v = await video();
  check('ED-04 Seret pinggir kiri → trim awal + in-point sumber ikut', v[1].start_ms > bStart && v[1].in_ms === v[1].start_ms - bStart, `start=${v[1].start_ms} in=${v[1].in_ms}`);

  // Playhead into A, select A, S = split.
  const ruler = await page.locator('.trackSurface.ruler').boundingBox();
  await page.mouse.click(ruler.x + 1500 * pxPerMs, ruler.y + ruler.height / 2);
  await clip('Hook.mp4').click();
  await page.keyboard.press('s');
  await saved();
  v = await video();
  check('ED-05 Playhead + S → split', v.length === 3 && v[1].media.media_id === v[0].media.media_id && v[1].in_ms === v[1].start_ms, JSON.stringify(v.map((c) => [c.start_ms, c.end_ms, c.in_ms])));

  // Delete the right half, then undo / redo with the keyboard.
  await clip('Hook.mp4', 1).click();
  await page.keyboard.press('Delete');
  await saved();
  check('ED-06 Del → hapus klip', (await video()).length === 2);
  await page.keyboard.press('Control+z');
  await saved();
  check('ED-07 Ctrl+Z → undo', (await video()).length === 3);
  await page.keyboard.press('Control+Shift+z');
  await saved();
  check('ED-08 Ctrl+Shift+Z → redo', (await video()).length === 2);
  check('ED-09 Tombol Undo menunjukkan langkah terakhir', (await page.getByRole('button', { name: /Undo/ }).getAttribute('title')).includes('Hapus klip'));

  // Nudge with arrows.
  await clip('Produk.mp4').click();
  const before = (await video()).find((c) => c.media && c.end_ms > 6000).start_ms;
  await page.keyboard.press('ArrowRight');
  await saved();
  const after = (await video()).find((c) => c.media && c.end_ms > 6000).start_ms;
  check('ED-10 → geser 100 ms', after === before + 100, `${before}→${after}`);

  // Overlap is refused by the server and nothing changes.
  const revBefore = (await proj()).revision;
  await dragBy(clip('Produk.mp4'), -(after - 1000) * pxPerMs);
  await page.getByRole('alert').waitFor();
  check('ED-11 Tumpang tindih ditolak + pesan jelas', (await page.getByRole('alert').innerText()).includes('tumpang tindih') && (await proj()).revision === revBefore);

  // Someone else changes the project: next edit reloads instead of overwriting.
  const p = await proj();
  await svc.editTimeline({ project_id: 'lucy', expected_revision: p.revision, ops: [{ op: 'add_clip', track_kind: 'audio', media: p.timeline.tracks[0].clips[0].media, start_ms: 0, duration_ms: 2000 }], actor: 'user' });
  await clip('Produk.mp4').click();
  await page.keyboard.press('ArrowLeft');
  await page.getByText(/Proyek berubah di tempat lain/).waitFor();
  const afterConflict = await proj();
  check('ED-12b Sidebar ikut menampilkan revisi terbaru', await page.locator('.project.active').getByText(`Revisi ${afterConflict.revision}`).isVisible());
  check('ED-12 Revisi basi → muat ulang, tidak menimpa', afterConflict.revision === p.revision + 1 && (await page.locator('.track').filter({ hasText: 'Audio' }).locator('.clip').count()) === 1);
  await page.screenshot({ path: path.join(EVID, 'w06_editor_desktop.png') });

  // Undo history holds media for the GC (a deleted clip's media stays referenced).
  const reg = await core.loadRegistry(await core.openWorkspace(wsRoot));
  check('ED-13 Media pernah dipakai tercatat ever_referenced', Object.values(reg.versions).every((x) => x.ever_referenced));

  // Phone width.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  await p2.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await p2.getByRole('heading', { name: 'Lucy — Elegant Look' }).waitFor();
  check('ED-14 HP 390px tanpa scroll horizontal', await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p2.screenshot({ path: path.join(EVID, 'w06_editor_phone.png'), fullPage: true });

  check('ED-15 Tidak ada error JS di console', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('ED-RUN tanpa exception', false, String(e).slice(0, 500));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const summary = results.reduce((a, r) => ((a[r.ok ? 'PASS' : 'FAIL'] = (a[r.ok ? 'PASS' : 'FAIL'] ?? 0) + 1), a), {});
await fsp.writeFile(path.join(EVID, 'ui_results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
process.exit(summary.FAIL ? 1 : 0);
