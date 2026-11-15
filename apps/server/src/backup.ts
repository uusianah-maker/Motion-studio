import path from 'node:path';
import type { Route } from './app.js';
import { type Workspace, listBackupLocations, registerBackupLocation, verifyBackupLocation } from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { onlyKeys } from './routes.js';

export interface BackupVerifyStatus {
  location_id: string | null;
  state: 'idle' | 'berjalan' | 'selesai' | 'gagal';
  started_at: number | null;
  finished_at: number | null;
  /** Files looked at / hashed / versions proven, when finished. */
  hasil: { scanned: number; hashed: number; matched: number } | null;
  alasan: string | null;
}

/**
 * Footage backup (PRD §G) in Storage: the app never copies footage; the owner registers a backup
 * folder and VERIFIES it read-only by content hash. Verifying can hash many GB, so it runs in the
 * background (one at a time) and the page polls its status — a request would hit the idle timeout.
 */
export function backupRoutes(ws: Workspace): Route[] {
  let status: BackupVerifyStatus = { location_id: null, state: 'idle', started_at: null, finished_at: null, hasil: null, alasan: null };
  const view = async (owner: boolean) => ({
    // A folder's full local path is shown to the owner only; others see its name.
    lokasi: (await listBackupLocations(ws)).map((l) => ({ location_id: l.location_id, nama: path.basename(l.path) || l.path, ...(owner ? { path: l.path } : {}), registered_at: l.registered_at, terverifikasi: l.verified, terakhir: l.last_verified_at })),
    verifikasi: status,
  });
  return [
    {
      method: 'GET',
      path: '/api/backup',
      handle: async ({ role }) => view(role === 'owner'),
    },
    {
      method: 'POST',
      path: '/api/backup/lokasi',
      handle: async ({ req, actor, role }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['path']);
        if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 500) throw new ApiError(400, 'BAD_REQUEST', 'Isi path folder backup');
        await registerBackupLocation(ws, { path: body.path.trim(), actor });
        return view(role === 'owner');
      },
    },
    {
      method: 'POST',
      path: '/api/backup/lokasi/:location_id/verifikasi',
      handle: async ({ params, actor, role }) => {
        if (status.state === 'berjalan') throw new ApiError(409, 'BUSY', 'Verifikasi backup lain sedang berjalan');
        const id = params.location_id!;
        if (!(await listBackupLocations(ws)).some((l) => l.location_id === id)) throw new ApiError(404, 'NOT_FOUND', 'Lokasi backup tidak terdaftar');
        status = { location_id: id, state: 'berjalan', started_at: Date.now(), finished_at: null, hasil: null, alasan: null };
        void verifyBackupLocation(ws, { location_id: id, actor }).then(
          (r) => {
            status = { ...status, state: 'selesai', finished_at: Date.now(), hasil: { scanned: r.scanned, hashed: r.hashed, matched: r.matched.length } };
          },
          (e: unknown) => {
            // The reason without local paths (the folder may be gone / unplugged).
            const msg = e instanceof Error ? e.message : String(e);
            status = { ...status, state: 'gagal', finished_at: Date.now(), alasan: /ENOENT|EACCES|EPERM|tidak/i.test(msg) ? 'Folder backup tidak bisa dibaca (dicabut / dipindah / tanpa izin?)' : 'Verifikasi gagal' };
          },
        );
        return view(role === 'owner');
      },
    },
  ];
}
