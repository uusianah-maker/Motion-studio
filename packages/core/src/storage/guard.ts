import { audit } from './audit.js';
import { type Actor, type Operation, assertAllowed, isAllowed } from './permissions.js';
import type { Workspace } from './workspace.js';

/**
 * Permission check that audits every refused attempt (GC-12: AI attempts must be traceable),
 * then throws FORBIDDEN. Use this instead of bare `assertAllowed` in operations.
 */
export async function guard(ws: Workspace, actor: Actor, op: Operation, details: Record<string, unknown> = {}): Promise<void> {
  if (!isAllowed(actor, op)) {
    await audit(ws, { op: `denied.${op}`, actor: typeof actor === 'string' ? actor : 'system', outcome: 'blocked', reason: 'FORBIDDEN', ...details });
  }
  assertAllowed(actor, op);
}
