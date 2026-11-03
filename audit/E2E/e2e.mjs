// End-to-end acceptance run against the BUILT storage core (dist/), with real MP4 files.
// Covers PRD v0.8 §I GC-01..GC-12 and §M design checks (1)-(5) in one realistic workspace story.
// Run: npm run build && node audit/E2E/e2e.mjs
import { Buffer } from 'node:buffer';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (m) => import(pathToFileURL(path.resolve(here, '../../dist/storage', m)).href);
const { ManualClock, DAY_MS } = await dist('clock.js');
const { initWorkspace, createProject, readProject } = await dist('workspace.js');
const { StorageService } = await dist('service.js');
const { loadRegistry } = await dist('registry.js');
const { readAudit } = await dist('audit.js');
const { writeJournal } = await dist('journal.js');
const { PURGE_PHRASE } = await dist('purge.js');
const { getStorageStats } = await dist('quota.js');

const FIX = path.resolve(here, '../T01/fixtures');
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-e2e-'));
const clock = new ManualClock(Date.UTC(2026, 10, 4));
const ws = await initWorkspace(path.join(work, 'MOTION_STUDIO'), { clock });
const svc = new StorageService(ws);
const results = [];
const check = (id, name, ok, evidence) => {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} — ${evidence}`);
};
const exists = (p) => fsp.access(p).then(() => true, () => false);
const abs = (rel) => path.join(ws.root, rel);
const manifest = (base, refs, extra = {}) => ({
  ...base,
  ...extra,
  timeline: { tracks: [{ track_id: 'video', kind: 'video', clips: refs.map((m, i) => ({ clip_id: `c${i}`, start_ms: i * 1000, end_ms: i * 1000 + 1000, media: m })) }] },
});
async function commitRefs(pid, refs, extra = {}) {
  const base = await readProject(ws, pid);
  return (await svc.commitProject({ manifest: manifest(base, refs, extra), expected_revision: base.revision, actor: 'user' })).result;
}
const ref = (r) => ({ media_id: r.media.media_id, version_id: r.version.version_id });
const state = async (vid) => (await loadRegistry(ws)).versions[vid];
const copyFixture = async (name, as) => {
  const p = path.join(work, as);
  await fsp.copyFile(path.join(FIX, name), p);
  return p;
};
const variant = async (name, tag) => {
  // Same MP4 + a unique trailer so each import is a distinct real video file.
  const p = path.join(work, `${tag}.mp4`);
  await fsp.writeFile(p, Buffer.concat([await fsp.readFile(path.join(FIX, name)), Buffer.from(`#${tag}`)]));
  return p;
};

// ---- Story setup: two projects, shared footage, a recut, a never-used import
await createProject(ws, { project_id: 'lucy-elegant', name: 'Lucy — Elegant Look' });
await createProject(ws, { project_id: 'office-espresso', name: 'Office Look — Espresso' });
const lucyV1 = await svc.importMedia({ sourcePath: await copyFixture('sample_8s_9x16.mp4', 'lucy.mp4'), scope: { kind: 'shared' }, actor: 'user' });
const lucyV2 = (await svc.addVersion({ media_id: lucyV1.media.media_id, sourcePath: await variant('sample_8s_9x16.mp4', 'lucy-recut'), actor: 'user' })).result;
const espresso = await svc.importMedia({ sourcePath: await copyFixture('sample_3s_16x9.mp4', 'espresso.mp4'), scope: { kind: 'project', project_id: 'office-espresso' }, actor: 'user' });
const espressoV2 = (await svc.addVersion({ media_id: espresso.media.media_id, sourcePath: await variant('sample_3s_16x9.mp4', 'espresso-v2'), actor: 'user' })).result;
const neverUsed = await svc.importMedia({ sourcePath: await variant('sample_3s_16x9.mp4', 'raw-unused'), scope: { kind: 'shared' }, actor: 'user' });
const archOld = await svc.importMedia({ sourcePath: await variant('sample_8s_9x16.mp4', 'archive-take'), scope: { kind: 'shared' }, actor: 'user' });
await svc.addVersion({ media_id: archOld.media.media_id, sourcePath: await variant('sample_8s_9x16.mp4', 'archive-take-2'), actor: 'user' });
const renderOld = await svc.importMedia({ sourcePath: await variant('sample_3s_16x9.mp4', 'render-take'), scope: { kind: 'shared' }, actor: 'user' });
await svc.addVersion({ media_id: renderOld.media.media_id, sourcePath: await variant('sample_3s_16x9.mp4', 'render-take-2'), actor: 'user' });

await commitRefs('lucy-elegant', [ref(lucyV1), ref(archOld)]);
await commitRefs('office-espresso', [ref(espresso), ref(renderOld)]);
// Editors move on: v1s dropped from active timelines.
await commitRefs('lucy-elegant', [ref(lucyV2)]);
await createProject(ws, { project_id: 'old-campaign', name: 'Old campaign' });
await commitRefs('old-campaign', [ref(archOld)], { status: 'archived' });
await commitRefs('office-espresso', [ref(espressoV2)]);
// A render of the old take is queued before it is dropped.
await commitRefs('office-espresso', [ref(espressoV2), ref(renderOld)]);
const render = (await svc.startRender({ project_id: 'office-espresso', output_name: 'final.mp4', estimated_bytes: 10_000, actor: 'user' })).result;
await commitRefs('office-espresso', [ref(espressoV2)]);
const t0 = clock.now();

// ---- GC-02: 29d23h → nothing moved
clock.set(t0 + 30 * DAY_MS - 3_600_000);
let at = await svc.autoTrash({ actor: 'scheduler' });
check('GC-02', '29 hari 23 jam: belum dipindah', at.moved.length === 0, `moved=${at.moved.length}`);

// ---- GC-06: re-reference on day 29 resets the clock for espresso v1
clock.set(t0 + 29 * DAY_MS);
await commitRefs('office-espresso', [ref(espressoV2), ref(espresso)]);
await commitRefs('office-espresso', [ref(espressoV2)]);
const espressoRestart = clock.now();

// ---- GC-03: day 30 → lucy v1 trashed with manifest + audit
clock.set(t0 + 30 * DAY_MS);
at = await svc.autoTrash({ actor: 'scheduler' });
const movedIds = at.moved.map((m) => m.version_id);
const lucyRec = await state(lucyV1.version.version_id);
const audits = await readAudit(ws, (e) => e.op === 'gc.auto_trash.item' && e.version_id === lucyV1.version.version_id);
check('GC-03', '30 hari + semua gate lulus: masuk Trash, registry & audit akurat', movedIds.length === 1 && movedIds[0] === lucyV1.version.version_id && lucyRec.lifecycle === 'trashed' && (await exists(abs(lucyRec.rel_path))) && audits.map((a) => a.phase).join() === 'started,done', `moved=${movedIds.join()} lifecycle=${lucyRec.lifecycle} audit=${audits.map((a) => a.phase)}`);
check('GC-06', 'Re-reference hari 29: jam reset, tidak dipindah di jadwal lama', !movedIds.includes(espresso.version.version_id) && (await state(espresso.version.version_id)).unreferenced_since === espressoRestart, `espresso since=${(await state(espresso.version.version_id)).unreferenced_since === espressoRestart ? 'reset' : 'NOT reset'}`);
check('GC-10', 'Trash di disk yang sama: freed space dilaporkan 0', at.freed_bytes === 0 && at.moved_bytes > 0, `freed=${at.freed_bytes} moved_bytes=${at.moved_bytes}`);

// ---- GC-01 / GC-04 / GC-05 at day 90
clock.set(t0 + 90 * DAY_MS);
at = await svc.autoTrash({ actor: 'scheduler' });
const nu = await state(neverUsed.version.version_id);
check('GC-01', 'Media baru belum pernah dipakai (90 hari): tetap terlindungi', nu.lifecycle === 'active' && nu.unreferenced_since === null && !nu.ever_referenced, `lifecycle=${nu.lifecycle} ever=${nu.ever_referenced}`);
check('GC-04', 'Dipakai proyek arsip: tidak pernah dipindah', (await state(archOld.version.version_id)).lifecycle === 'active', `lifecycle=${(await state(archOld.version.version_id)).lifecycle}`);
const snap = await svc.verifyRenderSnapshot(render.lease.lease_id);
check('GC-05', 'Lease render antre: tidak dipindah, preflight tetap stabil', (await state(renderOld.version.version_id)).lifecycle === 'active' && snap.ok, `lifecycle=${(await state(renderOld.version.version_id)).lifecycle} snapshot_ok=${snap.ok}`);
await svc.finishRender({ lease_id: render.lease.lease_id, outcome: 'completed', actor: 'user' });

// ---- GC-11: bytes replaced without a new version
const espV2Rec = await state(espressoV2.version.version_id);
await fsp.chmod(abs(espV2Rec.rel_path), 0o666);
await fsp.appendFile(abs(espV2Rec.rel_path), 'tamper');
const ver = await svc.verifyVersion(espressoV2.version.version_id);
const pre = await svc.renderPreflight({ project_id: 'office-espresso', output_name: 'final.mp4', estimated_bytes: 1, actor: 'user' });
check('GC-11', 'Byte sumber diganti tanpa versi baru: alert CHANGED, timeline tidak di-upgrade', ver.integrity === 'changed' && !pre.ok && pre.problems[0].code === 'MEDIA_CHANGED' && pre.snapshot.length === 0, `integrity=${ver.integrity} preflight=${pre.problems.map((p) => p.code)}`);

// ---- GC-12: AI cannot trash/purge/restore
const aiAttempts = [
  svc.autoTrash({ actor: 'ai' }),
  svc.preparePurge({ version_ids: [lucyV1.version.version_id], actor: 'ai' }),
  svc.restore({ version_id: lucyV1.version.version_id, actor: 'ai' }),
];
const aiResults = await Promise.allSettled(aiAttempts);
check('GC-12', 'Prompt AI "hapus media lama": diblok dari Trash/purge/restore + diaudit', aiResults.every((r) => r.status === 'rejected' && r.reason.code === 'FORBIDDEN') && (await readAudit(ws, (e) => e.actor === 'ai' && e.outcome === 'blocked')).length >= 3, aiResults.map((r) => r.status).join());

// ---- GC-09: restore with conflicting destination
await fsp.writeFile(abs(lucyRec.trash.original_rel_path), 'someone else took this name');
const c = (await svc.restore({ version_id: lucyV1.version.version_id, actor: 'user' })).result;
const occupantSafe = (await fsp.readFile(abs(lucyRec.trash.original_rel_path), 'utf8')) === 'someone else took this name';
const alt = (await svc.restore({ version_id: lucyV1.version.version_id, actor: 'user', onConflict: 'alternate' })).result;
check('GC-09', 'Restore ke tujuan yang terisi: tidak overwrite, pilih path alternatif', c.status === 'conflict' && occupantSafe && alt.status === 'restored' && alt.alternate === true, `first=${c.status} then=${alt.status} at ${alt.rel_path}`);

// ---- GC-08 + design checks: manual purge
clock.advance(31 * DAY_MS);
at = await svc.autoTrash({ actor: 'scheduler' });
const trashedNow = at.moved.map((m) => m.version_id);
clock.advance(DAY_MS); // (1) only 1 day in Trash
const plan = await svc.preparePurge({ version_ids: trashedNow, actor: 'user' });
const wrong = await svc.executePurge({ request_id: plan.request_id, confirmation_token: plan.confirmation_token, typed_phrase: 'ya', actor: 'user' }).catch((e) => e.code);
const plan2 = await svc.preparePurge({ version_ids: trashedNow, actor: 'user' });
const done = await svc.executePurge({ request_id: plan2.request_id, confirmation_token: plan2.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
check('GC-08', 'Hapus permanen: audit dependensi segar + konfirmasi eksplisit, tanpa auto purge', wrong === 'FORBIDDEN' && done.purged.length === trashedNow.length && trashedNow.length > 0, `wrong_phrase=${wrong} purged=${done.purged.length}/${trashedNow.length}`);
check('M-1', 'Item 1 hari di Trash bisa di-purge manual (audit + konfirmasi lulus)', done.purged.length > 0, `purged=${done.purged.join()}`);

// (3) referenced/locked items cannot be manually purged
const plan3 = await svc.preparePurge({ version_ids: [archOld.version.version_id, lucyV2.version.version_id], actor: 'user' });
const blocked = await svc.executePurge({ request_id: plan3.request_id, confirmation_token: plan3.confirmation_token, typed_phrase: PURGE_PHRASE, actor: 'user' });
check('M-3', 'Item yang direferensikan/terkunci tidak bisa di-purge manual', blocked.purged.length === 0 && blocked.blocked.length === 2, blocked.blocked.map((b) => b.reasons.join('+')).join(' | '));
check('M-4', 'Prompt AI tidak bisa memicu hapus permanen', aiResults[1].status === 'rejected', 'lihat GC-12');

// (2) 365 days in Trash never auto-purged + (5) disk full never purges
const keepInTrash = (await svc.importMedia({ sourcePath: await variant('sample_3s_16x9.mp4', 'long-trash'), scope: { kind: 'shared' }, actor: 'user' }));
await svc.addVersion({ media_id: keepInTrash.media.media_id, sourcePath: await variant('sample_3s_16x9.mp4', 'long-trash-2'), actor: 'user' });
await createProject(ws, { project_id: 'tmp', name: 'tmp' });
await commitRefs('tmp', [ref(keepInTrash)]);
await commitRefs('tmp', []);
clock.advance(30 * DAY_MS);
await svc.autoTrash({ actor: 'scheduler' });
const sched = svc.createScheduler({ timers: { setInterval: () => 0, clearInterval: () => {} } });
await sched.start();
for (let i = 0; i < 5; i++) {
  clock.advance(73 * DAY_MS);
  await sched.runCycle();
}
sched.stop();
const stats = await getStorageStats(ws, { disk: { free_bytes: 0, total_bytes: 1 } });
const lt = await state(keepInTrash.version.version_id);
check('M-2', 'Item 365 hari di Trash tidak pernah di-purge otomatis', lt.lifecycle === 'trashed' && (await exists(abs(lt.rel_path))), `lifecycle=${lt.lifecycle}`);
check('M-5', 'Disk penuh tidak pernah memicu purge (hanya peringatan)', stats.warnings.some((w) => w.code === 'LOW_FREE_SPACE') && lt.lifecycle === 'trashed', `warnings=${stats.warnings.map((w) => w.code)}`);

// ---- GC-07: corrupt dependency data → GC stops safely
await fsp.writeFile(abs('PROJECTS/old-campaign/03_PROJECT/project.json'), '{"broken":');
const scan = await svc.scan({ actor: 'scheduler' });
at = await svc.autoTrash({ actor: 'scheduler' });
check('GC-07', 'Database dependensi rusak: GC berhenti aman + alasan dicatat', !scan.ok && !at.ok && at.moved.length === 0 && (await readAudit(ws, (e) => e.reason === 'INDEX_INVALID')).length >= 2, `scan.ok=${scan.ok} errors=${scan.errors[0]?.slice(0, 60)}`);

// ---- Crash recovery: simulated crash mid-Trash
await fsp.writeFile(abs('PROJECTS/old-campaign/03_PROJECT/project.json'), JSON.stringify(manifest(await (async () => { const r = JSON.parse(JSON.stringify(await readProject(ws, 'lucy-elegant'))); return { ...r, project_id: 'old-campaign', status: 'archived' }; })(), [ref(archOld)])));
const rec = await state(lucyV2.version.version_id); // an active, current version (a real mid-move crash)
if (rec.lifecycle !== "active") throw new Error("e2e setup: expected an active version");
const to = `.trash/op_crash/${rec.version_id}/${path.basename(rec.rel_path)}`;
await writeJournal(ws, { schema_version: 1, op_id: 'op_crash', kind: 'trash', version_id: rec.version_id, from_rel: rec.rel_path, to_rel: to, manifest_rel: `.trash/op_crash/${rec.version_id}/manifest.json`, content_hash: rec.content_hash, started_at: clock.now() });
await fsp.mkdir(path.dirname(abs(to)), { recursive: true });
await fsp.rename(abs(rec.rel_path), abs(to));
const recovery = await svc.recover();
check('ST-09', 'Crash di tengah pemindahan: recovery mengembalikan kondisi konsisten', recovery.journal[0]?.action === 'rolled-back' && (await exists(abs(rec.rel_path))) && (await state(rec.version_id)).lifecycle === 'active', `action=${recovery.journal[0]?.action}`);

const summary = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log('\nSUMMARY', JSON.stringify(summary));
const outDir = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : path.join(here, 'evidence');
await fsp.mkdir(outDir, { recursive: true });
await fsp.writeFile(path.join(outDir, 'e2e_results.json'), JSON.stringify({ runAt: new Date().toISOString(), workspace: ws.root, results, summary }, null, 2));
// Keep the workspace for inspection only on failure.
if (!summary.FAIL) {
  const chmodAll = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await chmodAll(p);
      else await fsp.chmod(p, 0o666).catch(() => {});
    }
  };
  await chmodAll(work);
  await fsp.rm(work, { recursive: true, force: true });
}
process.exit(summary.FAIL ? 1 : 0);
