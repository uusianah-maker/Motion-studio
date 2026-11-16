// R28 (owner): Video penutup — di Buat video pilihan "Video penutup" per job (default brand / dari
// Aset / unggah baru / tanpa), unggahan tersimpan di Aset kategori Penutup; Brand → Aset "Jadikan
// penutup default" (= slot Penutup Brand Kit); Editor "＋ Penutup" menaruh video sesudah klip
// terakhir (satu undo). Mesin menerima pilihan lewat brand_kit.json job (kontrak tetap) (real Chrome).
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
const FAKE = path.join(root, 'packages/core/test/fixtures/fake-engine.mjs');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { engineJobDir } = await import(pathToFileURL(path.join(root, 'packages/core/dist/storage/engine.js')).href);
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r28-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const vid = (name, color, d) => gen(name, ['-f', 'lavfi', '-i', `color=c=${color}:s=180x320:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=300:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const imp = async (f) => {
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const talk = vid('rekaman-bicara.mp4', 'gray', 3);
const OUT_A = await imp(vid('penutup-a.mp4', 'red', 2));
const OUT_B = await imp(vid('penutup-b.mp4', 'blue', 1.5));
const newOutro = vid('penutup-baru.mp4', 'green', 1);
const MAIN = await imp(vid('utama.mp4', 'gray', 2));
await svc.createBrand({
  kit: { name: 'Aysilla Factory', kode: 'AYS', outro: { ref: OUT_A, detik: 2 }, aset: [{ id: 'penutup-a', ref: OUT_A, jenis: 'penutup', nama: 'Penutup A' }, { id: 'penutup-b', ref: OUT_B, jenis: 'penutup', nama: 'Penutup B' }] },
  actor: 'user',
});
await core.createProject(ws, { project_id: 'r28', name: 'Uji Penutup' });
await svc.editTimeline({ project_id: 'r28', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: MAIN, start_ms: 0, duration_ms: 2000 }] });
const open = async () => core.openWorkspace(wsRoot);
const proj = async (id = 'r28') => core.readProject(await open(), id);
const kitNow = async () => (await new core.StorageService(await open()).listBrands())[0];

const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
await fsp.mkdir(path.join(engine, 'konten'));
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(engine, 'aset', 'musik-lokal.wav')], { windowsHide: true });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d|ERR_ABORTED|ERR_FAILED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });

  // ---- Brand → Aset: penutup default (= Brand Kit outro slot).
  await nav.getByRole('button', { name: /Brand/ }).click();
  const form = page.getByRole('region', { name: 'Pengaturan Brand Kit' });
  const lib = form.getByRole('group', { name: 'Library aset brand' });
  await lib.getByRole('group', { name: 'Aset penutup-b' }).waitFor();
  check('R28-01 Aset Penutup: yang dipakai Brand Kit bertanda ★ Penutup default', await lib.getByLabel('penutup-a penutup default').isVisible());
  await lib.getByRole('button', { name: 'Jadikan penutup-b penutup default' }).click();
  await form.getByRole('button', { name: 'Simpan Brand Kit' }).click();
  await until(() => form.getByText(/Tersimpan \(revisi/).isVisible());
  check('R28-02 "Jadikan penutup default" → slot Penutup Brand Kit = penutup-b (tersimpan)', (await kitNow()).outro.ref?.version_id === OUT_B.version_id);

  // ---- Buat video: choice per job → brand_kit.json of that job.
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const f = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await f.getByLabel('Brand').inputValue()) !== '');
  const pick = f.getByRole('group', { name: 'Video penutup' });
  const opts = await pick.getByLabel('Pilih video penutup').locator('option').allInnerTexts();
  check('R28-03 Pilihan penutup: default brand, dari Aset (Penutup A), Tanpa penutup', opts.join('|') === 'Penutup default brand|Penutup A|Tanpa penutup', opts.join('|'));
  check('R28-04 Pratinjau penutup default tampil (video)', await until(async () => (await pick.getByLabel('Pratinjau penutup').count()) === 1));
  const runJob = async () => {
    const before = new Set(await core.listProjectIds(await open()));
    await f.getByLabel('Video bicara').setInputFiles(talk);
    await f.getByLabel('Preset').fill('aysilla-konversi');
    await f.getByRole('button', { name: /Susun draf otomatis/ }).click();
    // The previous job's plan card may still show: wait for THIS job (new project) to be ready.
    let pid = null;
    let jobs = [];
    await until(async () => {
      pid = (await core.listProjectIds(await open())).find((id) => !before.has(id)) ?? null;
      jobs = pid ? await core.listEngineJobs(await open(), pid) : [];
      return jobs.at(-1)?.state === 'siap';
    }, 40000);
    const dir = engineJobDir(await open(), pid, jobs.at(-1).job_id);
    const read = async (n) => JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
    return { kit: await read('brand_kit.json'), refs: (await read('refs.json')).refs, job: await read('job.json') };
  };
  await pick.getByLabel('Pilih video penutup').selectOption({ label: 'Penutup A' });
  const j1 = await runJob();
  check('R28-05 Job dengan "Penutup A" → brand_kit.json job: $penutup = file A (kontrak mesin sama, job.json tanpa field baru)', j1.kit.visual.penutup.aset === '$penutup' && j1.refs.$penutup?.version_id === OUT_A.version_id && !('penutup' in j1.job), JSON.stringify(j1.kit.visual.penutup));
  await f.getByRole('combobox', { name: 'Proyek tujuan' }).selectOption('new');
  await pick.getByLabel('Pilih video penutup').selectOption({ label: 'Tanpa penutup' });
  const j2 = await runJob();
  check('R28-06 Job "Tanpa penutup" → penutup.aset null, tanpa $penutup', j2.kit.visual.penutup.aset === null && !j2.refs.$penutup && !j2.kit.aset.some((a) => a.kunci === '$penutup'));
  // Upload a new end card from Buat video → kept in the library (Penutup) and chosen.
  await pick.getByLabel('File penutup baru').setInputFiles(newOutro);
  const saved = await until(async () => (await kitNow()).aset.some((a) => a.jenis === 'penutup' && a.id === 'penutup-baru'), 15000);
  const chosen = await until(async () => (await pick.getByLabel('Pilih video penutup').locator('option:checked').innerText()) === 'penutup-baru');
  check('R28-07 Unggah penutup baru di Buat video → tersimpan di Aset (Penutup) + langsung terpilih', saved && chosen);
  await page.screenshot({ path: path.join(EVID, 'buat-video-penutup.png') });

  // ---- Editor: ＋ Penutup after the last video clip.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji Penutup' }).first().waitFor().catch(() => undefined);
  await page.getByRole('button', { name: /Uji Penutup/ }).first().click().catch(() => undefined);
  await page.getByRole('heading', { name: 'Uji Penutup' }).waitFor();
  const rev0 = (await proj()).revision;
  await page.getByRole('button', { name: '＋ Penutup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Tambah video penutup' });
  await dlg.getByLabel('Pilih video penutup').waitFor();
  const first = await dlg.getByLabel('Pilih video penutup').locator('option:checked').innerText();
  check('R28-08 Dialog ＋ Penutup: yang terpilih awal = penutup default brand', first === 'Penutup B', first);
  await dlg.getByRole('button', { name: 'Taruh di akhir video' }).click();
  const vids = async () => (await proj()).timeline.tracks.find((t) => t.kind === 'video').clips;
  check('R28-09 Penutup ditaruh sesudah klip terakhir (2,0 dtk), panjang = file (1,5 dtk), satu revisi', await until(async () => {
    const v = await vids();
    return v.length === 2 && v[1].media.version_id === OUT_B.version_id && v[1].start_ms === 2000 && v[1].end_ms === 3500 && (await proj()).revision === rev0 + 1;
  }), JSON.stringify((await vids()).map((c) => [c.start_ms, c.end_ms])));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R28-10 Undo → penutup hilang (satu langkah)', await until(async () => (await vids()).length === 1));
  await page.screenshot({ path: path.join(EVID, 'editor-penutup.png') });
  check('R28-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R28-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R28 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
