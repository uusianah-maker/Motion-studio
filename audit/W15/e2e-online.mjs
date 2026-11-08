// W15 acceptance run: the whole app "online" the way PC-14 deploys it, end to end in real Chrome:
//   Chrome → https://motion.example.test (TLS proxy = stand-in for Caddy on the VPS, Host kept)
//         → Motion Studio on 127.0.0.1 (Google login mode, MOTION_PUBLIC_URL https)
// with a stand-in Google (login) and stand-in AI provider (transcription). Real FFmpeg render.
// One journey: login → project → upload → timeline → Copilot → captions → render → play →
// download (metadata clean) → logout. Plus deploy-file sanity checks. Evidence → audit/W15/evidence/.
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startFakeAi } from '../../scripts/fake-ai.mjs';
import { startFakeGoogle } from '../../scripts/fake-google.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const EVID = path.join(here, 'evidence');
const FIX = path.join(root, 'audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MOTION_FFPROBE || 'ffprobe';
const HOSTNAME = 'motion.example.test';
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const { start } = await import(pathToFileURL(path.join(root, 'apps/server/dist/main.js')).href);
const { checkDeploy } = await import(pathToFileURL(path.join(root, 'scripts/check-deploy.mjs')).href);

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// ---------------------------------------------------------------- deploy files (static checks)
{
  const sh = readFileSync(path.join(root, 'deploy/vps/setup-vps.sh'), 'utf8');
  const bashOk = spawnSync('bash', ['-n', path.join(root, 'deploy/vps/setup-vps.sh')]).status === 0;
  check('DP-01 setup-vps.sh: sintaks bash valid', bashOk);
  check(
    'DP-02 Terowongan dikunci: key hanya boleh 127.0.0.1:14317, tanpa shell/TTY/agent/X11, GatewayPorts no',
    sh.includes('restrict,port-forwarding,permitlisten="127.0.0.1:%s"') && /ForceCommand \/usr\/sbin\/nologin/.test(sh) && /PermitTTY no/.test(sh) && /GatewayPorts no/.test(sh) && /AllowTcpForwarding remote/.test(sh) && /--shell \/usr\/sbin\/nologin/.test(sh),
  );
  check('DP-03 Caddy: HTTPS otomatis, Host diteruskan apa adanya ke 127.0.0.1:14317, HSTS; firewall hanya SSH/80/443', /reverse_proxy 127\.0\.0\.1:\$\{TUNNEL_PORT\}/.test(sh) && /Strict-Transport-Security/.test(sh) && !/header_up Host/.test(sh) && /ufw allow 80\/tcp/.test(sh) && /ufw allow 443\/tcp/.test(sh));
  if (process.platform === 'win32') {
    const bad = [];
    for (const f of ['start-motion.ps1', 'start-tunnel.ps1', 'install-autostart.ps1']) {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'deploy/windows', f)}', [ref]$null, [ref]$e); exit $e.Count`]);
      if (r.status !== 0) bad.push(f);
    }
    const tun = readFileSync(path.join(root, 'deploy/windows/start-tunnel.ps1'), 'utf8');
    check('DP-04 Skrip Windows: sintaks PowerShell valid; terowongan wajib kenal sidik jari VPS + sambung ulang', !bad.length && /StrictHostKeyChecking=yes/.test(tun) && /ExitOnForwardFailure=yes/.test(tun) && /while \(\$true\)/.test(tun), bad.join(', '));
  }
}

// ---------------------------------------------------------------- the online journey
await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w15-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
const upload = path.join(work, 'Talk.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-i', path.join(FIX, 'sample_8s_9x16.mp4'), '-c', 'copy', '-metadata', 'title=JUDUL-RAHASIA-ONLINE-9001', '-metadata', 'location=+06.1754+106.8272/', upload], { windowsHide: true });

const CLIENT_ID = 'w15.apps.googleusercontent.com';
const google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-w15' });
const ai = await startFakeAi();
const appPort = await freePort();
const env = {
  MOTION_WORKSPACE: wsRoot,
  MOTION_PORT: String(appPort),
  MOTION_GC: 'off',
  MOTION_UPLOAD_TMP: work,
  MOTION_RENDER_TMP: work,
  MOTION_STATE_DIR: path.join(work, 'state'),
  MOTION_PUBLIC_URL: `https://${HOSTNAME}`,
  MOTION_GOOGLE_CLIENT_ID: CLIENT_ID,
  MOTION_GOOGLE_CLIENT_SECRET: 'GOCSPX-w15',
  MOTION_ALLOWED_EMAILS: 'owner@example.com',
  MOTION_GOOGLE_AUTH_ENDPOINT: google.authUrl,
  MOTION_GOOGLE_TOKEN_ENDPOINT: google.tokenUrl,
};
const server = await start(env, () => undefined);

// TLS reverse proxy = Caddy on the VPS: keeps Host, streams bodies both ways (uploads, Range).
const proxy = https.createServer({ key: readFileSync(path.join(here, 'fixtures/test-only.key')), cert: readFileSync(path.join(here, 'fixtures/test-only.crt')) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = proxy.address().port;
const base = `https://${HOSTNAME}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1:${proxyPort}`] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && errors.push(m.text()));
  const first = await page.goto(`${base}/`);
  await page.getByRole('link', { name: /Masuk dengan Google/ }).waitFor();
  const hsts = (await first.allHeaders())['strict-transport-security'];
  check('EJ-01 Lewat https://domain: halaman masuk Google, HSTS aktif, CSP aktif', !!hsts && !!(await first.allHeaders())['content-security-policy'], `HSTS ${hsts}`);

  await page.getByRole('link', { name: /Masuk dengan Google/ }).click();
  await page.getByRole('button', { name: 'Keluar (owner@example.com)' }).waitFor({ timeout: 20_000 });
  const sid = (await ctx.cookies(base)).find((c) => c.name === '__Host-motion_sid');
  check('EJ-02 Login Google lewat domain: cookie __Host- + Secure + HttpOnly + Strict', sid?.secure && sid.httpOnly && sid.sameSite === 'Strict' && page.url() === `${base}/`, page.url());

  // Project + upload through the proxy (raw body streamed).
  await page.getByPlaceholder('Nama proyek baru').fill('Promo Online');
  await page.getByPlaceholder('Nama proyek baru').press('Enter');
  await page.getByRole('heading', { name: 'Promo Online' }).waitFor();
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await page.getByLabel('Pilih file media').setInputFiles(upload);
  await page.getByText('Talk.mp4').first().waitFor({ timeout: 30_000 });
  let v;
  for (let i = 0; i < 100 && !v?.probe; i++) {
    v = Object.values((await core.loadRegistry(await core.openWorkspace(wsRoot))).versions)[0];
    if (!v?.probe) await page.waitForTimeout(100);
  }
  check('EJ-03 Upload lewat proxy: tersimpan di workspace PC, ukuran & durasi terbaca', v && v.size === (await fsp.stat(upload)).size && v.probe?.duration_ms > 7000, v ? `${v.size} B, ${v.probe?.duration_ms} ms` : 'tidak ada');

  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await page.getByRole('button', { name: 'Tambah Talk.mp4 ke linimasa' }).click();
  await page.locator('.track .clip', { hasText: 'Talk.mp4' }).waitFor();
  const projectId = (await core.listProjectIds(await core.openWorkspace(wsRoot)))[0];
  const proj = async () => core.readProject(await core.openWorkspace(wsRoot), projectId);

  // Preview stream (signed URL + Range) through the proxy.
  await page.getByRole('button', { name: /Putar/ }).first().click().catch(() => undefined);
  let dur = 0;
  for (let i = 0; i < 60 && !(dur > 0); i++) {
    dur = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('video')].map((x) => x.duration || 0)));
    await page.waitForTimeout(100);
  }
  check('EJ-04 Pratinjau video diputar lewat domain (link bertanda tangan + Range)', dur > 7, `durasi ${dur}`);
  await page.getByRole('button', { name: /Jeda/ }).first().click().catch(() => undefined);

  // Copilot (local rules).
  const panel = page.getByRole('region', { name: 'Motion Copilot' });
  await panel.getByLabel('Perintah Copilot').fill('hook "Diskon 50% hari ini!" 2 detik');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await panel.getByLabel('Rencana edit').getByRole('button', { name: /Terapkan/ }).click();
  await page.locator('.track .clip', { hasText: 'Diskon 50% hari ini!' }).waitFor();
  check('EJ-05 Copilot lokal: hook masuk linimasa', (await proj()).timeline.tracks.some((t) => t.kind === 'text' && t.clips.length === 1));

  // Captions: AI connection (stand-in Whisper) → CC → transcribe → subtitles.
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const conns = page.getByRole('region', { name: 'Koneksi AI' });
  await conns.getByText('＋ Tambah koneksi').click();
  await conns.getByLabel('Provider').selectOption('openai');
  await conns.getByLabel('Nama koneksi').fill('Whisper');
  await conns.getByLabel('Model').fill('whisper-1');
  await conns.getByLabel('API key').fill('sk-openai-online-KEY1');
  await conns.getByLabel('Alamat server').fill(ai.url);
  await conns.getByRole('checkbox', { name: /Copilot/ }).uncheck();
  await conns.getByRole('checkbox', { name: /Transkripsi/ }).check();
  await conns.getByLabel('Harga per menit audio').fill('0.006');
  await conns.getByRole('button', { name: 'Simpan koneksi' }).click();
  await conns.getByText(/^1\. Whisper$/).waitFor();
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await page.getByRole('button', { name: 'Transkrip Talk.mp4' }).click();
  const dlg = page.getByRole('dialog', { name: 'Transkrip: Talk.mp4' });
  await dlg.getByRole('button', { name: /Transkripsi \(≈/ }).click();
  await dlg.getByLabel('Daftar cue').waitFor({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Jadikan subtitle' }).click();
  await dlg.getByLabel('Rencana subtitle').getByRole('button', { name: /Terapkan/ }).click();
  await dlg.getByText(/subtitle masuk ke linimasa/).waitFor();
  await dlg.getByRole('button', { name: 'Tutup' }).last().click();
  const sttBody = String(ai.state.requests.find((r) => r.key === 'openai.transcribe')?.body ?? '');
  check('EJ-06 Caption: transkrip → subtitle di linimasa; audio ke provider tanpa metadata', (await proj()).timeline.tracks.some((t) => t.kind === 'subtitle' && t.clips.length === 1) && sttBody.length > 0 && !sttBody.includes('JUDUL-RAHASIA'));
  await page.screenshot({ path: path.join(EVID, 'online-editor.png') });

  // Render + download through the domain.
  await page.getByRole('button', { name: '↧ Render' }).click();
  const rd = page.getByRole('dialog', { name: 'Render MP4' });
  await rd.getByLabel('Nama file output').fill('Promo Online');
  await rd.getByLabel('Resolusi render').selectOption('720');
  await rd.getByRole('button', { name: /Mulai render/ }).click();
  await rd.getByText('Selesai', { exact: true }).waitFor({ timeout: 120_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), rd.getByRole('button', { name: 'Unduh Promo Online.mp4' }).click()]);
  const saved = path.join(work, 'downloaded.mp4');
  await dl.saveAs(saved);
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', saved], { encoding: 'utf8', windowsHide: true }));
  const bytes = (await fsp.readFile(saved)).toString('latin1');
  const leaks = ['JUDUL-RAHASIA', '106.8272', 'Lavf', 'Lavc', 'x264'].filter((m) => bytes.includes(m));
  const tags = Object.keys(probe.format.tags ?? {}).sort().join(',');
  check('EJ-07 Render 720p lalu unduh lewat domain: H.264/AAC, metadata bersih', probe.streams.some((s) => s.codec_name === 'h264' && s.width === 720) && probe.streams.some((s) => s.codec_name === 'aac') && leaks.length === 0 && tags === 'compatible_brands,major_brand,minor_version', `tag ${tags}; bocor ${leaks.join(',') || '-'}`);
  await page.screenshot({ path: path.join(EVID, 'online-render.png') });
  await rd.getByRole('button', { name: 'Tutup' }).last().click();

  // From another site: blocked. Direct access to the app port with the public Host header but no session: 401.
  const evil = await ctx.newPage();
  await evil.goto(`http://localhost:${google.port}/other-site`);
  const forged = await evil.evaluate(async (target) => {
    try {
      const r = await fetch(`${target}/api/projects`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-motion-request': '1' }, body: '{"name":"PALSU"}' });
      return r.status;
    } catch {
      return 'blocked';
    }
  }, base);
  await evil.close();
  check('EJ-08 Situs lain tidak bisa memakai sesi lewat domain', (await core.listProjectIds(await core.openWorkspace(wsRoot))).length === 1, String(forged));

  // Pre-flight checker against the live "online" setup (through the proxy).
  const lines = await checkDeploy(env, `https://127.0.0.1:${proxyPort}`, (u, o) =>
    new Promise((resolve, reject) => {
      const url = new URL(u);
      const r = https.request({ host: '127.0.0.1', port: proxyPort, path: url.pathname, method: 'GET', headers: { host: HOSTNAME, ...(o?.headers ?? {}) }, rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.entries(res.headers).filter(([, v]) => typeof v === 'string') })));
      });
      r.on('error', reject);
      r.end();
    }),
  );
  const fails = lines.filter((l) => l.level === 'FAIL').map((l) => l.what);
  check('EJ-09 check:deploy: konfigurasi online lulus (login Google wajib, HSTS, API menolak tanpa login)', !fails.length && lines.some((l) => l.what === 'Akses publik wajib login Google' && l.level === 'OK'), fails.join('; '));

  await page.getByRole('button', { name: 'Keluar (owner@example.com)' }).click();
  await page.getByText('Anda sudah keluar.').waitFor();
  const after = await page.evaluate(async () => (await fetch('/api/session', { headers: { 'x-motion-request': '1' } })).status);
  check('EJ-10 Keluar: sesi mati', after === 401);

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, ignoreHTTPSErrors: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${base}/`);
  await phone.getByRole('link', { name: /Masuk dengan Google/ }).click();
  await phone.getByRole('heading', { name: 'Promo Online' }).waitFor({ timeout: 20_000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'online-phone.png') });
  check('EJ-11 HP lewat domain: login + editor tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('EJ-12 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('EJ-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
  await new Promise((r) => proxy.close(r));
  await google.close();
  await ai.close();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW15 E2E online: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exitCode = failed.length ? 1 : 0;
