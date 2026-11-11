import { TEXT_PRESETS, type TextPreset } from '../../../../packages/core/dist/storage/textPresets.js';
import type { EditOp, Project } from '../api';

/** First start ≥ `from` where a clip of `len` fits on `track` without overlapping. */
export function freeSlot(project: Project, track: 'text' | 'subtitle', from: number, len: number): number {
  const clips = (project.timeline.tracks.find((t) => t.kind === track)?.clips ?? []).slice().sort((a, b) => a.start_ms - b.start_ms);
  let start = Math.max(0, Math.round(from / 100) * 100);
  for (const c of clips) if (c.start_ms < start + len && start < c.end_ms) start = c.end_ms;
  return start;
}

export const presetOp = (p: TextPreset, project: Project, playhead: number): EditOp => ({
  op: 'add_clip',
  track_kind: p.track,
  text: p.text,
  style: { ...p.style },
  start_ms: freeSlot(project, p.track, playhead, p.duration_ms),
  duration_ms: p.duration_ms,
});

/**
 * Text preset library (X03, PRD §7 P0): one click adds the preset at the playhead (or the next
 * free spot on its track) with its look and sample copy; edit the words in the inspector.
 */
export function PresetPanel({ project, playhead, busy, onAdd }: { project: Project; playhead: number; busy: boolean; onAdd: (op: EditOp, label: string) => void }) {
  return (
    <section className="presets" aria-label="Preset teks">
      <div className="inspHead">
        <b>Preset teks</b>
        <span className="muted small">di playhead</span>
      </div>
      <div className="presetGrid">
        {TEXT_PRESETS.map((p) => (
          <button key={p.id} className="presetBtn" disabled={busy} title={p.hint} aria-label={`Tambah preset ${p.label}`} onClick={() => onAdd(presetOp(p, project, playhead), p.label)}>
            <span
              className="presetSwatch"
              style={{ color: p.style.color, background: p.style.bg ?? '#2a2f42', fontWeight: p.style.bold ? 800 : 400, textShadow: p.style.outline ? '0 1px 2px #000' : 'none' }}
              aria-hidden="true"
            >
              Aa
            </span>
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}
