// R36 (owner): Brand → C "Dipelajari dari koreksi editor" — daftar dari kamusBelajar (label
// "otomatis dipakai" / "usulan"), "Tambah ke kamus" dan "Abaikan" (kamus_abaikan, dihormati job
// berikutnya); berlaku setelah Simpan Brand Kit (real Chrome).
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
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r36-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const kit = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' })).result;
const kor = (sebelum, sesudah, at = 1) => JSON.stringify({ jenis: 'koreksi', bagian: 'kata', track: 'subtitle', op: 'set_text', sebelum, sesudah, at });
await fsp.mkdir(path.dirname(core.learnFile(ws, kit.brand_id)), { recursive: true });
await fsp.writeFile(core.learnFile(ws, kit.brand_id), [kor('mau punya cana', 'mau punya celana'), kor('Icy Love Factory.', 'Aysilla Factory.'), kor('Janganlah sekarang yuk', 'Join Live sekarang yuk')].join('\n') + '\n');
const kitNow = async () => (await new core.StorageService(await core.openWorkspace(wsRoot)).listBrands())[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  const box = form.getByRole('group', { name: 'Dipelajari dari koreksi editor' });
  const row = (w) => box.getByRole('group', { name: `Belajar ${w}` });
  await row('cana').waitFor();
  check('R36-01 Brand bagian C: daftar koreksi editor (cana, icy love, janganlah)', (await box.getByRole('group', { name: /^Belajar / }).count()) === 3);
  check(
    'R36-02 Label: "otomatis dipakai" untuk pasangan aman (cana→celana, icy love→Aysilla), "usulan" untuk janganlah→Join Live',
    (await row('cana').getByText('otomatis dipakai').isVisible()) && (await row('icy love').getByText('otomatis dipakai').isVisible()) && (await row('janganlah').getByText('usulan').isVisible()),
  );
  await page.screenshot({ path: path.join(EVID, 'kamus-belajar.png') });
  const nKamus = await form.getByLabel(/^Kamus salah /).count();
  await row('janganlah').getByRole('button', { name: 'Tambah janganlah ke kamus' }).click();
  check(
    'R36-03 "Tambah ke kamus" → pasangan masuk Kamus (bisa diedit) dan hilang dari daftar belajar',
    (await form.getByLabel(/^Kamus salah /).count()) === nKamus + 1 && (await form.getByLabel(`Kamus salah ${nKamus + 1}`).inputValue()) === 'janganlah' && (await form.getByLabel(`Kamus benar ${nKamus + 1}`).inputValue()) === 'Join Live' && (await row('janganlah').count()) === 0,
  );
  await row('cana').getByRole('button', { name: 'Abaikan cana' }).click();
  check('R36-04 "Abaikan" → hilang dari daftar, muncul di "Diabaikan" (bisa dibatalkan)', (await row('cana').count()) === 0 && (await box.getByRole('button', { name: 'Batal abaikan cana' }).isVisible()));
  await box.getByRole('button', { name: 'Batal abaikan cana' }).click();
  check('R36-05 "Batal abaikan" → cana kembali di daftar', await row('cana').isVisible());
  await row('cana').getByRole('button', { name: 'Abaikan cana' }).click();
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await until(() => form.getByText(/Tersimpan \(revisi/).isVisible());
  const k = await kitNow();
  check('R36-06 Simpan → Brand Kit: kamus janganlah→Join Live, kamus_abaikan [cana]', k.kamus.some((x) => x.salah === 'janganlah' && x.benar === 'Join Live') && k.kamus_abaikan.join() === 'cana', JSON.stringify({ kamus: k.kamus, abaikan: k.kamus_abaikan }));
  const api = await (await fetch(`http://127.0.0.1:${server.port}/api/brands/${kit.brand_id}/kamus-belajar`, { headers: { authorization: `Bearer ${server.app.token}`, 'x-motion-request': '1' } })).json();
  check('R36-07 GET /api/brands/:id/kamus-belajar sesudah simpan: hanya icy love, abaikan [cana]', api.pasangan?.map((p) => p.salah).join() === 'icy love' && api.abaikan?.join() === 'cana', JSON.stringify(api).slice(0, 200));
  await page.reload();
  await page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Brand/ }).click();
  await row('icy love').waitFor();
  check('R36-08 Setelah muat ulang: daftar tetap 1 (icy love) + "Diabaikan: cana"', (await box.getByRole('group', { name: /^Belajar / }).count()) === 1 && (await box.getByRole('button', { name: 'Batal abaikan cana' }).isVisible()));
  check('R36-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R36-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R36 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
