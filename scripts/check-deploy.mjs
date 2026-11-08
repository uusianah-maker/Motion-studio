#!/usr/bin/env node
// Pre-flight check before putting Motion Studio online (W15). Read-only: it never changes
// settings, never prints secrets. Usage:
//   npm run check:deploy                       (checks .env.local + tools on this PC)
//   npm run check:deploy -- --url https://motion.domainlo.com   (also checks the public URL)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const envFile = process.env.MOTION_ENV_FILE ?? path.join(root, '.env.local');

const results = [];
const out = (level, what, detail = '') => {
  results.push(level);
  console.log(`${level.padEnd(4)} ${what}${detail ? ` — ${detail}` : ''}`);
};

export async function checkDeploy(env, publicUrl, fetchImpl = fetch) {
  const lines = [];
  const add = (level, what, detail = '') => lines.push({ level, what, detail });
  const googleVars = ['MOTION_GOOGLE_CLIENT_ID', 'MOTION_GOOGLE_CLIENT_SECRET', 'MOTION_ALLOWED_EMAILS'];
  const set = googleVars.filter((k) => (env[k] ?? '').trim());
  const pub = (env.MOTION_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const loopback = !pub || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(pub);

  // Workspace
  if (!env.MOTION_WORKSPACE) add('FAIL', 'MOTION_WORKSPACE belum diisi');
  else {
    try {
      const core = await import('../packages/core/dist/index.js');
      const ws = await core.openWorkspace(path.resolve(env.MOTION_WORKSPACE));
      add('OK', 'Workspace terbaca', `${ws.root} (backend ${ws.blobs.kind})`);
    } catch (e) {
      add('FAIL', 'Workspace tidak bisa dibuka', e instanceof Error ? e.message : String(e));
    }
  }

  // Login + public URL
  if (set.length && set.length < googleVars.length) add('FAIL', 'Login Google setengah terisi', `belum: ${googleVars.filter((k) => !set.includes(k)).join(', ')}`);
  if (!pub) add('WARN', 'MOTION_PUBLIC_URL kosong', 'app hanya bisa dibuka dari komputer ini (127.0.0.1)');
  else if (loopback) add('WARN', 'MOTION_PUBLIC_URL masih alamat lokal', pub);
  else if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(pub)) add('FAIL', 'MOTION_PUBLIC_URL harus https://domain tanpa path/port', pub);
  else add('OK', 'Alamat publik', pub);
  if (!loopback && set.length !== googleVars.length) add('FAIL', 'Alamat publik butuh login Google', 'isi MOTION_GOOGLE_CLIENT_ID, MOTION_GOOGLE_CLIENT_SECRET, MOTION_ALLOWED_EMAILS');
  if (set.length === googleVars.length) {
    const emails = env.MOTION_ALLOWED_EMAILS.split(/[,;\s]+/).filter(Boolean);
    add('OK', 'Login Google aktif', `${emails.length} email diizinkan`);
    add('INFO', 'Redirect URI yang wajib terdaftar di Google Cloud', `${pub && !loopback ? pub : `http://127.0.0.1:${env.MOTION_PORT ?? 4317}`}/api/auth/callback`);
  }
  if (!env.MOTION_PORT || env.MOTION_PORT === '0') add('WARN', 'MOTION_PORT tidak diisi', 'default 4317 — tunnel/proxy harus menunjuk port ini');
  if (env.MOTION_SECRET_KEY) add('OK', 'Kunci enkripsi dari MOTION_SECRET_KEY');
  else add('INFO', 'Kunci enkripsi API key AI', 'file secret.key di folder state (cadangkan bersama ai-providers.json)');

  // Tools
  try {
    const core = await import('../packages/core/dist/index.js');
    const t = await core.checkTools();
    if (t.ok) add('OK', 'FFmpeg siap untuk render', t.version ?? '');
    else add('FAIL', 'FFmpeg belum siap', t.problems.join(', '));
    add(core.findFont() ? 'OK' : 'WARN', 'Font teks/subtitle', core.findFont() ?? 'tidak ditemukan (set MOTION_FONT)');
  } catch {
    add('FAIL', 'Build belum ada', 'jalankan npm run build dulu');
  }
  if (!existsSync(path.join(root, 'apps/web/dist/index.html'))) add('FAIL', 'UI web belum dibuild', 'jalankan npm run build');

  // Public URL reachability (optional)
  if (publicUrl) {
    try {
      const h = await fetchImpl(`${publicUrl}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const body = await h.json().catch(() => null);
      if (h.status === 200 && body?.ok === true) add('OK', 'Alamat publik terhubung ke server', publicUrl);
      else add('FAIL', 'Alamat publik tidak menjawab health', `HTTP ${h.status}`);
      if (publicUrl.startsWith('https://')) add(h.headers.get('strict-transport-security') ? 'OK' : 'WARN', 'Header HSTS', h.headers.get('strict-transport-security') ?? 'tidak ada');
      const mode = await fetchImpl(`${publicUrl}/api/auth/mode`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null);
      if (mode?.mode === 'google') add('OK', 'Akses publik wajib login Google');
      else add('FAIL', 'Akses publik TIDAK memakai login Google', JSON.stringify(mode));
      const s = await fetchImpl(`${publicUrl}/api/session`, { headers: { 'x-motion-request': '1' }, signal: AbortSignal.timeout(15_000) });
      add(s.status === 401 ? 'OK' : 'FAIL', 'API menolak tanpa login', `HTTP ${s.status}`);
      if (publicUrl.startsWith('https://')) {
        const plain = await fetchImpl(publicUrl.replace(/^https:/, 'http:') + '/api/health', { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (plain) add(plain.status >= 300 && plain.status < 400 ? 'OK' : 'WARN', 'http:// dialihkan ke https://', `HTTP ${plain.status}`);
      }
    } catch (e) {
      add('FAIL', 'Alamat publik tidak bisa dihubungi', e instanceof Error ? e.message : String(e));
    }
  }
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = { ...process.env };
  if (existsSync(envFile)) {
    // Read the file into a copy: never print its values.
    const { parseEnv } = await import('node:util');
    Object.assign(env, parseEnv((await import('node:fs')).readFileSync(envFile, 'utf8')));
    out('OK', 'File pengaturan', envFile);
  } else out('WARN', 'File .env.local tidak ada', 'pakai environment variable saja');
  for (const l of await checkDeploy(env, urlArg)) out(l.level, l.what, l.detail);
  const fails = results.filter((r) => r === 'FAIL').length;
  console.log(`\n${fails ? `${fails} masalah harus dibereskan sebelum online.` : 'Siap dari sisi konfigurasi.'}`);
  process.exitCode = fails ? 1 : 0; // no process.exit(): lets open sockets close cleanly (libuv assert on Windows)
}
