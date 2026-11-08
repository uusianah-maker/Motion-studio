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
import { type CycleResult, type RecoveryReport, openWorkspace, recoverOnStartup } from './core.js';
import { apiRoutes, sweepUploadTemp } from './routes.js';

export const DEFAULT_PORT = 4317;

/** apps/server/dist/main.js → apps/web/dist (built by `npm run build`). */
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

/** MOTION_GC: "on" (default, PRD: Auto Trash runs while the app runs), "scan-only", "off" (recovery only). */
type GcMode = 'on' | 'scan-only' | 'off';

export async function start(env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)) {
  const root = env.MOTION_WORKSPACE;
  if (!root) throw new Error('MOTION_WORKSPACE belum di-set (folder workspace yang sudah di-init)');
  const port = env.MOTION_PORT ? Number(env.MOTION_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MOTION_PORT tidak valid: ${env.MOTION_PORT}`);
  const gc = (env.MOTION_GC ?? 'on') as GcMode;
  if (!['on', 'scan-only', 'off'].includes(gc)) throw new Error(`MOTION_GC tidak valid: ${env.MOTION_GC} (on | scan-only | off)`);

  const ws = await openWorkspace(path.resolve(root));
  const webDir = env.MOTION_WEB_DIR ? path.resolve(env.MOTION_WEB_DIR) : WEB_DIST;
  const devOrigin = env.MOTION_DEV_ORIGIN;
  if (devOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(devOrigin)) throw new Error('MOTION_DEV_ORIGIN hanya boleh http://127.0.0.1:<port> atau http://localhost:<port>');
  const uploadTmp = env.MOTION_UPLOAD_TMP ? path.resolve(env.MOTION_UPLOAD_TMP) : os.tmpdir();
  const sweptUploads = await sweepUploadTemp(uploadTmp);
  const app = createApp({
    ws,
    ...(existsSync(path.join(webDir, 'index.html')) ? { staticDir: webDir } : {}),
    ...(devOrigin ? { allowedOrigins: [devOrigin] } : {}),
    routes: apiRoutes({ tmpDir: uploadTmp }),
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

  let bound: number;
  try {
    bound = await app.listen(port);
  } catch (e) {
    scheduler?.stop();
    throw e;
  }
  out(`Motion Studio server jalan di http://${HOST}:${bound} (GC: ${gc})`);
  out(`Buka: http://${HOST}:${bound}/#token=${app.token}`);
  if (recovery.corrupt_journal.length || recovery.orphan_files.length) {
    out(`Perhatian recovery: ${recovery.corrupt_journal.length} journal korup, ${recovery.orphan_files.length} file yatim (lihat audit log)`);
  }
  return {
    app,
    port: bound,
    recovery,
    sweptUploads,
    firstCycle,
    scheduler,
    async stop() {
      scheduler?.stop();
      await app.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start().catch((e: unknown) => {
    process.stderr.write(`Gagal start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
