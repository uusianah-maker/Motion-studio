/**
 * R19 "Kirim ke PIC" (owner: "Ya, buat"): the editor's last send of a project to the PIC.
 *
 *   03_PROJECT/kirim-pic.json  { revision, kiriman, at, by, job_id, state, alasan }
 *
 * One click renders the newest revision; when the render is done the video is in the PIC's queue
 * (3. Setujui) as "Revisi <kiriman>". The same revision is never sent twice.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './jsonStore.js';
import { resolveInside } from './paths.js';
import { type Workspace, projectRel } from './workspace.js';

export interface KirimPic {
  /** Project revision that was sent (rendered). */
  revision: number;
  /** How many times this project was sent (1, 2, …): "Revisi 2" in the queue. */
  kiriman: number;
  at: number;
  by: string | null;
  /** The render job (in-memory on the server; gone after a restart). */
  job_id: string | null;
  state: 'merender' | 'terkirim' | 'gagal';
  alasan: string | null;
}

const file = async (ws: Workspace, projectId: string) => resolveInside(ws.root, path.posix.join(projectRel(projectId, '03_PROJECT'), 'kirim-pic.json'), { allowMissing: true });

export async function readKirimPic(ws: Workspace, projectId: string): Promise<KirimPic | null> {
  try {
    const o = JSON.parse(await fsp.readFile(await file(ws, projectId), 'utf8')) as KirimPic;
    return o && Number.isInteger(o.revision) && Number.isInteger(o.kiriman) && ['merender', 'terkirim', 'gagal'].includes(o.state) ? o : null;
  } catch {
    return null; // never sent, or an unreadable file (the next send rewrites it)
  }
}

export async function writeKirimPic(ws: Workspace, projectId: string, k: KirimPic): Promise<void> {
  await writeJsonAtomic(await file(ws, projectId), k);
}
