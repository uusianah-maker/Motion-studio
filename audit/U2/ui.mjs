// U2 acceptance run: brand asset library — upload SFX/music/b-roll, tag, licence rules, product
// link, filter, saved + held by the brand, exported for the engine with duration/licence (real Chrome).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-u2-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const pop = gen('Pop Satu.wav', ['-f', 'lavfi', '-i', 'sine=f=900:d=0.3']);
const whoosh = gen('Whoosh.wav', ['-f', 'lavfi', '-i', 'anoisesrc=d=0.5']);
const song = gen('Musik Ceria.mp3', ['-f', 'lavfi', '-i', 'sine=f=300:d=2']);
const broll = gen('Detail Bahan.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=180x320:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
const open = async () => new core.StorageService(await core.openWorkspace(wsRoot));

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('button', { name: /Brand/ }).first().click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  await form.getByLabel('Nama brand').fill('Aysilla Factory');
  await form.getByLabel('Kode brand').fill('AYS');
  await form.getByRole('button', { name: '＋ Produk' }).click();
  await form.getByLabel('Produk 1', { exact: true }).fill('Loose Pants');
  await form.getByLabel('Varian produk 1').fill('Espresso, Black');
  const lib = form.getByRole('group', { name: 'Library aset brand' });

  // SFX: two files at once.
  await lib.getByLabel('Saring jenis aset').selectOption('sfx');
  await lib.getByLabel('File aset brand').setInputFiles([pop, whoosh]);
  await lib.getByRole('group', { name: 'Aset whoosh' }).waitFor();
  check('X-U2-01 Unggah 2 SFX sekaligus → 2 aset dengan id dari nama file', (await lib.getByRole('group', { name: /^Aset / }).count()) === 2 && (await lib.getByRole('group', { name: 'Aset pop-satu' }).count()) === 1);
  const popRow = lib.getByRole('group', { name: 'Aset pop-satu' });
  await popRow.getByRole('button', { name: 'Tambah tag teks-muncul ke pop-satu' }).click();
  await popRow.getByLabel(/Status lisensi/).selectOption('milik_sendiri');
  await popRow.getByLabel(/Boleh untuk iklan/).check();
  const wRow = lib.getByRole('group', { name: 'Aset whoosh' });
  await wRow.getByLabel(/Tag aset/).fill('transisi');
  await wRow.getByLabel(/Status lisensi/).selectOption('tanpa_lisensi');
  check('X-U2-02 Tanpa lisensi → centang "boleh untuk iklan" mati', await wRow.getByLabel(/Boleh untuk iklan/).isDisabled());

  // Music + b-roll.
  await lib.getByLabel('Saring jenis aset').selectOption('musik');
  await lib.getByLabel('File aset brand').setInputFiles(song);
  const mRow = lib.getByRole('group', { name: 'Aset musik-ceria' });
  await mRow.waitFor();
  await mRow.getByLabel(/Status lisensi/).selectOption('berlisensi');
  await mRow.getByLabel(/Boleh untuk iklan/).check();
  await mRow.getByLabel(/Mood/).fill('ceria');
  await mRow.getByLabel(/BPM/).fill('120');
  // Licensed music for ads without proof is refused on save.
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await page.getByText(/musik berlisensi untuk iklan wajib ada bukti lisensi/).waitFor();
  check('X-U2-03 Musik berlisensi untuk iklan tanpa bukti → ditolak saat simpan', true);
  await mRow.getByLabel(/Bukti lisensi/).fill('Epidemic Sound #123');
  await lib.getByLabel('Saring jenis aset').selectOption('broll');
  await lib.getByLabel('File aset brand').setInputFiles(broll);
  const bRow = lib.getByRole('group', { name: 'Aset detail-bahan' });
  await bRow.waitFor();
  await bRow.getByLabel(/Produk b-roll/).selectOption('Loose Pants');
  await bRow.getByLabel(/Varian b-roll/).selectOption('Espresso');
  await bRow.getByLabel(/Ada teks bawaan/).check();
  check('X-U2-04 Saring jenis "B-roll" hanya menampilkan b-roll', (await lib.getByRole('group', { name: /^Aset / }).count()) === 1);
  await lib.getByLabel('Saring jenis aset').selectOption('');
  await lib.getByLabel('Cari tag aset').fill('teks-muncul');
  check('X-U2-05 Cari tag "teks-muncul" → hanya SFX pop', (await lib.getByRole('group', { name: /^Aset / }).count()) === 1);
  await lib.getByLabel('Cari tag aset').fill('');
  await form.getByLabel('SFX dilarang').fill('kaget, kartun');
  await form.getByRole('button', { name: '＋ Referensi' }).click();
  await form.getByLabel('Link referensi 1').fill('https://www.tiktok.com/@aysillafactoryid/video/1');
  await form.getByLabel('Yang ditiru 1').fill('hook cepat 2 detik');
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await form.getByText('Tersimpan (revisi 1)').waitFor();

  const k = (await (await open()).listBrands())[0];
  const byId = Object.fromEntries(k.aset.map((a) => [a.id, a]));
  check(
    'X-U2-06 Tersimpan: 4 aset (tag, lisensi, mood/BPM, produk/varian), SFX dilarang, referensi',
    k.aset.length === 4 && byId['pop-satu'].tag.join() === 'teks-muncul' && byId['pop-satu'].lisensi.iklan && !byId.whoosh.lisensi.iklan && byId['musik-ceria'].bpm === 120 && byId['musik-ceria'].lisensi.bukti && byId['detail-bahan'].produk === 'Loose Pants' && byId['detail-bahan'].ada_teks_bawaan && k.sfx_dilarang.join() === 'kaget,kartun' && k.referensi[0].tiru === 'hook cepat 2 detik',
    k.aset.map((a) => a.id).join(','),
  );
  const ex = await (await fetch(`http://127.0.0.1:${server.port}/api/brands/${k.brand_id}/export`, { headers: { authorization: `Bearer ${server.app.token}` } })).json();
  const keys = Object.fromEntries(ex.export.aset.map((a) => [a.kunci, a]));
  check(
    'X-U2-07 Ekspor mesin: $sfx/$musik/$broll dengan tag, lisensi_iklan, durasi_ms, orientasi, tanpa path',
    keys['$sfx:pop-satu']?.lisensi_iklan === true && keys['$sfx:whoosh']?.lisensi_iklan === false && Math.abs(keys['$sfx:pop-satu'].durasi_ms - 300) < 80 && keys['$musik:ceria'] === undefined && keys['$musik:musik-ceria']?.sumber_lisensi === 'Epidemic Sound #123' && keys['$broll:detail-bahan']?.orientasi === '9:16' && !/"path"/.test(JSON.stringify(ex)),
    Object.keys(keys).join(','),
  );
  await page.screenshot({ path: path.join(EVID, 'library.png'), fullPage: true });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: /Brand/ }).first().click();
  await phone.getByRole('group', { name: 'Library aset brand' }).getByRole('group', { name: 'Aset detail-bahan' }).waitFor();
  const sticking = await phone.evaluate(() => {
    const card = document.querySelector('.brandForm').getBoundingClientRect();
    return [...document.querySelectorAll('.assetLib input, .assetLib select, .assetLib button')].filter((el) => el.getAttribute('type') !== 'file' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > card.right + 1).length;
  });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('X-U2-08 HP 390px: library muat, tidak ada isian terpotong', overflow <= 0 && sticking === 0, `overflow ${overflow}px, terpotong ${sticking}`);
  check('X-U2-09 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X-U2-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nU2 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
