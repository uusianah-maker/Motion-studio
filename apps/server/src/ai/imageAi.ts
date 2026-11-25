import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Route } from '../app.js';
import { ApiError } from '../errors.js';
import { readJsonBody } from '../http.js';
import { onlyKeys } from '../routes.js';
import { type SecretBox, createSecretBox, loadSecretKey } from '../secrets.js';

/**
 * R12a: "AI gambar" settings for Motion Transfer stage 2 (owner, 15 Nov: "siapkan kolom untuk gua
 * masukin apinya"). Owner only. Stored in the server state folder (`ai-gambar.json`, outside the
 * workspace and the repo); the API key is sealed with the server secret (MOTION_SECRET_KEY, like
 * the other AI keys) and never sent back — the browser only sees "tersimpan ••••abcd".
 * Used since §29 Beat Spot Ganti Outfit: `generateImageEdit` edits one picture (OpenAI-style
 * `/v1/images/edits`). "Tes koneksi" only lists the provider's models (free) and remembers the newest
 * gpt-image model it saw. Owner 25 Nov: "kenapa harus ada penyedia?" → the provider is recognised
 * from the key (`sk-` OpenAI, `AIza` Gemini) when none is chosen; an empty model = the detected one.
 */
export type ImageProvider = 'openai' | 'gemini' | 'lainnya';
export const IMAGE_PROVIDERS: Record<ImageProvider, { label: string; base: string | null; model_hint: string }> = {
  openai: { label: 'OpenAI (gambar)', base: 'https://api.openai.com', model_hint: 'gpt-image-1' },
  gemini: { label: 'Google Gemini (gambar)', base: 'https://generativelanguage.googleapis.com', model_hint: 'gemini-2.5-flash-image' },
  lainnya: { label: 'Lainnya (URL endpoint)', base: null, model_hint: '' },
};

interface FileShape {
  version: 1;
  provider: ImageProvider | null;
  endpoint: string | null;
  model: string | null;
  budget: { amount: number | null; currency: 'IDR' | 'USD' };
  /** §29: estimated price of one picture (same currency as the budget); needed when a budget is set. */
  harga_per_gambar: number | null;
  /** Newest gpt-image model seen by "Tes koneksi" (used when `model` is empty). */
  model_terdeteksi: string | null;
  sealed_key: string | null;
  key_hint: string | null;
  last_test: { at: number; ok: boolean; message: string } | null;
  updated_at: number;
}
const EMPTY: FileShape = { version: 1, provider: null, endpoint: null, model: null, budget: { amount: null, currency: 'IDR' }, harga_per_gambar: null, model_terdeteksi: null, sealed_key: null, key_hint: null, last_test: null, updated_at: 0 };
const AAD = 'ai-gambar/1';

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const HTTPS_RE = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const bad = (msg: string) => new ApiError(422, 'EDIT_INVALID', msg);

export async function openImageAiStore(stateDir: string, secretKeyEnv: string | undefined, now: () => number = Date.now) {
  const file = path.join(stateDir, 'ai-gambar.json');
  let box: SecretBox | null = null;
  const getBox = async () => (box ??= createSecretBox((await loadSecretKey(secretKeyEnv, stateDir)).key));
  let data: FileShape = structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<FileShape>;
    if (parsed.version !== 1) throw new Error('bad');
    data = { ...structuredClone(EMPTY), ...parsed, budget: { ...EMPTY.budget, ...parsed.budget } } as FileShape;
    if (data.sealed_key) (await getBox()).open(data.sealed_key, AAD); // fail closed: another server key
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Pengaturan AI gambar tidak bisa dibuka (${file}): file rusak atau kunci enkripsi berbeda`);
  }
  let writing: Promise<void> = Promise.resolve();
  const save = () => {
    data.updated_at = now();
    const snapshot = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    return writing;
  };
  return {
    file,
    /** What the browser may see: never the key. */
    view: () => ({
      provider: data.provider,
      endpoint: data.endpoint,
      model: data.model,
      budget: data.budget,
      harga_per_gambar: data.harga_per_gambar,
      model_terdeteksi: data.model_terdeteksi,
      model_dipakai: modelOf(data),
      key_saved: !!data.sealed_key,
      key_hint: data.key_hint,
      last_test: data.last_test,
      providers: Object.entries(IMAGE_PROVIDERS).map(([id, p]) => ({ id, label: p.label, model_hint: p.model_hint, needs_endpoint: !p.base })),
    }),
    raw: () => data,
    async setConfig(c: Pick<FileShape, 'provider' | 'endpoint' | 'model' | 'budget'> & Partial<Pick<FileShape, 'harga_per_gambar'>>) {
      Object.assign(data, c);
      data.last_test = null;
      await save();
    },
    async setKey(apiKey: string | null) {
      data.sealed_key = apiKey ? (await getBox()).seal(apiKey, AAD) : null;
      data.key_hint = apiKey ? apiKey.slice(-4) : null;
      // Owner 25 Nov: cukup tempel key — penyedia dikenali dari awalannya kalau belum dipilih.
      if (apiKey && !data.provider) data.provider = providerFromKey(apiKey);
      if (apiKey) data.model_terdeteksi = null;
      data.last_test = null;
      await save();
    },
    async keyOf(): Promise<string | null> {
      return data.sealed_key ? (await getBox()).open(data.sealed_key, AAD) : null;
    },
    async setTest(t: FileShape['last_test'], extra: Partial<Pick<FileShape, 'provider' | 'model_terdeteksi'>> = {}) {
      data.last_test = t;
      Object.assign(data, extra);
      await save();
    },
    flush: () => writing,
  };
}
export type ImageAiStore = Awaited<ReturnType<typeof openImageAiStore>>;

/** `sk-…` = OpenAI, `AIza…` = Google Gemini; anything else stays unchosen. */
export function providerFromKey(key: string): ImageProvider | null {
  return key.startsWith('sk-') ? 'openai' : key.startsWith('AIza') ? 'gemini' : null;
}

/** Model used for a picture: the owner's choice, else the newest one "Tes koneksi" saw, else the default. */
export function modelOf(d: Pick<FileShape, 'provider' | 'model' | 'model_terdeteksi'>): string | null {
  return d.model || d.model_terdeteksi || (d.provider ? IMAGE_PROVIDERS[d.provider].model_hint || null : null);
}

/** Newest `gpt-image-*` id in an OpenAI model list (`gpt-image-1.5` > `gpt-image-1` > `gpt-image-1-mini`). */
export function newestImageModel(ids: string[]): string | null {
  const cands = ids.filter((id) => /^gpt-image-\d/.test(id) && !/mini/.test(id));
  if (!cands.length) return null;
  const ver = (id: string) => (id.match(/^gpt-image-(\d+(?:\.\d+)?)/)?.[1] ?? '0').split('.').map(Number);
  cands.sort((a, b) => {
    const va = ver(a);
    const vb = ver(b);
    return (vb[0]! - va[0]!) || ((vb[1] ?? 0) - (va[1] ?? 0)) || a.length - b.length;
  });
  return cands[0]!;
}

/** Where the key may be sent: the provider's official host, or (lainnya) an https host / this machine. */
function endpointOf(d: Pick<FileShape, 'provider' | 'endpoint'>, dev: boolean): string {
  const p = d.provider ? IMAGE_PROVIDERS[d.provider] : null;
  if (!p) throw bad('Pilih penyedia AI gambar dulu');
  if (p.base) return dev && d.endpoint && LOOPBACK_RE.test(d.endpoint) ? d.endpoint : p.base;
  if (!d.endpoint) throw bad('Isi URL endpoint penyedia');
  return d.endpoint;
}

export function imageAiRoutes(store: ImageAiStore, fetchImpl: typeof fetch = fetch, opts: { devEndpoints?: boolean } = {}): Route[] {
  const dev = opts.devEndpoints === true;
  return [
    { method: 'GET', path: '/api/ai/gambar', handle: async () => ({ gambar: store.view() }) },
    {
      method: 'POST',
      path: '/api/ai/gambar',
      handle: async ({ req }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['provider', 'endpoint', 'model', 'budget', 'harga_per_gambar']);
        const provider = body.provider === null || body.provider === '' ? null : typeof body.provider === 'string' && body.provider in IMAGE_PROVIDERS ? (body.provider as ImageProvider) : null;
        if (body.provider && !provider) throw bad('Penyedia harus openai | gemini | lainnya');
        let endpoint: string | null = null;
        if (body.endpoint !== undefined && body.endpoint !== null && body.endpoint !== '') {
          if (typeof body.endpoint !== 'string') throw bad('URL endpoint tidak valid');
          const u = body.endpoint.trim().replace(/\/+$/, '');
          const official = provider ? IMAGE_PROVIDERS[provider].base : null;
          if (official && !(dev && LOOPBACK_RE.test(u))) throw bad('Penyedia resmi selalu memakai alamat resminya; kosongkan URL endpoint');
          if (!official && !HTTPS_RE.test(u) && !LOOPBACK_RE.test(u)) throw bad('URL endpoint harus https://nama-domain atau http://127.0.0.1:<port>');
          endpoint = u;
        }
        if (provider === 'lainnya' && !endpoint) throw bad('Penyedia "lainnya" butuh URL endpoint');
        const model = body.model === undefined || body.model === null || body.model === '' ? null : typeof body.model === 'string' && body.model.trim().length <= 100 ? body.model.trim() : null;
        if (body.model && !model) throw bad('Model maks 100 karakter');
        const b = (body.budget ?? {}) as Record<string, unknown>;
        if (typeof body.budget !== 'object' || body.budget === null) {
          if (body.budget !== undefined) throw bad('budget harus { amount, currency }');
        }
        const currency = b.currency === undefined ? 'IDR' : b.currency === 'IDR' || b.currency === 'USD' ? b.currency : null;
        if (!currency) throw bad('Mata uang batas biaya: IDR atau USD');
        const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : typeof b.amount === 'number' && Number.isFinite(b.amount) && b.amount >= 0 ? b.amount : NaN;
        if (Number.isNaN(amount)) throw bad('Batas biaya per bulan harus angka ≥ 0 (kosong = tanpa batas)');
        const harga = body.harga_per_gambar === undefined ? store.raw().harga_per_gambar : body.harga_per_gambar === null || body.harga_per_gambar === '' ? null : typeof body.harga_per_gambar === 'number' && Number.isFinite(body.harga_per_gambar) && body.harga_per_gambar >= 0 ? body.harga_per_gambar : NaN;
        if (Number.isNaN(harga)) throw bad('Perkiraan harga per gambar harus angka ≥ 0');
        // Owner 25 Nov: penyedia boleh kosong — dikenali dari key yang tersimpan.
        const key = provider ? null : await store.keyOf().catch(() => null);
        const prov = provider ?? (key ? providerFromKey(key) : null);
        await store.setConfig({ provider: prov, endpoint, model, budget: { amount: amount as number | null, currency }, harga_per_gambar: harga as number | null });
        return { gambar: store.view() };
      },
    },
    {
      method: 'POST',
      path: '/api/ai/gambar/key',
      handle: async ({ req }) => {
        const body = await readJsonBody(req);
        onlyKeys(body, ['api_key']);
        if (body.api_key === null) {
          await store.setKey(null);
          return { gambar: store.view() };
        }
        if (typeof body.api_key !== 'string' || body.api_key.length < 8 || body.api_key.length > 400 || /\s/.test(body.api_key)) throw bad('API key tidak valid (8–400 karakter, tanpa spasi)');
        await store.setKey(body.api_key);
        return { gambar: store.view() };
      },
    },
    {
      // Free check: list the provider's models with the saved key (no picture is made, nothing billed).
      method: 'POST',
      path: '/api/ai/gambar/tes',
      handle: async ({ req }) => {
        onlyKeys(await readJsonBody(req), []);
        const key = await store.keyOf();
        if (!key) throw bad('Simpan API key dulu');
        const d = { ...store.raw() };
        if (!d.provider) d.provider = providerFromKey(key);
        const base = endpointOf(d, dev);
        const url = d.provider === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
        const headers: Record<string, string> = d.provider === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
        let ok = false;
        let message: string;
        let terdeteksi: string | null = null;
        try {
          const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
          ok = r.ok;
          message = r.ok ? 'Koneksi berhasil (daftar model terbaca)' : r.status === 401 || r.status === 403 ? `API key ditolak (HTTP ${r.status})` : `Penyedia menjawab HTTP ${r.status}`;
          if (r.ok && d.provider !== 'gemini') {
            const list = (await r.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
            terdeteksi = newestImageModel((list?.data ?? []).map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean));
            if (terdeteksi) message = `Koneksi berhasil · model gambar: ${terdeteksi}`;
          }
        } catch (e) {
          message = `Tidak bisa menghubungi penyedia (${e instanceof Error ? e.name : 'error'})`;
        }
        await store.setTest({ at: Date.now(), ok, message }, { provider: d.provider, ...(terdeteksi ? { model_terdeteksi: terdeteksi } : {}) });
        return { gambar: store.view() };
      },
    },
  ];
}


export interface ImageEditInput {
  /** Image 1 = the picture to edit, then the reference pictures (catalog photos). PNG / JPEG / WEBP. */
  images: { name: string; bytes: Buffer; mime: string }[];
  prompt: string;
  /** e.g. "1024x1536" (portrait 2:3). */
  size: string;
  signal?: AbortSignal;
}
export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'key' | 'quota' | 'ditolak' | 'jaringan' | 'lain',
  ) {
    super(message);
  }
}

/**
 * §29: edit one picture with the saved key (OpenAI `/v1/images/edits`, also "lainnya" endpoints that
 * speak the same API). The key never leaves this server process except to the provider host.
 */
export async function generateImageEdit(store: ImageAiStore, input: ImageEditInput, fetchImpl: typeof fetch = fetch, opts: { devEndpoints?: boolean } = {}): Promise<{ bytes: Buffer; model: string }> {
  const key = await store.keyOf();
  if (!key) throw new ImageGenError('API key AI gambar belum disimpan (menu AI → AI gambar)', 'config');
  const d = { ...store.raw() };
  if (!d.provider) d.provider = providerFromKey(key);
  if (d.provider === 'gemini') throw new ImageGenError('Ganti Outfit saat ini memakai penyedia OpenAI (gpt-image); Gemini belum didukung', 'config');
  let base: string;
  try {
    base = endpointOf(d, opts.devEndpoints === true);
  } catch (e) {
    throw new ImageGenError(e instanceof Error ? e.message : 'Penyedia AI gambar belum diatur', 'config');
  }
  const model = modelOf(d) ?? 'gpt-image-1';
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', input.prompt);
  form.set('size', input.size);
  form.set('n', '1');
  form.set('quality', 'high');
  for (const im of input.images) form.append('image[]', new Blob([new Uint8Array(im.bytes)], { type: im.mime }), im.name);
  let r: Response;
  try {
    r = await fetchImpl(`${base}/v1/images/edits`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: input.signal ?? AbortSignal.timeout(300_000) });
  } catch (e) {
    throw new ImageGenError(`Tidak bisa menghubungi penyedia AI gambar (${e instanceof Error ? e.name : 'error'})`, 'jaringan');
  }
  const body = (await r.json().catch(() => null)) as { data?: { b64_json?: unknown }[]; error?: { message?: unknown; code?: unknown } } | null;
  if (!r.ok) {
    const msg = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 200) : `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) throw new ImageGenError(`API key ditolak penyedia (${msg})`, 'key');
    if (r.status === 429) throw new ImageGenError(`Kuota / batas kecepatan penyedia tercapai (${msg})`, 'quota');
    if (r.status === 400 && /safety|moderation|policy/i.test(msg)) throw new ImageGenError(`Gambar ditolak aturan penyedia (${msg})`, 'ditolak');
    throw new ImageGenError(`Penyedia AI gambar gagal: ${msg}`, 'lain');
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new ImageGenError('Penyedia tidak mengirim gambar', 'lain');
  return { bytes: Buffer.from(b64, 'base64'), model };
}
