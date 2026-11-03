import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { resolveCanonical } from './paths.js';
import { LAYOUT, META_FILES, type Workspace } from './workspace.js';

// ------------------------------------------------------------------ journal (crash safety, ST-09)

export interface JournalEntry {
  schema_version: 1;
  op_id: string;
  kind: 'trash' | 'restore' | 'purge';
  version_id: string;
  from_rel: string;
  to_rel: string;
  manifest_rel: string;
  content_hash: string;
  started_at: number;
}

const journalRel = (op_id: string, version_id: string) => `${LAYOUT.meta}/${META_FILES.journal}/${op_id}--${version_id}.json`;

export async function writeJournal(ws: Workspace, e: JournalEntry): Promise<void> {
  await writeJsonAtomic((await resolveCanonical(ws.root, journalRel(e.op_id, e.version_id), { allowMissing: true })).abs, e);
}
export async function clearJournal(ws: Workspace, e: Pick<JournalEntry, 'op_id' | 'version_id'>): Promise<void> {
  await fsp.rm(path.join(ws.root, LAYOUT.meta, META_FILES.journal, `${e.op_id}--${e.version_id}.json`), { force: true });
}
export async function listJournal(ws: Workspace): Promise<{ file: string; entry: JournalEntry | null }[]> {
  const dir = path.join(ws.root, LAYOUT.meta, META_FILES.journal);
  const out: { file: string; entry: JournalEntry | null }[] = [];
  for (const name of (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    const entry = await readJson(file, (x) => x as JournalEntry).catch(() => null);
    out.push({ file, entry });
  }
  return out;
}
/** Versions with an unfinished move are busy for every other operation. */
export async function journalBusy(ws: Workspace): Promise<Set<string>> {
  return new Set((await listJournal(ws)).map((j) => j.entry?.version_id).filter((x): x is string => !!x));
}

