/**
 * R22: which feature a project belongs to (Video iklan · Batch · Beat Spot · Motion Transfer ·
 * Edit). New projects carry `fitur` in project.json; old ones are only GUESSED when read (nothing
 * is written back): a variant follows its master, then the name the feature gave it ("Batch …",
 * "Footage …", "Beat Spot …", "Motion Transfer …", "Generate …"), then the newest engine job's
 * mode, then the engine origin mark; anything else is `editor`.
 */
import { type EngineMode, listEngineJobs } from './engine.js';
import { engineOrigin } from './learning.js';
import type { ProjectFitur, ProjectManifest } from './project.js';
import type { Workspace } from './workspace.js';

const BY_NAME: [RegExp, ProjectFitur][] = [
  [/^(batch|footage)\s/i, 'batch'],
  [/^beat\s*spot\b/i, 'beatspot'],
  [/^motion\s*transfer\b/i, 'transfer'],
  [/^generate\b/i, 'iklan'],
];
const BY_MODE: Partial<Record<EngineMode, ProjectFitur>> = { generate: 'iklan', batch: 'batch', pisah: 'batch', beatspot: 'beatspot', transfer: 'transfer' };

export interface FiturHints {
  /** The master's feature (variants only). */
  master?: ProjectFitur | null;
  /** Engine job modes, newest first. */
  modes?: EngineMode[];
  origin?: 'generate' | 'batch' | null;
}

export function guessFitur(m: Pick<ProjectManifest, 'name' | 'fitur'>, hints: FiturHints = {}): ProjectFitur {
  if (m.fitur) return m.fitur;
  if (hints.master) return hints.master;
  for (const [re, f] of BY_NAME) if (re.test(m.name)) return f;
  for (const mode of hints.modes ?? []) if (BY_MODE[mode]) return BY_MODE[mode]!;
  if (hints.origin === 'batch') return 'batch';
  if (hints.origin === 'generate') return 'iklan';
  return 'editor';
}

/**
 * Feature of each project in `manifests` (by project_id). Masters are resolved before their
 * variants; a variant whose master is not in the list is guessed on its own.
 */
export async function resolveFitur(ws: Workspace, manifests: ProjectManifest[]): Promise<Map<string, ProjectFitur>> {
  const out = new Map<string, ProjectFitur>();
  const one = async (m: ProjectManifest, master: ProjectFitur | null): Promise<ProjectFitur> => {
    if (m.fitur) return m.fitur;
    if (master) return master;
    const byName = guessFitur(m);
    if (byName !== 'editor') return byName;
    const modes = (await listEngineJobs(ws, m.project_id).catch(() => [])).map((j) => j.mode);
    const origin = modes.some((x) => BY_MODE[x]) ? null : ((await engineOrigin(ws, m.project_id))?.kind ?? null);
    return guessFitur(m, { modes, origin });
  };
  for (const m of manifests) if (!m.variant) out.set(m.project_id, await one(m, null));
  for (const m of manifests) if (m.variant) out.set(m.project_id, await one(m, out.get(m.variant.master_id) ?? null));
  return out;
}
