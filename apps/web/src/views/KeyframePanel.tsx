import { useEffect, useRef, useState } from 'react';
import { type Keyframe, MAX_KEYFRAMES, keyframeAt } from '../../../../packages/core/dist/storage/keyframes.js';
import type { Clip, EditOp } from '../api';
import { parseDecimal } from '../lib';

const pct = (v: number) => String(Math.round(v * 100));

/**
 * Malam 15 Nov (fitur owner #13): keyframe posisi, skala, opacity untuk klip video, b-roll, teks.
 * Each change saves the whole list as one `set_keyframes` edit (= one undo step).
 */
export function KeyframePanel({ clip, playhead, submit }: { clip: Clip; playhead: number; submit: (ops: EditOp[]) => void }) {
  const kfs = clip.keyframes ?? [];
  const len = clip.end_ms - clip.start_ms;
  const rel = playhead - clip.start_ms;
  const inside = rel >= 0 && rel <= len;
  const save = (next: Keyframe[]) => submit([{ op: 'set_keyframes', clip_id: clip.clip_id, keyframes: [...next].sort((a, b) => a.at_ms - b.at_ms) }]);
  const add = () => {
    const at = Math.round(Math.max(0, Math.min(len, rel)));
    if (kfs.some((k) => k.at_ms === at)) return;
    save([...kfs, { at_ms: at, ...keyframeAt(kfs, at), ease: 'ease' }]);
  };
  const preset = (kind: 'kenburns' | 'fade' | 'masuk') => {
    if (kind === 'kenburns') save([{ at_ms: 0, x: 0, y: 0, scale: 1, opacity: 1, ease: 'linear' }, { at_ms: len, x: 0, y: 0, scale: 1.15, opacity: 1, ease: 'ease' }]);
    else if (kind === 'fade') {
      const d = Math.min(500, Math.floor(len / 3));
      save([{ at_ms: 0, x: 0, y: 0, scale: 1, opacity: 0, ease: 'linear' }, { at_ms: d, x: 0, y: 0, scale: 1, opacity: 1, ease: 'ease' }, { at_ms: len - d, x: 0, y: 0, scale: 1, opacity: 1, ease: 'linear' }, { at_ms: len, x: 0, y: 0, scale: 1, opacity: 0, ease: 'ease' }]);
    } else {
      const d = Math.min(600, Math.floor(len / 2));
      save([{ at_ms: 0, x: 0, y: 0.25, scale: 0.8, opacity: 0, ease: 'linear' }, { at_ms: d, x: 0, y: 0, scale: 1, opacity: 1, ease: 'ease' }]);
    }
  };
  return (
    <div className="kfPanel" role="group" aria-label="Keyframe">
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <b className="small">Keyframe (gerak)</b>
        <button className="btn small" disabled={!inside || kfs.length >= MAX_KEYFRAMES} onClick={add} title={inside ? 'Tambah titik di posisi playhead (nilai ikut gerakan saat ini)' : 'Geser playhead ke dalam klip ini dulu'}>
          ＋ Keyframe di playhead
        </button>
        <select aria-label="Gerak cepat" value="" onChange={(e) => e.target.value && preset(e.target.value as 'kenburns' | 'fade' | 'masuk')}>
          <option value="">Gerak cepat…</option>
          <option value="kenburns">Zoom pelan (Ken Burns)</option>
          <option value="fade">Muncul & hilang pelan</option>
          <option value="masuk">Masuk dari bawah</option>
        </select>
        {kfs.length > 0 && (
          <button className="btn small" onClick={() => save([])}>
            Hapus semua
          </button>
        )}
      </div>
      {kfs.length === 0 && <div className="muted small">Belum ada keyframe. Tambah titik di playhead, lalu atur posisi/skala/opasitasnya. Pratinjau dan render bergerak halus di antara titik.</div>}
      {kfs.map((k, i) => (
        <KfRow key={`${clip.clip_id}:${k.at_ms}:${i}`} k={k} index={i} len={len} onChange={(nk) => save(kfs.map((x, j) => (j === i ? nk : x)))} onDelete={() => save(kfs.filter((_, j) => j !== i))} />
      ))}
    </div>
  );
}

function KfRow({ k, index, len, onChange, onDelete }: { k: Keyframe; index: number; len: number; onChange: (k: Keyframe) => void; onDelete: () => void }) {
  const [v, setV] = useState({ at: (k.at_ms / 1000).toFixed(2), x: pct(k.x), y: pct(k.y), scale: pct(k.scale), opacity: pct(k.opacity) });
  /** What this row last sent: Enter then blur (clicking the ruler / Undo) before the saved keyframe
   *  came back used to send the same change twice — two undo steps (audit M15-K5). */
  const sent = useRef<string | null>(null);
  useEffect(() => {
    sent.current = null;
    setV({ at: (k.at_ms / 1000).toFixed(2), x: pct(k.x), y: pct(k.y), scale: pct(k.scale), opacity: pct(k.opacity) });
  }, [k.at_ms, k.x, k.y, k.scale, k.opacity]);
  const commit = () => {
    const num = (s: string, lo: number, hi: number, dflt: number) => {
      const n = parseDecimal(s);
      return n === null || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, n));
    };
    const next: Keyframe = {
      at_ms: Math.round(num(v.at, 0, len / 1000, k.at_ms / 1000) * 1000),
      x: num(v.x, -100, 100, k.x * 100) / 100,
      y: num(v.y, -100, 100, k.y * 100) / 100,
      scale: num(v.scale, 10, 400, k.scale * 100) / 100,
      opacity: num(v.opacity, 0, 100, k.opacity * 100) / 100,
      ease: k.ease,
    };
    const json = JSON.stringify(next);
    if (json === JSON.stringify(k) || json === sent.current) return;
    sent.current = json;
    onChange(next);
  };
  const field = (key: keyof typeof v, label: string, title: string) => (
    <label title={title}>
      {label}
      <input aria-label={`${label} keyframe ${index + 1}`} inputMode="decimal" value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())} />
    </label>
  );
  return (
    <div className="kfRow" data-kf={index}>
      {field('at', 'Detik', 'Waktu titik di dalam klip (detik dari awal klip)')}
      {field('x', 'X %', 'Geser kiri (−) / kanan (+), persen lebar canvas')}
      {field('y', 'Y %', 'Geser atas (−) / bawah (+), persen tinggi canvas')}
      {field('scale', 'Skala %', '100 = ukuran normal')}
      {field('opacity', 'Opasitas %', '0 = tak terlihat, 100 = penuh')}
      <label title="Cara bergerak dari titik sebelumnya ke titik ini">
        Gerak
        <select aria-label={`Easing keyframe ${index + 1}`} value={k.ease} onChange={(e) => onChange({ ...k, ease: e.target.value as Keyframe['ease'] })}>
          <option value="ease">Halus</option>
          <option value="linear">Rata</option>
        </select>
      </label>
      <button className="tiny" aria-label={`Hapus keyframe ${index + 1}`} onClick={onDelete}>
        ✕
      </button>
    </div>
  );
}
