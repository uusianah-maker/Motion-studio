// R38b (owner 16 Nov): transisi custom (stinger dari Library → di tengah potongan, track Overlay;
// tanpa alpha = mode Screen) + video efek dengan mode campur (Normal/Screen/Lighten/Multiply/Overlay)
// di Inspector overlay. Pratinjau = CSS mix-blend-mode, render = FFmpeg blend. Undo.
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
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r38b-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, filter) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const blue = await gen('biru.mp4', 'color=c=0x2040c0:s=360x640:r=30:d=2');
const green = await gen('hijau.mp4', 'color=c=0x20c040:s=360x640:r=30:d=2');
const leak = await gen('leak.mp4', 'color=c=black:s=360x640:r=30:d=4,drawbox=x=0:y=0:w=360:h=320:color=0xff6000:t=fill');
const flash = await gen('flash.mp4', 'color=c=white:s=360x640:r=30:d=0.6');
await svc.createBrand({ kit: { name: 'Uji Brand', kode: 'UJI', aset: [{ id: 'flash-putih', ref: flash, jenis: 'broll', nama: 'Flash putih', tag: ['stinger'], lisensi: { status: 'milik_sendiri', bukti: '', iklan: true } }] }, actor: 'user' });
await core.createProject(ws, { project_id: 'r38b', name: 'Uji Mode Campur' });
await svc.editTimeline({ project_id: 'r38b', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 0, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'video', media: green, start_ms: 2000, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'overlay', media: leak, start_ms: 0, duration_ms: 4000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 100, opasitas: 1, margin: 0, layer: 0 } },
] });
const ovs = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r38b')).timeline.tracks.find((t) => t.kind === 'overlay').clips;

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Mode Campur' }).waitFor();

  // ---- Video efek: mode campur di Inspector.
  await page.locator('.track[data-kind="overlay"] .clip').first().click();
  const grp = page.getByRole('region', { name: 'Inspector klip' }).getByRole('group', { name: 'Mode campur' });
  check('R38B-01 Klip overlay → "Mode campur" di Inspector (Normal default)', await until(async () => (await grp.getByLabel('Mode campur').inputValue()) === 'normal'));
  const opts = await grp.getByLabel('Mode campur').locator('option').evaluateAll((o) => o.map((x) => x.value));
  check('R38B-02 Pilihan Normal, Screen, Lighten, Multiply, Overlay', opts.join(',') === 'normal,screen,lighten,multiply,overlay', opts.join(','));
  await grp.getByLabel('Mode campur').selectOption('screen');
  check('R38B-03 Pilih Screen → overlay.blend = screen tersimpan', await until(async () => (await ovs())[0].overlay.blend === 'screen'));
  const ovEl = page.getByLabel('Overlay video');
  check('R38B-04 Pratinjau: mix-blend-mode screen', await until(async () => (await ovEl.evaluate((e) => getComputedStyle(e).mixBlendMode)) === 'screen'));
  await page.screenshot({ path: path.join(EVID, 'mode-campur.png') });
  await grp.getByLabel('Mode campur').selectOption('multiply');
  check('R38B-05 Ganti Multiply → tersimpan + pratinjau ikut', await until(async () => (await ovs())[0].overlay.blend === 'multiply') && (await until(async () => (await ovEl.evaluate((e) => getComputedStyle(e).mixBlendMode)) === 'multiply')));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R38B-06 Undo → kembali Screen', await until(async () => (await ovs())[0].overlay.blend === 'screen'));

  // ---- Stinger dari Library → Transisi.
  await page.mouse.click(5, 5);
  const L = page.getByRole('region', { name: 'Library efek' });
  await L.getByRole('tab', { name: 'Transisi' }).click();
  const tp = L.getByRole('tabpanel', { name: 'Transisi' });
  const row = tp.getByRole('group', { name: 'Stinger flash-putih' });
  check('R38B-07 Tab Transisi: stinger brand (tag "stinger") tampil, mode Screen (tanpa alpha)', await until(async () => (await row.count()) === 1 && /Screen/.test(await row.innerText())));
  await row.getByRole('button', { name: 'Pasang stinger flash-putih' }).click();
  const placed = await until(async () => (await ovs()).some((c) => c.overlay?.stinger));
  const st = (await ovs()).find((c) => c.overlay?.stinger);
  check('R38B-08 Pasang → klip overlay stinger di tengah potongan 2,0 dtk (1,7–2,3), layar penuh, Screen', placed && st.start_ms === 1700 && st.end_ms === 2300 && st.overlay.skala === 100 && st.overlay.blend === 'screen', st ? `${st.start_ms}-${st.end_ms} ${st.overlay.blend}` : 'none');
  await page.locator(`.track[data-kind="overlay"] .clip[data-clip-id="${st?.clip_id}"]`).click().catch(async () => {
    await page.locator('.track[data-kind="overlay"] .clip').last().click();
  });
  check('R38B-09 Inspector stinger: catatan transisi + mode campur bisa diubah (hybrid)', await until(() => grp.getByText(/Transisi stinger/).isVisible()));
  await page.screenshot({ path: path.join(EVID, 'stinger.png') });
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R38B-10 Undo → stinger hilang', await until(async () => !(await ovs()).some((c) => c.overlay?.stinger)));
  await page.getByRole('button', { name: '↷ Redo' }).click().catch(() => undefined);
  await until(async () => (await ovs()).some((c) => c.overlay?.stinger), 4000);

  const res = await core.renderProject(await core.openWorkspace(wsRoot), { project_id: 'r38b', output_name: 'r38b.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  check('R38B-11 Render dengan blend + stinger selesai', res.status === 'completed', res.error?.message ?? '');
  check('R38B-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R38B-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R38B UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
