// W14 acceptance run: captions / speech-to-text from the real UI (built server + UI, real Chrome,
// real FFmpeg) against the local stand-in for the provider API (no real calls, no real cost).
// Evidence → audit/W14/evidence/.
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startFakeAi } from '../../scripts/fake-ai.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w14-'));
const wsRoot = path.join(work, 'ws');
const ws = await core.initWorkspace(wsRoot);
const svc = new core.StorageService(ws);
const talk = path.join(work, 'Talk.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-i', path.join(FIX, 'sample_8s_9x16.mp4'), '-c', 'copy', '-metadata', 'title=JUDUL-RAHASIA-UI-STT', talk], { windowsHide: true });
const imp = await svc.importMedia({ sourcePath: talk, scope: { kind: 'shared' }, display_name: 'Talk.mp4', actor: 'user' });
const silent = path.join(work, 'Diam.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-c:v', 'libx264', '-an', silent], { windowsHide: true });
await svc.importMedia({ sourcePath: silent, scope: { kind: 'shared' }, display_name: 'Diam.mp4', actor: 'user' });
await core.createProject(ws, { project_id: 'talk', name: 'Talking Head' });
await svc.editTimeline({ project_id: 'talk', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: { media_id: imp.media.media_id, version_id: imp.version.version_id }, start_ms: 1000, duration_ms: 6000 }] });
const proj = async () => core.readProject(await core.openWorkspace(wsRoot), 'talk');
const subs = async () => ((await proj()).timeline.tracks.find((t) => t.kind === 'subtitle')?.clips ?? []).map((c) => c.text);

const fake = await startFakeAi();
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: path.join(work, 'state') }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
await fetch(`${base}/api/ai/providers`, {
  method: 'POST',
  headers: { authorization: `Bearer ${server.app.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'openai', label: 'Whisper', model: 'whisper-1', api_key: 'sk-openai-ui-stt-KEY', capabilities: ['transcription'], base_url: fake.url, prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 0.006 } }),
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}/#token=${server.app.token}`);
  await page.getByRole('heading', { name: 'Talking Head' }).waitFor();
  check('TR-01 Tombol CC mati untuk media tanpa suara', await page.getByRole('button', { name: 'Transkrip Diam.mp4' }).isDisabled());

  await page.getByRole('button', { name: 'Transkrip Talk.mp4' }).click();
  const dlg = page.getByRole('dialog', { name: 'Transkrip: Talk.mp4' });
  await dlg.getByRole('button', { name: /Transkripsi \(≈ \$0\.0008\)/ }).waitFor();
  check('TR-02 Perkiraan biaya tampil sebelum apa pun dikirim (0,14 menit × $0.006)', fake.count('openai.transcribe') === 0 && (await dlg.getByText(/Whisper \(whisper-1\) · 0\.14 menit/).isVisible()));
  await page.screenshot({ path: path.join(EVID, 'stt-estimate.png') });

  await dlg.getByRole('button', { name: /Transkripsi \(≈/ }).click();
  const cues = dlg.getByLabel('Daftar cue');
  await cues.waitFor({ timeout: 30_000 });
  const firstText = await dlg.getByLabel('Teks cue 1').inputValue();
  const body = String(fake.state.requests.find((r) => r.key === 'openai.transcribe').body);
  check('TR-03 Transkripsi selesai → cue dari timestamp kata; audio terkirim tanpa metadata', firstText === 'Halo semua, ini promo spesial.' && !body.includes('JUDUL-RAHASIA') && /name="language"\r\n\r\nid/.test(body), firstText);

  // Edit: split into two cues.
  await dlg.getByLabel('Akhir cue 1 (detik)').fill('1.10');
  await dlg.getByLabel('Teks cue 1').fill('Halo semua!');
  await dlg.getByRole('button', { name: '＋ Tambah cue' }).click();
  await dlg.getByLabel('Mulai cue 2 (detik)').fill('1.0');
  await dlg.getByLabel('Akhir cue 2 (detik)').fill('2.6');
  await dlg.getByLabel('Teks cue 2').fill('Ini promo spesial.');
  await dlg.getByRole('button', { name: 'Simpan transkrip' }).click();
  await dlg.getByText(/tumpang tindih/).waitFor();
  check('TR-04 Cue tumpang tindih ditolak dengan pesan jelas', true);
  await dlg.getByLabel('Mulai cue 2 (detik)').fill('1.4');
  await dlg.getByRole('button', { name: 'Simpan transkrip' }).click();
  await dlg.getByText('Transkrip disimpan.').waitFor();
  const saved = (await (await fetch(`${base}/api/projects/talk/transcripts`, { headers: { authorization: `Bearer ${server.app.token}` } })).json()).transcripts[0];
  check('TR-05 Edit tersimpan (rev 1, 2 cue)', saved.rev === 1 && saved.cue_count === 2 && saved.edited === true);
  await page.screenshot({ path: path.join(EVID, 'stt-edit.png') });

  const revBefore = (await proj()).revision;
  await dlg.getByRole('button', { name: 'Jadikan subtitle' }).click();
  const planCard = dlg.getByLabel('Rencana subtitle');
  await planCard.waitFor();
  const diff = await planCard.locator('.diff').allInnerTexts();
  check('TR-06 Rencana subtitle: geser +1 dtk sesuai posisi klip, belum mengubah proyek', JSON.stringify(diff) === JSON.stringify(['+ subtitle “Halo semua!” 0:01.2–0:02.1', '+ subtitle “Ini promo spesial.” 0:02.4–0:03.6']) && (await proj()).revision === revBefore, diff.join(' | '));
  await planCard.getByRole('button', { name: 'Terapkan (2)' }).click();
  await dlg.getByText(/2 subtitle masuk ke linimasa/).waitFor();
  check('TR-07 Diterapkan: 2 subtitle di linimasa, satu revisi', JSON.stringify(await subs()) === '["Halo semua!","Ini promo spesial."]' && (await proj()).revision === revBefore + 1);
  await dlg.getByRole('button', { name: 'Tutup' }).last().click();
  await page.locator('.track .clip', { hasText: 'Halo semua!' }).waitFor();
  await page.screenshot({ path: path.join(EVID, 'stt-subtitles.png') });

  await page.getByRole('button', { name: '↶ Undo' }).first().click();
  await page.locator('.track .clip', { hasText: 'Halo semua!' }).waitFor({ state: 'detached' });
  check('TR-08 Undo menghapus semua subtitle dari transkrip sekaligus', (await subs()).length === 0);

  await page.getByRole('button', { name: 'Transkrip Talk.mp4' }).click();
  await dlg.getByLabel('Teks cue 2').waitFor();
  check('TR-09 Buka lagi: transkrip yang sudah diedit langsung tampil (tanpa bayar lagi)', (await dlg.getByLabel('Teks cue 1').inputValue()) === 'Halo semua!' && fake.count('openai.transcribe') === 1);
  await dlg.getByRole('button', { name: 'Tutup' }).last().click();

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${base}/#token=${server.app.token}`);
  await phone.getByRole('heading', { name: 'Talking Head' }).waitFor();
  await phone.getByRole('button', { name: 'Transkrip Talk.mp4' }).click();
  await phone.getByLabel('Daftar cue').waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'stt-phone.png') });
  check('TR-10 HP 390px: dialog transkrip tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('TR-11 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('TR-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
  await fake.close();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW14 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
