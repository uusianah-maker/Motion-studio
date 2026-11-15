// R12a acceptance run: "AI gambar" settings on the AI page (owner). Real server + Chrome, random
// port. "Tes koneksi" goes to a local stand-in server — no real (paid) API is called.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

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
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
const SECRET = 'sk-uji-gambar-0000WXYZ';

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r12a-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
// Stand-in provider: answers the model list, remembers the key it got.
let seenKey = null;
const fake = http.createServer((req, res) => {
  seenKey = req.headers.authorization ?? null;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"data":[]}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

const stateDir = path.join(work, 'state');
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: stateDir, MOTION_AI_DEV_ENDPOINTS: '1' }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /AI/ }).click();
  const sec = page.getByRole('region', { name: 'AI gambar' });
  await sec.waitFor();
  await sec.getByLabel('Penyedia AI gambar').selectOption('lainnya');
  await sec.getByLabel('URL endpoint AI gambar').fill(fakeUrl);
  await sec.getByLabel('Model AI gambar').fill('model-gambar-uji');
  await sec.getByLabel('Batas biaya AI gambar').fill('250000');
  await sec.getByRole('button', { name: 'Simpan pengaturan' }).click();
  check('R12A-01 Penyedia, endpoint, model, batas biaya tersimpan', await until(() => sec.getByRole('status').filter({ hasText: 'disimpan' }).isVisible()));
  await sec.getByLabel('API key AI gambar', { exact: true }).fill(SECRET);
  await sec.getByRole('button', { name: 'Simpan key' }).click();
  const masked = await until(async () => (await sec.getByLabel('Status API key AI gambar').innerText()).includes('••••WXYZ'));
  const html = await page.content();
  check('R12A-02 Key tersimpan: hanya "tersimpan ••••WXYZ", key asli tidak ada di halaman', masked && !html.includes(SECRET) && (await sec.getByLabel('API key AI gambar', { exact: true }).count()) === 0);
  const onDisk = (await fsp.readdir(stateDir)).includes('ai-gambar.json') ? await fsp.readFile(path.join(stateDir, 'ai-gambar.json'), 'utf8') : '';
  check('R12A-03 Di disk server: tersegel (tidak ada key polos), di luar workspace', onDisk.includes('sealed_key') && !onDisk.includes(SECRET) && !(await fsp.readdir(wsRoot, { recursive: true })).some((f) => String(f).includes('ai-gambar')));
  await sec.getByRole('button', { name: 'Tes koneksi' }).click();
  check('R12A-04 Tes koneksi (server pengganti lokal): berhasil, key terkirim ke penyedia saja', await until(() => sec.getByText('Koneksi berhasil').isVisible()) && seenKey === `Bearer ${SECRET}`);
  await page.reload();
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /AI/ }).click();
  check('R12A-05 Setelah muat ulang: pengaturan tetap, key tetap tersembunyi', await until(async () => (await page.getByRole('region', { name: 'AI gambar' }).getByLabel('Model AI gambar').inputValue()) === 'model-gambar-uji' && (await page.getByLabel('Status API key AI gambar').innerText()).includes('••••WXYZ')));
  await page.screenshot({ path: path.join(EVID, 'ai-gambar.png') });
  check('R12A-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R12A-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  fake.close();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R12A UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
