// X09 acceptance run: ad variants — briefs (ratio/hook/CTA) → one project each → approve one by one →
// render only the approved ones → files per variant; master untouched (real Chrome + FFmpeg).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x09-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const imp = await svc.importMedia({ sourcePath: path.join(FIX, 'sample_8s_9x16.mp4'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'master', name: 'Promo Master' });
await svc.editTimeline({
  project_id: 'master',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 2000 },
    { op: 'add_clip', track_kind: 'text', text: 'Hook master', start_ms: 0, duration_ms: 1000 },
    { op: 'add_clip', track_kind: 'text', text: 'CTA master', start_ms: 1000, duration_ms: 1000 },
  ],
});
const open = async () => core.openWorkspace(wsRoot);
const masterBefore = JSON.stringify((await core.readProject(await open(), 'master')).timeline);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Promo Master' }).waitFor();

  await page.getByRole('button', { name: '◫ Varian' }).click();
  const dlg = page.getByRole('dialog', { name: 'Varian iklan' });
  await dlg.waitFor();
  await dlg.getByLabel('Rasio varian 1').selectOption('1:1');
  await dlg.getByLabel('Nama varian 1').fill('Feed IG');
  await dlg.getByLabel('Hook varian 2').fill('Stop scroll dulu!');
  await dlg.getByLabel('CTA varian 2').fill('Join live jam 7');
  await dlg.getByRole('button', { name: '＋ Brief' }).click();
  await dlg.getByLabel('Rasio varian 3').selectOption('16:9');
  await dlg.getByRole('button', { name: 'Buat 3 varian' }).click();
  const list = dlg.getByRole('region', { name: 'Daftar varian' });
  await list.locator('.variantRow').nth(2).waitFor();
  const rows = await list.locator('.variantRow').allInnerTexts();
  check('X9-01 3 varian dibuat (V1–V3) dengan rasio/hook/CTA sesuai brief, status belum disetujui', rows.length === 3 && /V1[\s\S]*Feed IG[\s\S]*1:1[\s\S]*Belum disetujui/.test(rows[0]) && /V2[\s\S]*Hook “Stop scroll dulu!”[\s\S]*CTA “Join live jam 7”/.test(rows[1]) && /16:9/.test(rows[2]), rows.map((r) => r.replace(/\s+/g, ' ')).join(' | '));
  const ids = await core.listProjectIds(await open());
  check('X9-02 Tiap varian = proyek sendiri; master tidak berubah', ids.length === 4 && JSON.stringify((await core.readProject(await open(), 'master')).timeline) === masterBefore);
  const variants = (await Promise.all(ids.filter((i) => i !== 'master').map(async (i) => core.readProject(await open(), i)))).sort((a, b) => a.variant.number - b.variant.number);
  check('X9-03 V2: hook & CTA master diganti teks brief', JSON.stringify(variants[1].timeline.tracks.find((t) => t.kind === 'text').clips.map((c) => c.text)) === JSON.stringify(['Stop scroll dulu!', 'Join live jam 7']));
  check('X9-04 Tombol render mati sebelum ada yang disetujui', await dlg.getByRole('button', { name: /Render yang disetujui \(0\)/ }).isDisabled());

  await list.getByRole('button', { name: 'Setujui V1' }).click();
  await list.getByRole('button', { name: 'Batalkan persetujuan V1' }).waitFor();
  await list.getByRole('button', { name: 'Setujui V2' }).click();
  await list.getByRole('button', { name: 'Batalkan persetujuan V2' }).waitFor();
  check('X9-05 Setujui V1 & V2 satu per satu', /Disetujui/.test(await list.locator('.variantRow').nth(0).innerText()) && /Disetujui/.test(await list.locator('.variantRow').nth(1).innerText()));

  // Edit V2 after approval → it drops out of the render set.
  await list.getByRole('button', { name: 'Buka V2' }).click();
  await page.getByRole('heading', { name: /Promo Master · Hook/ }).waitFor();
  const banner = page.getByRole('status', { name: 'Status varian' });
  check('X9-06 Editor varian: banner "Varian V2 … disetujui" + tautan ke master', /Varian V2[\s\S]*disetujui/.test(await banner.innerText()) && (await page.getByRole('button', { name: '◫ Varian' }).count()) === 0);
  await page.getByLabel('Rasio canvas').selectOption('3:4');
  await banner.getByText(/diubah setelah disetujui/).waitFor();
  check('X9-07 Diedit setelah disetujui → "perlu disetujui ulang"', true);
  await banner.getByRole('button', { name: 'Buka master' }).click();
  await page.getByRole('heading', { name: 'Promo Master' }).waitFor();
  const side = page.getByRole('complementary', { name: 'Proyek' });
  await side.getByText(/V1 ✓ ·/).waitFor({ timeout: 5000 }).catch(() => undefined);
  const sideTexts = (await side.locator('button.project small').allInnerTexts()).join(' | ');
  check('X9-08 Daftar proyek menandai varian (V1 ✓, V2, V3)', /V1 ✓ ·/.test(sideTexts) && /(^| )V2 ·/.test(sideTexts) && /(^| )V3 ·/.test(sideTexts), sideTexts);

  await page.getByRole('button', { name: '◫ Varian' }).click();
  await dlg.getByLabel('Resolusi render varian').selectOption('720');
  await dlg.getByRole('button', { name: /Render yang disetujui \(1\)/ }).click();
  await dlg.getByRole('status').filter({ hasText: 'Dilewati' }).waitFor();
  const skippedText = await dlg.getByRole('status').filter({ hasText: 'Dilewati' }).innerText();
  check('X9-09 Hanya yang disetujui & belum diubah dirender; sisanya dijelaskan', /diubah setelah disetujui/.test(skippedText) && /belum disetujui/.test(skippedText), skippedText);
  await list.locator('.variantRow').nth(0).getByText(/Selesai/).waitFor({ timeout: 90_000 });
  const outDir = path.join(wsRoot, 'PROJECTS', variants[0].project_id, '05_OUTPUT');
  const files = await fsp.readdir(outDir);
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', path.join(outDir, files[0])], { encoding: 'utf8', windowsHide: true }));
  const v = probe.streams.find((x) => x.codec_type === 'video');
  check('X9-10 V1 dirender ke folder output-nya sendiri: 720×720 (1:1)', files.length === 1 && v.width === 720 && v.height === 720, `${files.join(',')} ${v.width}×${v.height}`);
  check('X9-11 V2/V3 tidak punya output; master tidak dirender', !(await fsp.readdir(path.join(wsRoot, 'PROJECTS', variants[1].project_id, '05_OUTPUT'))).length && !(await fsp.readdir(path.join(wsRoot, 'PROJECTS', 'master', '05_OUTPUT'))).length);
  await dlg.screenshot({ path: path.join(EVID, 'variants.png') });
  await dlg.getByRole('button', { name: 'Tutup' }).click();

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  // The phone opens the most recently changed project (a variant): switch to the master first.
  await phone.getByText('Ganti proyek').click();
  await phone.locator('button.project b').getByText('Promo Master', { exact: true }).click();
  await phone.getByRole('heading', { name: 'Promo Master', exact: true }).waitFor();
  await phone.getByRole('button', { name: '◫ Varian' }).click();
  await phone.getByRole('region', { name: 'Daftar varian' }).locator('.variantRow').nth(2).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X9-12 HP 390px: dialog varian tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: path.join(EVID, 'variants-phone.png') });
  check('X9-13 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X9-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX09 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
