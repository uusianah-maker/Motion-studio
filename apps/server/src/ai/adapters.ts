import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * AI provider adapters (W12, PRD v0.4/v0.5): official HTTP APIs only, one API key per
 * connection entered manually by the admin. Raw `fetch` (no vendor SDKs = no new dependencies,
 * one code path for every provider, testable against a local fake). Adapters never see the
 * user's request, cookie or session (F7): only the key, the model and the payload.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai_compatible';
export type Capability = 'planner' | 'transcription';

export const PROVIDERS: Record<ProviderId, { label: string; base_url: string | null; capabilities: Capability[]; key_required: boolean; model_hint: string }> = {
  anthropic: { label: 'Anthropic (Claude)', base_url: 'https://api.anthropic.com', capabilities: ['planner'], key_required: true, model_hint: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', base_url: 'https://api.openai.com', capabilities: ['planner', 'transcription'], key_required: true, model_hint: 'gpt-… / whisper-1' },
  gemini: { label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com', capabilities: ['planner'], key_required: true, model_hint: 'gemini-…' },
  openai_compatible: { label: 'Kompatibel OpenAI (Ollama, LM Studio, …)', base_url: null, capabilities: ['planner', 'transcription'], key_required: false, model_hint: 'nama model lokal' },
};

/** How a failure should be handled by the router (PRD v0.4 failover rules). */
export type ErrorClass = 'transient' | 'rate_limit' | 'auth' | 'billing' | 'bad_request' | 'bad_output' | 'refused';

export class AiCallError extends Error {
  constructor(
    readonly cls: ErrorClass,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'AiCallError';
  }
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
}

export interface CallTarget {
  provider: ProviderId;
  model: string;
  base_url: string;
  api_key: string | null;
}

export interface JsonRequest {
  system: string;
  user: string;
  max_output_tokens: number;
}

export interface TranscribeRequest {
  file: string;
  mime: string;
  language: 'id' | 'en' | null;
}

export interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
}

const retryAfter = (h: Headers): number | null => {
  const v = h.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
};
const reqId = (h: Headers) => h.get('request-id') ?? h.get('x-request-id') ?? null;

/** Map an HTTP failure to a class; bodies are only inspected for a short error code. */
export async function classify(r: Response): Promise<AiCallError> {
  let code = '';
  let msg = '';
  try {
    const body = (await r.json()) as { error?: { type?: string; code?: string; status?: string; message?: string } | string };
    const e = typeof body.error === 'object' ? body.error : null;
    code = String(e?.type ?? e?.code ?? e?.status ?? (typeof body.error === 'string' ? body.error : '')).toLowerCase();
    msg = String(e?.message ?? '').slice(0, 160);
  } catch {
    /* non-JSON body */
  }
  const s = r.status;
  const id = reqId(r.headers);
  const text = `HTTP ${s}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`;
  if (s === 401 || s === 403) return new AiCallError('auth', text, s, null, id);
  if (s === 402 || /insufficient_quota|billing|credit|resource_exhausted.*quota/.test(code)) return new AiCallError('billing', text, s, null, id);
  if (s === 429) return new AiCallError('rate_limit', text, s, retryAfter(r.headers), id);
  if (s === 408 || s >= 500) return new AiCallError('transient', text, s, retryAfter(r.headers), id);
  return new AiCallError('bad_request', text, s, null, id);
}

async function send(url: string, init: RequestInit, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  let r: Response;
  try {
    r = await fetchImpl(url, { ...init, signal, redirect: 'error' });
  } catch (e) {
    if (signal.aborted) throw new AiCallError('transient', 'Waktu habis (timeout)');
    throw new AiCallError('transient', `Jaringan gagal: ${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`);
  }
  if (!r.ok) throw await classify(r);
  return r;
}

const join = (base: string, p: string) => `${base.replace(/\/+$/, '')}${p}`;
const headersFor = (t: CallTarget): Record<string, string> => {
  switch (t.provider) {
    case 'anthropic':
      return { 'x-api-key': t.api_key ?? '', 'anthropic-version': '2026-10-21' };
    case 'gemini':
      return { 'x-goog-api-key': t.api_key ?? '' };
    default:
      return t.api_key ? { authorization: `Bearer ${t.api_key}` } : {};
  }
};

/** Connection test: list models (free on every provider). */
export async function testConnection(t: CallTarget, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ models: number; model_listed: boolean | null }> {
  const url = t.provider === 'gemini' ? join(t.base_url, '/v1beta/models?pageSize=1000') : join(t.base_url, '/v1/models');
  const r = await send(url, { headers: headersFor(t) }, signal, fetchImpl);
  const body = (await r.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = (body.data ?? []).map((m) => String(m.id ?? '')).concat((body.models ?? []).map((m) => String(m.name ?? '').replace(/^models\//, '')));
  return { models: ids.length, model_listed: ids.length ? ids.includes(t.model) : null };
}

/** One LLM call that must answer with a JSON object. Returns the raw JSON text + metered usage. */
export async function completeJson(t: CallTarget, req: JsonRequest, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ text: string; usage: Usage; request_id: string | null }> {
  const h = { ...headersFor(t), 'content-type': 'application/json' };
  if (t.provider === 'anthropic') {
    const r = await send(
      join(t.base_url, '/v1/messages'),
      { method: 'POST', headers: h, body: JSON.stringify({ model: t.model, max_tokens: req.max_output_tokens, system: req.system, messages: [{ role: 'user', content: req.user }] }) },
      signal,
      fetchImpl,
    );
    const b = (await r.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };
    if (b.stop_reason === 'refusal') throw new AiCallError('refused', 'Model menolak permintaan ini', 200, null, reqId(r.headers));
    if (b.stop_reason === 'max_tokens') throw new AiCallError('bad_output', 'Jawaban model terpotong (max_tokens)', 200, null, reqId(r.headers));
    const text = (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    return { text, usage: { input_tokens: b.usage?.input_tokens ?? 0, output_tokens: b.usage?.output_tokens ?? 0, audio_seconds: 0 }, request_id: reqId(r.headers) };
  }
  if (t.provider === 'gemini') {
    const r = await send(
      join(t.base_url, `/v1beta/models/${encodeURIComponent(t.model)}:generateContent`),
      {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: req.max_output_tokens },
        }),
      },
      signal,
      fetchImpl,
    );
    const b = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
    const c = b.candidates?.[0];
    if (c?.finishReason === 'SAFETY' || c?.finishReason === 'PROHIBITED_CONTENT') throw new AiCallError('refused', 'Model menolak permintaan ini', 200);
    if (c?.finishReason === 'MAX_TOKENS') throw new AiCallError('bad_output', 'Jawaban model terpotong (max tokens)', 200);
    const u = b.usageMetadata ?? {};
    return { text: (c?.content?.parts ?? []).map((p) => p.text ?? '').join(''), usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), audio_seconds: 0 }, request_id: reqId(r.headers) };
  }
  // openai + openai_compatible
  const r = await send(
    join(t.base_url, '/v1/chat/completions'),
    {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        model: t.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: req.max_output_tokens,
      }),
    },
    signal,
    fetchImpl,
  );
  const b = (await r.json()) as { choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const ch = b.choices?.[0];
  if (ch?.message?.refusal) throw new AiCallError('refused', 'Model menolak permintaan ini', 200, null, reqId(r.headers));
  if (ch?.finish_reason === 'length') throw new AiCallError('bad_output', 'Jawaban model terpotong (max tokens)', 200, null, reqId(r.headers));
  return { text: ch?.message?.content ?? '', usage: { input_tokens: b.usage?.prompt_tokens ?? 0, output_tokens: b.usage?.completion_tokens ?? 0, audio_seconds: 0 }, request_id: reqId(r.headers) };
}

/** Speech-to-text with word timestamps (OpenAI audio API shape; also OpenAI-compatible servers). */
export async function transcribe(t: CallTarget, req: TranscribeRequest, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ words: Word[]; text: string; language: string | null; usage: Usage; request_id: string | null }> {
  if (t.provider !== 'openai' && t.provider !== 'openai_compatible') throw new AiCallError('bad_request', `Provider ${t.provider} tidak mendukung transkripsi`);
  const form = new FormData();
  const bytes = await fsp.readFile(req.file);
  form.append('file', new Blob([bytes], { type: req.mime }), path.basename(req.file));
  form.append('model', t.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (req.language) form.append('language', req.language);
  const r = await send(join(t.base_url, '/v1/audio/transcriptions'), { method: 'POST', headers: headersFor(t), body: form }, signal, fetchImpl);
  const b = (await r.json()) as { text?: string; language?: string; duration?: number; words?: { word?: string; start?: number; end?: number }[] };
  const words = (b.words ?? [])
    .map((w) => ({ text: String(w.word ?? '').trim(), start_ms: Math.round(Number(w.start) * 1000), end_ms: Math.round(Number(w.end) * 1000) }))
    .filter((w) => w.text && Number.isFinite(w.start_ms) && Number.isFinite(w.end_ms) && w.end_ms >= w.start_ms);
  if (!words.length && (b.text ?? '').trim()) throw new AiCallError('bad_output', 'Provider tidak mengirim timestamp per kata');
  return { words, text: b.text ?? '', language: b.language ?? null, usage: { input_tokens: 0, output_tokens: 0, audio_seconds: Number(b.duration) || 0 }, request_id: reqId(r.headers) };
}

/** First JSON object in a model answer (models sometimes wrap it in ``` fences). */
export function parseJsonObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiCallError('bad_output', 'Jawaban model bukan JSON');
  try {
    const v = JSON.parse(t.slice(start, end + 1)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v as Record<string, unknown>;
  } catch {
    throw new AiCallError('bad_output', 'Jawaban model bukan JSON yang valid');
  }
}
