/**
 * Folder "HASIL RENDER" yang mudah dibaca di Windows Explorer (owner 14 Nov 2026).
 *
 * Folder proyek memakai kode internal (`PROJECTS/p-xxxx/05_OUTPUT`) supaya ganti nama tidak merusak apa
 * pun — tapi itu "ruwed" untuk dibuka manual. Setiap render yang selesai disalin ke
 *   <workspace>/HASIL RENDER/<YYYY-MM-DD>/<nama yang bisa dibaca>.mp4
 * Disk owner exFAT (tidak ada hardlink), jadi ini SALINAN: boleh dihapus kapan saja tanpa merusak proyek.
 * Aplikasi tidak pernah membaca folder ini; gagal menyalin tidak menggagalkan render.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type Workspace, readProject } from './workspace.js';

export const HASIL_DIR = 'HASIL RENDER';

const tanggal = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Nama file aman untuk Windows: tanpa <>:"/\|?* dan karakter kontrol, maks 180 karakter. */
export function namaAman(s: string): string {
  const ext = path.extname(s);
  const dasar = s
    .slice(0, s.length - ext.length)
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\p{Cc}/gu, ' ') // karakter kontrol
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${dasar.slice(0, 180 - ext.length) || 'video'}${ext}`;
}

/**
 * Salin satu output render ke HASIL RENDER/<tanggal>/. Kembalikan path relatif tujuan (atau null kalau
 * sumbernya tidak ada). Salinan yang sama (nama + ukuran) tidak dibuat dua kali.
 */
export async function salinKeHasil(ws: Workspace, input: { project_id: string; rel: string; name: string; at?: number }): Promise<string | null> {
  const rel = await ws.blobs.resolve(input.rel, ['project_output']).catch(() => null);
  if (!rel) return null;
  return ws.blobs.withLocalFile(rel, (src) => salin(ws, input, src));
}

async function salin(ws: Workspace, input: { project_id: string; name: string; at?: number }, src: string): Promise<string | null> {
  const st = await fsp.stat(src).catch(() => null);
  if (!st?.isFile()) return null;
  const proyek = await readProject(ws, input.project_id).then((p) => p.name, () => '');
  // Nama output biasanya sudah memuat nama proyek; kalau belum, gabungkan supaya tetap jelas asalnya.
  const inti = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const sudahMemuat = inti(input.name).startsWith(inti(proyek).slice(0, 15));
  const nama = namaAman(proyek && !sudahMemuat ? `${proyek} · ${input.name}` : input.name);
  const dir = path.join(ws.root, HASIL_DIR, tanggal(input.at ?? st.mtimeMs));
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(nama);
  const dasar = nama.slice(0, nama.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const tujuan = path.join(dir, n === 1 ? nama : `${dasar} (${n})${ext}`);
    const ada = await fsp.stat(tujuan).catch(() => null);
    if (ada) {
      if (ada.size === st.size) return path.relative(ws.root, tujuan); // sudah disalin
      continue;
    }
    await fsp.copyFile(src, tujuan);
    await fsp.utimes(tujuan, st.atime, st.mtime).catch(() => undefined);
    await fsp.chmod(tujuan, 0o644).catch(() => undefined); // output asli read-only; salinan boleh dihapus tim
    return path.relative(ws.root, tujuan);
  }
  return null;
}
