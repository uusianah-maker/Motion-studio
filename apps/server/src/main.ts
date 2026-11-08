#!/usr/bin/env node
/**
 * Start the local server: open the workspace, run crash recovery + the Smart GC scheduler
 * (ST-09: launch = recovery, an immediate cycle, then the policy interval), listen on
 * 127.0.0.1 and print the one-time session URL. The token travels in the URL *fragment*,
 * which browsers never send to servers or proxies.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST, createApp } from './app.js';
import { type GoogleAuth, createGoogleAuth, parseAllowlist } from './auth.js';
import { type CycleResult, RENDER_TMP_PREFIX, type RecoveryReport, openWorkspace, recoverOnStartup, releaseOrphanLeases } from './core.js';
import { createCopilot } from './copilot.js';
import { createRenderJobs } from './render.js';
import { apiRoutes, sweepUploadTemp } from './routes.js';
import { createStreamSigner } from './stream.js';

export const DEFAULT_PORT = 4317;

/** apps/server/dist/main.js → apps/web/dist (built by `npm run build`). */
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const GOOGLE_VARS = ['MOTION_GOOGLE_CLIENT_ID', 'MOTION_GOOGLE_CLIENT_SECRET', 'MOTION_ALLOWED_EMAILS'] as const;

/** Google endpoints may be overridden (tests: a fake Google) but only with https or loopback http. */
function endpoint(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const u = new URL(raw);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error(`${name} harus https:// (atau http://127.0.0.1 untuk tes)`);
  return u.toString();
}

/** Default server state folder (secret key, sealed AI provider keys): outside the workspace. */
export const defaultStateDir = () => path.join(os.homedir(), '.motion-studio');

/** MOTION_GC: "on" (default, PRD: Auto Trash runs while the app runs), "scan-only", "off" (recovery only). */
type GcMode = 'on' | 'scan-only' | 'off';

export async function start(env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)) {
  const root = env.MOTION_WORKSPACE;
  if (!root) throw new Error('MOTION_WORKSPACE belum di-set (folder workspace yang sudah di-init)');
  const port = env.MOTION_PORT ? Number(env.MOTION_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MOTION_PORT tidak valid: ${env.MOTION_PORT}`);
  const gc = (env.MOTION_GC ?? 'on') as GcMode;
  if (!['on', 'scan-only', 'off'].includes(gc)) throw new Error(`MOTION_GC tidak valid: ${env.MOTION_GC} (on | scan-only | off)`);

  // Google login (W09): all three set = on; none = local token mode; some = refuse (fail closed).
  const googleSet = GOOGLE_VARS.filter((k) => (env[k] ?? '').trim() !== '');
  if (googleSet.length && googleSet.length < GOOGLE_VARS.length) {
    throw new Error(`Login Google belum lengkap: ${GOOGLE_VARS.filter((k) => !googleSet.includes(k)).join(', ')} belum di-set`);
  }
  const allowedEmails = googleSet.length ? parseAllowlist(env.MOTION_ALLOWED_EMAILS) : [];
  if (googleSet.length && !allowedEmails.length) throw new Error('MOTION_ALLOWED_EMAILS kosong: minimal satu email');
  const publicUrl = (env.MOTION_PUBLIC_URL ?? '').replace(/\/+$/, '') || null;
  if (publicUrl && !/^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/.test(publicUrl)) {
    throw new Error('MOTION_PUBLIC_URL harus https://domain (atau http://127.0.0.1:<port> / http://localhost:<port>), tanpa path');
  }
  if (googleSet.length && !publicUrl && port === 0) throw new Error('Login Google butuh port tetap (redirect URI terdaftar di Google): set MOTION_PORT atau MOTION_PUBLIC_URL');

  const ws = await openWorkspace(path.resolve(root));
  const webDir = env.MOTION_WEB_DIR ? path.resolve(env.MOTION_WEB_DIR) : WEB_DIST;
  const devOrigin = env.MOTION_DEV_ORIGIN;
  if (devOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(devOrigin)) throw new Error('MOTION_DEV_ORIGIN hanya boleh http://127.0.0.1:<port> atau http://localhost:<port>');
  const uploadTmp = env.MOTION_UPLOAD_TMP ? path.resolve(env.MOTION_UPLOAD_TMP) : os.tmpdir();
  const sweptUploads = await sweepUploadTemp(uploadTmp);
  // Render (W08): job folders outside the workspace; a crashed render leaves its folder + lease.
  const renderTmp = env.MOTION_RENDER_TMP ? path.resolve(env.MOTION_RENDER_TMP) : os.tmpdir();
  const sweptRenders = await sweepUploadTemp(renderTmp, 6 * 3_600_000, Date.now(), RENDER_TMP_PREFIX);
  const releasedLeases = await releaseOrphanLeases(ws);
  const jobs = createRenderJobs(ws, { tmpRoot: renderTmp }, (e) => process.stderr.write(`[server] render: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}
`));
  const copilot = createCopilot(ws);
  let auth: GoogleAuth | undefined;
  const stateDir = env.MOTION_STATE_DIR ? path.resolve(env.MOTION_STATE_DIR) : defaultStateDir();
  if (googleSet.length) {
    const authEndpoint = endpoint(env.MOTION_GOOGLE_AUTH_ENDPOINT, 'MOTION_GOOGLE_AUTH_ENDPOINT');
    const tokenEndpoint = endpoint(env.MOTION_GOOGLE_TOKEN_ENDPOINT, 'MOTION_GOOGLE_TOKEN_ENDPOINT');
    auth = createGoogleAuth({
      ws,
      clientId: env.MOTION_GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.MOTION_GOOGLE_CLIENT_SECRET!.trim(),
      allowedEmails,
      publicUrl: () => publicUrl ?? `http://${HOST}:${port}`,
      ...(authEndpoint ? { authEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
    });
  }
  const app = createApp({
    ws,
    ...(auth ? { auth } : {}),
    ...(publicUrl && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(publicUrl) ? { publicOrigin: publicUrl } : {}),
    ...(existsSync(path.join(webDir, 'index.html')) ? { staticDir: webDir } : {}),
    ...(devOrigin ? { allowedOrigins: [devOrigin] } : {}),
    routes: [...apiRoutes({ tmpDir: uploadTmp }, createStreamSigner(), jobs), ...copilot.routes],
    onError: (e) => process.stderr.write(`[server] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`),
  });

  let recovery: RecoveryReport;
  let firstCycle: CycleResult | null = null;
  const scheduler = gc === 'off' ? null : app.svc.createScheduler({ autoTrash: gc === 'on' });
  if (scheduler) {
    firstCycle = await scheduler.start();
    recovery = scheduler.lastRecovery!;
  } else {
    recovery = await recoverOnStartup(ws);
  }

  // Probe media imported before W07 in the background (metadata only; never blocks startup).
  void app.svc.backfillProbes({ limit: 500 }).catch((e: unknown) => process.stderr.write(`[server] backfill probe: ${String(e)}
`));

  let bound: number;
  try {
    bound = await app.listen(port);
  } catch (e) {
    scheduler?.stop();
    await jobs.stopAll();
    throw e;
  }
  out(`Motion Studio server jalan di http://${HOST}:${bound} (GC: ${gc})`);
  if (auth) {
    out(`Login Google aktif (${auth.allowedCount} email diizinkan). Buka: ${publicUrl ?? `http://${HOST}:${bound}`}/`);
  } else {
    out(`Mode lokal (tanpa login Google, hanya untuk komputer ini). Buka: http://${HOST}:${bound}/#token=${app.token}`);
  }
  if (recovery.corrupt_journal.length || recovery.orphan_files.length) {
    out(`Perhatian recovery: ${recovery.corrupt_journal.length} journal korup, ${recovery.orphan_files.length} file yatim (lihat audit log)`);
  }
  return {
    app,
    port: bound,
    recovery,
    sweptUploads,
    sweptRenders,
    releasedLeases,
    firstCycle,
    scheduler,
    jobs,
    auth: auth ?? null,
    copilot,
    stateDir,
    async stop() {
      scheduler?.stop();
      await jobs.stopAll();
      await app.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Optional local env file (gitignored) so Client ID/secret need not be typed per terminal.
  const envFile = process.env.MOTION_ENV_FILE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  start().catch((e: unknown) => {
    process.stderr.write(`Gagal start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
