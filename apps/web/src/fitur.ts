import type { ProjectFitur, ProjectSummary } from './api';

/** R22: feature names as the menu says them (chips and labels in Edit). */
export const FITUR_LABEL: Record<ProjectFitur, string> = { iklan: 'Video iklan', batch: 'Batch', beatspot: 'Beat Spot', transfer: 'Motion Transfer', editor: 'Edit' };
export const fiturOf = (p: ProjectSummary): ProjectFitur => p.fitur ?? 'editor';

/**
 * R22: the "Proyek" choices of a feature page — only that feature's own active, non-variant
 * projects of the chosen brand (a project without a brand uses the workspace default brand).
 * The project already selected stays listed so a running job never loses its row.
 */
export function proyekFitur(projects: ProjectSummary[], fitur: ProjectFitur, brandId: string, defaultBrandId: string | null, selected?: string): ProjectSummary[] {
  return projects.filter((p) => p.project_id === selected || (!p.error && p.status !== 'archived' && !p.variant && fiturOf(p) === fitur && (p.brand_id ?? defaultBrandId ?? '') === brandId));
}
