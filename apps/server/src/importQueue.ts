import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

/**
 * Upload queue (owner request): one import runs at a time — parallel uploads would each pass the
 * free-space check (Checkpoint D F4) — and the others WAIT their turn instead of being refused.
 * A waiting request sends nothing yet (its bytes stay in the client), so it has no idle timeout;
 * a client that gives up leaves the queue. A full queue is still refused (429).
 */
export function createImportQueue(opts: { maxWaiting?: number } = {}) {
  const maxWaiting = opts.maxWaiting ?? 10;
  let running = false;
  const waiting: { grant: () => void; drop: (e: unknown) => void }[] = [];
  const next = () => {
    const w = waiting.shift();
    if (w) w.grant();
    else running = false;
  };
  return {
    /** Wait for the turn; resolves with `release` (call it exactly once when the import is done). */
    async acquire(req: IncomingMessage, res: ServerResponse): Promise<() => void> {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        next();
      };
      if (!running) {
        running = true;
        return release;
      }
      if (waiting.length >= maxWaiting) throw new ApiError(429, 'BUSY', `Antrean upload penuh (${maxWaiting} menunggu); coba lagi sebentar`);
      req.setTimeout(0); // waiting is not stalling: no bytes are expected until our turn
      await new Promise<void>((resolve, reject) => {
        const entry = {
          grant: () => {
            res.off('close', gone);
            resolve();
          },
          drop: reject,
        };
        const gone = () => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new ApiError(499, 'CLIENT_CLOSED', 'Upload dibatalkan sebelum gilirannya'));
        };
        res.once('close', gone);
        waiting.push(entry);
      });
      return release;
    },
    status: () => ({ berjalan: running, menunggu: waiting.length }),
  };
}
export type ImportQueue = ReturnType<typeof createImportQueue>;
