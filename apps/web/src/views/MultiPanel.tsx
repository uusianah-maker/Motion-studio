import { useEffect, useRef, useState } from 'react';
import type { Clip, EditOp, Track } from '../api';
import { effectiveStyle } from '../../../../packages/core/dist/storage/textStyle.js';

type Picked = Clip & { kind: Track['kind'] };

/**
 * R33 (owner 16 Nov): several clips picked at once (Shift / Ctrl + klik, kotak pilih, Ctrl+A).
 * Everything here is ONE edit = one undo: hapus semua, geser bersama, ubah gaya bersama (teks).
 */
export function MultiPanel({ clips, busy, readOnly, onEdit, onClear }: { clips: Picked[]; busy: boolean; readOnly: boolean; onEdit: (ops: EditOp[]) => void; onClear: () => void }) {
  const ids = clips.map((c) => c.clip_id);
  const textOnly = clips.every((c) => c.kind === 'text' || c.kind === 'subtitle');
  const first = clips[0]!;
  const base = textOnly ? effectiveStyle(first.kind as 'text' | 'subtitle', first.style) : null;
  const [size, setSize] = useState(base?.size ?? 6);
  const [y, setY] = useState(Math.round((base?.y ?? 0.8) * 100));
  useEffect(() => {
    setSize(base?.size ?? 6);
    setY(Math.round((base?.y ?? 0.8) * 100));
  }, [ids.join(','), base?.size, base?.y]);
  const style = (s: Record<string, unknown>) => onEdit([{ op: 'set_style_many', clip_ids: ids, style: s }]);
  // Sliders save once the hand stops (one undo per drag).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = (s: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => style(s), 450);
  };
  const [shift, setShift] = useState('0,5');
  const shiftBy = (sign: 1 | -1) => {
    const v = Number(shift.replace(',', '.'));
    if (Number.isFinite(v) && v > 0) onEdit([{ op: 'shift_clips', clip_ids: ids, delta_ms: sign * Math.round(v * 1000) }]);
  };
  const kinds = [...new Set(clips.map((c) => c.kind))];

  return (
    <section className="inspector" aria-label="Pilihan beberapa klip">
      <fieldset className="plain" disabled={readOnly || busy}>
        <div className="inspHead">
          <b>{clips.length} klip dipilih</b>
          <span className="badge vio">{kinds.join(' + ')}</span>
          <button type="button" className="smallbtn inspDelete" onClick={onClear} title="Batal pilih (Esc)">
            ✕
          </button>
        </div>
        <p className="muted small">Shift+klik = rentang · Ctrl+klik = tambah/kurangi · seret kotak di lajur · Ctrl+A = semua di lajur. Del menghapus, ←/→ menggeser (Shift = 1 dtk).</p>
        <div className="inspGrid" role="group" aria-label="Aksi bersama">
          <button type="button" className="btn small" onClick={() => onEdit([{ op: 'delete_clips', clip_ids: ids }])}>
            🗑 Hapus {clips.length} klip
          </button>
          <label>
            Geser (dtk)
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="smallbtn" aria-label="Geser mundur" onClick={() => shiftBy(-1)}>
                ←
              </button>
              <input aria-label="Jarak geser (detik)" inputMode="decimal" style={{ width: 56 }} value={shift} onChange={(e) => setShift(e.target.value)} />
              <button type="button" className="smallbtn" aria-label="Geser maju" onClick={() => shiftBy(1)}>
                →
              </button>
            </span>
          </label>
        </div>
        {textOnly && base && (
          <div className="inspGrid" role="group" aria-label="Gaya bersama">
            <label>
              Font
              <select aria-label="Font bersama" defaultValue={base.font} onChange={(e) => style({ font: e.target.value })}>
                <option value="default">Bawaan</option>
                <option value="brand">Font brand</option>
                <option value="caption">Font caption brand</option>
              </select>
            </label>
            <label>
              Warna
              <input type="color" aria-label="Warna bersama" defaultValue={base.color} onChange={(e) => later({ color: e.target.value })} />
            </label>
            <label>
              Ukuran {size}
              <input type="range" aria-label="Ukuran bersama" min={2} max={20} step={0.5} value={size} onChange={(e) => (setSize(Number(e.target.value)), later({ size: Number(e.target.value) }))} />
            </label>
            <label>
              Posisi Y {y}%
              <input type="range" aria-label="Posisi Y bersama" min={0} max={100} value={y} onChange={(e) => (setY(Number(e.target.value)), later({ y: Number(e.target.value) / 100 }))} />
            </label>
            <label className="inline">
              <input type="checkbox" aria-label="Tebal bersama" defaultChecked={base.bold} onChange={(e) => style({ bold: e.target.checked })} /> Tebal
            </label>
          </div>
        )}
      </fieldset>
    </section>
  );
}
