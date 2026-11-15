#!/usr/bin/env node
/**
 * Start the local server: open the workspace, run crash recovery + the Smart GC scheduler
 * (ST-09: launch = recovery, an immediate cycle, then the policy interval), listen on
 * 127.0.0.1 and print the one-time session URL. The token travels in the URL *fragment*,
 * which browsers never send to servers or proxies.
 */
import { imageAiRoutes, openImageAiStore } from './ai/imageAi.js';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST, createApp } from './app.js';
import { type GoogleAuth, createGoogleAuth, parseAllowlist } from './auth.js';
import { type CycleResult, RENDER_TMP_PREFIX, type RecoveryReport, engineConfigFromEnv, openWorkspace, recoverOnStartup, releaseOrphanLeases } from './core.js';
import { openSpendGate } from './ai/budget.js';
import { createAiPlanner } from './ai/planner.js';
import { createRouter } from './ai/router.js';
import { aiRoutes } from './ai/routes.js';
import { openAiStore } from './ai/store.js';
import { createCopilot } from './copilot.js';
import { STT_TMP_PREFIX, transcribeRoutes } from './transcribe.js';
import { cutRoutes } from './cuts.js';
import { createEngine } from './engine.js';
import { reviewRoutes } from './review.js';
import { parseRoleLists, roleResolver, teamRoleResolver } from './roles.js';
import { type TeamStore, envMembers, openTeamStore, teamRoutes } from './team.js';
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

/**
 * Start-up line for Google login. The team can change later from the Tim page, so this counts the
 * list AT START and says where the live list is (audit 14 Nov: "1 email diizinkan" with 3 members).
 */
export function loginBanner(members: number, url: string): string {
  return `Login Google aktif: ${members} email di daftar tim saat server mulai (daftar terbaru di halaman Tim). Buka: ${url}`;
}

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
  // U7: roles only mean something with Google login (local token mode = the owner on this PC).
  const roleLists = googleSet.length ? parseRoleLists(env, allowedEmails) : null;
  const publicUrl = (env.MOTION_PUBLIC_URL ?? '').replace(/\/+$/, '') || null;
  if (publicUrl && !/^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/.test(publicUrl)) {
    throw new Error('MOTION_PUBLIC_URL harus https://domain (atau http://127.0.0.1:<port> / http://localhost:<port>), tanpa path');
  }
  // Checkpoint E E2: never serve a public origin with only the URL token (fail closed).
  if (publicUrl && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(publicUrl) && !googleSet.length) {
    throw new Error('MOTION_PUBLIC_URL publik butuh login Google (MOTION_GOOGLE_CLIENT_ID, MOTION_GOOGLE_CLIENT_SECRET, MOTION_ALLOWED_EMAILS). Mode token URL hanya untuk komputer ini.');
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
  await sweepUploadTemp(renderTmp, 6 * 3_600_000, Date.now(), STT_TMP_PREFIX);
  const releasedLeases = await releaseOrphanLeases(ws);
  const jobs = createRenderJobs(ws, { tmpRoot: renderTmp }, (e) => process.stderr.write(`[server] render: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}
`));
  let auth: GoogleAuth | undefined;
  const stateDir = env.MOTION_STATE_DIR ? path.resolve(env.MOTION_STATE_DIR) : defaultStateDir();
  // AI (W12): provider keys sealed in the state folder; the key file is only created on first use.
  const aiStore = await openAiStore(stateDir, env.MOTION_SECRET_KEY);
  const imageAi = await openImageAiStore(stateDir, env.MOTION_SECRET_KEY);
  const ledger = await openSpendGate({ ws, store: aiStore, stateDir });
  const aiRouter = createRouter({ ws, store: aiStore, gate: ledger.gate });
  const copilot = createCopilot(ws, { ai: createAiPlanner(aiStore, aiRouter), mode: () => aiStore.settings().mode });
  // Halaman Tim: env accounts (locked) + accounts the owner added on the web (<state dir>/team.json).
  const team: TeamStore | null = googleSet.length ? await openTeamStore({ stateDir, env: envMembers(allowedEmails, roleLists) }) : null;
  if (team) {
    const authEndpoint = endpoint(env.MOTION_GOOGLE_AUTH_ENDPOINT, 'MOTION_GOOGLE_AUTH_ENDPOINT');
    const tokenEndpoint = endpoint(env.MOTION_GOOGLE_TOKEN_ENDPOINT, 'MOTION_GOOGLE_TOKEN_ENDPOINT');
    auth = createGoogleAuth({
      ws,
      clientId: env.MOTION_GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.MOTION_GOOGLE_CLIENT_SECRET!.trim(),
      isAllowed: team.isAllowed,
      // Sesi login disimpan di folder state supaya restart server tidak me-logout tim.
      stateDir,
      publicUrl: () => publicUrl ?? `http://${HOST}:${port}`,
      ...(authEndpoint ? { authEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
    });
  }
  const engine = createEngine(ws, { copilot, config: engineConfigFromEnv(env), onError: (e) => process.stderr.write(`[server] mesin: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`) });
  void engine.sweepOrphans().catch((e: unknown) => process.stderr.write(`[server] mesin (job yatim): ${String(e)}\n`));
  const app = createApp({
    ws,
    ...(auth ? { auth } : {}),
    ...(publicUrl && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(publicUrl) ? { publicOrigin: publicUrl } : {}),
    ...(existsSync(path.join(webDir, 'index.html')) ? { staticDir: webDir } : {}),
    ...(devOrigin ? { allowedOrigins: [devOrigin] } : {}),
    routes: [...apiRoutes({ tmpDir: uploadTmp }, createStreamSigner(), jobs), ...copilot.routes, ...aiRoutes(ws, aiStore, ledger, fetch, { devEndpoints: env.MOTION_AI_DEV_ENDPOINTS === '1' }), ...imageAiRoutes(imageAi, fetch, { devEndpoints: env.MOTION_AI_DEV_ENDPOINTS === '1' }), ...transcribeRoutes(ws, { router: aiRouter, copilot, tmpRoot: renderTmp }), ...cutRoutes(ws, { copilot }), ...reviewRoutes(ws), ...engine.routes, ...(team ? teamRoutes(ws, team, { onRemoved: (email) => auth?.revokeEmail(email) }) : [])],
    roleOf: team ? teamRoleResolver(team.roleOf) : roleResolver(roleLists),
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
    await engine.stopAll();
    await jobs.stopAll();
    throw e;
  }
  out(`Motion Studio server jalan di http://${HOST}:${bound} (GC: ${gc})`);
  if (auth) {
    out(loginBanner(team?.size() ?? 0, `${publicUrl ?? `http://${HOST}:${bound}`}/`));
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
    team,
    copilot,
    ai: { store: aiStore, router: aiRouter, ledger },
    stateDir,
    async stop() {
      scheduler?.stop();
      await engine.stopAll();
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
