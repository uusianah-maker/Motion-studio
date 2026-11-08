import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeAi, startFakeAi } from '../../../scripts/fake-ai.mjs';
import { openSpendGate } from '../src/ai/budget.js';
import { createAiPlanner } from '../src/ai/planner.js';
import { createRouter } from '../src/ai/router.js';
import { aiRoutes } from '../src/ai/routes.js';
import { openAiStore } from '../src/ai/store.js';
import { HOST, createApp } from '../src/app.js';
import { createCopilot } from '../src/copilot.js';
import { StorageService, createProject, initWorkspace, readAudit, readProject } from '../src/core.js';
import { apiRoutes } from '../src/routes.js';
import { transcribeRoutes } from '../src/transcribe.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const FFMPEG = process.env.MOTION_FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-w14-'));
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const fake: FakeAi = await startFakeAi();
  cleanup.push(() => fake.close());
  const ws = await initWorkspace(path.join(dir, 'ws'));
  const svc = new StorageService(ws);
  // A source that carries identifying metadata: it must never reach the STT provider.
  const tagged = path.join(dir, 'Talk.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-i', path.join(FIX, 'sample_8s_9x16.mp4'), '-c', 'copy', '-metadata', 'title=JUDUL-RAHASIA-STT-4410', '-metadata', 'artist=Nama Asli Owner', tagged], { windowsHide: true });
  const imp = await svc.importMedia({ sourcePath: tagged, scope: { kind: 'shared' }, actor: 'user' });
  const silent = path.join(dir, 'Silent.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=30:d=2', '-c:v', 'libx264', '-an', silent], { windowsHide: true });
  const mute = await svc.importMedia({ sourcePath: silent, scope: { kind: 'shared' }, actor: 'user' });
  await createProject(ws, { project_id: 'p1', name: 'Talk' });
  const ref = { media_id: imp.media.media_id, version_id: imp.version.version_id };
  await svc.editTimeline({ project_id: 'p1', expected_revision: 0, actor: 'user', ops: [{ op: 'add_clip', track_kind: 'video', media: ref, start_ms: 1000, duration_ms: 6000, in_ms: 0 }] });
  const stateDir = path.join(dir, 'state');
  const store = await openAiStore(stateDir, undefined);
  const ledger = await openSpendGate({ ws, store, stateDir });
  const router = createRouter({ ws, store, gate: ledger.gate, sleep: async () => undefined });
  const copilot = createCopilot(ws, { ai: createAiPlanner(store, router), mode: () => store.settings().mode });
  const app = createApp({ ws, routes: [...apiRoutes({ tmpDir: dir }), ...copilot.routes, ...aiRoutes(ws, store, ledger, fetch, { devEndpoints: true }), ...transcribeRoutes(ws, { router, copilot, tmpRoot: dir })] });
  const port = await app.listen(0);
  cleanup.push(() => app.close());
  const call = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request(
        { host: HOST, port, path: p, method: data ? 'POST' : 'GET', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  const conn = async (extra: Record<string, unknown> = {}) =>
    (await call('/api/ai/providers', { provider: 'openai', label: 'Whisper', model: 'whisper-1', api_key: 'sk-openai-stt-KEY7', capabilities: ['transcription'], base_url: fake.url, prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 0.006 }, ...extra })).json.connection.connection_id as string;
  const waitJob = async () => {
    for (let i = 0; i < 200; i++) {
      const j = (await call('/api/projects/p1/transcripts')).json.jobs[0];
      if (j && j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job timeout');
  };
  return { ws, fake, store, ledger, call, conn, waitJob, ref, mute: mute.version.version_id, dir };
}

/** The estimate the UI shows, confirmed exactly (Checkpoint F F-9). */
async function quote(s: Awaited<ReturnType<typeof setup>>) {
  const e = (await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.ref.version_id })).json;
  return { confirm_usd: e.estimate_usd as number, connection_id: e.provider.connection_id as string };
}

describe.skipIf(!hasFfmpeg)('W14 captions / speech-to-text', () => {
  it('estimate → confirm cost → audio WITHOUT metadata to the provider → cues saved → metered', async () => {
    const s = await setup();
    await s.conn();
    const est = await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.ref.version_id });
    expect(est.json).toMatchObject({ minutes: 0.14, provider: { provider: 'openai', model: 'whisper-1' }, unavailable: null });
    expect(est.json.estimate_usd).toBeCloseTo(0.14 * 0.006, 8);
    const noConfirm = await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, language: 'id' });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.json.error.message).toMatch(/Konfirmasi biaya dulu/);
    expect(s.fake.count('openai.transcribe')).toBe(0);

    const start = await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, language: 'id', confirm_usd: est.json.estimate_usd, connection_id: est.json.provider.connection_id });
    expect(start.json.job.status).toBe('running');
    const job = await s.waitJob();
    expect(job).toMatchObject({ status: 'completed', error: null });
    const sent = s.fake.state.requests.find((r) => r.key === 'openai.transcribe')!;
    expect(sent.headers.authorization).toBe('Bearer sk-openai-stt-KEY7');
    const body = String(sent.body);
    expect(body).toContain('whisper-1');
    expect(body).toContain('verbose_json');
    expect(body).toContain('timestamp_granularities[]');
    expect(body).toMatch(/name="language"\r\n\r\nid/);
    expect(body).not.toMatch(/JUDUL-RAHASIA|Nama Asli|Lavf/); // metadata stripped from the extracted audio
    expect(sent.size).toBeLessThan(200_000); // mono 16 kHz audio only, not the video

    const list = (await s.call('/api/projects/p1/transcripts')).json.transcripts;
    expect(list[0]).toMatchObject({ transcript_id: job.transcript_id, version_id: s.ref.version_id, provider: 'openai', cue_count: 1, rev: 0 });
    const t = (await s.call(`/api/projects/p1/transcripts/${job.transcript_id}`)).json.transcript;
    expect(t.cues.map((c: { text: string; start_ms: number; end_ms: number }) => [c.text, c.start_ms, c.end_ms])).toEqual([['Halo semua, ini promo spesial.', 200, 2600]]);
    expect(t.words).toBeUndefined();
    expect(t.word_count).toBe(5);
    const usage = s.ledger.summary();
    expect(usage.by_model[0]).toMatchObject({ provider: 'openai', model: 'whisper-1', calls: 1, audio_seconds: 8 });
    expect(usage.today.usd).toBeCloseTo((8 / 60) * 0.006, 8);
    expect((await readAudit(s.ws, (e) => e.op === 'transcript.create'))[0]).toMatchObject({ outcome: 'ok', cues: 1 });
  }, 60_000);

  it('edit cues (overlap/out-of-bounds refused, stale tab refused) → subtitles plan → approve → one undo', async () => {
    const s = await setup();
    await s.conn();
    const est = (await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.ref.version_id })).json;
    await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, language: 'id', confirm_usd: est.estimate_usd, connection_id: est.provider.connection_id });
    const id = (await s.waitJob()).transcript_id;
    const url = `/api/projects/p1/transcripts/${id}`;
    expect((await s.call(url, { expected_rev: 0, cues: [{ start_ms: 0, end_ms: 2000, text: 'A' }, { start_ms: 1500, end_ms: 3000, text: 'B' }] })).json.error.message).toMatch(/tumpang tindih/);
    expect((await s.call(url, { expected_rev: 0, cues: [{ start_ms: 7000, end_ms: 9500, text: 'A' }] })).json.error.message).toMatch(/melewati panjang media/);
    const ok = await s.call(url, { expected_rev: 0, cues: [{ start_ms: 200, end_ms: 1100, text: 'Halo semua!' }, { start_ms: 1400, end_ms: 2600, text: 'Ini promo spesial.' }] });
    expect(ok.json.transcript).toMatchObject({ rev: 1, edited: true });
    expect((await s.call(url, { expected_rev: 0, cues: [] })).status).toBe(409);

    const plan = await s.call(`${url}/subtitles`, {});
    expect(plan.json.plan).toMatchObject({ source: 'transcript', cost_estimate: { usd: 0 } });
    // Clip sits at 1 s on the timeline with in-point 0 → cue times shift by +1 s.
    expect(plan.json.diff.map((d: { summary: string }) => d.summary)).toEqual(['+ subtitle “Halo semua!” 0:01.2–0:02.1', '+ subtitle “Ini promo spesial.” 0:02.4–0:03.6']);
    const rev = (await readProject(s.ws, 'p1')).revision;
    const applied = await s.call(`/api/projects/p1/copilot/plans/${plan.json.plan.plan_id}/apply`, { expected_revision: rev });
    expect(applied.json.status).toBe('applied');
    expect(applied.json.project.timeline.tracks.find((t: { kind: string }) => t.kind === 'subtitle').clips.map((c: { text: string }) => c.text)).toEqual(['Halo semua!', 'Ini promo spesial.']);
    expect(applied.json.project.history.undo_label).toMatch(/^Copilot: Subtitle dari transkrip/);
    const undo = await s.call('/api/projects/p1/undo', { expected_revision: applied.json.applied_revision });
    expect(undo.json.project.timeline.tracks.find((t: { kind: string }) => t.kind === 'subtitle')?.clips ?? []).toEqual([]);
  }, 60_000);

  it('refusals: no sound, no connection, budget, provider errors — never a half transcript', async () => {
    const s = await setup();
    expect((await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.ref.version_id })).json).toMatchObject({ provider: null, estimate_usd: null, unavailable: expect.stringMatching(/transkripsi/) });
    expect((await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, confirm_usd: 1 })).status).toBe(503);
    await s.conn();
    expect((await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.mute })).json.error.message).toMatch(/tidak punya suara/);
    expect((await s.call('/api/projects/p1/transcripts/estimate', { version_id: 'v_0000000000000000' })).status).toBe(404);
    expect((await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, confirm_usd: 1, language: 'jp' })).status).toBe(400);

    await s.call('/api/ai/settings', { budget: { per_request_usd: 0.0001 } });
    await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, ...(await quote(s)) });
    expect(await s.waitJob()).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED' } });
    expect(s.fake.count('openai.transcribe')).toBe(0);

    await s.call('/api/ai/settings', { budget: { per_request_usd: 1 } });
    s.fake.queue('openai.transcribe', { status: 401, body: { error: { code: 'invalid_api_key' } } });
    await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, ...(await quote(s)) });
    const failed = await s.waitJob();
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'AI_UNAVAILABLE' } });
    expect(failed.error.message).toMatch(/API key ditolak/);
    expect(s.fake.count('openai.transcribe')).toBe(1); // auth errors are never retried
    expect((await s.call('/api/projects/p1/transcripts')).json.transcripts).toEqual([]);
    // Temp audio folders are cleaned up.
    expect((await fsp.readdir(s.dir)).filter((n) => n.startsWith('motion-stt-'))).toEqual([]);
  }, 60_000);

  it('F-9: the confirmation must be exactly the estimate shown, for the connection it was quoted for', async () => {
    const s = await setup();
    await s.conn();
    const q = await quote(s);
    for (const bad of [{ confirm_usd: 1000, connection_id: q.connection_id }, { confirm_usd: q.confirm_usd, connection_id: 'conn_000000000000' }, { confirm_usd: q.confirm_usd }]) {
      expect((await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, ...bad })).status).toBe(409);
    }
    expect(s.fake.count('openai.transcribe')).toBe(0);
    expect((await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, ...q })).status).toBe(200);
  }, 60_000);

  it('a backup provider that costs more than the approved amount is not used silently', async () => {
    const s = await setup();
    await s.conn({ priority: 1 });
    await s.call('/api/ai/providers', { provider: 'openai_compatible', label: 'Mahal', model: 'stt-x', capabilities: ['transcription'], base_url: s.fake.url, priority: 2, prices: { input_per_mtok: 0, output_per_mtok: 0, per_audio_minute: 5 } });
    const est = (await s.call('/api/projects/p1/transcripts/estimate', { version_id: s.ref.version_id })).json;
    s.fake.queue('openai.transcribe', { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} });
    await s.call('/api/ai/settings', { budget: { per_request_usd: 1 } });
    await s.call('/api/projects/p1/transcripts', { version_id: s.ref.version_id, confirm_usd: est.estimate_usd, connection_id: est.provider.connection_id });
    const j = await s.waitJob();
    expect(j.status).toBe('failed');
    expect(j.error.message).toMatch(/lebih mahal dari biaya yang disetujui/);
    expect(s.fake.count('openai.transcribe')).toBe(3); // 503 is safe to repeat (rejected before processing); the pricey backup was not called
  }, 60_000);
});
