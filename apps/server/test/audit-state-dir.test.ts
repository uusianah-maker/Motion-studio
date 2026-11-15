// Security: every audit script that starts the server must give it its own state dir — without
// MOTION_STATE_DIR the server falls back to the LIVE one in the home folder (token, sessions,
// sealed AI keys), and an audit run would read or overwrite it.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const auditDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../audit');

describe('audit scripts never use the live state dir', () => {
  it('each start({...}) call passes MOTION_STATE_DIR', async () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const d of await fsp.readdir(auditDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of await fsp.readdir(path.join(auditDir, d.name))) {
        if (!f.endsWith('.mjs')) continue;
        const src = await fsp.readFile(path.join(auditDir, d.name, f), 'utf8');
        for (const m of src.matchAll(/\bstart\(\s*\{([^}]*)\}/g)) {
          calls++;
          if (!m[1]!.includes('MOTION_STATE_DIR')) offenders.push(`${d.name}/${f}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
