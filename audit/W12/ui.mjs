// W12 acceptance run: AI Provider Manager + AI planner + failover from the real UI (built server
// + UI, real Chrome) against a local stand-in for the official provider APIs (no real calls).
// Evidence → audit/W12/evidence/.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startFakeAi } from '../../scripts/fake-ai.mjs';

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
const KEY_A = 'sk-ant-ui-test-KEYA1111';
const KEY_O = 'sk-openai-ui-test-KEYO2222';

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w12-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
await core.createProject(await core.openWorkspace(wsRoot), { project_id: 'promo', name: 'Promo Lebaran' });
const stateDir = path.join(work, 'state');
const fake = await startFakeAi();
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: stateDir, MOTION_AI_DEV_ENDPOINTS: '1' }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const bodies = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && !m.text().includes('status of 503') && errors.push(m.text()));
  page.on('response', async (r) => {
    if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/#token=${server.app.token}`);
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const conns = page.getByRole('region', { name: 'Koneksi AI' });
  await conns.getByText('Belum ada koneksi').waitFor();
  check('AI-01 Halaman AI: belum ada koneksi, Copilot tetap lokal', true);

  const add = async ({ provider, model, key, name, pin, pout }) => {
    await conns.getByText('＋ Tambah koneksi').click();
    await conns.getByLabel('Provider').selectOption(provider);
    await conns.getByLabel('Nama koneksi').fill(name);
    await conns.getByLabel('Model').fill(model);
    await conns.getByLabel('API key').fill(key);
    await conns.getByLabel('Alamat server').fill(fake.url);
    await conns.getByLabel('Harga input').fill(pin);
    await conns.getByLabel('Harga output').fill(pout);
    await conns.getByRole('button', { name: 'Simpan koneksi' }).click();
    await conns.getByText(new RegExp(`^\\d\\. ${name}$`)).waitFor();
  };
  await add({ provider: 'anthropic', model: 'claude-opus-5-5', key: KEY_A, name: 'Claude utama', pin: '4', pout: '20' });
  const keyInDom = await page.evaluate((k) => document.documentElement.outerHTML.includes(k) || JSON.stringify({ ...localStorage, ...sessionStorage }).includes(k), KEY_A);
  check('AI-02 Tambah koneksi: tampil "…1111", key tidak ada di DOM/storage/balasan server', (await conns.getByText(/key …1111/).isVisible()) && !keyInDom && !bodies.some((b) => b.includes(KEY_A)), `balasan dicek: ${bodies.length}`);

  await conns.getByRole('button', { name: 'Tes Claude utama' }).click();
  await page.getByText('Tes Claude utama: berhasil.').waitFor();
  check('AI-03 Tes koneksi berhasil → status Siap; header resmi terkirim', (await conns.locator('.badge', { hasText: 'Siap' }).count()) === 1 && fake.state.requests.at(-1).headers['x-api-key'] === KEY_A);

  await add({ provider: 'openai', model: 'gpt-test', key: KEY_O, name: 'OpenAI cadangan', pin: '1', pout: '4' });
  check('AI-04 Koneksi kedua urutan 2', await conns.getByText(/^2\. OpenAI cadangan$/).isVisible());

  await page.getByLabel('Pilih mode Copilot').selectOption('ai');
  await page.getByText('Mode disimpan.').waitFor();
  await page.screenshot({ path: path.join(EVID, 'ai-page.png'), fullPage: true });

  // Editor: plan from AI.
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  const panel = page.getByRole('region', { name: 'Motion Copilot' });
  await panel.locator('.badge', { hasText: /^AI$/ }).waitFor();
  await panel.getByLabel('Perintah Copilot').fill('bikin hook yang bikin penasaran');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  const card = panel.getByLabel('Rencana edit');
  await card.waitFor();
  const costText = await card.getByText(/≈ \$/).innerText();
  check('AI-05 Rencana dari AI: badge provider + biaya (1200 in × $4 + 300 out × $20 = $0.0108)', (await card.getByText('AI · anthropic').isVisible()) && costText.includes('0.0108'), costText);
  await card.getByRole('button', { name: /Terapkan/ }).click();
  await page.locator('.track .clip', { hasText: 'Hook dari AI' }).waitFor();
  check('AI-06 Disetujui → klip "Hook dari AI" masuk linimasa', ((await core.readProject(await core.openWorkspace(wsRoot), 'promo')).revision === 1));
  await page.screenshot({ path: path.join(EVID, 'ai-plan-applied.png') });

  // Failover: primary overloaded ×3 → OpenAI.
  const down = { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } };
  fake.queue('anthropic.messages', down, down, down);
  fake.state.planJson = { operations: [{ op: 'add_clip', track_kind: 'text', text: 'Join live jam 7', start_ms: 5000, duration_ms: 2000 }], rationale: 'CTA penutup', warnings: [] };
  await panel.getByLabel('Perintah Copilot').fill('tambahkan CTA penutup');
  await panel.getByRole('button', { name: 'Buat rencana' }).click();
  await card.waitFor();
  check('AI-07 Failover: Claude overload 3× → rencana dari OpenAI', (await card.getByText('AI · openai').isVisible()) && fake.count('anthropic.messages') === 4, `panggilan claude ${fake.count('anthropic.messages')}`);
  await card.getByRole('button', { name: 'Tolak' }).click();

  // Back to AI page: the routing log shows it; primary on cooldown.
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const logTable = page.getByRole('region', { name: 'Log routing AI' });
  await logTable.getByText('ai.call · failed').first().waitFor();
  const logText = await logTable.innerText();
  check('AI-08 Log routing: gagal transient (anthropic) lalu ok (openai), tanpa key', /transient/.test(logText) && /openai/.test(logText) && !logText.includes(KEY_A) && !logText.includes(KEY_O));
  check('AI-09 Provider utama ditandai jeda (cooldown)', await conns.locator('.badge', { hasText: 'Jeda (cooldown)' }).isVisible());

  // A rejected key → "Perlu tindakan" → rotate → tested again.
  fake.queue('models', { status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
  await conns.getByRole('button', { name: 'Tes Claude utama' }).click();
  await page.getByText(/Tes Claude utama gagal/).waitFor();
  const held = await conns.locator('li', { hasText: 'Claude utama' }).locator('.badge', { hasText: 'Perlu tindakan' }).isVisible();
  await conns.locator('li', { hasText: 'Claude utama' }).getByRole('button', { name: 'Ganti key' }).click();
  await conns.getByLabel('Key baru Claude utama').fill('sk-ant-rotated-NEW9');
  await conns.getByRole('button', { name: 'Simpan', exact: true }).click();
  await page.getByText('Key diganti. Tes ulang koneksinya.').waitFor();
  await conns.getByRole('button', { name: 'Tes Claude utama' }).click();
  await page.getByText('Tes Claude utama: berhasil.').waitFor();
  const hintOk = await conns.getByText(/key …NEW9/).isVisible();
  const sentKey = fake.state.requests.at(-1).headers['x-api-key'];
  check('AI-10 Key ditolak → Perlu tindakan → ganti key → Siap lagi (…NEW9)', held && hintOk && sentKey === 'sk-ant-rotated-NEW9', `held=${held} hint=${hintOk} sent=${String(sentKey).slice(-4)}`);

  await conns.locator('li', { hasText: 'OpenAI cadangan' }).getByRole('button', { name: 'Hapus' }).click();
  await conns.getByText(/OpenAI cadangan/).waitFor({ state: 'detached' });
  const disk = await fsp.readFile(path.join(stateDir, 'ai-providers.json'), 'utf8');
  check('AI-11 Hapus koneksi (dengan konfirmasi); file server hanya berisi key terenkripsi', !disk.includes(KEY_O) && !disk.includes('sk-ant-rotated-NEW9') && disk.includes('"sealed_key": "v1.'));

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${base}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: 'AI', exact: true }).click();
  await phone.getByRole('region', { name: 'Koneksi AI' }).getByText('＋ Tambah koneksi').click();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'ai-phone.png'), fullPage: true });
  check('AI-12 HP 390px: halaman AI muat tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);

  check('AI-13 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('AI-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
  await fake.close();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW12 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
