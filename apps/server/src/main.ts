#!/usr/bin/env node
/**
 * Start the local server: open the workspace, run crash recovery (ST-09), listen on
 * 127.0.0.1 and print the one-time session URL. The token travels in the URL *fragment*,
 * which browsers never send to servers or proxies.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST, createApp } from './app.js';
import { openWorkspace, recoverOnStartup } from './core.js';

export const DEFAULT_PORT = 4317;

export async function start(env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)) {
  const root = env.MOTION_WORKSPACE;
  if (!root) throw new Error('MOTION_WORKSPACE belum di-set (folder workspace yang sudah di-init)');
  const port = env.MOTION_PORT ? Number(env.MOTION_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MOTION_PORT tidak valid: ${env.MOTION_PORT}`);
  const ws = await openWorkspace(path.resolve(root));
  const recovery = await recoverOnStartup(ws);
  const app = createApp({ ws, onError: (e) => process.stderr.write(`[server] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`) });
  const bound = await app.listen(port);
  out(`Motion Studio server jalan di http://${HOST}:${bound}`);
  out(`Buka: http://${HOST}:${bound}/#token=${app.token}`);
  if (recovery.corrupt_journal.length || recovery.orphan_files.length) {
    out(`Perhatian recovery: ${recovery.corrupt_journal.length} journal korup, ${recovery.orphan_files.length} file yatim (lihat audit log)`);
  }
  return { app, port: bound, recovery };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start().catch((e: unknown) => {
    process.stderr.write(`Gagal start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
