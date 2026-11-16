// R23e (owner 16 Nov): chroma key / green screen untuk video/gambar di track overlay (R26) —
// Inspector: aktifkan, warna kunci (preset / pilih / pipet), toleransi, tepi halus; pratinjau
// membuat warna kunci transparan (rumus sama dengan render FFmpeg chromakey); undo.
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-r23e-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const gen = async (name, filter) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', f], { windowsHide: true });
  const r = await svc.importMedia({ sourcePath: f, scope: { kind: 'shared' }, display_name: name, actor: 'user' });
  return { media_id: r.media.media_id, version_id: r.version.version_id };
};
const blue = await gen('biru.mp4', 'color=c=blue:s=360x640:r=30:d=3');
const gs = await gen('greenscreen.mp4', 'color=c=0x00ff00:s=360x640:r=30:d=3,drawbox=x=120:y=240:w=120:h=160:color=red:t=fill');
await core.createProject(ws, { project_id: 'r23e', name: 'Uji Green Screen' });
await svc.editTimeline({ project_id: 'r23e', expected_revision: 0, actor: 'user', ops: [
  { op: 'add_clip', track_kind: 'video', media: blue, start_ms: 0, duration_ms: 3000 },
  { op: 'add_clip', track_kind: 'overlay', media: gs, start_ms: 0, duration_ms: 3000, overlay: { pos: 'c', dx: 0, dy: 0, skala: 60, opasitas: 1, margin: 0, layer: 0 } },
] });
const ov = async () => (await core.readProject(await core.openWorkspace(wsRoot), 'r23e')).timeline.tracks.find((t) => t.kind === 'overlay').clips[0];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4|MEDIA_ERR|DEMUXER|PIPELINE/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Green Screen' }).waitFor();
  await page.locator('.track[data-kind="overlay"] .clip').first().click();
  const panel = page.getByRole('region', { name: 'Inspector klip' }).getByRole('group', { name: 'Chroma key' });
  check('R23E-01 Klip overlay → grup "Chroma key" di Inspector', await until(() => panel.isVisible()));
  await panel.getByLabel('Chroma key').click();
  check('R23E-02 Aktifkan → chroma hijau #00ff00 tersimpan', await until(async () => (await ov()).chroma?.warna === '#00ff00'));
  const cv = page.locator('canvas[aria-label="Overlay chroma key"]');
  check('R23E-03 Pratinjau: overlay digambar lewat kanvas chroma', await until(async () => (await cv.count()) === 1 && (await cv.getAttribute('data-chroma')) === '#00ff00'));
  const alpha = await until(async () => {
    const a = await cv.evaluate((c) => {
      const ctx = c.getContext('2d');
      if (!c.width) return null;
      const at = (x, y) => ctx.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data;
      return { tepi: at(0.05, 0.05)[3], subjek: at(0.5, 0.5)[3], merah: at(0.5, 0.5)[0] };
    });
    return a && a.tepi < 20 && a.subjek > 230 && a.merah > 150;
  });
  check('R23E-04 Pratinjau: latar hijau transparan, subjek merah tetap (rumus = render)', alpha);
  await page.screenshot({ path: path.join(EVID, 'green-screen.png') });
  await panel.getByRole('button', { name: 'Kunci biru' }).click();
  check('R23E-05 Preset "Biru" → warna kunci #0000ff', await until(async () => (await ov()).chroma?.warna === '#0000ff'));
  await panel.getByLabel('Toleransi chroma').fill('30');
  check('R23E-06 Toleransi 30% tersimpan (satu simpan setelah berhenti)', await until(async () => (await ov()).chroma?.toleransi === 0.3));
  check('R23E-07 Pipet warna (EyeDropper browser) tersedia', (await panel.getByRole('button', { name: 'Pipet warna' }).count()) === 1 || !(await page.evaluate(() => 'EyeDropper' in window)), String(await page.evaluate(() => 'EyeDropper' in window)));
  await page.getByRole('button', { name: '↶ Undo' }).click();
  check('R23E-08 Undo → toleransi kembali', await until(async () => (await ov()).chroma?.toleransi === 0.15));
  await panel.getByLabel('Chroma key').click();
  check('R23E-09 Matikan → chroma hilang, overlay biasa lagi', await until(async () => (await ov()).chroma === undefined) && (await until(async () => (await cv.count()) === 0)));
  const res = await core.renderProject(await core.openWorkspace(wsRoot), { project_id: 'r23e', output_name: 'gs.mp4', actor: 'user' }, { settings: { short_side: 180, preset: 'ultrafast' } });
  check('R23E-10 Render tetap jalan', res.status === 'completed');
  check('R23E-99 0 error JS', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('R23E-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify(results, null, 2));
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const pass = results.filter((r) => r.ok).length;
console.log(`R23E UI: ${pass}/${results.length} lulus`);
process.exit(pass === results.length ? 0 : 1);
