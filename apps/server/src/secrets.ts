import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Secrets at rest (W09/W12): AES-256-GCM with a server-only key. Used for AI provider API keys.
 * The key lives outside the workspace (server state folder) or in `MOTION_SECRET_KEY`.
 */
const b64u = (b: Buffer) => b.toString('base64url');

/** AES-256-GCM box. `aad` binds a ciphertext to its owner (a token copied to another user fails). */
export function createSecretBox(key: Buffer) {
  if (key.length !== 32) throw new Error('Kunci enkripsi harus 32 byte');
  return {
    seal(plain: string, aad: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`;
    },
    open(sealed: string, aad: string): string {
      if (!sealed.startsWith('v1.')) throw new Error('Format rahasia tidak dikenal');
      const raw = Buffer.from(sealed.slice(3), 'base64url');
      if (raw.length < 29) throw new Error('Rahasia rusak');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;

/**
 * The encryption key: `MOTION_SECRET_KEY` (64 hex chars; preferred on a VPS), else a random key
 * file created once in the server state folder (outside the workspace).
 */
export async function loadSecretKey(envValue: string | undefined, stateDir: string): Promise<{ key: Buffer; source: 'env' | 'file' | 'created' }> {
  if (envValue !== undefined && envValue !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(envValue.trim())) throw new Error('MOTION_SECRET_KEY harus 64 karakter hex (32 byte)');
    return { key: Buffer.from(envValue.trim(), 'hex'), source: 'env' };
  }
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'secret.key');
  try {
    await fsp.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const key = await readKeyFile(file);
    return { key, source: 'created' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return { key: await readKeyFile(file), source: 'file' };
}

async function readKeyFile(file: string): Promise<Buffer> {
  const raw = (await fsp.readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`File kunci rusak: ${file}`);
  return Buffer.from(raw, 'hex');
}

