// Hapus proyek (keluhan tim 24 Nov): delete from the project list → Trash → restore (real Chrome).
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-hapus-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
for (const [id, name] of [['a', 'Proyek A'], ['b', 'Proyek B'], ['c', 'Proyek C'], ['d', 'Proyek D']]) await core.createProject(ws, { project_id: id, name });
const read = async (id) => core.readProject(await core.openWorkspace(wsRoot), id);

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const side = page.getByRole('complementary', { name: 'Proyek' });
  await side.getByText('Proyek A').waitFor();

  // Several at once from the list.
  await side.getByRole('button', { name: /Pilih proyek untuk dihapus/ }).click();
  await side.getByRole('checkbox', { name: /Proyek B/ }).click();
  await side.getByRole('checkbox', { name: /Proyek C/ }).click();
  await page.screenshot({ path: path.join(EVID, 'pilih-hapus.png') });
  await side.getByRole('button', { name: 'Hapus (2)' }).click();
  await side.getByText('Proyek B').waitFor({ state: 'detached' });
  const names = await side.locator('.project b').allTextContents();
  check('H-01 Pilih 2 proyek → Hapus: hilang dari daftar, sisanya tetap', !names.includes('Proyek B') && !names.includes('Proyek C') && names.includes('Proyek A') && names.includes('Proyek D'), names.join(', '));
  check('H-02 Di disk: pindah ke Trash (hanya-baca), bukan dihapus', !!(await read('b')).dihapus && (await read('c')).status === 'archived');
  check('H-03 Hitungan daftar ikut turun', (await side.locator('.sideTitle .muted').textContent()) === '2');

  // From the open project's menu.
  await side.getByText('Proyek D').click();
  await page.getByRole('heading', { name: 'Proyek D' }).waitFor();
  await page.locator('summary[aria-label="Kelola proyek"]').click();
  await page.getByRole('group', { name: 'Kelola proyek' }).getByRole('button', { name: /Hapus proyek/ }).click();
  await side.getByText('Proyek D').waitFor({ state: 'detached' });
  check('H-04 Hapus dari menu ⋯ Proyek: hilang dari daftar, editor pindah ke proyek lain', !(await side.locator('.project b').allTextContents()).includes('Proyek D') && !!(await read('d')).dihapus);

  // Trash → restore.
  await page.getByRole('button', { name: 'Trash' }).click();
  const box = page.getByRole('region', { name: 'Proyek terhapus' });
  await box.waitFor();
  check('H-05 Trash menampilkan 3 proyek terhapus', (await box.locator('tbody tr').count()) === 3);
  await page.screenshot({ path: path.join(EVID, 'trash-proyek.png') });
  await box.locator('tr', { hasText: 'Proyek B' }).getByRole('button', { name: /Pulihkan/ }).click();
  await page.getByText('Proyek “Proyek B” dipulihkan').waitFor();
  check('H-06 Pulihkan → kembali aktif di disk dan hilang dari Trash', (await read('b')).status === 'active' && !(await read('b')).dihapus && (await box.locator('tbody tr').count()) === 2);
  await page.getByRole('button', { name: '2. Edit' }).click();
  await side.getByText('Proyek B').waitFor();
  check('H-07 Proyek yang dipulihkan muncul lagi di daftar Edit', true);
  check('H-08 Tanpa error di konsol', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
