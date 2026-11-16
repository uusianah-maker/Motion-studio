// R27 (owner): Library efek di Editor — tab SFX (▶ dengar + cari per tag + tambah di playhead),
// tab Transisi, tab Efek (zoom + filter), tab Teks preset; satu klik = satu edit = satu undo.
// Brand → Aset: tombol ▶ dengar untuk SFX / musik / VO (real Chrome).
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
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r27-'));
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
const A = await imp(gen('klip-a.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']));
const B = await imp(gen('klip-b.mp4', ['-f', 'lavfi', '-i', 'color=c=navy:s=180x320:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']));
const POP = await imp(gen('pop.wav', ['-f', 'lavfi', '-i', 'sine=f=900:d=3']));
const WHOOSH = await imp(gen('whoosh.wav', ['-f', 'lavfi', '-i', 'anoisesrc=d=0.8']));
const sfx = (id, ref, tag) => ({ id, ref, jenis: 'sfx', nama: id, tag, lisensi: { status: 'milik_sendiri', bukti: '', iklan: true } });
await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS', aset: [sfx('pop', POP, ['teks-muncul', 'kata-kunci']), sfx('whoosh', WHOOSH, ['transisi'])] }, actor: 'user' });
await core.createProject(ws, { project_id: 'r27', name: 'Uji Library' });
await svc.editTimeline({ project_id: 'r27', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: A, start_ms: 0, duration_ms: 2000 },
  { op: 'add_clip', track_kind: 'video', media: B, start_ms: 2000, duration_ms: 2000 },
] });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'r27');
const lane = (p, kind) => p.timeline.tracks.find((t) => t.kind === kind)?.clips ?? [];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
  // Count the sounds that really start playing (HTMLMediaElement.play resolves).
  await page.addInitScript(() => {
    window.__played = [];
    const orig = globalThis.HTMLMediaElement.prototype.play;
    globalThis.HTMLMediaElement.prototype.play = function () {
      const p = orig.call(this);
      if (this.dataset.vid) p.then(() => window.__played.push(this.dataset.vid)).catch(() => undefined);
      return p;
    };
  });
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  const played = () => page.evaluate(() => window.__played.slice());

  // ---- Brand → Aset: ▶ dengar.
  await nav.getByRole('button', { name: /Brand/ }).click();
  const lib = page.getByRole('region', { name: 'Pengaturan Brand Kit' }).getByRole('group', { name: 'Library aset brand' });
  await lib.getByRole('group', { name: 'Aset pop' }).waitFor();
  await lib.getByRole('button', { name: 'Dengar aset pop' }).click();
  check('R27-01 Brand → Aset: ▶ dengar memutar SFX (tombol jadi ■ Hentikan)', (await until(async () => (await played()).includes(POP.version_id))) && (await lib.getByRole('button', { name: 'Hentikan aset pop' }).getAttribute('aria-pressed')) === 'true');
  await lib.getByRole('button', { name: 'Hentikan aset pop' }).click();
  check('R27-02 Klik lagi → berhenti (kembali ▶)', await until(() => lib.getByRole('button', { name: 'Dengar aset pop' }).isVisible()));

  // ---- Editor: Library panel.
  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  await page.getByRole('heading', { name: 'Uji Library' }).waitFor();
  const L = page.getByRole('region', { name: 'Library efek' });
  const tabs = await L.getByRole('tab').allInnerTexts();
  check('R27-03 Panel Library di Editor: tab SFX, VO, Transisi, Efek, Teks', tabs.join('|') === 'SFX|VO|Transisi|Efek|Teks', tabs.join('|'));
  const sfxPanel = L.getByRole('tabpanel', { name: 'SFX' });
  check('R27-04 Tab SFX berisi SFX dari Aset brand (2)', (await sfxPanel.getByRole('group', { name: /^SFX / }).count()) === 2);
  await sfxPanel.getByLabel('Cari SFX').fill('transisi');
  check('R27-05 Cari per tag "transisi" → hanya whoosh', (await sfxPanel.getByRole('group', { name: /^SFX / }).count()) === 1 && (await sfxPanel.getByRole('group', { name: 'SFX whoosh' }).count()) === 1);
  await sfxPanel.getByLabel('Cari SFX').fill('');
  await sfxPanel.getByRole('button', { name: 'Saring tag teks-muncul' }).click();
  check('R27-06 Chip tag #teks-muncul → hanya pop', (await sfxPanel.getByRole('group', { name: /^SFX / }).count()) === 1 && (await sfxPanel.getByRole('group', { name: 'SFX pop' }).count()) === 1);
  await sfxPanel.getByRole('button', { name: 'Saring tag teks-muncul' }).click();
  const before = (await played()).length;
  await sfxPanel.getByRole('button', { name: 'Dengar whoosh' }).click();
  check('R27-07 ▶ dengar di Editor memutar SFX itu', await until(async () => (await played()).slice(before).includes(WHOOSH.version_id)));
  const rev0 = (await proj()).revision;
  await sfxPanel.getByRole('button', { name: 'Tambah pop di playhead' }).click();
  check('R27-08 ＋ SFX → klip SFX di playhead (0 dtk), panjang = file (3 dtk), satu revisi', await until(async () => {
    const s = lane(await proj(), 'sfx');
    return s.length === 1 && s[0].start_ms === 0 && s[0].end_ms === 3000 && (await proj()).revision === rev0 + 1;
  }));
  await sfxPanel.getByRole('button', { name: 'Tambah whoosh di playhead' }).click();
  check('R27-09 ＋ SFX kedua di tempat terisi → di slot bebas berikutnya (3 dtk), tidak error tumpang tindih', await until(async () => lane(await proj(), 'sfx').map((c) => c.start_ms).join() === '0,3000'));

  // ---- Transisi: on the cut nearest to the playhead (start of clip B).
  await L.getByRole('tab', { name: 'Transisi' }).click();
  const tp = L.getByRole('tabpanel', { name: 'Transisi' });
  check('R27-10 Tab Transisi menunjukkan sasaran: klip yang masuk di 2,0 dtk', (await tp.getByLabel('Sasaran transisi').innerText()).includes('2,0 dtk'));
  const revT = (await proj()).revision;
  await tp.getByRole('button', { name: 'Pasang transisi Spin (putar)' }).click();
  const vB = async () => lane(await proj(), 'video').find((c) => c.media.version_id === B.version_id);
  check('R27-11 Pasang Spin → klip B transisi spin 500 ms (satu revisi)', (await until(async () => (await vB()).transition?.type === 'spin')) && (await vB()).transition.ms === 500 && (await proj()).revision === revT + 1);
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R27-12 Undo → transisi hilang (satu langkah)', await until(async () => !(await vB()).transition));

  // ---- Efek: zoom + filter on the clip under the playhead.
  await L.getByRole('tab', { name: 'Efek' }).click();
  const ep = L.getByRole('tabpanel', { name: 'Efek' });
  await ep.getByRole('button', { name: 'Tambah Zoom kuat 1,5×' }).click();
  check('R27-13 Zoom kuat → klip efek zoom 1,5× 1 dtk di playhead', await until(async () => {
    const e = lane(await proj(), 'effects');
    return e.length === 1 && e[0].effect.scale === 1.5 && e[0].start_ms === 0 && e[0].end_ms === 1000;
  }));
  await ep.getByRole('button', { name: 'Pasang filter Vintage' }).click();
  const vA = async () => lane(await proj(), 'video').find((c) => c.media.version_id === A.version_id);
  check('R27-14 Filter Vintage → klip di playhead (A) memakai look vintage', await until(async () => (await vA()).look === 'vintage'));
  await ep.getByRole('button', { name: 'Hapus filter' }).click();
  check('R27-15 "Tanpa filter" → look dihapus', await until(async () => !(await vA()).look));

  // ---- Teks preset.
  await L.getByRole('tab', { name: 'Teks' }).click();
  await L.getByRole('tabpanel', { name: 'Teks' }).getByRole('button', { name: 'Library teks CTA' }).click();
  check('R27-16 Teks CTA → klip teks CTA dengan gaya preset', await until(async () => lane(await proj(), 'text').some((c) => c.text === 'Cek keranjang kuning sekarang!' && c.style?.bg === '#ffd23f')));
  await page.screenshot({ path: path.join(EVID, 'library.png') });
  check('R27-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R27-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R27 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
