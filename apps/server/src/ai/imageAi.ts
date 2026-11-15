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
 * Not used to make pictures yet. "Tes koneksi" only lists the provider's models (free).
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
  sealed_key: string | null;
  key_hint: string | null;
  last_test: { at: number; ok: boolean; message: string } | null;
  updated_at: number;
}
const EMPTY: FileShape = { version: 1, provider: null, endpoint: null, model: null, budget: { amount: null, currency: 'IDR' }, sealed_key: null, key_hint: null, last_test: null, updated_at: 0 };
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
      key_saved: !!data.sealed_key,
      key_hint: data.key_hint,
      last_test: data.last_test,
      providers: Object.entries(IMAGE_PROVIDERS).map(([id, p]) => ({ id, label: p.label, model_hint: p.model_hint, needs_endpoint: !p.base })),
    }),
    raw: () => data,
    async setConfig(c: Pick<FileShape, 'provider' | 'endpoint' | 'model' | 'budget'>) {
      Object.assign(data, c);
      data.last_test = null;
      await save();
    },
    async setKey(apiKey: string | null) {
      data.sealed_key = apiKey ? (await getBox()).seal(apiKey, AAD) : null;
      data.key_hint = apiKey ? apiKey.slice(-4) : null;
      data.last_test = null;
      await save();
    },
    async keyOf(): Promise<string | null> {
      return data.sealed_key ? (await getBox()).open(data.sealed_key, AAD) : null;
    },
    async setTest(t: FileShape['last_test']) {
      data.last_test = t;
      await save();
    },
    flush: () => writing,
  };
}
export type ImageAiStore = Awaited<ReturnType<typeof openImageAiStore>>;

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
        onlyKeys(body, ['provider', 'endpoint', 'model', 'budget']);
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
        await store.setConfig({ provider, endpoint, model, budget: { amount: amount as number | null, currency } });
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
        const d = store.raw();
        const key = await store.keyOf();
        if (!key) throw bad('Simpan API key dulu');
        const base = endpointOf(d, dev);
        const url = d.provider === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
        const headers: Record<string, string> = d.provider === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
        let ok = false;
        let message: string;
        try {
          const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
          ok = r.ok;
          message = r.ok ? 'Koneksi berhasil (daftar model terbaca)' : r.status === 401 || r.status === 403 ? `API key ditolak (HTTP ${r.status})` : `Penyedia menjawab HTTP ${r.status}`;
        } catch (e) {
          message = `Tidak bisa menghubungi penyedia (${e instanceof Error ? e.name : 'error'})`;
        }
        await store.setTest({ at: Date.now(), ok, message });
        return { gambar: store.view() };
      },
    },
  ];
}
