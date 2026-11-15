// R22 (owner 15 Nov): projects are split per feature. Each feature page's "Proyek" list shows only
// its own projects of the chosen brand ("＋ Proyek baru" first); old projects without a feature are
// guessed from their name; Edit still lists everything with chips Semua · Video iklan · Batch ·
// Beat Spot · Motion Transfer. A Beat Spot run creates a project marked beatspot.
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
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r22-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const engine = path.join(work, 'engine');
await fsp.mkdir(engine, { recursive: true });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args], { windowsHide: true });
const mall = path.join(work, 'mall.mp4');
const sound = path.join(work, 'sound.wav');
ff(['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mall]);
ff(['-f', 'lavfi', '-i', 'sine=f=440:d=8', sound]);
const A = (await svc.createBrand({ kit: { name: 'Aysilla Factory', kode: 'AYS' }, actor: 'user' })).result.brand_id; // default brand
const B = (await svc.createBrand({ kit: { name: 'Brand Kedua', kode: 'BKD' }, actor: 'user' })).result.brand_id;
const SEED = [];
const mk = async (id, name, fitur, brand) => {
  SEED.push(id);
  await core.createProject(ws, { project_id: id, name, ...(fitur ? { fitur } : {}) });
  if (brand) await svc.updateProjectMeta({ project_id: id, expected_revision: 0, brand_id: brand, actor: 'user' });
};
await mk('bs-a', 'Sore di mall', 'beatspot', A);
await mk('bs-b', 'Kedua beat', 'beatspot', B);
await mk('bs-def', 'Beat Spot lama', null, null); // old, no brand → default brand A, guessed by name
await mk('ik-a', 'Iklan gamis', 'iklan', A);
await mk('ik-old', 'Generate Gamis 14 Nov', null, A); // old, guessed iklan
await mk('tr-a', 'Transfer jilbab', 'transfer', A);
await mk('bt-old', 'Batch Sore · 14 Nov 10.00', null, A);
await mk('ed-a', 'Promo Lebaran', 'editor', A);

const server = await start(
  { MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state'), MOTION_ENGINE_ROOT: engine, MOTION_ENGINE_PYTHON: process.execPath, MOTION_ENGINE_SCRIPT: FAKE },
  () => undefined,
);
const base = `http://127.0.0.1:${server.port}/`;
const listProjects = async () => (await (await fetch(`${base}api/projects`, { headers: { authorization: `Bearer ${server.app.token}` } })).json()).projects;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}#token=${server.app.token}`);
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  const select = (name) => page.locator(`select[aria-label="${name}"]:visible`);
  // "＋ Proyek baru" first, then the projects (newest first) — compared as a sorted set.
  const options = async () => {
    const [first, ...rest] = (await select('Proyek tujuan').locator('option').allInnerTexts()).map((t) => t.trim());
    return [first, ...rest.sort()];
  };
  const openFitur = async (nama) => {
    await nav.getByRole('button', { name: /Buat video/ }).click();
    await page.getByRole('button', { name: new RegExp(`^Buka ${nama}`) }).click();
    await until(async () => (await select('Brand').inputValue()) !== '');
  };

  await openFitur('Beat Spot');
  const bsA = await options();
  check('R22-01 Beat Spot: hanya proyek Beat Spot brand terpilih (＋ Proyek baru paling atas; lama tanpa brand ikut brand bawaan)', bsA.join('|') === '＋ Proyek baru|Beat Spot lama|Sore di mall', bsA.join('|'));
  await select('Brand').selectOption(B);
  const bsB = await until(async () => (await options()).join('|') === '＋ Proyek baru|Kedua beat');
  check('R22-02 Ganti brand → daftar ikut brand itu', bsB, (await options()).join('|'));
  await select('Brand').selectOption(A);

  await openFitur('Video iklan');
  const ik = await options();
  check('R22-03 Video iklan: hanya proyek iklan (proyek lama "Generate …" ditebak iklan)', ik.join('|') === '＋ Proyek baru|Generate Gamis 14 Nov|Iklan gamis', ik.join('|'));
  await openFitur('Motion Transfer');
  const tr = await options();
  check('R22-04 Motion Transfer: hanya proyek Motion Transfer', tr.join('|') === '＋ Proyek baru|Transfer jilbab', tr.join('|'));

  // A Beat Spot run on "＋ Proyek baru" makes a project marked beatspot.
  await openFitur('Beat Spot');
  const form = page.getByRole('region', { name: 'Footage dan sound' });
  await form.getByLabel('Footage orang').setInputFiles([mall]);
  await form.getByLabel('Sound tim').setInputFiles(sound);
  await form.getByRole('button', { name: /Susun Beat Spot/ }).click();
  await until(async () => (await page.getByRole('region', { name: 'Hasil Beat Spot' }).getByRole('table', { name: 'Daftar potongan' }).locator('tbody tr').count()) > 0, 30000);
  const made = (await listProjects()).filter((p) => !SEED.includes(p.project_id));
  check('R22-05 Proyek baru dari Beat Spot tercatat fitur beatspot + brand terpilih', made.length === 1 && made[0].fitur === 'beatspot' && made[0].brand_id === A, JSON.stringify(made.map((p) => [p.name, p.fitur, p.brand_id])));

  await nav.getByRole('button', { name: /^2\. Edit$/ }).click();
  const chips = page.getByRole('group', { name: 'Saring fitur' });
  await chips.waitFor();
  const chipNames = (await chips.getByRole('button').allInnerTexts()).map((t) => t.trim());
  const side = page.locator('button.project');
  const allCount = await side.count();
  check('R22-06 Edit: semua proyek tampil + chip Semua · Video iklan · Batch · Beat Spot · Motion Transfer', chipNames.join('|') === 'Semua|Video iklan|Batch|Beat Spot|Motion Transfer' && allCount === 9, `${chipNames.join('|')} · ${allCount} proyek`);
  await chips.getByRole('button', { name: 'Beat Spot' }).click();
  const bsRows = await side.allInnerTexts();
  check('R22-07 Chip "Beat Spot" → hanya proyek Beat Spot (semua brand), tiap baris berlabel fitur', bsRows.length === 4 && bsRows.every((t) => t.includes('Beat Spot ·')), bsRows.map((t) => t.split('\n').slice(1).join(' ')).join(' | '));
  await page.screenshot({ path: path.join(EVID, 'edit-chip.png'), fullPage: true });
  await chips.getByRole('button', { name: 'Batch' }).click();
  const btRows = await side.allInnerTexts();
  check('R22-08 Chip "Batch" → proyek lama "Batch …" ditebak Batch', btRows.length === 1 && btRows[0].includes('Batch Sore'), btRows.map((t) => t.split('\n').slice(1).join(' ')).join(' | '));
  await chips.getByRole('button', { name: 'Semua' }).click();
  await page.getByLabel('Nama proyek baru').first().fill('Bikin di Edit');
  await page.getByTitle('Buat proyek').click();
  await until(async () => (await side.count()) === 10);
  const ed = (await listProjects()).find((p) => p.name === 'Bikin di Edit');
  check('R22-09 Proyek dibuat di Edit = fitur Edit (tidak muncul di halaman fitur)', ed?.fitur === 'editor', String(ed?.fitur));
  check('R22-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R22-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R22 UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
