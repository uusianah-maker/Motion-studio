// T01 — Audit prototype v0.5 FIXED (repeatable). Run: node audit.mjs
// Requires Google Chrome installed (uses playwright-core with channel 'chrome').
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(here, '../../prototype/prototype_v0.5_FIXED.html');
const URL_ = pathToFileURL(PROTO).href;
const EV = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : path.join(here, 'evidence');
const FX = path.join(here, 'fixtures');
fs.mkdirSync(EV, { recursive: true });

const results = [];
const record = (id, name, expected, status, evidence) => {
  results.push({ id, name, expected, status, evidence });
  console.log(`${status.padEnd(4)} ${id} ${name} — ${evidence}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function fresh(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const log = { console: [], pageErrors: [], requests: [], dialogs: [] };
  page.on('console', m => log.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => log.pageErrors.push(String(e.message)));
  page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) log.requests.push(r.url()); });
  await page.goto(URL_);
  return { ctx, page, log };
}
const txt = (page, sel) => page.locator(sel).first().innerText();
const count = (page, sel) => page.locator(sel).count();
const modalText = async page => (await page.locator('#modal').isVisible()) ? (await txt(page, '#modalTitle')) + ' | ' + (await txt(page, '#modalText')) : null;
const closeModal = page => page.click('#closeModal');
async function ask(page, prompt) { await page.fill('#prompt', prompt); await page.click('#send'); }
const lastBubble = page => page.locator('#messages .bubble').last().innerText();

// ---------- Run 1: load, console, network, storage ----------
{
  const { ctx, page, log } = await fresh();
  await page.waitForTimeout(500);
  record('A01', 'Load tanpa error JS', '0 pageerror, 0 console error', log.pageErrors.length === 0 && !log.console.some(c => c.startsWith('error')) ? 'PASS' : 'FAIL', `pageErrors=${JSON.stringify(log.pageErrors)} console=${JSON.stringify(log.console)}`);
  await page.screenshot({ path: path.join(EV, '01_load_1440.png') });
  const phVisible = await page.evaluate(() => { const r = document.getElementById('placeholder').getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return document.getElementById('placeholder').contains(h); });
  record('A04', 'Placeholder canvas terlihat sebelum import', 'placeholder di lapisan atas', phVisible ? 'PASS' : 'FAIL', `placeholderOnTop=${phVisible}`);

  // Ratio
  const ratioRes = [];
  for (const r of ['3:4', '1:1', '16:9', '9:16']) {
    await page.selectOption('#ratio', r);
    ratioRes.push(`${r}->aspect=${await page.$eval('#canvas', e => e.style.aspectRatio)} meta=${await txt(page, '#projectMeta')}`);
  }
  const ratioOk = ratioRes[0].includes('3 / 4') && ratioRes[1].includes('1 / 1') && ratioRes[2].includes('16 / 9') && ratioRes[2].includes('1920 × 1080');
  record('B01', 'Ganti rasio canvas 4 opsi', 'aspect-ratio & resolusi meta berubah', ratioOk ? 'PASS' : 'FAIL', ratioRes.join('; '));

  // CTA + overlay visibility
  await page.click('#addCta');
  const ctaClips = await count(page, '#trackText .ctaClip');
  await page.evaluate(() => { const r = document.getElementById('trackVideo').getBoundingClientRect(); });
  const box = await page.locator('#trackVideo').boundingBox();
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2); // ~27s
  const ov = await count(page, '#overlays .overlay.cta');
  const t = await txt(page, '#time');
  record('B02', 'Tambah CTA + overlay muncul di akhir', '1 clip CTA, overlay tampil di detik ≥25', ctaClips === 1 && ov === 1 ? 'PASS' : 'FAIL', `ctaClips=${ctaClips} overlayCta=${ov} time=${t}`);
  record('B03', 'Klik linimasa memindah playhead', 'waktu ~00:27', t.startsWith('00:26') || t.startsWith('00:27') ? 'PASS' : 'FAIL', `time=${t} playheadLeft=${await page.$eval('#playhead', e => e.style.left)}`);
  await page.screenshot({ path: path.join(EV, '02_cta_overlay.png') });

  // Add text via prompt()
  await page.mouse.click(box.x + 2, box.y + box.height / 2); // ~0s
  page.once('dialog', d => d.accept('Teks Uji Audit'));
  await page.click('#addText');
  const textClips = await page.locator('#trackText .textClip').allInnerTexts();
  const ovText = await page.locator('#overlays .overlay').allInnerTexts();
  record('B04', 'Tambah teks via dialog', 'clip & overlay "Teks Uji Audit"', textClips.includes('Teks Uji Audit') && ovText.includes('Teks Uji Audit') ? 'PASS' : 'FAIL', `clips=${JSON.stringify(textClips)} overlays=${JSON.stringify(ovText)}`);

  // Edit text via clicking clip
  page.once('dialog', d => d.accept('Teks Diedit'));
  await page.locator('#trackText .textClip').first().click();
  const edited = await page.locator('#trackText .textClip').first().innerText();
  record('B05', 'Edit teks dengan klik clip', 'clip berubah jadi "Teks Diedit"', edited === 'Teks Diedit' ? 'PASS' : 'FAIL', `clip=${edited}`);

  // Undo x3
  await page.click('#undo'); const u1 = await page.locator('#trackText .textClip').allInnerTexts();
  await page.click('#undo'); const u2 = await count(page, '#trackText .clip');
  await page.click('#undo'); const u3 = await count(page, '#trackText .clip');
  record('B06', 'Undo bertahap', 'edit→teks lama, hapus teks, hapus CTA', JSON.stringify(u1) === '["Teks Uji Audit"]' && u2 === 1 && u3 === 0 ? 'PASS' : 'FAIL', `afterUndo1=${JSON.stringify(u1)} afterUndo2Clips=${u2} afterUndo3Clips=${u3}`);
  // Note: ratio changes earlier also pushed history; drain and check empty-undo modal
  for (let i = 0; i < 10; i++) { await page.click('#undo'); if (await modalText(page)) break; }
  const emptyUndo = await modalText(page);
  record('B07', 'Undo saat history kosong', 'modal "Belum ada perubahan"', emptyUndo?.includes('Belum ada perubahan') ? 'PASS' : 'FAIL', `modal=${emptyUndo}`);
  await closeModal(page);

  // Copilot: Hook + CTA pill
  await page.click('[data-prompt^="Buat hook"]');
  const planItems = await page.locator('.plan li').allInnerTexts();
  await page.screenshot({ path: path.join(EV, '03_copilot_plan.png') });
  await page.click('.plan .btn.primary');
  const afterApply = await page.locator('#trackText .clip').allInnerTexts();
  record('C01', 'Copilot pill Hook+CTA → plan → terapkan', '2 langkah, 2 clip baru', planItems.length === 2 && afterApply.length === 2 ? 'PASS' : 'FAIL', `plan=${JSON.stringify(planItems)} clips=${JSON.stringify(afterApply)}`);

  // Reject
  await ask(page, 'Ubah rasio jadi 3:4 dan tambahkan teks Elegant Look');
  const plan2 = await page.locator('.plan li').allInnerTexts();
  await page.click('.plan .btn:not(.primary)');
  const afterReject = await count(page, '#trackText .clip');
  const ratioAfterReject = await page.inputValue('#ratio');
  record('C02', 'Tolak rencana → timeline tidak berubah', 'clip tetap 2, rasio tetap 9:16', afterReject === 2 && ratioAfterReject === '9:16' ? 'PASS' : 'FAIL', `plan=${JSON.stringify(plan2)} clips=${afterReject} ratio=${ratioAfterReject}`);

  // Unsupported
  await ask(page, 'buat subtitle otomatis');
  const unsupportedDisabled = await page.locator('.plan .btn.primary').last().isDisabled();
  const unsupportedText = await page.locator('.plan li').last().innerText();
  record('C03', 'Perintah unsupported (subtitle) tidak dipalsukan', 'tombol Terapkan disabled + pesan butuh backend', unsupportedDisabled ? 'PASS' : 'FAIL', `disabled=${unsupportedDisabled} text=${unsupportedText}`);
  await page.click('.plan .btn:not(.primary)');

  // Unknown
  await ask(page, 'halo apa kabar');
  const unk = await lastBubble(page);
  record('C04', 'Perintah tidak dikenal', 'pesan "belum dikenali"', unk.includes('belum dikenali') ? 'PASS' : 'FAIL', `bubble=${unk.slice(0, 80)}`);

  // Ratio prompt variants (regex bug probe)
  const variants = ['ubah ke 16x9', 'ubah rasio 1 : 1', 'ubah rasio 9 x 16'];
  for (const v of variants) {
    const errsBefore = log.pageErrors.length;
    await ask(page, v);
    const li = await page.locator('.plan li').last().innerText().catch(() => '(no plan)');
    await page.click('.plan .btn.primary').catch(() => {});
    await page.waitForTimeout(100);
    const newErr = log.pageErrors.slice(errsBefore);
    const ratioNow = await page.inputValue('#ratio');
    const meta = await txt(page, '#projectMeta');
    record(`C05-${variants.indexOf(v) + 1}`, `Prompt rasio "${v}"`, 'rasio valid diterapkan, tanpa error', newErr.length === 0 && ratioNow !== '' ? 'PASS' : 'FAIL', `plan=${li} ratioSelect="${ratioNow}" meta=${meta} newPageErrors=${JSON.stringify(newErr)}`);
    // recover from broken state if needed
    if (newErr.length) { await page.click('#undo').catch(() => {}); }
  }
  await page.screenshot({ path: path.join(EV, '04_ratio_prompt_probe.png') });

  // Simulated play without video
  await page.selectOption('#ratio', '9:16').catch(() => {});
  await page.click('#rewind'); await page.click('#rewind'); await page.click('#rewind'); await page.click('#rewind'); await page.click('#rewind'); await page.click('#rewind');
  await page.click('#play'); await page.waitForTimeout(1600); await page.click('#play');
  const simT = await txt(page, '#time');
  record('D01', 'Play simulasi tanpa video', 'waktu maju ~1 detik lalu pause', /^00:0[1-2]/.test(simT) ? 'PASS' : 'FAIL', `time=${simT}`);

  // Mute without video
  await page.click('#mute'); const muteModal = await modalText(page);
  record('D02', 'Mute tanpa video', 'modal minta import', muteModal?.includes('Impor video') ? 'PASS' : 'FAIL', `modal=${muteModal}`); await closeModal(page);

  // JSON export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#jsonBtn')]);
  const jp = path.join(EV, 'exported_project.json'); await dl.saveAs(jp);
  const json = JSON.parse(fs.readFileSync(jp, 'utf8'));
  record('E01', 'Export JSON proyek', 'file valid, berisi texts, prototype:true', json.prototype === true && Array.isArray(json.project.texts) ? 'PASS' : 'FAIL', `keys=${Object.keys(json.project)} texts=${json.project.texts.length} → evidence/exported_project.json`);

  // Render
  await page.click('#renderBtn'); const rm = await modalText(page);
  record('E02', 'Render jujur (tidak palsu MP4)', 'modal "Belum tersedia"', rm?.includes('Belum tersedia') ? 'PASS' : 'FAIL', `modal=${rm?.slice(0, 60)}`); await closeModal(page);

  // Escape closes modal?
  await page.click('#renderBtn');
  const focusOnOpen = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  const focusInside = await page.evaluate(() => document.getElementById('modal').contains(document.activeElement));
  await page.keyboard.press('Escape'); const escOpen = await page.locator('#modal').isVisible();
  record('F01', 'Escape menutup modal + fokus terkunci di modal (a11y)', 'fokus di modal saat buka & Tab, Escape menutup', !escOpen && focusOnOpen === 'closeModal' && focusInside ? 'PASS' : 'FAIL', `focusOnOpen=${focusOnOpen} focusInsideAfterTab=${focusInside} modalStillVisible=${escOpen}`);
  if (escOpen) await closeModal(page);
  await page.click('.nav[data-panel="Settings"]'); await page.fill('#brainKey', 'x'); await page.keyboard.press('Escape');
  const sEsc = { open: await page.locator('#settingsBackdrop').isVisible(), key: await page.inputValue('#brainKey') };
  record('F01b', 'Escape menutup Settings & membersihkan field key', 'tertutup, key kosong', !sEsc.open && sEsc.key === '' ? 'PASS' : 'FAIL', JSON.stringify(sEsc));

  // Nav buttons
  await page.click('.nav[data-panel="Template"]'); const navm = await modalText(page);
  record('F02', 'Nav modul rencana (Template) jujur', 'modal "belum tersedia"', navm?.includes('belum tersedia') ? 'PASS' : 'FAIL', `modal=${navm?.slice(0, 70)}`); await closeModal(page);
  await page.click('.nav.sel');
  const projFocus = await page.evaluate(() => document.activeElement?.id);
  record('F03', 'Nav "Proyek" punya aksi', 'fokus ke pencarian proyek', projFocus === 'search' ? 'PASS' : 'FAIL', `activeElement=${projFocus}`);
  await page.click('#projectList .project:nth-child(2)'); const projModal = await modalText(page);
  record('F04', 'Item proyek di sidebar memberi respons jujur', 'modal "Data contoh" (bukan klik mati)', projModal?.includes('Data contoh') ? 'PASS' : 'FAIL', `modal=${projModal?.slice(0, 60)}`);
  if (projModal) await closeModal(page);

  // Search
  await page.fill('#search', 'loose');
  const vis = await page.locator('#projectList .project:visible').allInnerTexts();
  record('F05', 'Cari proyek', 'hanya Loosepants tampil', vis.length === 1 && vis[0].includes('Loosepants') ? 'PASS' : 'FAIL', `visible=${vis.length}`);
  await page.fill('#search', '');

  // Feature catalog
  await page.click('#featuresBtn');
  const fc = await txt(page, '#featureCount');
  await page.selectOption('#featureFilter', 'demo');
  const demoCards = await count(page, '.featureCard');
  await page.fill('#featureSearch', 'subtitle'); await page.selectOption('#featureFilter', 'all');
  const subCards = await count(page, '.featureCard');
  await page.screenshot({ path: path.join(EV, '05_feature_catalog.png') });
  record('F06', 'Katalog fitur: count, filter, search', 'total 29, demo 4, search "subtitle" ≥1', fc.startsWith('29') && demoCards === 4 && subCards >= 1 ? 'PASS' : 'FAIL', `count="${fc}" demo=${demoCards} subtitle=${subCards}`);
  await page.click('#featureClose');

  // Settings / secrets
  await page.click('.nav[data-panel="Settings"]');
  const SECRET = 'sk-AUDITFAKESECRET1234567890';
  await page.fill('#brainKey', SECRET);
  await page.selectOption('#executionStrategy', 'rules');
  await page.fill('#registryName', 'Demo A'); await page.fill('#registryKey', SECRET); await page.click('#addProviderDemo');
  await page.click('#simulateFailover'); const fo1 = await txt(page, '#failoverStatus');
  await page.selectOption('#registryProvider', 'gemini'); await page.fill('#registryName', 'Demo B'); await page.click('#addProviderDemo');
  await page.click('#simulateFailover'); const fo2 = await txt(page, '#failoverStatus');
  await page.screenshot({ path: path.join(EV, '06_settings_failover.png') });
  record('G01', 'Failover butuh ≥2 koneksi', '1 koneksi → ditolak; 2 → simulasi', fo1.includes('minimal 2') && fo2.startsWith('SIMULASI') ? 'PASS' : 'FAIL', `1conn="${fo1.slice(0, 60)}" 2conn="${fo2.slice(0, 60)}"`);
  const regKeyCleared = (await page.inputValue('#registryKey')) === '';
  await page.click('#brainSave');
  const ls = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage }, cookie: document.cookie }));
  const domHasSecret = (await page.content()).includes(SECRET);
  record('G02', 'API key tidak tersimpan (storage/DOM)', 'tidak ada di localStorage/session/cookie/DOM', !ls.includes(SECRET) && !domHasSecret && regKeyCleared ? 'PASS' : 'FAIL', `storage=${ls} domHasSecret=${domHasSecret} registryKeyCleared=${regKeyCleared}`);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#jsonBtn')]);
  const j2 = fs.readFileSync(await dl2.path(), 'utf8');
  record('G03', 'API key tidak ikut export JSON', 'secret absen', !j2.includes(SECRET) ? 'PASS' : 'FAIL', `jsonContainsSecret=${j2.includes(SECRET)}`);

  // Reopen settings: executionStrategy persisted?
  await page.click('.nav[data-panel="Settings"]');
  const stratAfter = await page.inputValue('#executionStrategy');
  record('G04', 'Strategi eksekusi tersimpan saat dibuka ulang', '"rules"', stratAfter === 'rules' ? 'PASS' : 'FAIL', `executionStrategy=${stratAfter} (wrapper openBrain baris 77 tidak terpasang ke tombol Settings, binding baris 41)`);

  // Cancel must not leak unsaved strategy
  await page.selectOption('#executionStrategy', 'llm'); await page.click('#brainClose');
  await page.click('.nav[data-panel="Settings"]');
  const stratAfterCancel = await page.inputValue('#executionStrategy');
  record('G04b', 'Batal tidak menyimpan strategi (reopen = nilai tersimpan)', '"rules" (nilai yang disimpan)', stratAfterCancel === 'rules' ? 'PASS' : 'FAIL', `executionStrategy=${stratAfterCancel} — form menampilkan nilai belum disimpan; G04 PASS hanya karena DOM tidak di-reset`);

  // Cloud mode behaviour consistency
  await page.selectOption('#brainMode', 'cloud'); await page.click('#brainSave');
  const saveMsg = await page.locator('#messages .bubble').nth(-2).innerText();
  await ask(page, 'Tambah CTA Join Live Sekarang');
  const cloudReply = await lastBubble(page);
  record('G05', 'Mode Cloud: pesan konsisten dg perilaku', 'pesan simpan sesuai perilaku Copilot', !(saveMsg.includes('masih menggunakan planner lokal') && cloudReply.includes('Backend AI belum terhubung')) ? 'PASS' : 'FAIL', `saveMsg="${saveMsg.slice(0, 90)}" reply="${cloudReply.slice(0, 70)}"`);

  // Network
  record('G06', 'Tidak ada request jaringan eksternal', '0 request', log.requests.length === 0 ? 'PASS' : 'FAIL', `requests=${JSON.stringify(log.requests)}`);

  // Persistence claim
  await page.reload(); await page.waitForTimeout(300);
  const clipsAfterReload = await count(page, '#trackText .clip');
  const badge = await txt(page, '#saveBadge');
  record('H01', 'Badge "Disimpan lokal" sesuai fakta', 'data bertahan setelah reload, atau badge tidak klaim simpan', clipsAfterReload > 0 || !badge.includes('Disimpan lokal') ? 'PASS' : 'FAIL', `badge="${badge}" clipsAfterReload=${clipsAfterReload} (klaim simpan menyesatkan)`);
  record('A02', 'Tidak ada pageerror selama sesi run1 (di luar probe C05)', '0', log.pageErrors.length === 0 ? 'PASS' : 'FAIL', `pageErrors=${JSON.stringify(log.pageErrors)}`);
  await ctx.close();
}

// ---------- Run 2: media import ----------
{
  const { ctx, page, log } = await fresh();
  await page.click('#addCta'); // CTA at 25–30 with default 30s duration
  await page.setInputFiles('#file', path.join(FX, 'sample_8s_9x16.mp4'));
  await page.waitForFunction(() => document.getElementById('durationText').textContent !== '00:30', null, { timeout: 8000 }).catch(() => {});
  const dur = await txt(page, '#durationText');
  const vclip = await page.locator('#trackVideo .videoClip').innerText().catch(() => '');
  const vw = await page.$eval('#video', v => `${v.videoWidth}x${v.videoHeight} dur=${v.duration.toFixed(2)}`);
  record('I01', 'Import MP4 H.264 8 detik', 'durasi 00:08, clip video tampil', dur === '00:08' && vclip.includes('sample_8s') ? 'PASS' : 'FAIL', `duration=${dur} clip="${vclip}" intrinsic=${vw}`);
  const rulerAll = await page.locator('#ruler span').allInnerTexts();
  const rulerLast = rulerAll[rulerAll.length - 1];
  record('I01b', 'Ruler linimasa mengikuti durasi', 'label terakhir 00:08', rulerLast === '00:08' ? 'PASS' : 'FAIL', `ruler=${rulerAll.join(',')} duration=${dur}`);
  // CTA from before import now beyond duration
  const ctaStyle = await page.$eval('#trackText .ctaClip', e => `left=${e.style.left} width=${e.style.width}`);
  const ctaLeft = parseFloat(ctaStyle.match(/left=([\d.]+)/)[1]);
  const clampMsg = (await page.locator('#messages .bubble').allInnerTexts()).some(t => t.includes('digeser/dipotong'));
  record('I02', 'Teks lama di luar durasi video baru', 'di-clamp ke dalam durasi + diberi peringatan', ctaLeft < 100 && clampMsg ? 'PASS' : 'FAIL', `${ctaStyle} warningShown=${clampMsg}`);
  const fit = await page.$eval('#video', v => getComputedStyle(v).objectFit);
  const meta9 = await txt(page, '#projectMeta');
  record('I03', 'Rasio intrinsik video ditampilkan benar', 'object-fit contain + resolusi sumber tampil', fit === 'contain' && meta9.includes('sumber 360×640') ? 'PASS' : 'FAIL', `objectFit=${fit} meta=${meta9}`);

  await page.click('#play'); await page.waitForTimeout(1500); await page.click('#play');
  const pt = await txt(page, '#time');
  record('I04', 'Play/pause video nyata', 'waktu maju ≥1s', /^00:0[1-3]/.test(pt) ? 'PASS' : 'FAIL', `time=${pt}`);
  await page.screenshot({ path: path.join(EV, '07_video_imported.png') });

  await page.click('#mute'); const muted = await page.$eval('#video', v => v.muted);
  record('I05', 'Mute video', 'video.muted=true', muted ? 'PASS' : 'FAIL', `muted=${muted}`);

  // Undo after import: does it restore duration but keep video?
  await page.click('#undo');
  const durAfterUndo = await txt(page, '#durationText');
  record('I06', 'Undo setelah import tidak merusak durasi', 'durasi tetap 00:08', durAfterUndo === '00:08' ? 'PASS' : 'FAIL', `durationAfterUndo=${durAfterUndo} (snapshot sebelum import berisi duration=30)`);

  // Non-video file
  await page.setInputFiles('#file', path.join(FX, 'not_video.txt'));
  const nv = await modalText(page);
  record('I07', 'Import file non-video', 'modal "File tidak didukung"', nv?.includes('tidak didukung') ? 'PASS' : 'FAIL', `modal=${nv?.slice(0, 50)}`);
  if (nv) await closeModal(page);

  // Import landscape into portrait canvas: intrinsic aspect must be preserved (letterbox)
  await page.setInputFiles('#file', path.join(FX, 'sample_3s_16x9.mp4'));
  await page.waitForFunction(() => document.getElementById('durationText').textContent === '00:03', null, { timeout: 8000 }).catch(() => {});
  const meta16 = await txt(page, '#projectMeta');
  const ruler3 = await page.locator('#ruler span').allInnerTexts();
  record('I01c', 'Ruler video pendek tanpa label dobel', 'label unik', new Set(ruler3).size === ruler3.length ? 'PASS' : 'FAIL', `ruler=${ruler3.join(',')}`);
  await page.screenshot({ path: path.join(EV, '07b_landscape_in_portrait.png') });
  record('I03b', 'Video 16:9 di canvas 9:16 tidak terpotong', 'resolusi sumber 640×360 tampil, letterbox', meta16.includes('sumber 640×360') ? 'PASS' : 'FAIL', `meta=${meta16} duration=${await txt(page, '#durationText')}`);

  // New project
  await page.click('#newProject');
  const np = { name: await page.inputValue('#projectName'), clips: await count(page, '#trackText .clip'), v: await count(page, '#trackVideo .clip'), ph: await page.locator('#placeholder').isVisible() };
  record('I08', 'Proyek baru reset state', 'nama Proyek Baru, 0 clip, placeholder tampil', np.name === 'Proyek Baru' && np.clips === 0 && np.v === 0 && np.ph ? 'PASS' : 'FAIL', JSON.stringify(np));
  // Undo new project: is video restored?
  await page.click('#undo');
  const undoNP = { name: await page.inputValue('#projectName'), v: await count(page, '#trackVideo .clip'), src: await page.$eval('#video', v => v.getAttribute('src')) };
  record('I09', 'Undo "Proyek baru"', 'state & video kembali konsisten', (undoNP.v === 0) === (undoNP.src === null) ? 'PASS' : 'FAIL', `${JSON.stringify(undoNP)} (nama/teks kembali, video tidak)`);

  // Add text at end of timeline
  await page.click('#newProject');
  const b = await page.locator('#trackVideo').boundingBox();
  await page.mouse.click(b.x + b.width - 1, b.y + b.height / 2);
  page.once('dialog', d => d.accept('Teks di ujung'));
  await page.click('#addText');
  const endClip = await page.$eval('#trackText .clip', e => `left=${e.style.left} width=${e.style.width}`).catch(() => 'none');
  const w = parseFloat((endClip.match(/width=([\d.]+)/) || [0, 0])[1]);
  record('I10', 'Tambah teks saat playhead di ujung', 'durasi teks > 0 atau ditolak', w > 1 ? 'PASS' : 'FAIL', `clip ${endClip} time=${await txt(page, '#time')}`);
  record('A03', 'Tidak ada pageerror selama run2', '0', log.pageErrors.length === 0 ? 'PASS' : 'FAIL', `pageErrors=${JSON.stringify(log.pageErrors)}`);
  await ctx.close();
}

// ---------- Run 3: responsive ----------
for (const vp of [{ width: 1100, height: 800 }, { width: 820, height: 1000 }, { width: 390, height: 844 }]) {
  const { ctx, page } = await fresh(vp);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  await page.screenshot({ path: path.join(EV, `08_responsive_${vp.width}.png`), fullPage: true });
  record(`J-${vp.width}`, `Responsif lebar ${vp.width}px`, 'tanpa scroll horizontal', ov.sw <= ov.cw ? 'PASS' : 'FAIL', `scrollWidth=${ov.sw} clientWidth=${ov.cw}`);
  const btns = await page.evaluate(() => ['uploadBtn', 'jsonBtn', 'renderBtn', 'send'].map(id => {
    const el = document.getElementById(id); const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 - window.scrollY + window.scrollY);
    return { id, visible: r.width > 0 && r.left >= 0 && r.right <= innerWidth + 0.5, onTop: el === hit || el.contains(hit) };
  }));
  const bad = btns.filter(b => !b.visible);
  record(`J-${vp.width}b`, `Tombol utama terlihat di ${vp.width}px`, 'Import/JSON/Render/Susun edit di dalam layar', bad.length === 0 ? 'PASS' : 'FAIL', JSON.stringify(btns));
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(EV, 'results.json'), JSON.stringify({ runAt: new Date().toISOString(), target: PROTO, results }, null, 2));
const s = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
console.log('\nSUMMARY', JSON.stringify(s));
