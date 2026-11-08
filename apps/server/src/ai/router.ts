import { type Workspace, audit } from '../core.js';
import { ApiError } from '../errors.js';
import { AiCallError, type Capability, type CallTarget, type Usage } from './adapters.js';
import { type AiStore, type Connection, providerBase } from './store.js';

/**
 * Capability router + failover (W12, PRD v0.4/v0.5):
 * - only enabled connections with a key (or a keyless local server), the capability, and no
 *   cooldown / admin hold are eligible, by priority;
 * - transient errors and 429 are retried with Retry-After or exponential backoff + jitter;
 *   transcription is retried only when the request was refused before processing (429/503/529),
 *   so a paid upload is never sent twice to the same provider after a timeout;
 * - 401/403 and billing/credit errors are never retried: the connection waits for the admin;
 * - failover goes to a connection of ANOTHER provider only (keys of one provider are never
 *   treated as separate quota pools); when everything fails the caller gets a clear error.
 * Every attempt is audited (provider alias, class, request id, cost) without secrets or prompts.
 */

export interface SpendGate {
  /** Block BEFORE calling when the estimate does not fit the hard caps (throws BUDGET_EXCEEDED). */
  reserve(input: { connection: Connection; estimate_usd: number; capability: Capability; project_id: string | null }): Promise<string>;
  settle(reservation: string, input: { connection: Connection; cost_usd: number; usage: Usage; capability: Capability; project_id: string | null; request_id: string | null; outcome: 'ok' | 'failed' }): Promise<void>;
}

export interface RouterOptions {
  ws: Workspace;
  store: AiStore;
  gate?: SpendGate;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const costOf = (c: Connection, u: Usage) => (u.input_tokens * c.prices.input_per_mtok + u.output_tokens * c.prices.output_per_mtok) / 1e6 + (u.audio_seconds / 60) * c.prices.per_audio_minute;

const MAX_WAIT_MS = 30_000;

export function createRouter(opts: RouterOptions) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  function eligible(cap: Capability): { list: Connection[]; reasons: string[] } {
    const reasons: string[] = [];
    const list = opts.store
      .connections()
      .filter((c) => {
        if (!c.capabilities.includes(cap)) return false;
        const name = `${c.label} (${c.provider})`;
        if (!c.enabled) return void reasons.push(`${name}: nonaktif`);
        if (c.status === 'needs_admin') return void reasons.push(`${name}: perlu tindakan admin (${c.last_error?.message ?? 'kunci/kredit'})`);
        if (!c.sealed_key && c.provider !== 'openai_compatible') return void reasons.push(`${name}: belum ada API key`);
        if (c.cooldown_until > now()) return void reasons.push(`${name}: jeda sampai ${new Date(c.cooldown_until).toLocaleTimeString('id-ID')}`);
        return true;
      })
      .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
    return { list, reasons };
  }

  function available(cap: Capability): string | null {
    const { list, reasons } = eligible(cap);
    if (list.length) return null;
    const any = opts.store.connections().some((c) => c.capabilities.includes(cap));
    if (!any) return cap === 'planner' ? 'Belum ada koneksi AI untuk Copilot. Tambahkan di menu AI.' : 'Belum ada koneksi AI untuk transkripsi. Tambahkan di menu AI.';
    return `Tidak ada koneksi AI yang siap: ${reasons.join('; ')}`;
  }

  async function call<T>(
    cap: Capability,
    meta: { project_id: string | null; estimate: (c: Connection) => number },
    fn: (target: CallTarget, signal: AbortSignal, connection: Connection) => Promise<{ value: T; usage: Usage; request_id: string | null }>,
  ): Promise<{ value: T; connection: Connection; cost_usd: number; usage: Usage; attempts: number }> {
    const settings = opts.store.settings();
    const { list, reasons } = eligible(cap);
    if (!list.length) throw new ApiError(503, 'AI_UNAVAILABLE', available(cap) ?? reasons.join('; '));
    const tried = new Set<string>();
    const failures: string[] = [];
    let attempts = 0;
    for (const c of list) {
      if (tried.has(c.provider)) continue; // never another key of the same provider
      tried.add(c.provider);
      const target: CallTarget = { provider: c.provider, model: c.model, base_url: providerBase(c)!, api_key: await opts.store.keyOf(c) };
      for (let attempt = 0; attempt <= settings.max_retries; attempt++) {
        attempts++;
        const reservation = opts.gate ? await opts.gate.reserve({ connection: c, estimate_usd: meta.estimate(c), capability: cap, project_id: meta.project_id }) : null;
        const signal = AbortSignal.timeout(settings.timeout_ms);
        try {
          const out = await fn(target, signal, c);
          const cost = costOf(c, out.usage);
          if (reservation) await opts.gate!.settle(reservation, { connection: c, cost_usd: cost, usage: out.usage, capability: cap, project_id: meta.project_id, request_id: out.request_id, outcome: 'ok' });
          if (c.status !== 'ok' || c.last_error) {
            c.status = 'ok';
            c.last_error = null;
            await opts.store.touch();
          }
          await audit(opts.ws, { op: 'ai.call', actor: 'ai', outcome: 'ok', capability: cap, connection_id: c.connection_id, provider: c.provider, model: c.model, attempt, request_id: out.request_id, input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens, audio_seconds: out.usage.audio_seconds, cost_usd: cost, project_id: meta.project_id });
          return { value: out.value, connection: c, cost_usd: cost, usage: out.usage, attempts };
        } catch (e) {
          if (reservation) await opts.gate!.settle(reservation, { connection: c, cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, audio_seconds: 0 }, capability: cap, project_id: meta.project_id, request_id: null, outcome: 'failed' });
          const err = e instanceof AiCallError ? e : new AiCallError('transient', e instanceof Error ? e.message.slice(0, 120) : 'unknown');
          await audit(opts.ws, { op: 'ai.call', actor: 'ai', outcome: 'failed', capability: cap, connection_id: c.connection_id, provider: c.provider, model: c.model, attempt, error_class: err.cls, status: err.status, request_id: err.requestId, project_id: meta.project_id });
          c.last_error = { class: err.cls, status: err.status, message: err.message.slice(0, 200), at: now() };
          if (err.cls === 'auth' || err.cls === 'billing') {
            c.status = 'needs_admin';
            await opts.store.touch();
            failures.push(`${c.label}: ${err.cls === 'auth' ? 'API key ditolak' : 'kredit/tagihan habis'} — perlu tindakan admin`);
            break;
          }
          const retryable = err.cls === 'rate_limit' || err.cls === 'transient';
          const safeToRepeat = cap !== 'transcription' || (err.status !== null && [429, 503, 529].includes(err.status));
          if (retryable && safeToRepeat && attempt < settings.max_retries) {
            const backoff = Math.min(MAX_WAIT_MS, 500 * 2 ** attempt) * (0.5 + random());
            const wait = err.retryAfterMs ?? backoff;
            if (wait <= MAX_WAIT_MS) {
              await sleep(wait);
              continue;
            }
          }
          c.status = 'error';
          if (retryable) c.cooldown_until = now() + Math.max(settings.cooldown_ms, err.retryAfterMs ?? 0);
          await opts.store.touch();
          failures.push(`${c.label}: ${err.message}`);
          break;
        }
      }
      if (!settings.failover) break;
    }
    throw new ApiError(503, 'AI_UNAVAILABLE', `Semua koneksi AI gagal, tidak ada perubahan yang dibuat. ${failures.join('; ')}`);
  }

  /** First connection the router would try for this capability (cost preview). */
  const first = (cap: Capability) => eligible(cap).list[0] ?? null;

  return { call, available, first };
}
export type AiRouter = ReturnType<typeof createRouter>;
