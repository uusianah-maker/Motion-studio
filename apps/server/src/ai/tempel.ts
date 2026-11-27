import { AiCallError, type CallTarget, PROVIDERS, type ProviderId, completeJson, listModels, parseJsonObject } from './adapters.js';
import type { Prices } from './store.js';

/**
 * 27 Nov (owner: "gua cukup tempel, nanti otomatis dicari tau ini API dari mana"): the owner pastes
 * one key and the app finds where it belongs, picks the best text model and checks it with one tiny
 * call. The key is only ever sent to a fixed list of trusted hosts, in an order that never hands an
 * official provider's key to a reseller: a key whose prefix names its provider goes there only; a
 * generic `sk-…` key goes to OpenAI first (a reseller key is just refused there), then the resellers.
 */

export interface Tujuan {
  /** Stored provider: resellers are "compatible" servers with their own address. */
  provider: ProviderId;
  base_url: string | null;
  label: string;
}

/** Resellers the owner uses (OpenAI-compatible `/v1/models` + `/v1/chat/completions`). */
export const RESELLER = { apimart: { label: 'apimart.ai', base: 'https://api.apimart.ai' } } as const;
export type TujuanId = 'anthropic' | 'openai' | 'gemini' | keyof typeof RESELLER;

const tujuan = (id: TujuanId): Tujuan =>
  id === 'apimart' ? { provider: 'openai_compatible', base_url: RESELLER.apimart.base, label: RESELLER.apimart.label } : { provider: id, base_url: null, label: PROVIDERS[id].label };

/** Where a pasted key may be tried, in order. */
export function urutanCoba(key: string): TujuanId[] {
  if (key.startsWith('sk-ant-')) return ['anthropic'];
  if (key.startsWith('AIza')) return ['gemini'];
  if (/^sk-(proj|svcacct|admin)-/.test(key)) return ['openai'];
  if (key.startsWith('sk-')) return ['openai', 'apimart'];
  return ['apimart'];
}

/** Ids that are not a chat model (pictures, speech, embeddings, …) or the small/cheap variants. */
const BUKAN_TEKS = /(image|imagen|dall|embed|whisper|tts|audio|realtime|speech|transcri|moderation|search|video|veo|sora|kling|seedance|seedream|flux|midjourney|suno|music|banana|mini|nano|lite|tiny|instant|vision-only|ocr)/i;
/** Families, best first (strong but not the most expensive); inside one family the newest version wins. */
const KELUARGA: [RegExp, number][] = [
  [/^claude-sonnet/, 1],
  [/^gpt-5/, 2],
  [/^claude-opus/, 3],
  [/^gemini-[\d.]+-pro/, 4],
  [/^deepseek/, 5],
  [/^gemini/, 6],
  [/^gpt-4/, 7],
  [/^claude/, 8],
];
const versi = (id: string) => (id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '0').split(/[.-]/).map(Number);

/** Text models to try, best first (at most `max`). */
export function urutanModel(ids: string[], max = 3): string[] {
  const teks = [...new Set(ids)].filter((id) => !BUKAN_TEKS.test(id) && KELUARGA.some(([re]) => re.test(id)));
  return teks
    .sort((a, b) => {
      const ka = KELUARGA.find(([re]) => re.test(a))![1];
      const kb = KELUARGA.find(([re]) => re.test(b))![1];
      if (ka !== kb) return ka - kb;
      const va = versi(a);
      const vb = versi(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
      return a.length - b.length;
    })
    .slice(0, max);
}

/** Rough USD per 1M tokens for the budget guard (rounded up: a reseller is usually cheaper). */
export function hargaKira(model: string): Prices {
  const m = model.toLowerCase();
  const [i, o] = /opus/.test(m) ? [15, 75] : /sonnet|gpt-5|gemini-[\d.]+-pro/.test(m) ? [5, 25] : /deepseek/.test(m) ? [1, 4] : [5, 25];
  return { input_per_mtok: i, output_per_mtok: o, per_audio_minute: 0 };
}

export type HasilTempel =
  | { ok: true; id: TujuanId; tujuan: Tujuan; model: string; jumlah_model: number; ids: string[]; dicoba: string[] }
  | { ok: false; alasan: 'tidak_dikenal' | 'saldo' | 'tanpa_model' | 'jaringan'; pesan: string; dicoba: string[] };

/**
 * Try the pasted key: list models at each allowed host until one accepts the key, then make one
 * tiny JSON call with the best models until one answers. `bases` overrides hosts (tests only).
 */
export async function deteksiKunci(key: string, opts: { fetchImpl?: typeof fetch; bases?: Partial<Record<TujuanId, string>>; timeoutMs?: number } = {}): Promise<HasilTempel> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dicoba: string[] = [];
  const ms = opts.timeoutMs ?? 20_000;
  for (const id of urutanCoba(key)) {
    const t = tujuan(id);
    const base = opts.bases?.[id] ?? t.base_url ?? PROVIDERS[t.provider].base_url!;
    dicoba.push(t.label);
    let ids: string[];
    try {
      ids = await listModels({ provider: t.provider, base_url: base, api_key: key }, AbortSignal.timeout(ms), fetchImpl);
    } catch (e) {
      const err = e instanceof AiCallError ? e : null;
      if (err?.cls === 'auth' || err?.cls === 'bad_request') continue; // not this host's key
      if (err?.cls === 'billing') return { ok: false, alasan: 'saldo', pesan: `Kunci dikenali oleh ${t.label}, tapi saldo/kuota habis. Isi saldo dulu lalu tempel lagi.`, dicoba };
      return { ok: false, alasan: 'jaringan', pesan: `Tidak bisa menghubungi ${t.label} (${err?.message ?? 'jaringan'}). Coba lagi sebentar.`, dicoba };
    }
    const models = urutanModel(ids);
    if (!models.length) return { ok: false, alasan: 'tanpa_model', pesan: `Kunci dikenali oleh ${t.label}, tapi tidak ada model teks (Claude/GPT/Gemini/DeepSeek) yang boleh dipakai kunci ini.`, dicoba };
    const gagal: string[] = [];
    for (const model of models) {
      const target: CallTarget = { provider: t.provider, model, base_url: base, api_key: key };
      try {
        const r = await completeJson(target, { system: 'Answer with one JSON object only.', user: 'Reply exactly {"ok":true}', max_output_tokens: 200 }, AbortSignal.timeout(ms * 2), fetchImpl);
        parseJsonObject(r.text);
        return { ok: true, id, tujuan: { ...t, base_url: opts.bases?.[id] ? base : t.base_url }, model, jumlah_model: ids.length, ids, dicoba };
      } catch (e) {
        const err = e instanceof AiCallError ? e : null;
        if (err?.cls === 'billing') return { ok: false, alasan: 'saldo', pesan: `Kunci dikenali oleh ${t.label}, tapi saldo/kuota habis. Isi saldo dulu lalu tempel lagi.`, dicoba };
        gagal.push(`${model}: ${err?.message ?? (e instanceof Error ? `${e.name} ${e.message}`.replaceAll(key, '…').slice(0, 120) : 'gagal')}`);
      }
    }
    return { ok: false, alasan: 'tanpa_model', pesan: `Kunci dikenali oleh ${t.label}, tapi model teksnya gagal menjawab (${gagal.join('; ')}).`, dicoba };
  }
  return { ok: false, alasan: 'tidak_dikenal', pesan: `Kunci ini ditolak oleh ${dicoba.join(', ')}. Salin ulang kuncinya utuh (tanpa spasi), atau pakai "Tambah koneksi" manual di bawah.`, dicoba };
}
