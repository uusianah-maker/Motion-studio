import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type Workspace, audit } from '../core.js';
import { ApiError } from '../errors.js';
import type { Capability } from './adapters.js';
import type { SpendGate } from './router.js';
import type { AiStore, Connection } from './store.js';

/**
 * Usage ledger + hard budget (W13, PRD: "A request exceeding budget is blocked before inference
 * when estimable … metering records actual usage"). Every paid call:
 *   1. estimate (prompt size + the max output we allow × the connection's prices);
 *   2. reserve against per-request / daily / monthly caps, counting calls still in flight —
 *      over the cap = BUDGET_EXCEEDED before anything is sent;
 *   3. settle with the provider's metered usage, appended to an on-disk JSONL ledger.
 * A paid provider without prices cannot be estimated, so it is blocked (fail closed).
 * The ledger holds numbers and ids only: no prompts, no keys.
 */

export interface UsageEvent {
  ts: number;
  connection_id: string;
  provider: string;
  model: string;
  capability: Capability;
  project_id: string | null;
  request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
  cost_usd: number;
  outcome: 'ok' | 'failed';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Server-local calendar day / month. */
export const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthKey = (ts: number) => dayKey(ts).slice(0, 7);
const usd = (n: number) => `$${n.toFixed(4)}`;

export async function openSpendGate(opts: { ws: Workspace; store: AiStore; stateDir: string; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const file = path.join(opts.stateDir, 'ai-usage.jsonl');
  const events: UsageEvent[] = [];
  try {
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as UsageEvent);
      } catch {
        /* torn last line after a crash */
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const reservations = new Map<string, { usd: number; at: number }>();
  let seq = 0;
  let writing: Promise<void> = Promise.resolve();

  const spent = (pred: (e: UsageEvent) => boolean) => events.filter(pred).reduce((s, e) => s + e.cost_usd, 0);
  const totals = () => {
    const t = now();
    const d = dayKey(t);
    const m = monthKey(t);
    const inFlight = [...reservations.values()].reduce((s, r) => s + r.usd, 0);
    return { day: spent((e) => dayKey(e.ts) === d), month: spent((e) => monthKey(e.ts) === m), inFlight };
  };

  const priced = (c: Connection, cap: Capability) => (cap === 'transcription' ? c.prices.per_audio_minute > 0 : c.prices.input_per_mtok > 0 || c.prices.output_per_mtok > 0);

  async function block(reason: string, details: Record<string, unknown>): Promise<never> {
    await audit(opts.ws, { op: 'ai.budget_blocked', actor: 'ai', outcome: 'blocked', reason, ...details }).catch(() => undefined);
    throw new ApiError(402, 'BUDGET_EXCEEDED', reason);
  }

  const gate: SpendGate = {
    async reserve({ connection: c, estimate_usd, capability, project_id }) {
      const b = opts.store.settings().budget;
      const est = Math.max(0, estimate_usd);
      const ctx = { connection_id: c.connection_id, provider: c.provider, capability, project_id, estimate_usd: est };
      if (c.provider !== 'openai_compatible' && !priced(c, capability)) {
        await block(`Harga ${c.label} belum diisi, jadi biaya tidak bisa diperkirakan. Isi harga di menu AI dulu.`, ctx);
      }
      if (est > b.per_request_usd) await block(`Perkiraan biaya ${usd(est)} melebihi batas per permintaan ${usd(b.per_request_usd)}.`, ctx);
      const t = totals();
      if (t.day + t.inFlight + est > b.daily_usd) await block(`Batas harian ${usd(b.daily_usd)} akan terlewati (terpakai ${usd(t.day)}${t.inFlight ? ` + ${usd(t.inFlight)} berjalan` : ''}, perkiraan ${usd(est)}).`, ctx);
      if (t.month + t.inFlight + est > b.monthly_usd) await block(`Batas bulanan ${usd(b.monthly_usd)} akan terlewati (terpakai ${usd(t.month)}, perkiraan ${usd(est)}).`, ctx);
      const id = `r${++seq}`;
      reservations.set(id, { usd: est, at: now() });
      return id;
    },
    async settle(id, i) {
      reservations.delete(id);
      const ev: UsageEvent = {
        ts: now(),
        connection_id: i.connection.connection_id,
        provider: i.connection.provider,
        model: i.connection.model,
        capability: i.capability,
        project_id: i.project_id,
        request_id: i.request_id,
        input_tokens: i.usage.input_tokens,
        output_tokens: i.usage.output_tokens,
        audio_seconds: i.usage.audio_seconds,
        cost_usd: Math.max(0, i.cost_usd),
        outcome: i.outcome,
      };
      events.push(ev);
      const line = `${JSON.stringify(ev)}\n`;
      writing = writing.then(async () => {
        await fsp.mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
        await fsp.appendFile(file, line, { mode: 0o600 });
      });
      await writing;
    },
  };

  /** Dashboard numbers for the AI page. */
  function summary() {
    const t = totals();
    const m = monthKey(now());
    const groups = new Map<string, { provider: string; model: string; calls: number; failed: number; usd: number; input_tokens: number; output_tokens: number; audio_seconds: number }>();
    for (const e of events.filter((x) => monthKey(x.ts) === m)) {
      const k = `${e.provider}|${e.model}`;
      const g = groups.get(k) ?? { provider: e.provider, model: e.model, calls: 0, failed: 0, usd: 0, input_tokens: 0, output_tokens: 0, audio_seconds: 0 };
      g.calls++;
      if (e.outcome === 'failed') g.failed++;
      g.usd += e.cost_usd;
      g.input_tokens += e.input_tokens;
      g.output_tokens += e.output_tokens;
      g.audio_seconds += e.audio_seconds;
      groups.set(k, g);
    }
    const d = dayKey(now());
    return {
      budget: opts.store.settings().budget,
      today: { usd: t.day, calls: events.filter((e) => dayKey(e.ts) === d && e.outcome === 'ok').length },
      month: { usd: t.month, calls: events.filter((e) => monthKey(e.ts) === m && e.outcome === 'ok').length },
      in_flight_usd: t.inFlight,
      by_model: [...groups.values()].sort((a, b) => b.usd - a.usd),
      recent: events.slice(-50).reverse(),
    };
  }

  return { gate, summary, file, flush: () => writing };
}
export type SpendLedger = Awaited<ReturnType<typeof openSpendGate>>;
