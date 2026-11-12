// U7 acceptance run: roles Owner / Editor / Reviewer with Google login (stand-in Google, real
// server + UI, real Chrome), comments at a timecode, review Lulus / Revisi. Evidence → audit/U7/evidence/.
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startFakeGoogle } from '../../scripts/fake-google.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u7-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'promo', name: 'Promo Lebaran' });
await svc.editTimeline({ project_id: 'promo', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'text', text: 'Diskon besar', start_ms: 0, duration_ms: 3000 }] });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
const CLIENT_ID = 'ui-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-ui-test';
const g = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = await start(
  {
    MOTION_WORKSPACE: wsRoot,
    MOTION_PORT: String(port),
    MOTION_GC: 'off',
    MOTION_UPLOAD_TMP: work,
    MOTION_RENDER_TMP: work,
    MOTION_STATE_DIR: path.join(work, 'state'),
    MOTION_GOOGLE_CLIENT_ID: CLIENT_ID,
    MOTION_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    MOTION_ALLOWED_EMAILS: 'owner@example.com, editor@example.com, reviewer@example.com',
    MOTION_OWNER_EMAILS: 'owner@example.com',
    MOTION_EDITOR_EMAILS: 'editor@example.com',
    MOTION_REVIEWER_EMAILS: 'reviewer@example.com',
    MOTION_GOOGLE_AUTH_ENDPOINT: g.authUrl,
    MOTION_GOOGLE_TOKEN_ENDPOINT: g.tokenUrl,
  },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const login = async (sub, email, name) => {
  g.state.user = { sub, email, email_verified: true, name };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403)/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/`);
  await page.getByRole('link', { name: /Masuk dengan Google/ }).click();
  await page.getByRole('button', { name: /Promo Lebaran/ }).first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /Promo Lebaran/ }).first().click();
  await page.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  return page;
};
const apiStatus = (page, p, body) =>
  page.evaluate(
    async ([p, body]) => (await fetch(p, { method: 'POST', headers: { 'x-motion-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status,
    [p, body],
  );
const review = () => core.readReview(ws, 'promo');

try {
  // ---- Reviewer: read-only editor, comments, cannot pass while a comment is open.
  const rev = await login('3003', 'reviewer@example.com', 'Rina Reviewer');
  const nav = rev.getByRole('navigation', { name: 'Navigasi utama' });
  check('U7-01 Reviewer: menu AI (khusus Owner) tidak tampil', (await nav.getByRole('button', { name: /AI/ }).count()) === 0);
  check('U7-02 Reviewer: linimasa hanya-baca (tombol edit mati, Copilot tidak ada)', (await rev.getByRole('button', { name: '＋ Teks' }).isDisabled().catch(() => true)) && (await rev.locator('button[title="Tambah teks di playhead"]').isDisabled()) && (await rev.getByRole('region', { name: 'Copilot' }).count()) === 0);
  check('U7-03 Server menolak edit dari Reviewer (403), bukan cuma UI', (await apiStatus(rev, '/api/projects/promo/edit', { expected_revision: 1, ops: [{ op: 'set_canvas', ratio: '1:1' }] })) === 403);
  const panel = rev.getByRole('region', { name: 'Review' });
  await panel.getByLabel('Komentar di playhead').fill('Diskonnya sebut angka ya');
  await panel.getByRole('button', { name: 'Kirim' }).click();
  check('U7-04 Komentar di timecode tersimpan dengan nama penulis', await until(async () => (await review()).comments[0]?.author.name === 'Rina Reviewer'));
  check('U7-05 "Lulus" mati selama ada komentar terbuka', await panel.getByRole('button', { name: /Lulus/ }).isDisabled());
  await panel.getByLabel('Catatan revisi').fill('Tambah angka diskon di detik 0');
  await panel.getByRole('button', { name: /Revisi/ }).click();
  check('U7-06 Reviewer memberi "Perlu revisi" + catatan', await until(async () => (await review()).state === 'revisi') && (await until(() => panel.getByText('Perlu revisi').first().isVisible())));
  await rev.screenshot({ path: path.join(EVID, 'reviewer.png') });

  // ---- Editor: edits + resolves, cannot approve, Brand Kit read-only.
  const ed = await login('2002', 'editor@example.com', 'Edi Editor');
  const before = (await core.readProject(ws, 'promo')).revision;
  await ed.locator('.track .clip.text').first().click();
  await ed.getByLabel('Isi teks di inspector').fill('Diskon 50%');
  await ed.getByLabel('Isi teks di inspector').press('Enter');
  check('U7-07 Editor bisa mengedit', await until(async () => (await core.readProject(ws, 'promo')).revision > before));
  const epanel = ed.getByRole('region', { name: 'Review' });
  await epanel.getByRole('checkbox', { name: /Selesai: Diskonnya/ }).click();
  check('U7-08 Editor menandai komentar selesai', await until(async () => !!(await review()).comments[0]?.resolved_at));
  check('U7-09 Editor tidak melihat tombol Lulus/Revisi; server menolak (403)', (await epanel.getByRole('button', { name: /Lulus/ }).count()) === 0 && (await apiStatus(ed, '/api/projects/promo/review', { expected_revision: (await core.readProject(ws, 'promo')).revision, status: 'lulus' })) === 403);
  await ed.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Brand/ }).click();
  await ed.getByText('Hanya Owner yang bisa mengubah Brand Kit').waitFor();
  check('U7-10 Editor: Brand Kit hanya-baca (isian mati) dan server menolak simpan (403)', (await ed.getByLabel('Nama brand').isDisabled()) && (await apiStatus(ed, '/api/brands', { kit: { name: 'Lain' } })) === 403);

  // ---- Reviewer passes the new revision; owner sees it; an edit makes it "changed".
  await rev.reload();
  await rev.getByRole('button', { name: /Promo Lebaran/ }).first().click();
  const panel2 = rev.getByRole('region', { name: 'Review' });
  await panel2.getByRole('button', { name: /Lulus/ }).click();
  check('U7-11 Reviewer memberi Lulus pada revisi terbaru', await until(async () => (await review()).state === 'lulus'));
  const own = await login('1001', 'owner@example.com', 'Owner');
  check('U7-12 Owner melihat status Lulus + menu AI', (await until(() => own.getByRole('region', { name: 'Review' }).getByText('Lulus', { exact: true }).isVisible())) && (await own.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /AI/ }).isVisible()));
  await own.getByRole('region', { name: 'Review' }).getByLabel('Komentar di playhead').fill('Oke, siap tayang');
  await own.getByRole('region', { name: 'Review' }).getByRole('button', { name: 'Kirim' }).click();
  await until(async () => (await review()).comments.length === 2);
  const p = await core.readProject(ws, 'promo');
  await svc.editTimeline({ project_id: 'promo', expected_revision: p.revision, actor: 'user', ops: [{ op: 'set_canvas', ratio: '1:1' }] });
  check('U7-13 Edit setelah Lulus → "Diubah setelah Lulus"', (await review()).state === 'berubah');
  await own.screenshot({ path: path.join(EVID, 'owner.png') });
  check('U7-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('U7-XX run selesai tanpa exception', false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await g.close();
}
const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nU7 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
