import type { Route } from '../app.js';
import { type Workspace, audit, readAudit } from '../core.js';
import { ApiError } from '../errors.js';
import { readJsonBody } from '../http.js';
import { bad, onlyKeys } from '../routes.js';
import type { SpendLedger } from './budget.js';
import { AiCallError, type Capability, PROVIDERS, type ProviderId, testConnection } from './adapters.js';
import { type AiSettings, type AiStore, DEFAULT_SETTINGS, type Prices, providerBase, publicConnection } from './store.js';

/** Caps set by "tempel kunci" (USD): enough for heavy daily use, still stops a runaway loop. */
export const LONGGAR = { daily_usd: 20, monthly_usd: 300, per_request_usd: 3 };
import { type TujuanId, deteksiKunci, hargaKira } from './tempel.js';
import { type ImageAiStore, apimartImageModel, modelOf, newestImageModel } from './imageAi.js';

/**
 * AI Provider Manager API (W12). Keys go in once (POST) and never come back out. Every change
 * and test is audited. All signed-in users of this single-team app are admins (ADR-002: one
 * owner + allowlist); a separate admin role is out of scope.
 */

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
/** A real hostname (letters in the TLD): no IP literals, so no private/link-local addresses (Checkpoint F F-11). */
const HTTPS_HOST_RE = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${what} wajib teks 1–${max} karakter`);
  return v.trim();
}

function apiKey(v: unknown): string {
  if (typeof v !== 'string' || v.length < 8 || v.length > 400 || /\s/.test(v)) throw bad('API key tidak valid (8–400 karakter, tanpa spasi)');
  return v;
}

/**
 * Where a connection's key may be sent (Checkpoint F F-1/F-11). Official providers always use
 * their official host (a test endpoint on this machine is allowed only in dev mode, for the
 * fake providers). "Compatible" servers: this machine (http loopback) or an https hostname.
 */
function baseUrl(provider: ProviderId, v: unknown, dev: boolean): string | null {
  const official = PROVIDERS[provider].base_url;
  if (v === undefined || v === null || v === '') {
    if (!official) throw bad('Provider kompatibel OpenAI butuh alamat server-nya');
    return null;
  }
  if (typeof v !== 'string') throw bad('base_url tidak valid');
  const url = v.replace(/\/+$/, '');
  if (official) {
    if (url === official) return null;
    if (dev && LOOPBACK_RE.test(url)) return url;
    throw bad('Provider resmi selalu memakai alamat resminya; kosongkan "Alamat server"');
  }
  if (LOOPBACK_RE.test(url) || HTTPS_HOST_RE.test(url)) return url;
  throw bad('Alamat server harus http://127.0.0.1:<port> (server di komputer ini) atau https://nama-domain');
}

function prices(v: unknown, current?: Prices): Prices {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o !== 'object' || Array.isArray(o)) throw bad('prices tidak valid');
  const num = (k: keyof Prices) => {
    const x = o[k] ?? current?.[k] ?? 0;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 10_000) throw bad(`prices.${k} harus angka 0–10000 (USD)`);
    return x;
  };
  const extra = Object.keys(o).filter((k) => !['input_per_mtok', 'output_per_mtok', 'per_audio_minute'].includes(k));
  if (extra.length) throw bad(`Field harga tidak dikenal: ${extra.join(', ')}`);
  return { input_per_mtok: num('input_per_mtok'), output_per_mtok: num('output_per_mtok'), per_audio_minute: num('per_audio_minute') };
}

function caps(v: unknown, provider: ProviderId): Capability[] {
  const allowed = PROVIDERS[provider].capabilities;
  if (!Array.isArray(v) || !v.length || !v.every((c) => allowed.includes(c as Capability))) throw bad(`capabilities untuk ${provider}: ${allowed.join(', ')}`);
  return [...new Set(v as Capability[])];
}

function intIn(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} harus bilangan bulat ${min}–${max}`);
  return v;
}

function usd(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw bad(`${what} harus angka USD 0–100000`);
  return Math.round(v * 10_000) / 10_000;
}

export function parseSettings(body: Record<string, unknown>, cur: AiSettings): AiSettings {
  onlyKeys(body, ['mode', 'failover', 'max_retries', 'timeout_ms', 'cooldown_ms', 'max_output_tokens', 'budget']);
  const next: AiSettings = structuredClone(cur);
  if (body.mode !== undefined) {
    if (body.mode !== 'local' && body.mode !== 'auto' && body.mode !== 'ai') throw bad('mode harus local | auto | ai');
    next.mode = body.mode;
  }
  if (body.failover !== undefined) {
    if (typeof body.failover !== 'boolean') throw bad('failover harus true/false');
    next.failover = body.failover;
  }
  if (body.max_retries !== undefined) next.max_retries = intIn(body.max_retries, 'max_retries', 0, 5);
  if (body.timeout_ms !== undefined) next.timeout_ms = intIn(body.timeout_ms, 'timeout_ms', 5_000, 600_000);
  if (body.cooldown_ms !== undefined) next.cooldown_ms = intIn(body.cooldown_ms, 'cooldown_ms', 0, 3_600_000);
  if (body.max_output_tokens !== undefined) next.max_output_tokens = intIn(body.max_output_tokens, 'max_output_tokens', 256, 64_000);
  if (body.budget !== undefined) {
    const b = body.budget as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('budget tidak valid');
    onlyKeys(b, ['daily_usd', 'monthly_usd', 'per_request_usd']);
    if (b.daily_usd !== undefined) next.budget.daily_usd = usd(b.daily_usd, 'budget.daily_usd');
    if (b.monthly_usd !== undefined) next.budget.monthly_usd = usd(b.monthly_usd, 'budget.monthly_usd');
    if (b.per_request_usd !== undefined) next.budget.per_request_usd = usd(b.per_request_usd, 'budget.per_request_usd');
  }
  return next;
}

/** `devEndpoints`: allow loopback test endpoints for official providers (tests / MOTION_AI_DEV_ENDPOINTS=1 only). */
export function aiRoutes(ws: Workspace, store: AiStore, ledger?: SpendLedger, fetchImpl: typeof fetch = fetch, opts: { devEndpoints?: boolean; tempelBases?: Partial<Record<TujuanId, string>>; imageAi?: ImageAiStore } = {}): Route[] {
  const dev = opts.devEndpoints === true;
  const notFound = () => new ApiError(404, 'NOT_FOUND', 'Koneksi AI tidak ada');
  const view = () => ({
    connections: store.connections().map(publicConnection),
    settings: store.settings(),
    catalog: Object.entries(PROVIDERS).map(([id, p]) => ({ provider: id, ...p })),
  });

  return [
    {
      // Audit Jenius #5: connections, prices, budget and errors are the owner's; the others' Copilot
      // only needs the mode.
      method: 'GET',
      path: '/api/ai/providers',
      handle: async ({ role }) => (role === 'owner' ? view() : { connections: [], settings: { mode: store.settings().mode }, catalog: [] }),
    },
    {
      method: 'POST',
      path: '/api/ai/providers',
      handle: async ({ req, actor }) => {
        const body = await readJsonBody(req, 64 * 1024);
        onlyKeys(body, ['provider', 'label', 'model', 'api_key', 'capabilities', 'base_url', 'priority', 'prices', 'enabled']);
        const provider = body.provider as ProviderId;
        if (!Object.hasOwn(PROVIDERS, provider)) throw bad(`provider harus ${Object.keys(PROVIDERS).join(' | ')}`);
        const model = text(body.model, 'model', 100);
        if (!MODEL_RE.test(model)) throw bad('Nama model hanya huruf, angka, . _ : / -');
        const base = baseUrl(provider, body.base_url, dev);
        const key = body.api_key === undefined || body.api_key === '' ? null : apiKey(body.api_key);
        if (PROVIDERS[provider].key_required && !key) throw bad('API key wajib untuk provider ini');
        const c = await store.add({
          provider,
          label: text(body.label ?? PROVIDERS[provider].label, 'label', 60),
          model,
          capabilities: caps(body.capabilities ?? PROVIDERS[provider].capabilities.slice(0, 1), provider),
          base_url: base,
          priority: body.priority === undefined ? store.connections().length + 1 : intIn(body.priority, 'priority', 1, 99),
          enabled: body.enabled === undefined ? true : body.enabled === true,
          prices: prices(body.prices),
          api_key: key,
        });
        await audit(ws, { op: 'ai.provider.add', actor, outcome: 'ok', connection_id: c.connection_id, provider, model, capabilities: c.capabilities });
        return { connection: publicConnection(c) };
      },
    },
    {
      // 27 Nov owner: "cukup masukin API-nya, otomatis test bisa atau tidaknya" — paste one key, the
      // app finds its provider, picks a model, checks it with a tiny call and turns Copilot on.
      method: 'POST',
      path: '/api/ai/tempel',
      handle: async ({ req, actor }) => {
        const body = await readJsonBody(req, 8 * 1024);
        onlyKeys(body, ['api_key']);
        const key = apiKey(typeof body.api_key === 'string' ? body.api_key.trim() : body.api_key);
        const hasil = await deteksiKunci(key, { fetchImpl, bases: opts.tempelBases });
        if (!hasil.ok) {
          await audit(ws, { op: 'ai.provider.tempel', actor, outcome: 'failed', reason: hasil.alasan, tried: hasil.dicoba });
          return { ok: false, pesan: hasil.pesan };
        }
        const { tujuan, model } = hasil;
        const sama = store.connections().find((c) => c.provider === tujuan.provider && (c.base_url ?? null) === (tujuan.base_url ?? null));
        let c;
        if (sama) {
          await store.setKey(sama.connection_id, key);
          c = await store.update(sama.connection_id, { model, enabled: true, status: 'ok', last_test_at: Date.now(), capabilities: sama.capabilities.includes('planner') ? sama.capabilities : [...sama.capabilities, 'planner'] });
        } else {
          c = await store.add({ provider: tujuan.provider, label: tujuan.label, model, capabilities: ['planner'], base_url: tujuan.base_url, priority: store.connections().length + 1, enabled: true, prices: hargaKira(model), api_key: key });
          c = await store.update(c.connection_id, { status: 'ok', last_test_at: Date.now() });
        }
        // Owner: no limits to set up. The factory caps ($0.25 per request) block even one Opus plan
        // (worst-case estimate), so a paste lifts caps still at the factory values to roomy ones.
        const s = store.settings();
        const b = s.budget;
        const pabrik = b.daily_usd === DEFAULT_SETTINGS.budget.daily_usd && b.monthly_usd === DEFAULT_SETTINGS.budget.monthly_usd && b.per_request_usd === DEFAULT_SETTINGS.budget.per_request_usd;
        await store.setSettings({ ...s, mode: s.mode === 'local' ? 'auto' : s.mode, budget: pabrik ? { ...LONGGAR } : b });
        // Owner: one key for everything — the same key also makes pictures (Ganti Outfit) when it may
        // and no picture key is saved yet (a working picture key, e.g. beliapi, is left alone).
        let gambar: { status: 'dipakai' | 'sudah_ada' | 'tidak_bisa'; model: string | null } = { status: 'tidak_bisa', model: null };
        const img = opts.imageAi;
        if (img) {
          const imgModel = hasil.id === 'apimart' ? apimartImageModel(hasil.ids) : hasil.id === 'openai' ? newestImageModel(hasil.ids) : null;
          if (img.raw().sealed_key) gambar = { status: 'sudah_ada', model: modelOf(img.raw()) };
          else if (imgModel && (hasil.id === 'apimart' || hasil.id === 'openai')) {
            await img.setKey(key);
            const r = img.raw();
            await img.setConfig({ provider: hasil.id, endpoint: opts.tempelBases?.[hasil.id] ?? null, model: null, budget: r.budget, harga_per_gambar: r.harga_per_gambar });
            await img.setTest({ at: Date.now(), ok: true, message: `Dari "Tempel API key" · model gambar: ${imgModel}` }, { model_terdeteksi: imgModel });
            gambar = { status: 'dipakai', model: imgModel };
          }
        }
        await audit(ws, { op: 'ai.provider.tempel', actor, outcome: 'ok', connection_id: c!.connection_id, provider: tujuan.provider, label: tujuan.label, model, gambar: gambar.status });
        return { ok: true, penyedia: tujuan.label, model, gambar, connection: publicConnection(c!), mode: store.settings().mode };
      },
    },
    {
      method: 'POST',
      path: '/api/ai/providers/:connection_id',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req, 64 * 1024);
        onlyKeys(body, ['label', 'model', 'capabilities', 'base_url', 'priority', 'prices', 'enabled']);
        const c = store.find(params.connection_id!);
        if (!c) throw notFound();
        const patch: Record<string, unknown> = {};
        if (body.label !== undefined) patch.label = text(body.label, 'label', 60);
        if (body.model !== undefined) {
          const m = text(body.model, 'model', 100);
          if (!MODEL_RE.test(m)) throw bad('Nama model hanya huruf, angka, . _ : / -');
          patch.model = m;
          patch.status = 'untested';
        }
        if (body.capabilities !== undefined) patch.capabilities = caps(body.capabilities, c.provider);
        if (body.base_url !== undefined) {
          const b = baseUrl(c.provider, body.base_url, dev);
          if (b !== c.base_url) {
            // The key was entered for the old address: it never follows the connection elsewhere (F-1).
            patch.base_url = b;
            patch.sealed_key = null;
            patch.key_hint = null;
            patch.status = 'untested';
          }
        }
        if (body.priority !== undefined) patch.priority = intIn(body.priority, 'priority', 1, 99);
        if (body.prices !== undefined) patch.prices = prices(body.prices, c.prices);
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') throw bad('enabled harus true/false');
          patch.enabled = body.enabled;
        }
        const next = await store.update(c.connection_id, patch);
        await audit(ws, { op: 'ai.provider.update', actor, outcome: 'ok', connection_id: c.connection_id, fields: Object.keys(patch) });
        return { connection: publicConnection(next!) };
      },
    },
    {
      method: 'POST',
      path: '/api/ai/providers/:connection_id/key',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req, 8 * 1024);
        onlyKeys(body, ['api_key']);
        const c = await store.setKey(params.connection_id!, apiKey(body.api_key));
        if (!c) throw notFound();
        await audit(ws, { op: 'ai.provider.rotate', actor, outcome: 'ok', connection_id: c.connection_id, key_hint: c.key_hint });
        return { connection: publicConnection(c) };
      },
    },
    {
      method: 'POST',
      path: '/api/ai/providers/:connection_id/test',
      handle: async ({ req, params, actor }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, []);
        const c = store.find(params.connection_id!);
        if (!c) throw notFound();
        const key = await store.keyOf(c);
        let result: { ok: boolean; models: number | null; model_listed: boolean | null; error: { class: string; status: number | null; message: string } | null };
        try {
          const r = await testConnection({ provider: c.provider, model: c.model, base_url: providerBase(c)!, api_key: key }, AbortSignal.timeout(15_000), fetchImpl);
          result = { ok: true, ...r, error: null };
          c.status = 'ok';
          c.last_error = null;
          c.cooldown_until = 0;
        } catch (e) {
          const err = e instanceof AiCallError ? e : new AiCallError('transient', 'Tes gagal');
          result = { ok: false, models: null, model_listed: null, error: { class: err.cls, status: err.status, message: err.message.slice(0, 200) } };
          c.status = err.cls === 'auth' || err.cls === 'billing' ? 'needs_admin' : 'error';
          c.last_error = { ...result.error!, at: Date.now() };
        }
        c.last_test_at = Date.now();
        await store.touch();
        await audit(ws, { op: 'ai.provider.test', actor, outcome: result.ok ? 'ok' : 'failed', connection_id: c.connection_id, provider: c.provider, error_class: result.error?.class ?? null, status: result.error?.status ?? null });
        return { result, connection: publicConnection(c) };
      },
    },
    {
      method: 'DELETE',
      path: '/api/ai/providers/:connection_id',
      handle: async ({ params, actor }) => {
        if (!(await store.remove(params.connection_id!))) throw notFound();
        await audit(ws, { op: 'ai.provider.remove', actor, outcome: 'ok', connection_id: params.connection_id });
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/ai/settings',
      handle: async ({ req, actor }) => {
        const next = parseSettings(await readJsonBody(req), store.settings());
        await store.setSettings(next);
        await audit(ws, { op: 'ai.settings', actor, outcome: 'ok', mode: next.mode, failover: next.failover, budget: next.budget });
        return { settings: next };
      },
    },
    {
      method: 'GET',
      path: '/api/ai/usage',
      handle: async () => {
        if (!ledger) throw new ApiError(404, 'NOT_FOUND', 'Pencatatan pemakaian tidak aktif');
        return { usage: ledger.summary() };
      },
    },
    {
      method: 'GET',
      path: '/api/ai/log',
      handle: async () => {
        const entries = await readAudit(ws, (e) => e.op.startsWith('ai.') || e.op === 'copilot.plan');
        return { entries: entries.slice(-100).reverse() };
      },
    },
  ];
}
