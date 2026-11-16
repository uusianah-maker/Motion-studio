import { useEffect, useRef, useState } from 'react';
import { EQ_KEYS, EQ_PRESETS, EQ_PRESET_IDS, EQ_RANGE, type Eq, FLAT_EQ, eqPresetOf } from '../../../../packages/core/dist/storage/clipAudio.js';
import { NATURAL_SPEED, SPEED_RANGE } from '../../../../packages/core/dist/storage/clipMotion.js';
import type { Clip, EditOp, Track } from '../api';
import { parseDecimal } from '../lib';

const EQ_LABEL: Record<keyof Eq, string> = { bass: 'Bass', mid: 'Mid', treble: 'Treble' };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const fmt = (n: number) => String(n).replace('.', ',');

/**
 * R23b (owner 16 Nov): EQ sederhana (preset + 3 slider), "Perjelas suara", dan kecepatan klip suara
 * (audio / musik / SFX). Preset hanya mengisi angka slider — tetap bisa digeser (hybrid). Slider
 * disimpan saat dilepas: satu geseran = satu undo.
 */
export function AudioFxPanel({ clip, kind, submit }: { clip: Clip; kind: Track['kind']; submit: (ops: EditOp[]) => void }) {
  const [eq, setEq] = useState<Eq>(clip.eq ?? FLAT_EQ);
  const eqRef = useRef(eq);
  useEffect(() => {
    setEq(clip.eq ?? FLAT_EQ);
    eqRef.current = clip.eq ?? FLAT_EQ;
  }, [clip.clip_id, JSON.stringify(clip.eq ?? null)]);
  // One save after the hand stops (0,45 s) or on release: a drag / arrow keys = one undo step.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(JSON.stringify(clip.eq ?? FLAT_EQ));
  saved.current = JSON.stringify(clip.eq ?? FLAT_EQ);
  const commitEq = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (JSON.stringify(eqRef.current) === saved.current) return;
    saved.current = JSON.stringify(eqRef.current);
    submit([{ op: 'set_audio', clip_id: clip.clip_id, eq: eqRef.current }]);
  };
  const commitRef = useRef(commitEq);
  commitRef.current = commitEq;
  useEffect(() => () => void (timer.current && commitRef.current()), []);
  const preset = eqPresetOf(clip.eq);
  const presetValue = !clip.eq ? 'datar' : (preset ?? 'sendiri');
  const sound = kind === 'audio' || kind === 'music' || kind === 'sfx';
  const speed = clip.speed ?? 1;
  const [speedText, setSpeedText] = useState(fmt(speed));
  useEffect(() => setSpeedText(fmt(clip.speed ?? 1)), [clip.clip_id, clip.speed]);
  const commitSpeed = (raw: string) => {
    const v = parseDecimal(raw);
    if (v === null || !Number.isFinite(v)) return setSpeedText(fmt(speed));
    const s = Math.round(Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], v)) * 100) / 100;
    setSpeedText(fmt(s));
    if (s !== speed) submit([{ op: 'set_motion', clip_id: clip.clip_id, speed: s }]);
  };

  return (
    <div className="inspGrid" role="group" aria-label="EQ dan suara">
      <label className="inline" title="Highpass + EQ suara + kompresor ringan + loudness. Terdengar di pratinjau dan render.">
        <input type="checkbox" aria-label="Perjelas suara" checked={!!clip.voice} onChange={(e) => submit([{ op: 'set_audio', clip_id: clip.clip_id, voice: e.target.checked }])} /> Perjelas suara
      </label>
      <label>
        EQ
        <select
          aria-label="Preset EQ"
          value={presetValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'sendiri') return;
            submit([{ op: 'set_audio', clip_id: clip.clip_id, eq: v === 'datar' ? null : { ...EQ_PRESETS[v as keyof typeof EQ_PRESETS].eq } }]);
          }}
        >
          <option value="datar">Datar</option>
          {EQ_PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {EQ_PRESETS[id].label}
            </option>
          ))}
          {presetValue === 'sendiri' && <option value="sendiri">Atur sendiri</option>}
        </select>
      </label>
      {EQ_KEYS.map((k) => (
        <label key={k}>
          {EQ_LABEL[k]} {eq[k] > 0 ? '+' : ''}
          {eq[k]} dB
          <input
            type="range"
            aria-label={`EQ ${EQ_LABEL[k]}`}
            min={EQ_RANGE[0]}
            max={EQ_RANGE[1]}
            value={eq[k]}
            onChange={(e) => {
              const next = { ...eqRef.current, [k]: Number(e.target.value) };
              eqRef.current = next;
              setEq(next);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => commitRef.current(), 450);
            }}
            onPointerUp={commitEq}
            onBlur={() => timer.current && commitEq()}
          />
        </label>
      ))}
      {sound && (
        <>
          <label>
            Kecepatan
            <span className="row" style={{ gap: 6 }}>
              <select aria-label="Pilihan kecepatan suara" value={SPEEDS.includes(speed) ? String(speed) : ''} onChange={(e) => e.target.value && commitSpeed(e.target.value)}>
                {!SPEEDS.includes(speed) && <option value="">{fmt(speed)}×</option>}
                {SPEEDS.map((s) => (
                  <option key={s} value={String(s)}>
                    {fmt(s)}×
                  </option>
                ))}
              </select>
              <input aria-label="Kecepatan suara (×)" inputMode="decimal" style={{ width: 64 }} value={speedText} onChange={(e) => setSpeedText(e.target.value)} onBlur={() => commitSpeed(speedText)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commitSpeed(speedText))} title={`${fmt(SPEED_RANGE[0])}×–${fmt(SPEED_RANGE[1])}×, nada tetap. Durasi klip ikut berubah.`} />
            </span>
          </label>
          {(speed < NATURAL_SPEED[0] || speed > NATURAL_SPEED[1]) && <p className="muted small">Kecepatan ekstrem: suara bisa terdengar aneh.</p>}
        </>
      )}
    </div>
  );
}
