// Upload queue (owner request): one import at a time, the rest wait in order; a full queue is
// refused (429); a client that leaves while waiting is taken out of the queue.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createImportQueue } from '../src/importQueue.js';

const fakeReq = () => ({ setTimeout: () => undefined }) as unknown as IncomingMessage;
const fakeRes = () => new EventEmitter() as unknown as ServerResponse;

describe('upload queue', () => {
  it('runs one at a time in arrival order; release lets the next one in (once)', async () => {
    const q = createImportQueue({ maxWaiting: 3 });
    const order: string[] = [];
    const r1 = await q.acquire(fakeReq(), fakeRes());
    const p2 = q.acquire(fakeReq(), fakeRes()).then((r) => (order.push('2'), r));
    const p3 = q.acquire(fakeReq(), fakeRes()).then((r) => (order.push('3'), r));
    expect(q.status()).toEqual({ berjalan: true, menunggu: 2 });
    r1();
    r1(); // a second release of the same turn does nothing
    const r2 = await p2;
    expect(order).toEqual(['2']);
    expect(q.status()).toEqual({ berjalan: true, menunggu: 1 });
    r2();
    (await p3)();
    expect(order).toEqual(['2', '3']);
    expect(q.status()).toEqual({ berjalan: false, menunggu: 0 });
  });

  it('a full queue is refused with 429 BUSY; a leaving client is dropped from it', async () => {
    const q = createImportQueue({ maxWaiting: 1 });
    const r1 = await q.acquire(fakeReq(), fakeRes());
    const res2 = fakeRes();
    const p2 = q.acquire(fakeReq(), res2);
    await expect(q.acquire(fakeReq(), fakeRes())).rejects.toMatchObject({ status: 429, code: 'BUSY' });
    (res2 as unknown as EventEmitter).emit('close');
    await expect(p2).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    expect(q.status()).toEqual({ berjalan: true, menunggu: 0 });
    const p3 = q.acquire(fakeReq(), fakeRes());
    r1();
    (await p3)();
    expect(q.status()).toEqual({ berjalan: false, menunggu: 0 });
  });
});
