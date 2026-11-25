/**
 * 25 Nov (owner: "auto masking untuk overlay contohnya seperti objek yang berada di depan teks
 * highlight"). Step 1 of "Objek di depan teks": render the canvas PICTURE under a text clip
 * (video, b-roll, zoom — no text, overlays, logo or sound) and import it into the project's Media,
 * so the engine's hapus_latar (§18.8, models already installed) can cut the subject out of exactly
 * what the viewer sees. Step 2 (engine job) and step 3 (`set_depan`) are run by the server/editor.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEPAN_MAX_MS } from './clipLook.js';
import { StorageError } from './errors.js';
import type { Clip, MediaRef, Timeline } from './project.js';
import { importMedia } from './registry.js';
import { renderProject } from './render.js';
import type { Actor } from './permissions.js';
import { type Workspace, readProject } from './workspace.js';

const clipsOf = (t: Timeline, kind: string): Clip[] => t.tracks.filter((x) => x.kind === kind).flatMap((x) => x.clips);

export { DEPAN_MAX_MS };
/** Short side of the source the mask is made from (mask is scaled to the render size). */
export const DEPAN_SHORT_SIDE = 720;
/** Frames per second the engine cuts (15: edges follow motion; 1.3 s/frame on the office PC). */
export const DEPAN_FPS = 15;

export interface DepanSource {
  sumber: MediaRef;
  dari_ms: number;
  durasi_ms: number;
}

export async function depanSource(ws: Workspace, input: { project_id: string; clip_id: string; actor: Actor }, hooks: { signal?: AbortSignal; tmpRoot?: string } = {}): Promise<DepanSource> {
  const p = await readProject(ws, input.project_id);
  const c = [...clipsOf(p.timeline, 'text'), ...clipsOf(p.timeline, 'subtitle')].find((x) => x.clip_id === input.clip_id);
  if (!c) throw new StorageError('NOT_FOUND', 'Klip teks tidak ditemukan', { clip_id: input.clip_id });
  const from = c.start_ms;
  const to = Math.min(c.end_ms, c.start_ms + DEPAN_MAX_MS);
  const under = p.timeline.tracks.filter((t) => t.kind === 'video' || t.kind === 'broll').flatMap((t) => t.clips).some((v) => v.media && v.start_ms < to && v.end_ms > from);
  if (!under) throw new StorageError('PRECONDITION', 'Tidak ada video di bawah teks ini');
  let ref: MediaRef | null = null;
  const tmp = await fsp.mkdtemp(path.join(hooks.tmpRoot ?? os.tmpdir(), 'msc-depan-'));
  try {
    await renderProject(
      ws,
      { project_id: input.project_id, output_name: `depan-${input.clip_id}-${Date.now()}.mp4`, actor: input.actor, accept_brand_warnings: true },
      {
        settings: { short_side: DEPAN_SHORT_SIDE, preset: 'veryfast' },
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        ...(hooks.tmpRoot ? { tmpRoot: hooks.tmpRoot } : {}),
        pictureSpan: {
          from_ms: from,
          to_ms: to,
          deliver: async (file) => {
            const copy = path.join(tmp, `Sumber depan teks ${input.clip_id}.mp4`);
            await fsp.copyFile(file, copy);
            const r = await importMedia(ws, { sourcePath: copy, scope: { kind: 'project', project_id: input.project_id }, display_name: `Sumber depan teks ${input.clip_id}.mp4`, actor: input.actor });
            ref = { media_id: r.media.media_id, version_id: r.version.version_id };
          },
        },
      },
    );
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!ref) throw new StorageError('RENDER_FAILED', 'Gambar di bawah teks gagal dibuat');
  return { sumber: ref, dari_ms: from, durasi_ms: to - from };
}
