import type { SessionUser } from './auth.js';
import { parseAllowlist } from './auth.js';

/**
 * U7 roles (was X10), enforced HERE on every request — the UI only hides what a role cannot do.
 *  - owner:    everything, incl. Brand Kit, AI providers & budget, permanent delete.
 *  - editor:   edit projects, upload, render, run the engine, comment. Cannot approve.
 *  - reviewer: read everything, comment, approve / ask for revision. Cannot edit or render.
 * Local URL-token mode (one person on this PC) is always the owner. With Google login and no role
 * lists configured every allowed account stays owner (behaviour before U7); once any list is set,
 * an allowed account that is in none of them is a reviewer (least privilege).
 */
export type Role = 'owner' | 'editor' | 'reviewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'reviewer'];
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Editor', reviewer: 'Reviewer' };

const ALL: readonly Role[] = ROLES;
const EDIT: readonly Role[] = ['owner', 'editor'];
const APPROVE: readonly Role[] = ['owner', 'reviewer'];
const OWNER: readonly Role[] = ['owner'];

/** First match wins; `path` is the route TEMPLATE (with `:params`), never the raw URL. */
const RULES: { method: RegExp; path: RegExp; roles: readonly Role[] }[] = [
  // AI spending and prompts are the owner's (the editor's Copilot only needs the mode in /providers).
  { method: /./, path: /^\/api\/ai\/(usage|log)$/, roles: OWNER },
  // R12a: AI gambar settings (provider, key hint, budget) are the owner's, reading them too.
  { method: /./, path: /^\/api\/ai\/gambar(\/|$)/, roles: OWNER },
  // Halaman Tim: who may sign in, and with which role, is the owner's (reading it too).
  { method: /./, path: /^\/api\/team(\/|$)/, roles: OWNER },
  { method: /^(GET|HEAD)$/, path: /./, roles: ALL },
  { method: /./, path: /^\/api\/auth\/logout$/, roles: ALL },
  // Owner-only administration.
  { method: /./, path: /^\/api\/brands?(\/|$)/, roles: OWNER },
  { method: /./, path: /^\/api\/ai\//, roles: OWNER },
  { method: /./, path: /^\/api\/purge\//, roles: OWNER },
  // Footage backup folders: adding one and verifying it (hashing, read-only) are the owner's.
  { method: /./, path: /^\/api\/backup(\/|$)/, roles: OWNER },
  // Review: comments by anyone, decisions by approvers.
  { method: /./, path: /^\/api\/projects\/:project_id\/comments(\/|$)/, roles: ALL },
  { method: /./, path: /^\/api\/projects\/:project_id\/review$/, roles: APPROVE },
  { method: /./, path: /^\/api\/projects\/:project_id\/variant-approval$/, roles: APPROVE },
  { method: /./, path: /^\/api\/projects\/:project_id\/engine\/jobs\/:job_id\/batch\/decide$/, roles: APPROVE },
  // Everything else that changes something: editors and the owner.
  { method: /./, path: /./, roles: EDIT },
];

export function allowedRoles(method: string, routePath: string): readonly Role[] {
  return RULES.find((r) => r.method.test(method) && r.path.test(routePath))!.roles;
}

export interface RoleLists {
  owner: string[];
  editor: string[];
  reviewer: string[];
}

/** Read MOTION_OWNER_EMAILS / MOTION_EDITOR_EMAILS / MOTION_REVIEWER_EMAILS (Google mode only). */
export function parseRoleLists(env: NodeJS.ProcessEnv, allowed: string[]): RoleLists | null {
  const lists: RoleLists = {
    owner: env.MOTION_OWNER_EMAILS?.trim() ? parseAllowlist(env.MOTION_OWNER_EMAILS) : [],
    editor: env.MOTION_EDITOR_EMAILS?.trim() ? parseAllowlist(env.MOTION_EDITOR_EMAILS) : [],
    reviewer: env.MOTION_REVIEWER_EMAILS?.trim() ? parseAllowlist(env.MOTION_REVIEWER_EMAILS) : [],
  };
  const all = [...lists.owner, ...lists.editor, ...lists.reviewer];
  if (!all.length) return null;
  const allow = new Set(allowed.map((e) => e.toLowerCase()));
  const outside = all.filter((e) => !allow.has(e));
  if (outside.length) throw new Error(`Email peran harus ada di MOTION_ALLOWED_EMAILS: ${outside.join(', ')}`);
  const dup = all.filter((e, i) => all.indexOf(e) !== i);
  if (dup.length) throw new Error(`Satu email hanya boleh satu peran: ${[...new Set(dup)].join(', ')}`);
  if (!lists.owner.length) throw new Error('MOTION_OWNER_EMAILS wajib diisi bila peran dipakai (minimal satu owner)');
  return lists;
}

export function roleResolver(lists: RoleLists | null): (user: SessionUser | null) => Role {
  return (user) => {
    if (!user || !lists) return 'owner';
    const e = user.email.toLowerCase();
    if (lists.owner.includes(e)) return 'owner';
    if (lists.editor.includes(e)) return 'editor';
    return 'reviewer';
  };
}

/** Halaman Tim: role from the CURRENT team list (re-read on every request). Not listed = reviewer. */
export function teamRoleResolver(roleOf: (email: string) => Role | null): (user: SessionUser | null) => Role {
  return (user) => (user ? (roleOf(user.email) ?? 'reviewer') : 'owner');
}
