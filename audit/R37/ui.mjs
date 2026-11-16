// R37 (KONTRAK-ENGINE §22): "VO dari Library" — di Video iklan, Batch Remix, Beat Spot pilihan
// "Suara: dari footage | VO dari Library" + pilih VO brand (▶ dengar) + "Suara footage"; "musik saja"
// dicegah; job.json `vo` + <job>/vo_index.json; Editor tab VO (▶ + ＋ VO dengan subtitle dari teks,
// satu undo) (real Chrome, mesin palsu).
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
const { LAYOUT } = await import(pathToFileURL(path.join(root, 'packages/core/dist/storage/workspace.js')).href);
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r37-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const imp = async (f) => {
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const footage = gen('footage.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=200:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const footage2 = gen('footage-2.mp4', ['-f', 'lavfi', '-i', 'color=c=navy:s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
const VO = await imp(gen('vo-promo.wav', ['-f', 'lavfi', '-i', 'sine=f=220:d=3']));
const index = { schema: 'vo-index/1', job_id: 'AYS-20261116-001', teks: 'Halo kak. Diskon hari ini.', kalimat: [{ teks: 'Halo kak.', mulai: 0, akhir: 1.2, kata: [{ teks: 'Halo', mulai: 0, akhir: 0.5 }, { teks: 'kak.', mulai: 0.5, akhir: 1.2 }] }, { teks: 'Diskon hari ini.', mulai: 1.5, akhir: 2.9, kata: [{ teks: 'Diskon', mulai: 0, akhir: 0.5 }, { teks: 'hari', mulai: 0.5, akhir: 0.9 }, { teks: 'ini.', mulai: 0.9, akhir: 1.4 }] }] };
await fsp.mkdir(path.join(wsRoot, LAYOUT.meta, 'vo'), { recursive: true });
await fsp.writeFile(path.join(wsRoot, LAYOUT.meta, 'vo', `${VO.version_id}.json`), JSON.stringify(index));
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', aset: [{ id: 'vo-promo', ref: VO, jenis: 'vo', nama: 'VO Promo Diskon', tag: ['vo', 'tts'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true } }] }, actor: 'user' });
await core.createProject(ws, { project_id: 'r37', name: 'Uji VO Library' });
const open = async () => core.openWorkspace(wsRoot);
const proj = async () => core.readProject(await open(), 'r37');
const lane = (p, k) => p.timeline.tracks.find((t) => t.kind === k)?.clips ?? [];

const engine = path.join(work, 'engine');
await fsp.mkdir(path.join(engine, 'aset'), { recursive: true });
await fsp.mkdir(path.join(engine, 'konten'));
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=2', path.join(engine, 'aset', 'musik-lokal.wav')], { windowsHide: true });

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d|ERR_ABORTED|ERR_FAILED/.test(m.text()) && errors.push(m.text()));
  const bodies = [];
  page.on('request', (r) => r.method() === 'POST' && /\/engine\/jobs$/.test(r.url()) && bodies.push(r.postDataJSON()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  const newJobDir = async (before) => {
    let dir = null;
    await until(async () => {
      for (const pid of await core.listProjectIds(await open())) {
        for (const j of await core.listEngineJobs(await open(), pid)) if (!before.has(j.job_id)) dir = engineJobDir(await open(), pid, j.job_id);
      }
      return !!dir;
    }, 20000);
    return dir;
  };
  const allJobs = async () => {
    const s = new Set();
    for (const pid of await core.listProjectIds(await open())) for (const j of await core.listEngineJobs(await open(), pid)) s.add(j.job_id);
    return s;
  };
  const readJ = async (dir, f) => JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));

  // ---- Video iklan (Generate).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Video iklan/ }).click();
  await page.getByRole('heading', { name: 'Generate Otomatis' }).waitFor();
  const f = page.getByRole('region', { name: 'Video dan brief' });
  await until(async () => (await f.getByLabel('Brand').inputValue()) !== '');
  const suara = f.getByRole('group', { name: 'Sumber suara' });
  check('R37-01 Video iklan: pilihan "Suara: dari footage | VO dari Library" (bawaan dari footage)', (await suara.getByLabel('Suara dari footage').isChecked()) && (await suara.getByLabel('VO dari Library').isEnabled()));
  await f.getByLabel('Audio').selectOption('musik');
  await suara.getByLabel('VO dari Library').check();
  check(
    'R37-02 Pilih VO dari Library → VO brand terpilih, Suara footage "mati"; Audio "musik saja" dikosongkan + dinonaktifkan',
    (await suara.getByLabel('Pilih VO').locator('option:checked').innerText()) === 'VO Promo Diskon' && (await suara.getByLabel('Suara footage').inputValue()) === 'mati' && (await until(async () => (await f.getByLabel('Audio').inputValue()) === '')) && (await f.getByLabel('Audio').locator('option[value="musik"]').evaluate((o) => o.disabled)),
    `vo=${await suara.getByLabel('Pilih VO').locator('option:checked').innerText().catch(() => '?')} sf=${await suara.getByLabel('Suara footage').inputValue().catch(() => '?')} audio=${await f.getByLabel('Audio').inputValue()} musikDisabled=${await f.getByLabel('Audio').locator('option[value="musik"]').evaluate((o) => o.disabled)}`,
  );
  await suara.getByRole('button', { name: 'Dengar VO' }).click();
  check('R37-03 ▶ dengar VO yang dipilih', await until(() => suara.getByRole('button', { name: 'Hentikan VO' }).isVisible()));
  await suara.getByRole('button', { name: 'Hentikan VO' }).click();
  await suara.getByLabel('Suara footage').selectOption('pelan');
  await f.getByLabel('Video bicara').setInputFiles(footage);
  await f.getByLabel('Preset').fill('aysilla-konversi');
  let before = await allJobs();
  await f.getByRole('button', { name: /Susun draf otomatis/ }).click();
  let dir = await newJobDir(before);
  const gj = dir ? await readJ(dir, 'job.json') : {};
  check(
    'R37-04 Generate: job.json vo {media $vo:vo-promo, index vo_index.json, suara_footage pelan, subtitle true}; VO di sumber',
    gj.vo?.media === '$vo:vo-promo' && gj.vo.index === 'vo_index.json' && gj.vo.suara_footage === 'pelan' && gj.vo.subtitle === true && gj.sumber?.some((s) => s.kunci === '$vo:vo-promo'),
    JSON.stringify(gj.vo),
  );
  check('R37-05 vo_index.json disalin ke folder job (vo-index/1, 2 kalimat)', dir && (await readJ(dir, 'vo_index.json')).kalimat?.length === 2);
  await page.screenshot({ path: path.join(EVID, 'video-iklan-vo.png') });

  // ---- Batch Remix: the request carries vo (the start itself is answered by a stub here).
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Batch Remix/ }).click();
  await page.getByRole('heading', { name: 'Batch Remix' }).waitFor();
  const bf = page.getByRole('region', { name: 'Susun batch' });
  await until(async () => (await bf.getByLabel('Brand').inputValue()) !== '');
  const bs = bf.getByRole('group', { name: 'Sumber suara' });
  await bs.getByLabel('VO dari Library').check();
  const nb = bf.getByLabel('Nama batch');
  if ((await nb.evaluate((e) => e.tagName)) === 'SELECT') {
    if ((await nb.locator('option').count()) === 0) throw new Error('tidak ada batch di mesin palsu');
  } else await nb.fill('2026-11-13_video-winning');
  await page.route(/\/engine\/jobs$/, (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSY', message: 'uji R37' } }) }) : r.continue()), { times: 1 });
  const nBody = bodies.length;
  await page.getByRole('button', { name: /^▦ Susun \d+ varian/ }).click();
  await until(async () => bodies.length > nBody);
  const bb = bodies.at(-1) ?? {};
  check('R37-06 Batch Remix: pilihan VO dari Library ada dan permintaan job membawa vo {aset vo-promo}', bb.mode === 'batch' && bb.vo?.aset === 'vo-promo' && bb.vo.suara_footage === 'mati', JSON.stringify(bb.vo));

  // ---- Beat Spot: real job.
  await nav.getByRole('button', { name: /Buat video/ }).click();
  await page.getByRole('button', { name: /^Buka Beat Spot/ }).click();
  await page.getByRole('heading', { name: 'Beat Spot' }).waitFor();
  const sf = page.getByRole('region', { name: 'Footage dan sound' });
  await until(async () => (await sf.getByLabel('Brand').inputValue()) !== '');
  await sf.getByLabel('Footage orang').setInputFiles([footage, footage2]);
  await sf.getByRole('group', { name: 'Sumber suara' }).getByLabel('VO dari Library').check();
  await sf.getByRole('group', { name: 'Sumber suara' }).getByLabel('Suara footage').selectOption('asli');
  before = await allJobs();
  await sf.getByRole('button', { name: /Susun Beat Spot/ }).click();
  dir = await newJobDir(before);
  const bj = dir ? await readJ(dir, 'job.json') : {};
  check('R37-07 Beat Spot: job.json vo (suara_footage asli) + vo_index.json; VO bukan sumber/sound', bj.vo?.media === '$vo:vo-promo' && bj.vo.suara_footage === 'asli' && !bj.sumber?.some((s) => s.kunci.startsWith('$vo')) && !!(dir && (await readJ(dir, 'vo_index.json')).kalimat), JSON.stringify(bj.vo));

  // ---- Editor: tab VO.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('button', { name: /Uji VO Library/ }).first().click().catch(() => undefined);
  await page.getByRole('heading', { name: 'Uji VO Library' }).waitFor();
  const L = page.getByRole('region', { name: 'Library efek' });
  await L.getByRole('tab', { name: 'VO' }).click();
  const vp = L.getByRole('tabpanel', { name: 'VO' });
  check('R37-08 Editor: tab VO menampilkan VO brand', (await vp.getByRole('group', { name: 'VO vo-promo' }).count()) === 1);
  await vp.getByRole('button', { name: 'Dengar vo-promo' }).click();
  check('R37-09 ▶ dengar VO di Editor', await until(() => vp.getByRole('button', { name: 'Hentikan vo-promo' }).isVisible()));
  await vp.getByRole('button', { name: 'Hentikan vo-promo' }).click();
  const rev0 = (await proj()).revision;
  await vp.getByRole('button', { name: 'Tambah vo-promo dengan subtitle' }).click();
  check(
    'R37-10 ＋ VO + subtitle → klip VO di track Audio (0–3 dtk) + subtitle dari teks VO (Halo kak. / Diskon hari ini.) dalam SATU edit',
    await until(async () => {
      const p = await proj();
      const a = lane(p, 'audio');
      const s = lane(p, 'subtitle');
      return a.length === 1 && a[0].start_ms === 0 && a[0].end_ms === 3000 && s.map((c) => c.text).join('|') === 'Halo kak.|Diskon hari ini.' && s[1].start_ms === 1500 && p.revision === rev0 + 1;
    }),
    JSON.stringify(lane(await proj(), 'subtitle').map((c) => [c.text, c.start_ms])),
  );
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R37-11 Undo → VO dan subtitle hilang bersama (satu langkah)', await until(async () => lane(await proj(), 'audio').length === 0 && lane(await proj(), 'subtitle').length === 0));
  await page.screenshot({ path: path.join(EVID, 'editor-vo.png') });
  check('R37-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R37-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R37 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
