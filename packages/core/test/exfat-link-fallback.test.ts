import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStorageError } from '../src/storage/errors.js';
import { LocalFsBackend } from '../src/storage/localfs.js';
import { tempDir } from './helpers.js';

/**
 * exFAT (owner's D: workspace) does not support hard links; Windows answers link() with EISDIR
 * instead of EPERM/ENOTSUP. Import and move must fall back to check + rename, still never
 * overwriting an existing target.
 */
describe('renameNoReplace fallback when link() is unsupported (exFAT)', () => {
  afterEach(() => vi.restoreAllMocks());

  const linkFails = (code: string) =>
    vi.spyOn(fsp, 'link').mockImplementation(async () => {
      throw Object.assign(new Error(`${code}: illegal operation on a directory, link`), { code });
    });

  async function staged() {
    const root = await tempDir('exfat-');
    const src = path.join(await tempDir('src-'), 'clip.mp4');
    await fsp.writeFile(src, 'video-bytes');
    await fsp.mkdir(path.join(root, 'in'), { recursive: true });
    const b = new LocalFsBackend(root);
    return { root, b, s: await b.stage('in', src) };
  }

  for (const code of ['EISDIR', 'EPERM']) {
    it(`commit works when link() throws ${code}`, async () => {
      const { root, b, s } = await staged();
      linkFails(code);
      const rel = await b.commit(s, 'in/m_1/v_1.mp4');
      expect(await fsp.readFile(path.join(root, rel), 'utf8')).toBe('video-bytes');
      await expect(fsp.access(s.token)).rejects.toThrow(); // staged temp name is gone
    });
  }

  it('fallback still refuses to overwrite an existing target', async () => {
    const { root, b, s } = await staged();
    await fsp.mkdir(path.join(root, 'in', 'm_1'), { recursive: true });
    await fsp.writeFile(path.join(root, 'in', 'm_1', 'v_1.mp4'), 'existing');
    linkFails('EISDIR');
    const err = await b.commit(s, 'in/m_1/v_1.mp4').catch((e) => e);
    expect(isStorageError(err) && err.code).toBe('CONFLICT');
    expect(await fsp.readFile(path.join(root, 'in', 'm_1', 'v_1.mp4'), 'utf8')).toBe('existing');
  });

  it('other link() errors are still raised', async () => {
    const { b, s } = await staged();
    linkFails('EIO');
    await expect(b.commit(s, 'in/m_1/v_1.mp4')).rejects.toMatchObject({ code: 'EIO' });
  });
});
