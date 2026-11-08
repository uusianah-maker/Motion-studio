import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { StorageService, initWorkspace, loadLeases } from '../src/core.js';
import { start } from '../src/main.js';
import { createRenderJobs } from '../src/render.js';
import { apiRoutes, renderOutputName } from '../src/routes.js';
import { createStreamSigner } from '../src/stream.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit/T01/fixtures');
const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.MOTION_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp(prefix: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(async () => {
    const walk = async (d: string): Promise<void> => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else await fsp.chmod(p, 0o666).catch(() => undefined);
      }
    };
    await walk(dir);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

let clock = Date.now();
async function setup() {
  const dir = await tmp('msc-w08-');
  const ws = await initWorkspace(path.join(dir, 'ws'));
  clock = Date.now();
  const renderTmp = path.join(dir, 'render');
  await fsp.mkdir(renderTmp);
  const jobs = createRenderJobs(ws, { tmpRoot: renderTmp, settings: { short_side: 240, preset: 'ultrafast' } });
  const app = createApp({ ws, routes: apiRoutes({ tmpDir: dir }, createStreamSigner(() => clock), jobs) });
  const port = await app.listen(0);
  cleanup.push(async () => {
    await jobs.stopAll();
    await app.close();
  });
  const req = (p: string, opts: { headers?: Record<string, string>; body?: Buffer | object; method?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
      const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body));
      const json = opts.body !== undefined && !Buffer.isBuffer(opts.body);
      const r = http.request(
        {
          host: HOST,
          port,
          method: opts.method ?? (body ? 'POST' : 'GET'),
          path: p,
          headers: { host: `${HOST}:${port}`, ...(json ? { 'content-type': 'application/json' } : {}), ...opts.headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              /* binary */
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json: parsed });
          });
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  const auth = { authorization: `Bearer ${app.token}` };
  const bytes = await fsp.readFile(path.join(FIX, 'sample_8s_9x16.mp4'));
  const up = await req('/api/media/import?scope=shared', { headers: { ...auth, 'content-type': 'application/octet-stream', 'x-file-name': 'clip.mp4' }, body: bytes });
  const project = (await req('/api/projects', { headers: auth, body: { name: 'Promo Lebaran: "Diskon"', project_id: 'promo' } })).json.project;
  const media = { media_id: up.json.media_id as string, version_id: up.json.version.version_id as string };
  return { ws, req, auth, media, project, renderTmp, jobs };
}

const waitJob = async (s: Awaited<ReturnType<typeof setup>>, jobId: string, until: (j: { status: string }) => boolean, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const j = (await s.req(`/api/render/jobs/${jobId}`, { headers: s.auth })).json.job;
    if (until(j)) return j;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('W08 output names', () => {
  it('turns any name into one safe .mp4 file name', () => {
    expect(renderOutputName('Promo Lebaran: "Diskon"')).toBe('Promo Lebaran Diskon.mp4');
    expect(renderOutputName('../../etc/passwd')).toBe('passwd.mp4');
    expect(renderOutputName('final.MP4')).toBe('final.mp4');
    expect(renderOutputName('...')).toBe('render.mp4');
    expect(renderOutputName('con')).toBe('_con.mp4');
  });
});

describe.skipIf(!hasFfmpeg)('W08 render API', () => {
  it('render job → completed; output listed, playable by signed link, downloadable; no paths leak', async () => {
    const s = await setup();
    const tools = await s.req('/api/render/tools', { headers: s.auth });
    expect(tools.json).toMatchObject({ ok: true, problems: [], font: true });
    await s.req('/api/projects/promo/edit', { headers: s.auth, body: { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: s.media, start_ms: 0, duration_ms: 1500 }] } });

    const started = await s.req('/api/projects/promo/render', { headers: s.auth, body: {} });
    expect(started.status).toBe(200);
    expect(started.json.job).toMatchObject({ project_id: 'promo', output_name: 'Promo Lebaran Diskon.mp4' });
    expect(['queued', 'running']).toContain(started.json.job.status);
    const done = await waitJob(s, started.json.job.job_id, (j) => !['queued', 'running'].includes(j.status));
    expect(done).toMatchObject({ status: 'completed', progress: 1, error: null, output: { name: 'Promo Lebaran Diskon.mp4', metadata_clean: true, width: 240, height: 426 } });
    expect(JSON.stringify(done)).not.toMatch(/[A-Za-z]:\\\\|\/tmp\/|05_OUTPUT|PROJECTS/);

    const list = await s.req('/api/projects/promo/renders', { headers: s.auth });
    expect(list.json.outputs).toEqual([{ name: 'Promo Lebaran Diskon.mp4', size: done.output.size, mtime_ms: expect.any(Number) }]);
    expect(list.json.jobs[0].job_id).toBe(done.job_id);

    // Signed link: Range playback, download disposition; tampering/other names fail.
    const play = (await s.req(`/api/projects/promo/output-url?name=${encodeURIComponent('Promo Lebaran Diskon.mp4')}`, { headers: s.auth })).json;
    const part = await s.req(play.url, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.headers['content-disposition']).toBeUndefined();
    const dl = (await s.req(`/api/projects/promo/output-url?name=${encodeURIComponent('Promo Lebaran Diskon.mp4')}&download=1`, { headers: s.auth })).json;
    const whole = await s.req(dl.url);
    expect(whole.status).toBe(200);
    expect(whole.raw.length).toBe(done.output.size);
    expect(whole.headers['content-disposition']).toMatch(/^attachment; filename="Promo Lebaran Diskon.mp4"/);
    expect((await s.req(play.url.replace('download=0', 'download=1'))).status).toBe(401);
    expect((await s.req(play.url.replace('Promo', 'Xromo'))).status).toBe(401);
    clock += 11 * 60_000;
    expect((await s.req(play.url)).status).toBe(401);
    expect((await s.req('/api/projects/promo/output-url?name=..%2Fproject.json', { headers: s.auth })).status).toBe(400);
    expect((await s.req('/api/projects/promo/output-url?name=nope.mp4', { headers: s.auth })).status).toBe(404);
    expect((await s.req('/api/projects/promo/renders')).status).toBe(401);
  }, 90_000);

  it('blocked preflight is reported as codes; cancel works; bad input rejected', async () => {
    const s = await setup();
    // Empty timeline → NO_MEDIA
    const j1 = (await s.req('/api/projects/promo/render', { headers: s.auth, body: { output_name: 'kosong' } })).json.job;
    const b = await waitJob(s, j1.job_id, (j) => !['queued', 'running'].includes(j.status));
    expect(b).toMatchObject({ status: 'blocked', problems: [{ code: 'NO_MEDIA' }], output: null });

    await s.req('/api/projects/promo/edit', { headers: s.auth, body: { expected_revision: 0, ops: [{ op: 'add_clip', track_kind: 'video', media: s.media, start_ms: 0, duration_ms: 8000 }] } });
    const j2 = (await s.req('/api/projects/promo/render', { headers: s.auth, body: { output_name: 'batal.mp4', short_side: 1080 } })).json.job;
    await waitJob(s, j2.job_id, (j) => (j as { phase?: string }).phase === 'encoding' || j.status !== 'queued');
    const c = await s.req(`/api/render/jobs/${j2.job_id}/cancel`, { headers: s.auth, method: 'POST', body: {} });
    expect(c.status).toBe(200);
    const end = await waitJob(s, j2.job_id, (j) => !['queued', 'running'].includes(j.status));
    expect(['cancelled', 'completed']).toContain(end.status); // tiny clip may finish before the kill lands
    if (end.status === 'cancelled') expect((await s.req('/api/projects/promo/renders', { headers: s.auth })).json.outputs).toEqual([]);
    expect((await loadLeases(s.ws)).leases).toEqual([]);

    expect((await s.req('/api/projects/promo/render', { headers: s.auth, body: { short_side: 4000 } })).status).toBe(400);
    expect((await s.req('/api/projects/promo/render', { headers: s.auth, body: { actor: 'ai' } })).status).toBe(400);
    expect((await s.req('/api/projects/promo/render', { headers: s.auth, body: { settings: { crf: 0 } } })).status).toBe(400);
    expect((await s.req('/api/projects/nope/render', { headers: s.auth, body: {} })).status).toBe(404);
    expect((await s.req('/api/render/jobs/job_0000000000000000', { headers: s.auth })).status).toBe(404);
  }, 90_000);
});

describe('W08 server start', () => {
  it('releases a dead render worker lease and sweeps old render temp folders', async () => {
    const dir = await tmp('msc-w08-start-');
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const up = path.join(dir, 'src.mp4');
    await fsp.writeFile(up, 'x');
    const r = await new StorageService(ws).importMedia({ sourcePath: up, scope: { kind: 'shared' }, actor: 'user' });
    // A lease left by a render worker that no longer exists.
    const leasesFile = path.join(ws.root, '.motionstudio', 'leases.json');
    const file = JSON.parse(await fsp.readFile(leasesFile, 'utf8'));
    file.leases.push({ lease_id: 'lease_dead', job: 'render', status: 'running', label: 'x', created_at: 1, media: [{ media_id: r.media.media_id, version_id: r.version.version_id, content_hash: r.version.content_hash }], worker_pid: 2_147_483_000 });
    await fsp.writeFile(leasesFile, JSON.stringify(file));
    const renderTmp = path.join(dir, 'rt');
    await fsp.mkdir(path.join(renderTmp, 'motion-render-old'), { recursive: true });
    await fsp.writeFile(path.join(renderTmp, 'motion-render-old', 'out.mp4'), 'partial');
    const old = new Date(Date.now() - 7 * 3_600_000);
    await fsp.utimes(path.join(renderTmp, 'motion-render-old', 'out.mp4'), old, old);
    await fsp.utimes(path.join(renderTmp, 'motion-render-old'), old, old);
    const srv = await start({ MOTION_WORKSPACE: ws.root, MOTION_PORT: '0', MOTION_GC: 'off', MOTION_UPLOAD_TMP: dir, MOTION_RENDER_TMP: renderTmp, MOTION_WEB_DIR: path.join(dir, 'noweb') }, () => undefined);
    cleanup.push(() => srv.stop());
    expect(srv.releasedLeases).toEqual(['lease_dead']);
    expect(srv.sweptRenders).toEqual(['motion-render-old']);
    expect((await loadLeases(ws)).leases).toEqual([]);
  });
});
