import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 of a local file as `sha256:<hex>`, streamed (never loads the whole file). */
export async function hashFile(file: string): Promise<{ hash: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: `sha256:${h.digest('hex')}`, size };
}
