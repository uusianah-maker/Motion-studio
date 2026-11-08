// W09 acceptance run: Google login from the real UI (built server + UI, real Chrome) against a
// stand-in Google (scripts/fake-google.mjs) on another site (localhost vs 127.0.0.1), so the
// cross-site redirect + cookie rules are exercised as with the real Google.
// Evidence → audit/W09/evidence/.
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w09-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
await core.createProject(await core.openWorkspace(wsRoot), { project_id: 'promo', name: 'Promo Lebaran' });
const stateDir = path.join(work, 'state');
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
    MOTION_STATE_DIR: stateDir,
    MOTION_GOOGLE_CLIENT_ID: CLIENT_ID,
    MOTION_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    MOTION_ALLOWED_EMAILS: 'owner@example.com',
    MOTION_GOOGLE_AUTH_ENDPOINT: g.authUrl,
    MOTION_GOOGLE_TOKEN_ENDPOINT: g.tokenUrl,
  },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(String(e)));
  // 401 on /api/session before login is expected; anything else is an error.
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && errors.push(m.text()));
};
const loginButton = (p) => p.getByRole('link', { name: /Masuk dengan Google/ });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${base}/`);
  await loginButton(page).waitFor();
  const noEntry = await page.evaluate(async () => (await fetch('/api/session', { headers: { 'x-motion-request': '1' } })).status);
  await page.screenshot({ path: path.join(EVID, 'login.png') });
  check('LG-01 Tanpa login: halaman masuk Google, API menolak (401)', (await loginButton(page).isVisible()) && noEntry === 401, `session ${noEntry}`);

  await loginButton(page).click();
  await page.getByRole('button', { name: /Promo Lebaran/ }).first().waitFor({ timeout: 15_000 });
  const href = page.url();
  const sawGoogle = g.state.authRequests.length === 1 && g.state.tokenRequests.length === 1;
  check('LG-02 Klik → Google → kembali ke app; alamat bersih (tanpa code/state)', sawGoogle && href === `${base}/`, href);

  const cookies = await ctx.cookies(base);
  const sid = cookies.find((c) => c.name === 'motion_sid');
  const jsSees = await page.evaluate(() => document.cookie);
  const stores = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  check('LG-03 Sesi = cookie HttpOnly + SameSite=Strict; JS & storage tidak melihat token apa pun', sid?.httpOnly && sid.sameSite === 'Strict' && !jsSees.includes('motion_sid') && !/fake-refresh|ya29|motion_sid/.test(stores), `cookie JS: "${jsSees}"`);

  await page.screenshot({ path: path.join(EVID, 'signed-in.png') });
  const account = page.getByRole('button', { name: 'Keluar (owner@example.com)' });
  check('LG-04 Akun tampil di rail (owner@example.com) + tidak ada peringatan Drive', (await account.isVisible()) && !(await page.getByText(/Izin Google Drive belum diberikan/).isVisible()));

  const apiOk = await page.evaluate(async () => {
    const h = { 'x-motion-request': '1', 'content-type': 'application/json' };
    const made = await fetch('/api/projects', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Dari UI W09' }) });
    const noHeader = await fetch('/api/projects');
    return [made.status, noHeader.status];
  });
  check('LG-05 API jalan dengan sesi; tanpa header app ditolak', apiOk[0] === 200 && apiOk[1] === 401, apiOk.join('/'));

  // A page on another site tries to use the session (CSRF): blocked.
  const before = (await core.listProjectIds(await core.openWorkspace(wsRoot))).length;
  const evil = await ctx.newPage();
  await evil.goto(`http://localhost:${g.port}/other-site`);
  const forged = await evil.evaluate(async (target) => {
    const out = [];
    for (const init of [
      { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body: '{"name":"PALSU"}' },
      { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-motion-request': '1' }, body: '{"name":"PALSU"}' },
    ]) {
      try {
        const r = await fetch(`${target}/api/projects`, init);
        out.push(r.type === 'opaque' ? 'opaque' : r.status);
      } catch {
        out.push('blocked');
      }
    }
    return out;
  }, base);
  await evil.close();
  const after = (await core.listProjectIds(await core.openWorkspace(wsRoot))).length;
  check('LG-06 Situs lain tidak bisa memakai sesi (CSRF): tidak ada proyek dibuat', after === before, `percobaan: ${forged.join(', ')}; proyek ${before}→${after}`);

  await page.reload();
  await page.getByRole('button', { name: /Promo Lebaran/ }).first().waitFor();
  check('LG-07 Reload: tetap masuk (tanpa login ulang)', g.state.authRequests.length === 1);

  await account.click();
  await page.getByText('Anda sudah keluar.').waitFor();
  const afterOut = await page.evaluate(async () => (await fetch('/api/session', { headers: { 'x-motion-request': '1' } })).status);
  const sidGone = !(await ctx.cookies(base)).some((c) => c.name === 'motion_sid');
  check('LG-08 Keluar: kembali ke halaman masuk, sesi mati, cookie dihapus', afterOut === 401 && sidGone && (await loginButton(page).isVisible()));

  // Not on the allowlist.
  g.state.user = { sub: '2002', email: 'orang.lain@example.com', email_verified: true, name: 'Orang Lain' };
  await loginButton(page).click();
  await page.getByText(/tidak ada di daftar email yang diizinkan/).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(EVID, 'denied.png') });
  const deniedUrl = page.url();
  const deniedSid = (await ctx.cookies(base)).some((c) => c.name === 'motion_sid');
  check('LG-09 Email di luar daftar: ditolak dengan pesan jelas, tanpa sesi; kode error dihapus dari alamat', !deniedSid && deniedUrl === `${base}/`, deniedUrl);

  // Cancel on Google's page.
  g.state.user = { sub: '1001', email: 'owner@example.com', email_verified: true, name: 'Owner' };
  g.state.deny = true;
  await loginButton(page).click();
  await page.getByText('Login dibatalkan di halaman Google.').waitFor({ timeout: 15_000 });
  check('LG-10 Batal di Google: pesan "Login dibatalkan"', true);
  g.state.deny = false;

  // Drive permission unticked on the consent page.
  g.state.grantDrive = false;
  await loginButton(page).click();
  await page.getByText(/Izin Google Drive belum diberikan/).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(EVID, 'no-drive.png') });
  check('LG-11 Izin Drive tidak dicentang: tetap masuk + peringatan jelas', await page.getByRole('button', { name: 'Keluar (owner@example.com)' }).isVisible());
  g.state.grantDrive = true;

  // Secrets at rest.
  const files = await fsp.readdir(stateDir);
  const blob = (await Promise.all(files.map((f) => fsp.readFile(path.join(stateDir, f), 'utf8')))).join('\n');
  const auditRaw = JSON.stringify(await core.readAudit(await core.openWorkspace(wsRoot)));
  check(
    'LG-12 Refresh token tersimpan terenkripsi; tidak ada token di audit log',
    files.includes('google-tokens.json') && blob.includes('"refresh": "v1.') && !blob.includes('fake-refresh') && !/fake-refresh|ya29/.test(auditRaw) && auditRaw.includes('auth.login'),
    `file state: ${files.join(', ')}`,
  );

  // Phone.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  watch(phone);
  await phone.goto(`${base}/`);
  await loginButton(phone).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'login-phone.png') });
  check('LG-13 HP 390px: halaman masuk muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);

  check('LG-14 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('LG-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
  await g.close();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW09 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
