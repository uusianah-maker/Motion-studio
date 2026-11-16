// Owner 16 Nov: play media straight from the Media page — ▶/⏸ for audio, an inline player for
// video, one thing at a time, nothing plays until ▶ (real Chrome).
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
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

const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-mplay-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
const gen = (name, args) => {
  const f = path.join(work, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, f], { windowsHide: true });
  return f;
};
const files = [
  gen('Musik Satu.mp3', ['-f', 'lavfi', '-i', 'sine=f=300:d=6']),
  gen('Suara Dua.wav', ['-f', 'lavfi', '-i', 'sine=f=600:d=6']),
  gen('Klip Video.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=180x320:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest']),
];

const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
for (const f of files) {
  const r = await fetch(`${base}/api/media/import?scope=shared`, { method: 'POST', body: await fsp.readFile(f), headers: { authorization: `Bearer ${server.app.token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.basename(f)) } });
  if (!r.ok) throw new Error(`import ${path.basename(f)}: ${r.status}`);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}/#token=${server.app.token}`);
  await page.getByRole('button', { name: /^Media/ }).first().click();
  const play = (name) => page.getByRole('button', { name: new RegExp(`^(Putar|Jeda) ${name}`) });
  await play('Musik Satu').waitFor();
  const audioState = () => page.evaluate(() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, src: a.currentSrc || a.src } : null; });
  check('MP-01 Tiap baris audio & video punya tombol ▶; tidak ada yang diputar sebelum ditekan', (await play('Musik Satu').count()) === 1 && (await play('Suara Dua').count()) === 1 && (await play('Klip Video').count()) === 1 && ((await audioState())?.paused ?? true));
  await play('Musik Satu').click();
  check('MP-02 ▶ musik → audio berputar, tombol jadi ⏸', await until(async () => !(await audioState()).paused && (await page.getByRole('button', { name: 'Jeda Musik Satu' }).count()) === 1), JSON.stringify(await audioState()));
  const first = (await audioState()).src;
  await play('Suara Dua').click();
  check('MP-03 ▶ audio lain → yang pertama berhenti, hanya satu yang berputar', await until(async () => { const s = await audioState(); return !s.paused && s.src !== first && (await page.getByRole('button', { name: 'Jeda Musik Satu' }).count()) === 0; }));
  await page.getByRole('button', { name: 'Jeda Suara Dua' }).click();
  check('MP-04 ⏸ menjeda', await until(async () => (await audioState()).paused && (await page.getByRole('button', { name: 'Putar Suara Dua' }).count()) === 1));
  await play('Klip Video').click();
  const vid = page.locator('tr.playRow video.mediaVideo');
  check('MP-05 ▶ video → pemutar video muncul di bawah barisnya (controls), audio tetap diam', await until(async () => (await vid.count()) === 1 && (await vid.evaluate((v) => v.controls && v.readyState >= 1)) && (await audioState()).paused));
  await play('Musik Satu').click();
  check('MP-06 ▶ audio saat video terbuka → video ditutup, audio berputar', await until(async () => (await vid.count()) === 0 && !(await audioState()).paused));
  check('MP-99 0 error JS', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('MP-XX run selesai tanpa exception', false, String(e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  await server.stop();
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
const ok = results.filter((r) => r.ok).length;
console.log(`MEDIAPLAY UI: ${ok}/${results.length} lulus`);
process.exit(ok === results.length ? 0 : 1);
