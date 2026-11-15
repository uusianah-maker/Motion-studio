import { type Workspace, makeProxy } from './core.js';

/**
 * R14: background maker of preview proxies — one FFmpeg at a time (it is heavy), never holding up
 * an import or a request. The same version asked twice is made once.
 */
export function createProxyQueue(opts: { onError?: (e: unknown) => void } = {}) {
  const pending = new Map<string, Promise<void>>();
  let chain: Promise<void> = Promise.resolve();
  const key = (ws: Workspace, vid: string) => `${ws.root}|${vid}`;
  return {
    /** Queue a proxy (no-op if already queued); resolves when it is done (callers do not wait). */
    enqueue(ws: Workspace, versionId: string): Promise<void> {
      const k = key(ws, versionId);
      const have = pending.get(k);
      if (have) return have;
      const p = (chain = chain.then(() => makeProxy(ws, versionId).then(() => undefined, (e: unknown) => opts.onError?.(e)))).finally(() => pending.delete(k));
      pending.set(k, p);
      return p;
    },
    busy: (ws: Workspace, versionId: string) => pending.has(key(ws, versionId)),
    /** Everything queued so far is done (tests). */
    idle: () => chain,
  };
}
export type ProxyQueue = ReturnType<typeof createProxyQueue>;
