/**
 * Import from a Google Drive share link (owner 25 Nov 2026: Beat Spot takes footage + sound "dari google drive
 * juga"; chosen: paste a link shared "Siapa saja yang memiliki link", no Google sign-in / Drive scope).
 * PC-13 still holds: the file is downloaded once and imported into the local workspace like an upload.
 *
 * Safety: the server never fetches a URL the browser sends. Only a Drive FILE ID is taken from the link and the
 * download URL is built here; redirects are followed by hand and only to Google download hosts (no SSRF).
 */
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './errors.js';

const ID = /^[A-Za-z0-9_-]{20,200}$/;
const LINK_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
/** Hosts a download may be redirected to. */
const DOWNLOAD_HOST = /^(drive\.usercontent\.google\.com|drive\.google\.com|docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/;
const MAX_REDIRECTS = 5;

const tolak = (message: string) => new ApiError(400, 'DRIVE_LINK', message);
const BELUM_DIBAGIKAN = 'File Google Drive belum bisa diambil: ubah aksesnya jadi "Siapa saja yang memiliki link" (Bagikan → Akses umum), lalu coba lagi.';

/** The Drive file id in a share link, or an error the team can act on (Indonesian, shown as is). */
export function driveFileId(link: string): string {
  const raw = (link ?? '').trim();
  if (!raw) throw tolak('Link Google Drive kosong');
  if (raw.length > 2000) throw tolak('Link Google Drive terlalu panjang');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw tolak('Bukan link Google Drive (contoh: https://drive.google.com/file/d/…/view)');
  }
  if (u.protocol !== 'https:' || !LINK_HOSTS.has(u.hostname)) throw tolak('Bukan link Google Drive (contoh: https://drive.google.com/file/d/…/view)');
  if (/\/folders\//.test(u.pathname) || /\/drive\/(u\/\d+\/)?folders/.test(u.pathname)) throw tolak('Ini link folder, bukan file: tempel di kotak footage Beat Spot untuk memilih isinya');
  const m = u.pathname.match(/\/(?:file\/)?d\/([^/]+)/);
  const id = m?.[1] ?? u.searchParams.get('id') ?? '';
  if (!ID.test(id)) throw tolak('Link Google Drive tidak berisi id file (contoh: https://drive.google.com/file/d/…/view)');
  if (/^\/(document|spreadsheets|presentation|forms)\//.test(u.pathname)) throw tolak('Link ini dokumen Google (Docs/Sheets/Slides), bukan file video/audio');
  return id;
}

/** The Drive FOLDER id in a folder share link (https://drive.google.com/drive/folders/<id>). */
export function driveFolderId(link: string): string {
  const raw = (link ?? '').trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw tolak('Bukan link folder Google Drive (contoh: https://drive.google.com/drive/folders/…)');
  }
  const id = u.pathname.match(/\/folders\/([^/]+)/)?.[1] ?? '';
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com' || !ID.test(id)) throw tolak('Bukan link folder Google Drive (contoh: https://drive.google.com/drive/folders/…)');
  return id;
}

export interface DriveEntry {
  id: string;
  name: string;
  /** MIME type Drive shows (e.g. video/mp4), '' if unknown. */
  mime: string;
  jenis: 'video' | 'audio' | 'gambar' | 'folder' | 'lain';
}

const entity = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Entries of Drive's public folder view (embeddedfolderview). Exported for tests. */
export function parseFolder(html: string): DriveEntry[] {
  const out: DriveEntry[] = [];
  for (const block of html.split('<div class="flip-entry" id="entry-').slice(1)) {
    const id = block.match(/^([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    const href = block.match(/<a href="([^"]+)"/)?.[1] ?? '';
    const name = entity(block.match(/<div class="flip-entry-title">([^<]*)<\/div>/)?.[1] ?? '').trim();
    if (!ID.test(id) || !name) continue;
    const folder = /\/drive\/(u\/\d+\/)?folders\//.test(href);
    const mime = folder ? 'folder' : (block.match(/\/type\/([a-z0-9.+-]+\/[a-z0-9.+-]+)/i)?.[1] ?? '').toLowerCase();
    const jenis = folder ? 'folder' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'gambar' : 'lain';
    out.push({ id, name, mime: folder ? '' : mime, jenis });
  }
  return out;
}

/** List a folder shared "Siapa saja yang memiliki link" (no sign-in). Subfolders are listed, not opened. */
export async function listDriveFolder(id: string, fetchImpl: typeof fetch = fetch): Promise<DriveEntry[]> {
  if (!ID.test(id)) throw tolak('Id folder Google Drive tidak valid');
  let r: Response;
  try {
    r = await fetchImpl(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'MotionStudio/1 (drive import)' } });
  } catch {
    throw new ApiError(502, 'DRIVE_UNREACHABLE', 'Google Drive tidak bisa dihubungi dari server. Coba lagi sebentar.');
  }
  if (r.status >= 300 && r.status < 400) {
    await r.body?.cancel();
    throw tolak('Folder Google Drive belum bisa dibuka: ubah aksesnya jadi "Siapa saja yang memiliki link" (Bagikan → Akses umum), lalu coba lagi.');
  }
  if (r.status === 404 || r.status === 403 || r.status === 401) {
    await r.body?.cancel();
    throw tolak('Folder Google Drive tidak ditemukan, atau belum dibagikan "Siapa saja yang memiliki link".');
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new ApiError(502, 'DRIVE_FAILED', `Google Drive menolak membuka folder (HTTP ${r.status})`);
  }
  return parseFolder((await r.text()).slice(0, 5_000_000)).slice(0, 500);
}

/** File name from Content-Disposition (RFC 5987 filename* first). Unsafe characters are cleaned by the caller. */
export function dispositionName(cd: string | null): string | null {
  if (!cd) return null;
  const star = cd.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[2]!.trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename\s*=\s*"([^"]*)"/i) ?? cd.match(/filename\s*=\s*([^;]+)/i);
  return plain ? plain[1]!.trim() : null;
}

/** Google's "can't scan this file for viruses" page: a form that downloads anyway. Its URL, or null. */
export function confirmUrl(html: string): string | null {
  const form = html.match(/<form[^>]+id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  let u: URL;
  try {
    u = new URL(form[1]!.replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !DOWNLOAD_HOST.test(u.hostname)) return null;
  for (const inp of form[2]!.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const name = inp[0].match(/name="([^"]+)"/)?.[1];
    const value = inp[0].match(/value="([^"]*)"/)?.[1];
    if (name && value !== undefined) u.searchParams.set(name, value.replace(/&amp;/g, '&'));
  }
  return u.toString();
}

export interface DriveDownloadOptions {
  /** Empty temp folder the file is written into. */
  dir: string;
  maxBytes: number;
  /** Called once the size is known from the reply (null = Google did not say), before any byte is written. */
  beforeBody?: (size: number | null) => Promise<void>;
  /** Abort when no byte arrives for this long (default 2 min). */
  idleMs?: number;
  fetchImpl?: typeof fetch;
}

/** Download one publicly shared Drive file into `dir`. Returns the written file. */
export async function downloadDrive(id: string, opts: DriveDownloadOptions): Promise<{ file: string; name: string; size: number }> {
  if (!ID.test(id)) throw tolak('Id file Google Drive tidak valid');
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const idleMs = opts.idleMs ?? 120_000;
  let timer: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error('drive idle timeout')), idleMs);
  };
  kick();
  try {
    let url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
    let res: Response | null = null;
    let confirmed = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let r: Response;
      try {
        r = await f(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'MotionStudio/1 (drive import)' } });
      } catch {
        throw new ApiError(502, 'DRIVE_UNREACHABLE', 'Google Drive tidak bisa dihubungi dari server. Coba lagi sebentar.');
      }
      kick();
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        await r.body?.cancel();
        if (!loc) throw new ApiError(502, 'DRIVE_FAILED', 'Google Drive membalas tanpa alamat unduhan');
        const next = new URL(loc, url);
        if (next.hostname === 'accounts.google.com' || next.hostname.endsWith('.accounts.google.com')) throw tolak(BELUM_DIBAGIKAN);
        if (next.protocol !== 'https:' || !DOWNLOAD_HOST.test(next.hostname)) throw new ApiError(502, 'DRIVE_FAILED', 'Google Drive mengalihkan ke alamat yang tidak dikenal; unduhan dihentikan');
        url = next.toString();
        continue;
      }
      if (r.status === 404 || r.status === 403 || r.status === 401) {
        await r.body?.cancel();
        throw tolak(r.status === 404 ? 'File Google Drive tidak ditemukan, atau belum dibagikan "Siapa saja yang memiliki link".' : BELUM_DIBAGIKAN);
      }
      if (r.status === 429) {
        await r.body?.cancel();
        throw new ApiError(429, 'DRIVE_LIMIT', 'Google Drive membatasi unduhan file ini (terlalu sering diunduh). Coba lagi nanti, atau unggah dari komputer.');
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new ApiError(502, 'DRIVE_FAILED', `Google Drive menolak unduhan (HTTP ${r.status})`);
      }
      const type = (r.headers.get('content-type') ?? '').toLowerCase();
      if (type.startsWith('text/html')) {
        // Large file: the virus-scan page (download anyway once), or a sign-in / "no access" page.
        const html = (await r.text()).slice(0, 200_000);
        kick();
        const next = confirmed ? null : confirmUrl(html);
        if (!next) {
          if (/quota|terlalu banyak|too many users/i.test(html)) throw new ApiError(429, 'DRIVE_LIMIT', 'Google Drive membatasi unduhan file ini (kuota unduh habis). Coba lagi nanti, atau unggah dari komputer.');
          throw tolak(BELUM_DIBAGIKAN);
        }
        confirmed = true;
        url = next;
        continue;
      }
      res = r;
      break;
    }
    if (!res?.body) throw new ApiError(502, 'DRIVE_FAILED', 'Google Drive terlalu banyak mengalihkan; unduhan dihentikan');

    const lenHeader = res.headers.get('content-length');
    const declared = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
    if (declared === 0) {
      await res.body.cancel();
      throw tolak('File Google Drive kosong');
    }
    if (declared !== null && declared > opts.maxBytes) {
      await res.body.cancel();
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'File Google Drive melebihi batas upload');
    }
    if (opts.beforeBody) {
      try {
        await opts.beforeBody(declared);
      } catch (e) {
        await res.body.cancel();
        throw e;
      }
    }
    const name = dispositionName(res.headers.get('content-disposition')) ?? `drive-${id.slice(0, 12)}`;
    const file = path.join(opts.dir, 'drive.bin');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        kick();
        if (size > opts.maxBytes) cb(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'File Google Drive melebihi batas upload'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(file, { flags: 'wx' }));
    } catch (e) {
      await fsp.rm(file, { force: true });
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'DRIVE_FAILED', 'Unduhan dari Google Drive terputus. Coba lagi.');
    }
    if (declared !== null && size !== declared) {
      await fsp.rm(file, { force: true });
      throw new ApiError(502, 'DRIVE_FAILED', 'Unduhan dari Google Drive terputus (ukuran tidak cocok). Coba lagi.');
    }
    if (size === 0) {
      await fsp.rm(file, { force: true });
      throw tolak('File Google Drive kosong');
    }
    return { file, name, size };
  } finally {
    clearTimeout(timer);
  }
}
