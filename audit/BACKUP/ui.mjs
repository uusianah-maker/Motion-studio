// "Verifikasi backup" acceptance run: in Storage the owner registers a backup folder (another drive)
// and verifies it read-only; the page shows how many media versions are proven to be in the backup.
import { promises as fsp } from 'node:fs';
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-backup-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const a = path.join(work, 'footage-a.mp4');
const b = path.join(work, 'footage-b.mp4');
await fsp.writeFile(a, Buffer.alloc(4000, 1));
await fsp.writeFile(b, Buffer.alloc(6000, 2));
for (const f of [a, b]) await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
const backup = path.join(work, 'Backup-Footage');
await fsp.mkdir(backup);
await fsp.copyFile(a, path.join(backup, 'footage-a.mp4')); // only A is backed up

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Storage/ }).click();
  const card = page.getByRole('region', { name: 'Backup footage' });
  await card.waitFor();
  check('R-BACKUP-01 Storage punya kartu "Backup footage" (kosong di awal)', (await card.innerText()).includes('Belum ada folder backup'));

  await card.getByLabel('Path folder backup').fill(backup);
  await card.getByRole('button', { name: /Daftarkan folder backup/ }).click();
  const row = card.getByRole('table', { name: 'Folder backup' }).locator('tbody tr');
  check('R-BACKUP-02 Daftarkan folder → muncul di daftar (belum pernah diverifikasi)', await until(async () => (await row.count()) === 1 && (await row.innerText()).includes('belum pernah')));

  await card.getByRole('button', { name: 'Verifikasi backup Backup-Footage' }).click();
  const st = card.getByRole('status', { name: 'Status verifikasi backup' });
  const done = await until(async () => (await st.innerText()).includes('selesai'), 20000);
  const txt = done ? await st.innerText() : '';
  check('R-BACKUP-03 Verifikasi → selesai: 1 versi terbukti (hanya file yang benar-benar ada di backup)', done && txt.includes('1 versi media terbukti') && (await row.innerText()).includes('1 versi'), txt);
  const stat = page.locator('.stat').filter({ hasText: 'Backup terverifikasi' });
  check('R-BACKUP-04 Angka "Backup terverifikasi" di atas ikut naik (1/2)', await until(async () => (await stat.innerText()).includes('1/2')), await stat.innerText());
  check('R-BACKUP-05 Folder backup tidak diubah (read-only)', (await fsp.readdir(backup)).join(',') === 'footage-a.mp4');
  await page.screenshot({ path: path.join(EVID, 'backup.png'), fullPage: true });
  check('R-BACKUP-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R-BACKUP-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`BACKUP UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
