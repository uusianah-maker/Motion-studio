// X01 acceptance run: styled text in the real editor preview (built server + UI, real Chrome).
// The preview must place, size, colour and break the text exactly as the style says — the same
// numbers the render uses (the render side is proven pixel-wise in packages/core x01 tests).
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
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-x01-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
await core.createProject(ws, { project_id: 'gaya', name: 'Uji Gaya' });
const STYLE = { x: 0.3, y: 0.7, size: 9, width: 0.5, color: '#ff0000', bg: '#ffff00', bg_opacity: 1, bold: true, outline: false, align: 'left' };
const TEXT = 'Diskon besar hari ini untuk semua';
await svc.editTimeline({
  project_id: 'gaya',
  expected_revision: 0,
  actor: 'user',
  ops: [
    { op: 'add_clip', track_kind: 'text', text: TEXT, style: STYLE, start_ms: 0, duration_ms: 4000 },
    { op: 'add_clip', track_kind: 'subtitle', text: 'Subtitle bawaan', start_ms: 0, duration_ms: 4000 },
  ],
});

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const measure = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.canvas.live').getBoundingClientRect();
    return [...document.querySelectorAll('.overlayText.styled')].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { kind: el.dataset.kind, cx: (r.left + r.width / 2 - canvas.left) / canvas.width, cy: (r.top + r.height / 2 - canvas.top) / canvas.height, fontPx: parseFloat(cs.fontSize), short: Math.min(canvas.width, canvas.height), color: cs.color, bg: cs.backgroundColor, align: cs.textAlign, weight: cs.fontWeight, text: el.textContent };
    });
  });
try {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ viewport, isMobile: label === 'phone' })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
    await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
    await page.getByText('Ganti proyek').click().catch(() => undefined);
    await page.getByRole('button', { name: /Uji Gaya/ }).first().click().catch(() => undefined);
    await page.getByRole('heading', { name: 'Uji Gaya' }).waitFor();
    await page.locator('.overlayText.styled').first().waitFor();
    const [txt, sub] = await measure(page);
    const lines = core.layoutText(TEXT, core.effectiveStyle('text', STYLE), '9:16');
    check(
      `X1-${label}-01 Teks bergaya: pusat di (0.30, 0.70), ukuran 9% sisi pendek, merah di kotak kuning, rata kiri, tebal`,
      Math.abs(txt.cx - 0.3) < 0.02 && Math.abs(txt.cy - 0.7) < 0.02 && Math.abs(txt.fontPx - (txt.short * 9) / 100) < 0.6 && txt.color === 'rgb(255, 0, 0)' && txt.bg === 'rgb(255, 255, 0)' && txt.align === 'left' && Number(txt.weight) >= 700,
      `cx ${txt.cx.toFixed(3)} cy ${txt.cy.toFixed(3)} font ${txt.fontPx.toFixed(1)}/${((txt.short * 9) / 100).toFixed(1)}`,
    );
    check(`X1-${label}-02 Baris pratinjau = baris render (fungsi layout yang sama)`, txt.text === lines, JSON.stringify(txt.text));
    check(`X1-${label}-03 Subtitle tanpa gaya pakai bawaan (bawah tengah, kotak hitam)`, Math.abs(sub.cx - 0.5) < 0.02 && Math.abs(sub.cy - 0.78) < 0.03 && sub.bg.startsWith('rgba(0, 0, 0'), `cx ${sub.cx.toFixed(3)} cy ${sub.cy.toFixed(3)} ${sub.bg}`);
    await page.screenshot({ path: path.join(EVID, `styled-${label}.png`) });
    await page.context().close();
  }

  // Style change through the API → preview follows; undo brings the old look back.
  const p = await core.readProject(await core.openWorkspace(wsRoot), 'gaya');
  const id = p.timeline.tracks.find((t) => t.kind === 'text').clips[0].clip_id;
  const h = { authorization: `Bearer ${server.app.token}`, 'content-type': 'application/json' };
  const r = await fetch(`http://127.0.0.1:${server.port}/api/projects/gaya/edit`, { method: 'POST', headers: h, body: JSON.stringify({ expected_revision: p.revision, ops: [{ op: 'set_style', clip_id: id, style: { y: 0.3, color: '#00ff00', bg: null } }] }) }).then((x) => x.json());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.port}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Uji Gaya' }).waitFor();
  await page.locator('.overlayText.styled').first().waitFor();
  const [after] = await measure(page);
  check('X1-04 set_style lewat API: pratinjau ikut (y 0.30, hijau, tanpa kotak)', r.project?.history?.undo_label === 'Ubah gaya teks' && Math.abs(after.cy - 0.3) < 0.02 && after.color === 'rgb(0, 255, 0)' && after.bg === 'rgba(0, 0, 0, 0)', `${after.cy.toFixed(3)} ${after.color} ${after.bg}`);
  await page.getByRole('button', { name: '↶ Undo' }).first().click();
  await page.waitForTimeout(400);
  const [undone] = await measure(page);
  check('X1-05 Undo mengembalikan gaya lama', Math.abs(undone.cy - 0.7) < 0.02 && undone.color === 'rgb(255, 0, 0)', `${undone.cy.toFixed(3)} ${undone.color}`);
  check('X1-06 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('X1-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nX01 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
