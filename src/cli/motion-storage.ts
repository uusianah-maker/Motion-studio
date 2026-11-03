#!/usr/bin/env node
/**
 * Minimal CLI for the storage core until the desktop shell exists (PC-1).
 * Non-destructive operations only: init, dashboard, scan (dry run), recover (repairs
 * interrupted operations and sweeps stale temp files; never deletes media).
 * Auto Trash, restore and permanent delete are deliberately NOT exposed here.
 */
import { pathToFileURL } from 'node:url';
import { getDashboard } from '../storage/quota.js';
import { recoverOnStartup } from '../storage/recovery.js';
import { scanCandidates } from '../storage/scanner.js';
import { initWorkspace, openWorkspace } from '../storage/workspace.js';

const USAGE = `motion-storage <perintah> <folder-workspace> [--json]

Perintah:
  init       buat workspace baru (folder harus kosong / belum ada)
  dashboard  ringkasan pemakaian disk, status GC, isi Trash
  scan       scan kandidat Auto Trash (dry run, tidak memindahkan file)
  recover    pulihkan operasi yang terputus (crash recovery)`;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function runCli(argv: string[], out: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const [cmd, root] = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  if (!cmd || !root || !['init', 'dashboard', 'scan', 'recover'].includes(cmd)) {
    out(USAGE);
    return 2;
  }
  try {
    if (cmd === 'init') {
      const ws = await initWorkspace(root);
      out(json ? JSON.stringify({ root: ws.root, workspace_id: ws.meta.workspace_id }) : `Workspace dibuat: ${ws.root}`);
      return 0;
    }
    const ws = await openWorkspace(root);
    if (cmd === 'recover') {
      const r = await recoverOnStartup(ws);
      out(json ? JSON.stringify(r, null, 2) : `Recovery: ${r.journal.length} operasi diselesaikan, ${r.removed_temp_files.length} file sementara dihapus, ${r.orphan_files.length} file yatim (tidak dihapus), ${r.corrupt_journal.length} journal korup`);
      return r.corrupt_journal.length ? 1 : 0;
    }
    if (cmd === 'scan') {
      const r = await scanCandidates(ws, { actor: 'user' });
      if (json) out(JSON.stringify(r, null, 2));
      else if (!r.ok) out(`Scan DIHENTIKAN (fail closed): ${r.errors.join('; ')}`);
      else out(`Scan (dry run): ${r.candidates.length} kandidat Auto Trash. Status: ${JSON.stringify(r.summary)}`);
      return r.ok ? 0 : 1;
    }
    const d = await getDashboard(ws);
    if (json) {
      out(JSON.stringify(d, null, 2));
      return 0;
    }
    const u = d.stats.usage;
    out(
      [
        `Workspace: ${ws.root}`,
        `Media: ${mb(d.stats.media_bytes)} | Cache: ${mb(u.project_cache)} | Output: ${mb(u.project_output)} | Trash: ${mb(u.trash)}`,
        `Disk kosong: ${d.stats.disk ? mb(d.stats.disk.free_bytes) : 'tidak diketahui'}`,
        `GC: ${d.gc.ok ? `${d.gc.candidates} kandidat` : `DIHENTIKAN (${d.gc.errors.join('; ')})`} | Trash: ${d.trash.length} item | Backup terverifikasi: ${d.backup.verified}/${d.backup.active_versions}`,
        ...d.stats.warnings.map((w) => `! ${w.code}: ${w.advice}`),
      ].join('\n'),
    );
    return 0;
  } catch (e) {
    out(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
