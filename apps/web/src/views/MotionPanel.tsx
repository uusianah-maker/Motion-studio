import { useEffect, useState } from 'react';
import { FREEZE_MS, MAX_REVERSE_MS, NATURAL_SPEED, SPEED_RANGE, sourceLength } from '../../../../packages/core/dist/storage/clipMotion.js';
import type { Clip, EditOp } from '../api';
import { parseDecimal } from '../lib';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5];
const fmt = (n: number) => String(n).replace('.', ',');

/**
 * R23a (owner 16 Nov, alat edit gaya CapCut): arah, kecepatan, mundur, bekukan frame dan reduksi
 * noise gambar untuk klip video/b-roll yang dipilih. Setiap perubahan = satu edit = satu undo.
 */
export function MotionPanel({ clip, playhead, submit }: { clip: Clip; playhead: number; submit: (ops: EditOp[]) => void }) {
  const speed = clip.speed ?? 1;
  const [speedText, setSpeedText] = useState(fmt(speed));
  useEffect(() => setSpeedText(fmt(clip.speed ?? 1)), [clip.clip_id, clip.speed]);
  const [freezeSec, setFreezeSec] = useState('2');
  const set = (patch: Omit<Extract<EditOp, { op: 'set_motion' }>, 'op' | 'clip_id'>) => submit([{ op: 'set_motion', clip_id: clip.clip_id, ...patch }]);
  const commitSpeed = (raw: string) => {
    const v = parseDecimal(raw);
    if (v === null || !Number.isFinite(v)) return setSpeedText(fmt(speed));
    const s = Math.round(Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], v)) * 100) / 100;
    setSpeedText(fmt(s));
    if (s !== speed) set({ speed: s });
  };
  const extreme = speed < NATURAL_SPEED[0] || speed > NATURAL_SPEED[1];
  const reverseTooLong = !clip.reverse && sourceLength(clip) > MAX_REVERSE_MS;
  const inClip = playhead >= clip.start_ms && playhead < clip.end_ms;
  const freezeMs = (() => {
    const v = parseDecimal(freezeSec);
    return v === null ? null : Math.round(v * 1000);
  })();
  const freezeOk = freezeMs !== null && freezeMs >= FREEZE_MS[0] && freezeMs <= FREEZE_MS[1];

  return (
    <div className="inspGrid" role="group" aria-label="Arah dan kecepatan">
      <label>
        Putar
        <select aria-label="Putar gambar" value={clip.rotate ?? 0} onChange={(e) => set({ rotate: Number(e.target.value) as 0 | 90 | 180 | 270 })}>
          <option value={0}>Tidak</option>
          <option value={90}>90° kanan</option>
          <option value={180}>180°</option>
          <option value={270}>90° kiri</option>
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" aria-label="Balik kiri-kanan" checked={!!clip.flip_h} onChange={(e) => set({ flip_h: e.target.checked })} /> Balik kiri-kanan
      </label>
      <label className="inline">
        <input type="checkbox" aria-label="Balik atas-bawah" checked={!!clip.flip_v} onChange={(e) => set({ flip_v: e.target.checked })} /> Balik atas-bawah
      </label>
      {clip.freeze ? (
        <p className="muted small">Potongan diam (frame dibekukan): tanpa suara, tanpa kecepatan.</p>
      ) : (
        <>
          <label>
            Kecepatan
            <span className="row" style={{ gap: 6 }}>
              <select aria-label="Pilihan kecepatan" value={SPEEDS.includes(speed) ? String(speed) : ''} onChange={(e) => e.target.value && commitSpeed(e.target.value)}>
                {!SPEEDS.includes(speed) && <option value="">{fmt(speed)}×</option>}
                {SPEEDS.map((s) => (
                  <option key={s} value={String(s)}>
                    {fmt(s)}×
                  </option>
                ))}
              </select>
              <input aria-label="Kecepatan (×)" inputMode="decimal" style={{ width: 64 }} value={speedText} onChange={(e) => setSpeedText(e.target.value)} onBlur={() => commitSpeed(speedText)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commitSpeed(speedText))} title={`${fmt(SPEED_RANGE[0])}×–${fmt(SPEED_RANGE[1])}×. Durasi klip ikut berubah; klip sesudahnya di lajur ini ikut bergeser.`} />
            </span>
          </label>
          {(extreme || clip.volume === 0) && (
            <label className="inline" title="Suara pada kecepatan ekstrem terdengar aneh">
              <input type="checkbox" aria-label="Tanpa suara" checked={clip.volume === 0} onChange={(e) => submit([{ op: 'set_volume', clip_id: clip.clip_id, volume: e.target.checked ? 0 : 1 }])} /> Tanpa suara
            </label>
          )}
          <label className="inline" title={reverseTooLong ? `Mundur maksimal ${MAX_REVERSE_MS / 1000} detik sumber; potong klipnya dulu.` : 'Gambar dan suara diputar mundur. Di pratinjau suaranya diam; suara mundur terdengar di hasil render.'}>
            <input type="checkbox" aria-label="Putar mundur" checked={!!clip.reverse} disabled={reverseTooLong} onChange={(e) => set({ reverse: e.target.checked })} /> Mundur
            {reverseTooLong && <span className="muted small"> (maks {MAX_REVERSE_MS / 1000} dtk sumber)</span>}
          </label>
        </>
      )}
      <label>
        Noise gambar
        <select aria-label="Reduksi noise gambar" value={clip.vdenoise ?? 'off'} onChange={(e) => set({ vdenoise: e.target.value as 'off' | 'ringan' | 'sedang' })} title="Menghaluskan bintik/grain gambar. Terlihat di hasil render (pratinjau memakai gambar asli).">
          <option value="off">Mati</option>
          <option value="ringan">Ringan</option>
          <option value="sedang">Sedang</option>
        </select>
      </label>
      <label>
        Bekukan (dtk)
        <span className="row" style={{ gap: 6 }}>
          <input aria-label="Lama bekukan (detik)" inputMode="decimal" style={{ width: 56 }} value={freezeSec} onChange={(e) => setFreezeSec(e.target.value)} />
          <button
            type="button"
            className="smallbtn"
            disabled={!inClip || !freezeOk}
            title={!inClip ? 'Taruh playhead di dalam klip ini dulu' : !freezeOk ? `Lama ${FREEZE_MS[0] / 1000}–${FREEZE_MS[1] / 1000} detik` : 'Sisipkan potongan diam dari frame di playhead; klip sesudahnya bergeser.'}
            onClick={() => freezeMs !== null && submit([{ op: 'freeze_frame', clip_id: clip.clip_id, at_ms: playhead, duration_ms: freezeMs }])}
          >
            Bekukan frame di playhead
          </button>
        </span>
      </label>
    </div>
  );
}
