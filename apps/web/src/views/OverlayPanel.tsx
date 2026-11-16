import { useEffect, useRef, useState } from 'react';
import { OVERLAY_POS, OVERLAY_POS_LABEL, type Overlay } from '../../../../packages/core/dist/storage/overlay.js';
import type { Clip, EditOp } from '../api';

/**
 * R26: Inspector section of an overlay clip. Sliders show live in the preview (draft) and are saved
 * once on release — one change = one undo. Presets, whole-video and layer buttons save at once.
 */
export function OverlayPanel({ clip, submit, onDraft }: { clip: Clip; submit: (ops: EditOp[]) => void; onDraft?: (d: { clip_id: string; overlay: Overlay } | null) => void }) {
  const o = clip.overlay!;
  const [draft, setDraft] = useState<Overlay | null>(null);
  const cur = draft ?? o;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => onDraft?.(draft ? { clip_id: clip.clip_id, overlay: draft } : null), [draft, clip.clip_id, onDraft]);
  useEffect(() => () => onDraft?.(null), [onDraft]);
  const save = (patch: Partial<Omit<Overlay, 'sepanjang'>> & { sepanjang?: boolean }) => submit([{ op: 'set_overlay', clip_id: clip.clip_id, overlay: patch }]);
  const commit = () => {
    const d = draftRef.current;
    if (!d) return;
    const patch: Partial<Overlay> = {};
    for (const k of ['skala', 'opasitas', 'margin', 'dx', 'dy'] as const) if (d[k] !== o[k]) patch[k] = d[k];
    setDraft(null);
    if (Object.keys(patch).length) save(patch);
  };
  const slide = (k: 'skala' | 'opasitas' | 'margin', v: number) => setDraft({ ...cur, [k]: v });
  const sliderEnd = { onPointerUp: commit, onKeyUp: commit, onBlur: commit };
  return (
    <div className="inspGrid" role="group" aria-label="Overlay">
      <label>
        Posisi
        <select aria-label="Posisi overlay" value={o.pos} onChange={(e) => save({ pos: e.target.value as Overlay['pos'], dx: 0, dy: 0 })}>
          {OVERLAY_POS.map((p) => (
            <option key={p} value={p}>
              {OVERLAY_POS_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <span className="row" style={{ gap: 6, alignItems: 'end', flexWrap: 'wrap' }}>
        <span className="muted small">Geser: seret gambarnya di pratinjau</span>
        {(o.dx !== 0 || o.dy !== 0) && (
          <button className="btn small" aria-label="Reset geser overlay" onClick={() => save({ dx: 0, dy: 0 })}>
            Reset geser
          </button>
        )}
      </span>
      <label>
        Ukuran {cur.skala}%
        <input type="range" aria-label="Ukuran overlay" min={2} max={100} value={cur.skala} onChange={(e) => slide('skala', Number(e.target.value))} {...sliderEnd} />
      </label>
      <label>
        Opasitas {Math.round(cur.opasitas * 100)}%
        <input type="range" aria-label="Opasitas overlay" min={5} max={100} value={Math.round(cur.opasitas * 100)} onChange={(e) => slide('opasitas', Number(e.target.value) / 100)} {...sliderEnd} />
      </label>
      <label>
        Jarak tepi {cur.margin}%
        <input type="range" aria-label="Jarak tepi overlay" min={0} max={20} value={cur.margin} disabled={o.pos === 'c'} onChange={(e) => slide('margin', Number(e.target.value))} {...sliderEnd} />
      </label>
      <label>
        Durasi
        <select aria-label="Durasi overlay" value={o.sepanjang ? 'semua' : 'klip'} onChange={(e) => save({ sepanjang: e.target.value === 'semua' })}>
          <option value="semua">Sepanjang video</option>
          <option value="klip">Detik tertentu (panjang klip)</option>
        </select>
      </label>
      <span className="row inspFull" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Urutan lapisan">
        <span className="muted small">Lapisan {o.layer}</span>
        {(
          [
            ['depan', '⤒ Paling depan'],
            ['maju', '↑ Maju'],
            ['mundur', '↓ Mundur'],
            ['belakang', '⤓ Paling belakang'],
          ] as const
        ).map(([to, label]) => (
          <button key={to} className="btn small" aria-label={`Overlay ${label.replace(/^\S+\s/, '').toLowerCase()}`} onClick={() => submit([{ op: 'set_overlay_layer', clip_id: clip.clip_id, to }])}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}
