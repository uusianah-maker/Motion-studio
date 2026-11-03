import { promises as fsp } from 'node:fs';
import { newId } from './ids.js';
import type { Actor } from './permissions.js';
import { META_FILES, type Workspace, metaPath } from './workspace.js';

/** Field names that must never reach the audit log (PRD v0.8 §E: never log API keys). */
const SENSITIVE = /(api[_-]?key|secret|token|password|authorization|credential)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface AuditEntry {
  ts: number;
  op_id: string;
  op: string;
  actor: Actor | 'system';
  outcome: 'ok' | 'blocked' | 'failed' | 'info' | 'alert';
  [k: string]: unknown;
}

/** Append-only JSONL audit log. Every destructive/GC attempt is recorded, including blocked ones. */
export async function audit(
  ws: Workspace,
  entry: Omit<AuditEntry, 'ts' | 'op_id'> & { op_id?: string },
): Promise<AuditEntry> {
  const full = redact({ ts: ws.clock.now(), op_id: entry.op_id ?? newId('op'), ...entry }) as AuditEntry;
  const fh = await fsp.open(metaPath(ws, META_FILES.audit), 'a');
  try {
    await fh.appendFile(JSON.stringify(full) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  return full;
}

export async function readAudit(ws: Workspace, filter?: (e: AuditEntry) => boolean): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(metaPath(ws, META_FILES.audit), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (!filter || filter(e)) out.push(e);
    } catch {
      // A torn last line after a crash must not hide the rest of the log.
    }
  }
  return out;
}
