// W13 acceptance run: AI usage + hard budget from the real UI (built server + UI, real Chrome)
// against the local stand-in for the provider APIs (no real calls, no real cost).
// Evidence → audit/W13/evidence/.
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

await fsp.mkdir(EVID, { recursive: true });
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w13-'));
const wsRoot = path.join(work, 'ws');
await core.initWorkspace(wsRoot);
await core.createProject(await core.openWorkspace(wsRoot), { project_id: 'promo', name: 'Promo Lebaran' });
const stateDir = path.join(work, 'state');
const fake = await startFakeAi();
const server = await start({ MOTION_WORKSPACE: wsRoot, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: work, MOTION_RENDER_TMP: work, MOTION_STATE_DIR: stateDir, MOTION_AI_DEV_ENDPOINTS: '1' }, () => undefined);
const base = `http://127.0.0.1:${server.port}`;
const api = (p, body) => fetch(`${base}${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${server.app.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
await api('/api/ai/providers', { provider: 'anthropic', label: 'Claude', model: 'claude-opus-5-5', api_key: 'sk-ant-w13-KEY0000', capabilities: ['planner'], base_url: fake.url, prices: { input_per_mtok: 4, output_per_mtok: 20, per_audio_minute: 0 } });
await api('/api/ai/settings', { mode: 'ai', max_output_tokens: 500 });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(m.text()));
  await page.goto(`${base}/#token=${server.app.token}`);
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const budget = page.getByRole('region', { name: 'Anggaran dan pemakaian AI' });
  await budget.waitFor();
  check('BG-01 Meter hari ini & bulan ini tampil (default $1 / $10)', (await budget.getByText('$0.0000 / $1.0000').isVisible()) && (await budget.getByText('$0.0000 / $10.0000').isVisible()));

  await budget.getByLabel('Batas per permintaan').fill('0.005');
  await budget.getByRole('button', { name: 'Simpan batas' }).click();
  await page.getByText('Batas anggaran disimpan.').waitFor();
  const saved = (await api('/api/ai/providers')).settings.budget;
  check('BG-02 Batas disimpan dari UI', saved.per_request_usd === 0.005, JSON.stringify(saved));

  const toEditor = async () => {
    await page.getByRole('button', { name: 'Editor' }).click();
    await page.getByRole('heading', { name: 'Promo Lebaran' }).waitFor();
  };
  const panel = page.getByRole('region', { name: 'Motion Copilot' });
  const ask = async (prompt) => {
    await panel.getByLabel('Perintah Copilot').fill(prompt);
    await panel.getByRole('button', { name: 'Buat rencana' }).click();
  };
  await toEditor();
  await ask('buat pembuka yang menarik');
  await panel.getByText(/melebihi batas per permintaan \$0\.0050/).waitFor();
  await page.screenshot({ path: path.join(EVID, 'budget-blocked.png') });
  check('BG-03 Perkiraan melewati batas per permintaan → ditolak SEBELUM dikirim (0 panggilan)', fake.count('anthropic.messages') === 0);

  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await budget.getByLabel('Batas per permintaan').fill('1');
  await budget.getByLabel('Batas harian').fill('0.02');
  await budget.getByRole('button', { name: 'Simpan batas' }).click();
  await page.getByText('Batas anggaran disimpan.').waitFor();
  await toEditor();
  await ask('buat pembuka yang menarik');
  await panel.getByLabel('Rencana edit').waitFor();
  const cost = await panel.getByLabel('Rencana edit').getByText(/≈ \$/).innerText();
  await panel.getByRole('button', { name: 'Tolak' }).click();
  await ask('buat penutup yang kuat');
  await panel.getByText(/Batas harian \$0\.0200 akan terlewati \(terpakai \$0\.0108/).waitFor();
  check('BG-04 Panggilan pertama jalan ($0.0108), kedua ditolak batas harian', fake.count('anthropic.messages') === 1 && cost.includes('0.0108'), cost);

  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await budget.getByText('$0.0108 / $0.0200').waitFor();
  const row = await budget.getByRole('table', { name: 'Pemakaian per model bulan ini' }).innerText();
  check('BG-05 Meter = biaya tercatat dari usage provider; tabel per model', /anthropic · claude-opus-5-5/.test(row) && /1\s/.test(row) && row.includes('1.200 / 300') && row.includes('$0.0108'), row.replace(/\s+/g, ' '));
  const logText = await page.getByRole('region', { name: 'Log routing AI' }).innerText();
  check('BG-06 Log routing mencatat penolakan anggaran (ai.budget_blocked)', (logText.match(/ai\.budget_blocked/g) ?? []).length === 2);
  await page.screenshot({ path: path.join(EVID, 'budget-usage.png'), fullPage: true });

  const ledger = await fsp.readFile(path.join(stateDir, 'ai-usage.jsonl'), 'utf8');
  check('BG-07 Buku pemakaian di server: angka saja (tanpa prompt, tanpa key)', ledger.includes('"cost_usd":0.0108') && !/pembuka|penutup|sk-ant-w13/.test(ledger));

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${base}/#token=${server.app.token}`);
  await phone.getByRole('button', { name: 'AI', exact: true }).click();
  await phone.getByRole('region', { name: 'Anggaran dan pemakaian AI' }).scrollIntoViewIfNeeded();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.screenshot({ path: path.join(EVID, 'budget-phone.png') });
  check('BG-08 HP 390px: tanpa scroll samping', overflow <= 0, `overflow ${overflow}px`);
  check('BG-09 0 error JS (CSP tetap aktif)', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('BG-XX run selesai tanpa exception', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.stop();
  await fake.close();
}

const failed = results.filter((r) => !r.ok);
await fsp.writeFile(path.join(EVID, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\nW13 UI: ${results.length - failed.length}/${results.length} lulus`);
await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
process.exit(failed.length ? 1 : 0);
