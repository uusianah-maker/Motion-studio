import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Route } from './app.js';
import { EMAIL_RE } from './auth.js';
import { type Workspace, audit } from './core.js';
import { ApiError } from './errors.js';
import { readJsonBody } from './http.js';
import { ROLES, type Role, type RoleLists } from './roles.js';
import { onlyKeys } from './routes.js';

/**
 * Halaman Tim: who may sign in with Google, and with which role, managed from the web by the owner.
 *  - Accounts from the env (MOTION_ALLOWED_EMAILS + role lists) always apply and are locked here:
 *    they change only in `.env.local`. So the owner in the env can never be locked out from the web.
 *  - Accounts added on the web live in `<state dir>/team.json` (never in the workspace or in git).
 *  - Login, every request (session check) and the role all read the CURRENT list: a removed
 *    email's session stops working on its next request, a new role applies at once.
 *  - There is always at least one owner: the last owner cannot be removed or demoted.
 */

export const TEAM_FILE = 'team.json';
export const MAX_TEAM = 200;

export type TeamSource = 'env' | 'web';
export interface TeamMember {
  email: string;
  role: Role;
  source: TeamSource;
  added_at: number | null;
  added_by: string | null;
}
interface FileShape {
  version: 1;
  members: { email: string; role: Role; added_at: number; added_by: string | null }[];
}

/** Env accounts: role from the lists; with no lists every allowed account is owner (before U7). */
export function envMembers(allowed: string[], lists: RoleLists | null): TeamMember[] {
  return allowed.map((raw) => {
    const email = raw.toLowerCase();
    const role: Role = !lists ? 'owner' : lists.owner.includes(email) ? 'owner' : lists.editor.includes(email) ? 'editor' : 'reviewer';
    return { email, role, source: 'env', added_at: null, added_by: null };
  });
}

const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);

function cleanEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'Email wajib diisi');
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError(400, 'BAD_REQUEST', 'Alamat email tidak valid');
  return email;
}
function cleanRole(raw: unknown): Role {
  if (!isRole(raw)) throw new ApiError(400, 'BAD_REQUEST', 'Peran harus owner, editor, atau reviewer');
  return raw;
}

export async function openTeamStore(o: { stateDir: string; env: TeamMember[]; now?: () => number }) {
  const file = path.join(o.stateDir, TEAM_FILE);
  const now = o.now ?? Date.now;
  const env = new Map(o.env.map((m) => [m.email, m]));
  let web: FileShape['members'] = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<FileShape>;
    if (parsed.version !== 1 || !Array.isArray(parsed.members)) throw new Error('bentuk');
    for (const m of parsed.members) {
      if (!m || typeof m.email !== 'string' || !EMAIL_RE.test(m.email) || !isRole(m.role)) throw new Error('anggota');
    }
    // An email that is (now) in the env is governed by the env.
    web = parsed.members.map((m) => ({ email: m.email.toLowerCase(), role: m.role, added_at: typeof m.added_at === 'number' ? m.added_at : 0, added_by: typeof m.added_by === 'string' ? m.added_by : null })).filter((m, i, all) => !env.has(m.email) && all.findIndex((x) => x.email === m.email) === i);
  } catch (e) {
    // Fail closed: a damaged list must not silently drop (or add) people.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Daftar tim tidak bisa dibuka (${file}): file rusak. Perbaiki atau hapus file itu.`);
  }

  const index = () => new Map<string, TeamMember>([...web.map((m) => [m.email, { ...m, source: 'web' as const }] as const), ...env]);
  let current = index();

  let writing: Promise<void> = Promise.resolve();
  async function save(next: FileShape['members']): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, members: next } satisfies FileShape, null, 2);
    const run = writing.then(async () => {
      await fsp.mkdir(o.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    writing = run.catch(() => undefined);
    await run;
    web = next;
    current = index();
  }

  // One change at a time (the last-owner check must see the list it changes).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => undefined);
    return p;
  };

  const owners = (list: Iterable<TeamMember>) => [...list].filter((m) => m.role === 'owner').length;

  function editable(email: string, by: string | null): FileShape['members'][number] {
    const m = current.get(email);
    if (!m) throw new ApiError(404, 'NOT_FOUND', 'Email ini tidak ada di daftar tim');
    if (m.source === 'env') throw new ApiError(409, 'MANAGED_BY_ENV', 'Email ini diatur di .env.local di komputer server, jadi tidak bisa diubah dari web');
    if (by && by === email) throw new ApiError(409, 'SELF_CHANGE', 'Tidak bisa mengubah atau menghapus akun sendiri. Minta owner lain melakukannya.');
    return web.find((w) => w.email === email)!;
  }

  return {
    file,
    /** Sorted: owners first, then editors, reviewers; env accounts before web ones. */
    list(): TeamMember[] {
      const order = (m: TeamMember) => ROLES.indexOf(m.role) * 2 + (m.source === 'env' ? 0 : 1);
      return [...current.values()].sort((a, b) => order(a) - order(b) || a.email.localeCompare(b.email));
    },
    isAllowed: (email: string) => current.has(email.toLowerCase()),
    roleOf: (email: string): Role | null => current.get(email.toLowerCase())?.role ?? null,
    size: () => current.size,
    add(input: { email: unknown; role: unknown }, by: string | null) {
      return serial(async () => {
        const email = cleanEmail(input.email);
        const role = cleanRole(input.role);
        if (current.has(email)) throw new ApiError(409, 'ALREADY_MEMBER', 'Email ini sudah ada di daftar tim');
        if (current.size >= MAX_TEAM) throw new ApiError(409, 'TEAM_FULL', `Daftar tim sudah penuh (maks ${MAX_TEAM} email)`);
        await save([...web, { email, role, added_at: now(), added_by: by }]);
        return current.get(email)!;
      });
    },
    setRole(input: { email: unknown; role: unknown }, by: string | null) {
      return serial(async () => {
        const email = cleanEmail(input.email);
        const role = cleanRole(input.role);
        const m = editable(email, by);
        if (m.role === role) return current.get(email)!;
        const after = [...current.values()].map((x) => (x.email === email ? { ...x, role } : x));
        if (!owners(after)) throw new ApiError(409, 'LAST_OWNER', 'Owner terakhir tidak bisa diturunkan perannya. Tambahkan owner lain dulu.');
        await save(web.map((w) => (w.email === email ? { ...w, role } : w)));
        return current.get(email)!;
      });
    },
    remove(input: { email: unknown }, by: string | null) {
      return serial(async () => {
        const email = cleanEmail(input.email);
        editable(email, by);
        if (!owners([...current.values()].filter((x) => x.email !== email))) throw new ApiError(409, 'LAST_OWNER', 'Owner terakhir tidak bisa dihapus. Tambahkan owner lain dulu.');
        await save(web.filter((w) => w.email !== email));
        return { email };
      });
    },
  };
}
export type TeamStore = Awaited<ReturnType<typeof openTeamStore>>;

/** Owner-only (roles.ts rule for /api/team). `onRemoved` ends that email's sessions right away. */
export function teamRoutes(ws: Workspace, team: TeamStore, opts: { onRemoved?: (email: string) => void } = {}): Route[] {
  const log = (op: string, entry: Record<string, unknown>) => audit(ws, { op, actor: 'user', outcome: 'ok', ...entry }).catch(() => undefined);
  return [
    {
      method: 'GET',
      path: '/api/team',
      handle: async ({ user }) => ({ members: team.list(), me: user?.email ?? null, max: MAX_TEAM }),
    },
    {
      method: 'POST',
      path: '/api/team',
      handle: async ({ req, user }) => {
        const body = await readJsonBody(req, 4096);
        onlyKeys(body, ['email', 'role']);
        const member = await team.add({ email: body.email, role: body.role }, user?.email ?? null);
        await log('team.add', { email: member.email, role: member.role, by: user?.email ?? null });
        return { member, members: team.list() };
      },
    },
    {
      method: 'PUT',
      path: '/api/team',
      handle: async ({ req, user }) => {
        const body = await readJsonBody(req, 4096);
        onlyKeys(body, ['email', 'role']);
        const member = await team.setRole({ email: body.email, role: body.role }, user?.email ?? null);
        await log('team.role', { email: member.email, role: member.role, by: user?.email ?? null });
        return { member, members: team.list() };
      },
    },
    {
      method: 'DELETE',
      path: '/api/team',
      handle: async ({ req, user }) => {
        const body = await readJsonBody(req, 4096);
        onlyKeys(body, ['email']);
        const { email } = await team.remove({ email: body.email }, user?.email ?? null);
        opts.onRemoved?.(email);
        await log('team.remove', { email, by: user?.email ?? null });
        return { removed: email, members: team.list() };
      },
    },
  ];
}
