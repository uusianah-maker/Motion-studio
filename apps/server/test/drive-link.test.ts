// Owner 25 Nov 2026: Beat Spot takes footage + sound from a Google Drive share link. The server builds the
// download URL from the file id only, follows redirects only to Google download hosts, and imports the file
// like an upload. Google is faked here (no network).
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, createApp } from '../src/app.js';
import { createProject, initWorkspace } from '../src/core.js';
import { confirmUrl, dispositionName, downloadDrive, driveFileId } from '../src/driveLink.js';
import { apiRoutes } from '../src/routes.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-drive-'));
  cleanup.push(() => fsp.rm(d, { recursive: true, force: true, maxRetries: 5 }));
  return d;
}

type Reply = { status?: number; headers?: Record<string, string>; body?: string | Buffer };
/** Fake fetch: answers by URL; records every URL asked for. */
function fakeDrive(route: (url: URL) => Reply) {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const r = route(url);
    const body = r.body === undefined ? null : typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    return new Response(body, { status: r.status ?? 200, headers: { ...(body ? { 'content-length': String(body.length) } : {}), ...r.headers } });
  }) as typeof fetch;
  return { f, asked };
}
const VIDEO = Buffer.from('fake-mp4-bytes-'.repeat(100));
const okFile = (u: URL): Reply =>
  u.hostname === 'drive.usercontent.google.com' && u.searchParams.get('id') === ID
    ? { headers: { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="mall 1.mp4"; filename*=UTF-8''mall%201.mp4` }, body: VIDEO }
    : { status: 404 };

describe('driveFileId', () => {
  it('takes the file id from the usual share links', () => {
    for (const l of [
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/uc?id=${ID}&export=download`,
      `https://drive.usercontent.google.com/download?id=${ID}`,
      `  https://drive.google.com/file/u/1/d/${ID}/view  `,
    ])
      expect(driveFileId(l), l).toBe(ID);
  });
  it('refuses other sites, folders, Google Docs and junk with a reason', () => {
    expect(() => driveFileId('')).toThrow(/kosong/);
    expect(() => driveFileId(`https://evil.example/file/d/${ID}/view`)).toThrow(/Bukan link Google Drive/);
    expect(() => driveFileId(`http://drive.google.com/file/d/${ID}/view`)).toThrow(/Bukan link Google Drive/);
    expect(() => driveFileId(`https://drive.google.com.evil.example/file/d/${ID}`)).toThrow(/Bukan link Google Drive/);
    expect(() => driveFileId(`https://drive.google.com/drive/folders/${ID}`)).toThrow(/folder/);
    expect(() => driveFileId(`https://docs.google.com/document/d/${ID}/edit`)).toThrow(/dokumen Google/);
    expect(() => driveFileId('https://drive.google.com/file/d/short/view')).toThrow(/id file/);
    expect(() => driveFileId('bukan link')).toThrow(/Bukan link Google Drive/);
  });
});

describe('downloadDrive', () => {
  it('downloads a shared file with its name; only the id reaches Google', async () => {
    const dir = await tmp();
    const g = fakeDrive(okFile);
    const r = await downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: g.f });
    expect(r.name).toBe('mall 1.mp4');
    expect(r.size).toBe(VIDEO.length);
    expect(await fsp.readFile(r.file)).toEqual(VIDEO);
    expect(g.asked).toEqual([`https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`]);
  });

  it('follows redirects only to Google download hosts', async () => {
    const dir = await tmp();
    const g = fakeDrive((u) => (u.pathname === '/download' ? { status: 302, headers: { location: `https://doc-0k-9s-docs.googleusercontent.com/x?id=${ID}` } } : okFile(new URL(`https://drive.usercontent.google.com/download?id=${ID}`))));
    expect((await downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: g.f })).size).toBe(VIDEO.length);
    const bad = fakeDrive(() => ({ status: 302, headers: { location: 'http://127.0.0.1:4318/admin' } }));
    await expect(downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: bad.f })).rejects.toThrow(/tidak dikenal/);
    expect(bad.asked).toHaveLength(1); // never asked the other host
  });

  it('a file that is not shared says how to share it', async () => {
    const dir = await tmp();
    const login = fakeDrive(() => ({ status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?continue=x' } }));
    await expect(downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: login.f })).rejects.toThrow(/Siapa saja yang memiliki link/);
    const page = fakeDrive(() => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html>Anda memerlukan akses</html>' }));
    await expect(downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: page.f })).rejects.toThrow(/Siapa saja yang memiliki link/);
    const gone = fakeDrive(() => ({ status: 404 }));
    await expect(downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: gone.f })).rejects.toThrow(/tidak ditemukan/);
  });

  it('a large file: the virus-scan page is confirmed once', async () => {
    const dir = await tmp();
    const scan = `<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123"></form></html>`;
    const g = fakeDrive((u) => (u.searchParams.get('uuid') === 'u-123' ? okFile(u) : { headers: { 'content-type': 'text/html' }, body: scan }));
    expect((await downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: g.f })).size).toBe(VIDEO.length);
    expect(g.asked).toHaveLength(2);
    expect(confirmUrl(scan.replace('https://drive.usercontent.google.com', 'https://evil.example'))).toBeNull();
  });

  it('refuses a file over the limit before writing it, and Google quota limits clearly', async () => {
    const dir = await tmp();
    const g = fakeDrive(okFile);
    await expect(downloadDrive(ID, { dir, maxBytes: 100, fetchImpl: g.f })).rejects.toMatchObject({ status: 413 });
    expect(await fsp.readdir(dir)).toEqual([]);
    const q = fakeDrive(() => ({ headers: { 'content-type': 'text/html' }, body: '<p>Too many users have viewed or downloaded this file recently (quota)</p>' }));
    await expect(downloadDrive(ID, { dir, maxBytes: 1e6, fetchImpl: q.f })).rejects.toMatchObject({ status: 429 });
  });

  it('reads RFC 5987 and plain file names', () => {
    expect(dispositionName(`attachment; filename="a.mp4"; filename*=UTF-8''L%C3%A9a%20jalan.mp4`)).toBe('Léa jalan.mp4');
    expect(dispositionName('attachment; filename="sound tren.m4a"')).toBe('sound tren.m4a');
    expect(dispositionName(null)).toBeNull();
  });
});

describe('POST /api/media/import-drive', () => {
  async function server(driveFetch: typeof fetch) {
    const dir = await tmp();
    const ws = await initWorkspace(path.join(dir, 'ws'));
    await createProject(ws, { project_id: 'b', name: 'Beat Spot' });
    const app = createApp({ ws, roleOf: () => 'editor', routes: apiRoutes({ tmpDir: dir, driveFetch }) });
    const port = await app.listen(0);
    cleanup.push(() => app.close());
    const post = (p: string, body: unknown) =>
      new Promise<{ status: number; json: ReturnType<typeof JSON.parse> }>((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const r = http.request(
          { host: HOST, port, path: p, method: 'POST', headers: { host: `${HOST}:${port}`, authorization: `Bearer ${app.token}`, 'content-type': 'application/json', 'content-length': String(data.length) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
          },
        );
        r.on('error', reject);
        r.end(data);
      });
    return { ws, dir, post };
  }

  it('imports into the project like an upload, keeps the Drive name, leaves no temp files', async () => {
    const s = await server(fakeDrive(okFile).f);
    const r = await s.post('/api/media/import-drive?scope=project&project_id=b', { link: `https://drive.google.com/file/d/${ID}/view?usp=sharing` });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.name).toBe('mall 1.mp4');
    expect(r.json).toMatchObject({ duplicate: false, version: { original_name: 'mall 1.mp4', size: VIDEO.length, lifecycle: 'active', integrity: 'ok' } });
    expect(JSON.stringify(r.json)).not.toContain('rel_path');
    expect((await fsp.readdir(s.dir)).filter((n) => n.startsWith('motion-upload-'))).toEqual([]);
    // Same file again = the existing media (duplicate), not a second copy.
    const again = await s.post('/api/media/import-drive?scope=project&project_id=b', { link: `https://drive.google.com/open?id=${ID}` });
    expect(again.json).toMatchObject({ duplicate: true, media_id: r.json.media_id });
  });

  it('a bad link or an unknown project is refused before anything is downloaded', async () => {
    const g = fakeDrive(okFile);
    const s = await server(g.f);
    const bad = await s.post('/api/media/import-drive?scope=project&project_id=b', { link: 'https://example.com/x.mp4' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/Bukan link Google Drive/);
    expect((await s.post('/api/media/import-drive?scope=project&project_id=nope', { link: `https://drive.google.com/file/d/${ID}/view` })).status).toBe(404);
    expect(g.asked).toEqual([]);
  });
});
