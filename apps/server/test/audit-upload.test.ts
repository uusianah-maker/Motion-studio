// Audit 14 Nov 2026: the upload idle timeout guards a stalled sender only. Once every byte has
// arrived, the long import (probe, copy, hash) must not be cut by it.
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/core.js';
import { UPLOAD_IDLE_MS, receiveUpload } from '../src/routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('audit: upload timeout', () => {
  it('the idle timeout is on while receiving and off once all bytes are in', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msc-aup-'));
    cleanup.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const ws = await initWorkspace(path.join(dir, 'ws'));
    const seen: { calls: number[]; size: number; err: string } = { calls: [], size: 0, err: '' };
    const server = http.createServer((req, res) => {
      const orig = req.setTimeout.bind(req);
      req.setTimeout = ((ms: number, cb?: () => void) => {
        seen.calls.push(ms);
        return orig(ms, cb);
      }) as typeof req.setTimeout;
      void receiveUpload(ws, req, { tmpDir: dir, maxBytes: 10 * 1024 * 1024 }).then(
        async (up) => {
          seen.size = up.size;
          await fsp.rm(up.dir, { recursive: true, force: true });
          res.end('ok');
        },
        (e: unknown) => {
          seen.err = String(e);
          res.statusCode = 500;
          res.end(String(e));
        },
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    const body = Buffer.alloc(256 * 1024, 7);
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-file-name': 'besar.mp4' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end(body);
    });
    expect(seen.err).toBe('');
    expect(status).toBe(200);
    expect(seen.size).toBe(body.length);
    // While receiving, a stalled sender is dropped; once all bytes are in, the import has no idle limit.
    expect(seen.calls).toEqual([UPLOAD_IDLE_MS, 0]);
  });
});
