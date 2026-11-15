// Audit 14 Nov 2026 (Jenius → ucok): regression run for the web fixes, in real Chrome against the
// built server (random port, never 4317). Editor (preview captions, inspector per clip, free spot
// for new text, no empty undo step), Trash (typing the phrase key by key, a spent purge request),
// Brand (our own error messages), AI (a failed save keeps the form, decimal comma), engine progress
// surviving a failed status check.
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
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-a14-'));
const wsRoot = path.join(work, 'ws');
const DAY = 86_400_000;
const clock = new core.ManualClock(Date.now() - 40 * DAY);
const ws = await core.initWorkspace(wsRoot, { clock });
const svc = new core.StorageService(ws);
const variant = async (tag) => {
  const p = path.join(work, `${tag}.mp4`);
  await fsp.writeFile(p, Buffer.concat([await fsp.readFile(path.join(FIX, 'sample_8s_9x16.mp4')), Buffer.from(`#${tag}`)]));
  return p;
};
// Editor project: a video, two text clips (one with word timings + pop → word spans in the preview).
const imp = await svc.importMedia({ sourcePath: await variant('lucy'), scope: { kind: 'shared' }, display_name: 'Lucy-8s.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'cp', name: 'Uji Copilot Kosong' });
await core.createProject(ws, { project_id: 'panjang', name: 'Proyek dengan nama yang sangat panjang sekali untuk uji layar HP Motion Studio' });
await core.createProject(ws, { project_id: 'ed', name: 'Uji Audit Editor' });
await svc.editTimeline({
  project_id: 'ed',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 0, duration_ms: 8000 },
    { op: 'add_clip', track_kind: 'text', text: 'Klip A', start_ms: 0, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'text', text: 'Klip B', start_ms: 4000, duration_ms: 3000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'celana adem banget', words: [{ text: 'celana', start_ms: 0, end_ms: 400 }, { text: 'adem', start_ms: 400, end_ms: 800 }, { text: 'banget', start_ms: 800, end_ms: 1200 }], start_ms: 0, duration_ms: 2000, style: { anim: 'pop', size: 6 } },
  ],
});
// Trash: one old version moved by Auto Trash (as in W05).
{
  const first = await svc.importMedia({ sourcePath: await variant('lama'), scope: { kind: 'shared' }, display_name: 'lama.mp4', actor: 'user' });
  await svc.addVersion({ media_id: first.media.media_id, sourcePath: await variant('lama-recut'), actor: 'user' });
  // Used once by a project, then dropped: an old, unused version Auto Trash may move.
  await core.createProject(ws, { project_id: 'tr', name: 'Lama' });
  const base = await core.readProject(ws, 'tr');
  const clip = { clip_id: 'c-lama', start_ms: 0, end_ms: 8000, media: { media_id: first.media.media_id, version_id: first.version.version_id } };
  await svc.commitProject({ manifest: { ...base, timeline: { tracks: [{ track_id: 'v', kind: 'video', clips: [clip] }] } }, expected_revision: base.revision, actor: 'user' });
  const again = await core.readProject(ws, 'tr');
  await svc.commitProject({ manifest: { ...again, timeline: { tracks: [] } }, expected_revision: again.revision, actor: 'user' });
  clock.advance(31 * DAY);
  await svc.autoTrash({ actor: 'scheduler' });
}
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'ed');
const clipOf = (p, text) => p.timeline.tracks.flatMap((t) => t.clips).find((c) => c.text === text);

// Engine folder for the progress check.
const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
await fsp.mkdir(path.join(engine, 'konten'));
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(engine, 'aset', 'musik-lokal.wav')], { windowsHide: true });
const talk = path.join(work, 'rekaman-bicara.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk], { windowsHide: true });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d|ERR_FAILED|ERR_CONNECTION/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await page.getByText('Uji Audit Editor').first().waitFor();
  await page.getByText('Uji Audit Editor').first().click();
  await page.getByRole('heading', { name: 'Uji Audit Editor' }).waitFor();

  // ---- Editor
  // Word captions in the preview use their real size and colour, not the 11 px placeholder rule.
  const sizes = await until(async () => (await page.locator('.canvas.live .overlayText span').count()) > 0);
  const capStyle = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.canvas.live .overlayText span')].find((s) => /celana/.test(s.textContent ?? ''));
    return el ? { fs: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color } : null;
  });
  check('A14-01 Pratinjau caption per kata: ukuran & warna asli (bukan 11 px abu-abu)', sizes && capStyle && capStyle.fs > 12 && capStyle.color !== 'rgb(179, 193, 213)', JSON.stringify(capStyle));

  // A half-typed inspector field never lands on the next clip.
  const insp = page.getByRole('region', { name: 'Inspector klip' });
  await page.locator('.track .clip', { hasText: 'Klip A' }).click();
  await insp.getByLabel('Mulai klip (detik)').waitFor();
  const before = await proj();
  await insp.getByLabel('Mulai klip (detik)').fill('5');
  await page.locator('.track .clip', { hasText: 'Klip B' }).click();
  await page.waitForTimeout(800);
  const afterSwitch = await proj();
  check('A14-02 Ketik di inspector lalu pilih klip lain: klip lain tidak ikut berubah', clipOf(afterSwitch, 'Klip B').start_ms === 4000 && clipOf(afterSwitch, 'Klip A').start_ms === clipOf(before, 'Klip A').start_ms, `B=${clipOf(afterSwitch, 'Klip B').start_ms}`);

  // Leaving the keyword field unchanged makes no undo step.
  await page.locator('.track .clip', { hasText: 'Klip B' }).click();
  const kw = insp.getByLabel('Kata kunci disorot');
  if (await kw.count()) {
    const rev = (await proj()).revision;
    await kw.focus();
    await insp.getByLabel('Mulai klip (detik)').focus();
    await page.waitForTimeout(800);
    check('A14-03 Fokus lalu keluar dari "Kata kunci" tanpa mengubah: tidak ada revisi / undo kosong', (await proj()).revision === rev, `rev ${rev} → ${(await proj()).revision}`);
  } else check('A14-03 Kolom kata kunci ada di inspector teks', false);

  // "+ Teks" at a playhead that already has text goes to the next free spot.
  const textCount = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'text').clips.length;
  const n0 = await textCount();
  await page.getByRole('button', { name: '＋ Teks' }).click();
  await page.getByRole('button', { name: '＋ Teks' }).click();
  const added = await until(async () => (await textCount()) === n0 + 2);
  check('A14-04 "+ Teks" dua kali di posisi yang sudah terisi: dua klip baru, tanpa error tumpang tindih', added && (await page.getByRole('alert').count()) === 0, `${await textCount()} klip teks`);
  // ⏮ while playing really goes back to the start (the play clock used to overwrite it).
  await page.getByRole('button', { name: 'Putar' }).click();
  await page.waitForTimeout(3200);
  await page.getByRole('button', { name: 'Ke awal' }).click();
  await page.waitForTimeout(300);
  const tAfter = await page.locator('.time').innerText();
  await page.getByRole('button', { name: 'Jeda' }).click();
  check('A14-22 ⏮ saat diputar: kembali ke awal (00:00), tidak ditimpa jam pemutaran', /^00:0[01] \//.test(tAfter.trim()) /* reset (without the fix it shows 00:03+) */, tAfter);

  // A dragged text stays where it was dropped while the save is on its way.
  {
    await page.route('**/api/projects/ed/edit', async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    const el = page.locator('.overlayText.styled[data-kind="text"]', { hasText: 'Klip A' });
    const b0 = await el.boundingBox();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
    await page.mouse.down();
    await page.mouse.move(b0.x + b0.width / 2 + 30, b0.y + b0.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400); // the save is still waiting (1,5 s)
    const b1 = await el.boundingBox();
    check('A14-23 Teks yang di-drag tetap di posisi baru selama penyimpanan berjalan (tidak melompat balik)', b1 && b1.y - b0.y > 40, `Δy=${b1 ? Math.round(b1.y - b0.y) : '?'}`);
    await page.waitForTimeout(1600);
    await page.unroute('**/api/projects/ed/edit');
  }

  // Switching project fast: a slow answer for the previous project never shows on the new one.
  {
    await page.route('**/api/projects/cp', async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    await page.getByText('Uji Copilot Kosong').first().click();
    await page.getByText('Uji Audit Editor').first().click();
    await page.waitForTimeout(2200);
    const head = await page.locator('h1').first().innerText();
    check('A14-24 Pindah proyek cepat: jawaban lambat proyek sebelumnya tidak menimpa proyek yang terbuka', head.includes('Uji Audit Editor'), head);
    await page.unroute('**/api/projects/cp');
  }

  // A style change still waiting its 0,45 s when the clip is let go is saved, not dropped.
  await page.locator('.track .clip', { hasText: 'Klip A' }).click();
  await insp.getByLabel('Ukuran teks').waitFor();
  const sizeBefore = clipOf(await proj(), 'Klip A').style?.size ?? null;
  await insp.getByLabel('Ukuran teks').fill('12');
  await page.locator('.track .clip', { hasText: 'Klip B' }).click(); // within 0,45 s
  const kept = await until(async () => clipOf(await proj(), 'Klip A').style?.size === 12);
  check('A14-14 Ubah ukuran lalu langsung pilih klip lain (<0,45 dtk): perubahan tetap tersimpan', kept, `${sizeBefore} → ${clipOf(await proj(), 'Klip A').style?.size}`);

  // R5: undo right after a style change (< 0,45 s) undoes THAT change (it used to be saved after the undo).
  {
    await page.locator('.track .clip', { hasText: 'Klip A' }).click();
    await insp.getByLabel('Ukuran teks').waitFor();
    await until(async () => clipOf(await proj(), 'Klip A').style?.size === 12);
    await insp.getByLabel('Ukuran teks').fill('16');
    await page.getByRole('button', { name: '↶ Undo' }).click(); // within 0,45 s
    await page.waitForTimeout(1500);
    const after = clipOf(await proj(), 'Klip A').style?.size;
    const redo = await page.getByRole('button', { name: '↷ Redo' }).isEnabled();
    check('A14-25 Undo < 0,45 dtk setelah ubah ukuran: ukuran kembali (12), Redo tersedia, perubahan tidak tersimpan lagi', after === 12 && redo, `ukuran ${after}, redo ${redo}`);
  }

  // Copilot (in an empty project): a ticked subset that cannot be applied says so, "Terapkan" off.
  await page.getByText('Uji Copilot Kosong').first().click();
  await page.getByRole('heading', { name: 'Uji Copilot Kosong' }).waitFor();
  await page.getByLabel('Perintah Copilot').fill('hook "Diskon 50%" 2 detik; subtitle "Cek keranjang" detik 2-5');
  await page.getByRole('button', { name: 'Buat rencana' }).click();
  const boxes = page.getByRole('checkbox', { name: /^Terapkan: / });
  if (await until(async () => (await boxes.count()) >= 2)) {
    await page.route('**/copilot/plans/*/preview', (r) => r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'EDIT_INVALID', message: 'Klip saling tumpang tindih di track yang sama' } }) }), { times: 1 });
    await boxes.first().uncheck();
    const warned = await until(() => page.getByRole('alert', { name: 'Langkah terpilih tidak bisa diterapkan' }).isVisible());
    check('A14-15 Copilot: centang sebagian yang tidak bisa diterapkan → diberi tahu, "Terapkan" mati', warned && (await page.getByRole('button', { name: /^Terapkan/ }).isDisabled()));
    await page.getByRole('button', { name: /Tolak/ }).first().click().catch(() => undefined);
  } else check('A14-15 Copilot membuat rencana 2 langkah', false, `${await boxes.count()} langkah`);
  await page.getByText('Uji Audit Editor').first().click();
  await page.getByRole('heading', { name: 'Uji Audit Editor' }).waitFor();
  await page.screenshot({ path: path.join(EVID, 'editor.png') });

  // ---- Media: the upload queue survives leaving the page (and new files join the same queue).
  await nav.getByRole('button', { name: /Media/ }).click();
  await page.getByRole('heading', { name: 'Media' }).waitFor();
  await page.route('**/api/media/import**', async (r) => {
    await new Promise((res) => setTimeout(res, 1200));
    await r.continue();
  });
  await page.getByLabel('Pilih file media').setInputFiles([await variant('antri-1'), await variant('antri-2')]);
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji Audit Editor' }).waitFor();
  await nav.getByRole('button', { name: /Media/ }).click();
  const rows = page.locator('.uploads .uploadRow');
  const still = await until(async () => (await rows.count()) === 2);
  const finished = await until(async () => (await rows.filter({ hasText: 'Selesai' }).count()) === 2, 30000);
  check('A14-16 Media: antrean upload tetap terlihat setelah pindah halaman dan selesai semua (tanpa BUSY)', still && finished && (await page.getByText(/sedang berjalan/).count()) === 0, `${await rows.count()} baris`);
  await page.unroute('**/api/media/import**');

  // ---- Batch: the form survives switching menus (sukma).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Batch Remix/ }).click();
  await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();
  {
    const bform = page.getByRole('region', { name: 'Susun batch' });
    await bform.getByLabel('Jumlah varian').fill('7');
    await bform.getByLabel('Hak pakai footage jelas').check();
    await bform.getByLabel('Buang urgensi').check();
    await nav.getByRole('button', { name: /Media/ }).click();
    await page.getByRole('heading', { name: 'Media' }).waitFor();
    await nav.getByRole('button', { name: /Buat video/ }).click();
    await page.getByRole('button', { name: /^Buka Batch Remix/ }).click();
    await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();
    check(
      'A14-19 Batch: isian form tetap setelah pindah menu (jumlah, hak pakai, buang otomatis)',
      (await bform.getByLabel('Jumlah varian').inputValue()) === '7' && (await bform.getByLabel('Hak pakai footage jelas').isChecked()) && (await bform.getByLabel('Buang urgensi').isChecked()),
    );
  }

  // ---- Trash: type the phrase key by key; a spent request offers a fresh one.
  await nav.getByRole('button', { name: /Trash/ }).click();
  await page.getByRole('heading', { name: 'Trash' }).waitFor();
  await page.getByLabel('Pilih lama.mp4').check();
  await page.getByRole('button', { name: /Hapus permanen…/ }).click();
  const phrase = page.getByLabel('Frasa konfirmasi');
  await phrase.waitFor();
  await phrase.click();
  await page.keyboard.type('HAPUS PERMANEN', { delay: 30 });
  check('A14-05 Frasa diketik huruf per huruf: fokus tetap di kotak, frasa lengkap', (await phrase.inputValue()) === 'HAPUS PERMANEN' && (await phrase.evaluate((el) => el === document.activeElement)), await phrase.inputValue());
  await page.route('**/api/purge/execute', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permintaan hapus sudah kedaluwarsa' } }) }), { times: 1 });
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus permanen' }).click();
  const fresh = page.getByRole('dialog').getByRole('button', { name: 'Siapkan permintaan baru' });
  const offered = await until(() => fresh.isVisible());
  check('A14-06 Permintaan hapus yang gagal / kedaluwarsa: ada "Tutup" dan "Siapkan permintaan baru"', offered && (await page.getByRole('dialog').getByRole('button', { name: 'Tutup' }).isVisible()));
  await fresh.click();
  await phrase.waitFor();
  await phrase.fill('HAPUS PERMANEN');
  check('A14-07 Permintaan baru siap: frasa bisa diketik lagi dan tombol aktif', await page.getByRole('dialog').getByRole('button', { name: 'Hapus permanen' }).isEnabled());
  await page.keyboard.press('Escape');

  // ---- Brand: our own messages are shown, not "kesalahan tidak dikenal".
  await nav.getByRole('button', { name: /Brand/ }).click();
  const bad = path.join(work, 'bukan-font.txt');
  await fsp.writeFile(bad, 'x');
  await page.getByLabel('File font brand').first().setInputFiles(bad);
  check('A14-08 Brand: file font salah → pesan jelas "Pilih file font .ttf atau .otf."', await until(() => page.getByRole('alert').filter({ hasText: 'Pilih file font .ttf atau .otf.' }).isVisible()));

  // Brand: an upload finishing later keeps the edits made while it ran.
  const tone = path.join(work, 'pop-sfx.wav');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1200:d=0.3', tone], { windowsHide: true });
  await page.route('**/api/media/import**', async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await page.getByLabel('File aset brand').setInputFiles(tone);
  await page.getByLabel('Nama brand').fill('Aysilla Baru');
  const merged = await until(async () => (await page.getByLabel('Saring jenis aset').locator('option').first().innerText()).includes('(1)'));
  check('A14-08b Brand: upload aset selesai belakangan → nama yang diubah selama upload tetap, aset ikut masuk', merged && (await page.getByLabel('Nama brand').inputValue()) === 'Aysilla Baru');
  await page.unroute('**/api/media/import**');

  // Brand: picking another brand with unsaved edits asks first; "no" keeps the edits.
  {
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.getByLabel('Nama brand').fill('Aysilla Belum Disimpan');
    await page.getByRole('button', { name: /Brand baru/ }).click();
    await page.waitForTimeout(300);
    check('A14-21 Brand: pindah brand dengan editan belum disimpan → ditanya dulu; "batal" = editan tetap', /belum disimpan/.test(asked) && (await page.getByLabel('Nama brand').inputValue()) === 'Aysilla Belum Disimpan', asked);
  }

  // ---- AI: a refused connection keeps what was typed; decimal comma in the budget.
  await nav.getByRole('button', { name: /AI/ }).click();
  await page.getByText('＋ Tambah koneksi').click();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai_compatible');
  await page.getByLabel('Nama koneksi').fill('Server kantor');
  await page.getByLabel('Model', { exact: true }).fill('llama3');
  await page.getByLabel('Alamat server').fill('http://contoh.com');
  await page.getByRole('button', { name: 'Simpan koneksi' }).click();
  const refused = await until(() => page.getByRole('alert').filter({ hasText: 'Alamat server harus' }).isVisible());
  check('A14-09 AI: koneksi ditolak server → isian tetap (bisa diperbaiki), pesan tampil', refused && (await page.getByLabel('Nama koneksi').inputValue()) === 'Server kantor' && (await page.getByLabel('Model', { exact: true }).inputValue()) === 'llama3');
  await page.getByLabel('Batas harian').fill('0,5');
  await page.getByRole('button', { name: 'Simpan batas' }).click();
  const saved = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/ai/providers`, { headers: { authorization: `Bearer ${server.app.token}`, 'x-motion-request': '1' } });
    return (await r.json()).settings.budget.daily_usd === 0.5;
  });
  check('A14-10 AI: batas "0,5" (koma) tersimpan sebagai 0,5 USD', saved);
  // The page reloads the saved settings into the form; wait for that before clearing the field.
  await until(async () => (await page.getByLabel('Batas harian').inputValue()) === '0.5' && (await page.getByRole('button', { name: 'Simpan batas' }).isEnabled()));
  await page.getByLabel('Batas harian').fill('');
  check('A14-11 AI: batas kosong tidak bisa disimpan (bukan jadi 0 yang memblokir AI)', await page.getByRole('button', { name: 'Simpan batas' }).isDisabled());

  // ---- Generate: a start refused by the server, then retried, makes ONE project (not one per try).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  {
    const f = page.getByRole('region', { name: 'Video dan brief' });
    await until(async () => (await f.getByLabel('Brand').inputValue()) !== '');
    await f.getByLabel('Video bicara').setInputFiles(talk);
    await f.getByLabel('Preset').fill('aysilla-konversi');
    const count = async () => (await core.listProjectIds(await core.openWorkspace(wsRoot))).length;
    const nBefore = await count();
    await page.route(/\/api\/projects\/[^/]+\/engine\/jobs$/, (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSY', message: 'Antrean mesin penuh (20); tunggu dulu' } }) }) : r.continue()), { times: 1 });
    await f.getByRole('button', { name: /Susun draf otomatis/ }).click();
    const told = await until(() => page.getByRole('alert').filter({ hasText: 'Antrean mesin penuh' }).isVisible());
    await until(() => f.getByRole('button', { name: /Susun draf otomatis/ }).isEnabled());
    const nFailed = await count();
    await f.getByRole('button', { name: /Susun draf otomatis/ }).click();
    const ran = await until(() => page.getByRole('region', { name: 'Rencana edit' }).isVisible(), 30000);
    check('A14-11b Generate: gagal mulai (antrean penuh) lalu diulang → hanya satu proyek baru, bukan satu per percobaan', told && ran && nFailed === nBefore + 1 && (await count()) === nBefore + 1, `${nBefore} → ${nFailed} → ${await count()}`);
  }

  // ---- Engine progress survives one failed status check (a second run on the same page).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Batch Remix/ }).click();
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const form = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await form.getByLabel('Brand').inputValue()) !== '');
  await form.getByLabel('Video bicara').setInputFiles(talk);
  await form.getByLabel('Preset').fill('aysilla-konversi');
  let failed = 0;
  await page.route(/\/api\/projects\/[^/]+\/engine\/jobs\/AYS-\d{8}-\d{3}$/, (r) => {
    if (r.request().method() === 'GET' && failed < 1) {
      failed++;
      return r.abort('connectionreset');
    }
    return r.continue();
  });
  await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
  // Pages stay mounted now (keep-alive): the previous run's plan card may still show for a moment,
  // so wait for the failed check first, then for the NEW plan.
  const recovered = await until(async () => failed === 1 && (await page.getByRole('region', { name: 'Rencana edit' }).isVisible()), 30000);
  check('A14-12 Progres mesin: satu cek status gagal (koneksi putus) → tetap lanjut sampai rencana siap', failed === 1 && recovered, `gagal=${failed}`);

  // ---- R1 (hybrid): a job refused because the audio sounds like a song can "Tetap lanjut".
  {
    await page.unroute(/\/api\/projects\/[^/]+\/engine\/jobs\/AYS-\d{8}-\d{3}$/);
    await form.getByLabel('Video bicara').setInputFiles(talk);
    await form.getByLabel('Catatan').fill('lagu'); // fake engine: refuses as lyrics unless abaikan_cek_ucapan
    await form.getByRole('button', { name: /Susun draf otomatis/ }).click();
    const lagu = page.getByLabel('Ditolak karena lagu');
    const refused = await until(() => lagu.isVisible(), 30000);
    await lagu.getByRole('button', { name: /Tetap lanjut/ }).click();
    const gone = await until(async () => !(await lagu.isVisible()));
    const planned = await until(() => page.getByRole('region', { name: 'Rencana edit' }).isVisible(), 30000);
    check('A14-26 Generate ditolak karena lagu → "Tetap lanjut" menjalankan ulang tanpa cek lagu → rencana siap', refused && gone && planned);
    await form.getByLabel('Catatan').fill('');
  }

  // Generate: while the brand list loads, "Memuat brand…" — not "Buat brand dulu".
  {
    const slow = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await slow.route('**/api/brands', async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    await slow.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
    await slow.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Buat video/ }).click();
    await slow.getByRole('button', { name: /^Buka Video iklan/ }).click();
    await slow.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
    const loading = await slow.getByText('Memuat brand…').isVisible();
    const wrong = await slow.getByText('Buat brand dulu di menu Brand.').count();
    check('A14-17 Generate: saat brand dimuat tampil "Memuat brand…", bukan "Buat brand dulu"', loading && wrong === 0);
    await slow.close();
  }

  // Phone width: the purge dialog fits.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Trash/ }).click();
  await phone.getByLabel('Pilih lama.mp4').check();
  await phone.getByRole('button', { name: /Hapus permanen…/ }).click();
  await phone.getByLabel('Frasa konfirmasi').click();
  await phone.keyboard.type('HAPUS', { delay: 30 });
  check('A14-13 HP: frasa diketik per huruf tetap di kotak', (await phone.getByLabel('Frasa konfirmasi').inputValue()) === 'HAPUS');
  await phone.keyboard.press('Escape');
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /^2\. Edit$/ }).click();
  await phone.getByRole('button', { name: /^Transkrip / }).first().waitFor();
  const cc = phone.getByRole('button', { name: /^Transkrip / }).first();
  await cc.scrollIntoViewIfNeeded();
  const box = await cc.boundingBox();
  const vw = await phone.evaluate(() => innerWidth);
  check('A14-18 HP Editor: tombol CC media tidak terpotong layar', !!box && box.x >= 0 && box.x + box.width <= vw + 1, box ? `${Math.round(box.x + box.width)} / ${vw}` : 'tidak ada');
  await phone.screenshot({ path: path.join(EVID, 'trash-phone.png') });
  await phone.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: /Media/ }).click();
  await phone.getByRole('heading', { name: 'Media' }).waitFor();
  const overMedia = await phone.evaluate(() => [...document.querySelectorAll('select, input, button')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.getAttribute('aria-label') ?? e.textContent));
  check('A14-20 HP Media: select & tombol tidak keluar layar (nama proyek panjang)', overMedia.length === 0, overMedia.join(', '));
  check('A14-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('A14-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`A14 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
