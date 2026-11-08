import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type SecretBox, createSecretBox, loadSecretKey } from '../secrets.js';
import { type Capability, PROVIDERS, type ProviderId } from './adapters.js';

/**
 * AI Provider Manager storage (W12): connections + settings in the server state folder
 * (outside the workspace). API keys are sealed (AES-256-GCM, bound to the connection id) and
 * never leave the server: the public view only carries a masked hint.
 */

export type ConnStatus = 'untested' | 'ok' | 'error' | 'needs_admin';

export interface Prices {
  /** USD per 1M input tokens. */
  input_per_mtok: number;
  /** USD per 1M output tokens. */
  output_per_mtok: number;
  /** USD per audio minute (transcription). */
  per_audio_minute: number;
}

export interface Connection {
  connection_id: string;
  provider: ProviderId;
  label: string;
  model: string;
  capabilities: Capability[];
  base_url: string | null;
  priority: number;
  enabled: boolean;
  prices: Prices;
  key_hint: string | null;
  sealed_key: string | null;
  status: ConnStatus;
  last_error: { class: string; status: number | null; message: string; at: number } | null;
  last_test_at: number | null;
  cooldown_until: number;
  created_at: number;
  updated_at: number;
}

export type CopilotMode = 'local' | 'auto' | 'ai';

export interface AiSettings {
  /** local = rules only (no AI call ever); auto = rules first, AI only when rules don't know; ai = always AI. */
  mode: CopilotMode;
  failover: boolean;
  max_retries: number;
  timeout_ms: number;
  cooldown_ms: number;
  max_output_tokens: number;
  /** Hard spend caps in USD (W13). 0 = AI calls blocked. */
  budget: { daily_usd: number; monthly_usd: number; per_request_usd: number };
}

/** Sealed keys are bound to the connection AND the host they are meant for (Checkpoint F F-1). */
const keyAad = (c: Pick<Connection, 'connection_id' | 'provider' | 'base_url'>) => `${c.connection_id}|${c.provider}|${providerBase(c) ?? ''}`;

export const DEFAULT_SETTINGS: AiSettings = {
  mode: 'local',
  failover: true,
  max_retries: 2,
  timeout_ms: 60_000,
  cooldown_ms: 60_000,
  max_output_tokens: 8000,
  budget: { daily_usd: 1, monthly_usd: 10, per_request_usd: 0.25 },
};

interface FileShape {
  version: 1;
  settings: AiSettings;
  connections: Connection[];
}

export const publicConnection = (c: Connection) => {
  const { sealed_key: _k, ...rest } = c;
  void _k;
  return { ...rest, has_key: !!c.sealed_key, cooling_down: c.cooldown_until > Date.now() };
};
export type PublicConnection = ReturnType<typeof publicConnection>;

export async function openAiStore(stateDir: string, secretKeyEnv: string | undefined, now: () => number = Date.now) {
  const file = path.join(stateDir, 'ai-providers.json');
  let box: SecretBox | null = null;
  const getBox = async () => (box ??= createSecretBox((await loadSecretKey(secretKeyEnv, stateDir)).key));

  let data: FileShape = { version: 1, settings: structuredClone(DEFAULT_SETTINGS), connections: [] };
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<FileShape>;
    if (parsed.version !== 1 || !Array.isArray(parsed.connections)) throw new Error('bad');
    data = { version: 1, settings: { ...structuredClone(DEFAULT_SETTINGS), ...parsed.settings, budget: { ...DEFAULT_SETTINGS.budget, ...parsed.settings?.budget } }, connections: parsed.connections };
    if (data.connections.some((c) => c.sealed_key)) {
      const b = await getBox();
      // Fail closed at start: keys sealed with another key are unusable.
      for (const c of data.connections) if (c.sealed_key) b.open(c.sealed_key, keyAad(c));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Konfigurasi AI tidak bisa dibuka (${file}): file rusak atau kunci enkripsi berbeda`);
  }

  let writing: Promise<void> = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    return writing;
  };

  const find = (id: string) => data.connections.find((c) => c.connection_id === id) ?? null;

  return {
    file,
    settings: () => data.settings,
    connections: () => data.connections,
    find,
    async setSettings(s: AiSettings) {
      data.settings = s;
      await save();
    },
    async add(input: Omit<Connection, 'connection_id' | 'sealed_key' | 'key_hint' | 'status' | 'last_error' | 'last_test_at' | 'cooldown_until' | 'created_at' | 'updated_at'> & { api_key: string | null }) {
      const id = `conn_${randomBytes(6).toString('hex')}`;
      const { api_key, ...rest } = input;
      const t = now();
      const c: Connection = { ...rest, connection_id: id, sealed_key: null, key_hint: null, status: 'untested', last_error: null, last_test_at: null, cooldown_until: 0, created_at: t, updated_at: t };
      if (api_key) {
        c.sealed_key = (await getBox()).seal(api_key, keyAad(c));
        c.key_hint = `…${api_key.slice(-4)}`;
      }
      data.connections.push(c);
      await save();
      return c;
    },
    async update(id: string, patch: Partial<Connection>) {
      const c = find(id);
      if (!c) return null;
      Object.assign(c, patch, { updated_at: now() });
      await save();
      return c;
    },
    async setKey(id: string, apiKey: string) {
      const c = find(id);
      if (!c) return null;
      c.sealed_key = (await getBox()).seal(apiKey, keyAad(c));
      c.key_hint = `…${apiKey.slice(-4)}`;
      c.status = 'untested';
      c.last_error = null;
      c.cooldown_until = 0;
      c.updated_at = now();
      await save();
      return c;
    },
    async remove(id: string) {
      const before = data.connections.length;
      data.connections = data.connections.filter((c) => c.connection_id !== id);
      if (data.connections.length !== before) await save();
      return data.connections.length !== before;
    },
    /** Plain key for one outgoing call; never stored elsewhere, never logged. */
    async keyOf(c: Connection): Promise<string | null> {
      return c.sealed_key ? (await getBox()).open(c.sealed_key, keyAad(c)) : null;
    },
    /** Persist status fields the router changed in place. */
    touch: () => save(),
    flush: () => writing,
  };
}
export type AiStore = Awaited<ReturnType<typeof openAiStore>>;

export const providerBase = (c: Pick<Connection, 'provider' | 'base_url'>) => c.base_url ?? PROVIDERS[c.provider].base_url;
