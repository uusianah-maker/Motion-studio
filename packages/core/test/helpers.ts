import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

/** Fresh temp directory, removed after each test (read-only files are made writable first). */
export async function tempDir(prefix = 'msc-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function makeWritable(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await makeWritable(p);
    else await fsp.chmod(p, 0o666).catch(() => {});
  }
}

afterEach(async () => {
  while (created.length) {
    const d = created.pop()!;
    await makeWritable(d);
    await fsp.rm(d, { recursive: true, force: true, maxRetries: 5 });
  }
});

/** Try to create a link; returns false when the OS refuses (e.g. file symlinks without Developer Mode). */
export async function tryLink(target: string, linkPath: string, type: 'junction' | 'file' | 'dir'): Promise<boolean> {
  try {
    await fsp.symlink(target, linkPath, type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

export async function listTree(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(e.isDirectory() ? `${r}/` : r);
    if (e.isDirectory()) out.push(...(await listTree(root, r)));
  }
  return out.sort();
}
