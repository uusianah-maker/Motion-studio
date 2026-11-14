import { useEffect, useRef, useState } from 'react';
import { ADJUST_KEYS, ADJUST_RANGE, type Adjust, DEFAULT_DUCK, LOOKS, LOOK_IDS, NO_ADJUST, TRANSITIONS, TRANSITION_LABEL, TRANSITION_MS, type TransitionType } from '../../../../packages/core/dist/storage/clipLook.js';
import type { Clip, EditOp, Track } from '../api';
import { parseDecimal } from '../lib';

const ADJUST_LABEL: Record<keyof Adjust, string> = { terang: 'Terang', kontras: 'Kontras', saturasi: 'Saturasi', suhu: 'Suhu warna', tajam: 'Ketajaman', vignette: 'Vignette' };
const sec = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(1);

/**
 * Malam 15 Nov (fitur pilihan owner dari audit CapCut): suara (fade, reduksi noise, ducking musik),
 * gambar (tampilan di canvas, filter warna, adjust) dan transisi masuk untuk klip yang dipilih.
 * Every change is one edit = one undo step (sliders save when released).
 */
export function ClipLookPanel({ clip, kind, submit, duck, brandLook }: { clip: Clip; kind: Track['kind']; submit: (ops: EditOp[]) => void; duck: number | undefined; brandLook: string | null }) {
  const visual = kind === 'video' || kind === 'broll';
  const [fin, setFin] = useState(sec(clip.fade_in_ms));
  const [fout, setFout] = useState(sec(clip.fade_out_ms));
  useEffect(() => {
    setFin(sec(clip.fade_in_ms));
    setFout(sec(clip.fade_out_ms));
  }, [clip.clip_id, clip.fade_in_ms, clip.fade_out_ms]);
  const [adj, setAdj] = useState<Adjust>(clip.adjust ?? NO_ADJUST);
  const adjRef = useRef(adj);
  useEffect(() => {
    setAdj(clip.adjust ?? NO_ADJUST);
    adjRef.current = clip.adjust ?? NO_ADJUST;
  }, [clip.clip_id, JSON.stringify(clip.adjust ?? null)]);
  // One edit after the hand stops (0,45 s) or on release: dragging/arrow keys = one undo step.
  const adjTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(JSON.stringify(clip.adjust ?? NO_ADJUST));
  saved.current = JSON.stringify(clip.adjust ?? NO_ADJUST);
  const commitAdjust = () => {
    if (adjTimer.current) clearTimeout(adjTimer.current);
    adjTimer.current = null;
    if (JSON.stringify(adjRef.current) === saved.current) return;
    saved.current = JSON.stringify(adjRef.current);
    submit([{ op: 'set_picture', clip_id: clip.clip_id, adjust: adjRef.current }]);
  };
  const commitRef = useRef(commitAdjust);
  commitRef.current = commitAdjust;
  // A change still waiting when the clip is let go is saved, not dropped.
  useEffect(() => () => void (adjTimer.current && commitRef.current()), []);
  const [duckPct, setDuckPct] = useState(Math.round((duck ?? DEFAULT_DUCK) * 100));
  useEffect(() => setDuckPct(Math.round((duck ?? DEFAULT_DUCK) * 100)), [duck]);
  const [transMs, setTransMs] = useState(String(clip.transition?.ms ?? 500));
  useEffect(() => setTransMs(String(clip.transition?.ms ?? 500)), [clip.clip_id, clip.transition?.ms]);

  const commitFade = () => {
    const len = clip.end_ms - clip.start_ms;
    const toMs = (s: string) => {
      const v = parseDecimal(s);
      return v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(10_000, Math.round(v * 1000)));
    };
    const a = toMs(fin);
    const b = toMs(fout);
    const op: EditOp = { op: 'set_audio', clip_id: clip.clip_id };
    if (a !== null && a !== (clip.fade_in_ms ?? 0)) op.fade_in_ms = Math.min(a, len);
    if (b !== null && b !== (clip.fade_out_ms ?? 0)) op.fade_out_ms = Math.min(b, len);
    if (op.fade_in_ms !== undefined || op.fade_out_ms !== undefined) submit([op]);
    else {
      setFin(sec(clip.fade_in_ms));
      setFout(sec(clip.fade_out_ms));
    }
  };
  const enter = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  };
  const fitValue = clip.fit === 'isi' ? 'isi' : clip.fit === 'blur' ? 'blur' : clip.fit === 'warna' && clip.fit_color ? 'warna' : 'hitam';
  const commitTransMs = () => {
    if (!clip.transition) return;
    const v = Math.round(Number(transMs));
    const ms = Number.isFinite(v) ? Math.max(TRANSITION_MS[0], Math.min(TRANSITION_MS[1], v)) : clip.transition.ms;
    if (ms !== clip.transition.ms) submit([{ op: 'set_picture', clip_id: clip.clip_id, transition: { ...clip.transition, ms } }]);
    else setTransMs(String(clip.transition.ms));
  };

  return (
    <>
      <div className="inspGrid" role="group" aria-label="Suara klip">
        <label>
          Fade masuk (dtk)
          <input aria-label="Fade masuk (detik)" inputMode="decimal" value={fin} onChange={(e) => setFin(e.target.value)} onBlur={commitFade} onKeyDown={(e) => enter(e, commitFade)} />
        </label>
        <label>
          Fade keluar (dtk)
          <input aria-label="Fade keluar (detik)" inputMode="decimal" value={fout} onChange={(e) => setFout(e.target.value)} onBlur={commitFade} onKeyDown={(e) => enter(e, commitFade)} />
        </label>
        <label>
          Reduksi noise
          <select aria-label="Reduksi noise" value={clip.denoise ?? 'off'} onChange={(e) => submit([{ op: 'set_audio', clip_id: clip.clip_id, denoise: e.target.value as 'off' | 'ringan' | 'sedang' }])} title="Mengurangi desis/dengung latar suara bicara. Terdengar di hasil render (pratinjau memutar suara asli).">
            <option value="off">Mati</option>
            <option value="ringan">Ringan</option>
            <option value="sedang">Sedang</option>
          </select>
        </label>
      </div>
      {kind === 'music' && (
        <div className="inspGrid" role="group" aria-label="Ducking musik">
          <label className="inline">
            <input type="checkbox" aria-label="Ducking musik" checked={duck !== undefined} onChange={(e) => submit([{ op: 'set_ducking', on: e.target.checked, ...(e.target.checked ? { level: duckPct / 100 } : {}) }])} /> Ducking: musik turun saat ada suara bicara
          </label>
          {duck !== undefined && (
            <label>
              Musik saat bicara {duckPct}%
              <input type="range" aria-label="Level musik saat bicara" min={10} max={80} value={duckPct} onChange={(e) => setDuckPct(Number(e.target.value))} onPointerUp={() => submit([{ op: 'set_ducking', on: true, level: duckPct / 100 }])} onKeyUp={() => submit([{ op: 'set_ducking', on: true, level: duckPct / 100 }])} />
            </label>
          )}
        </div>
      )}
      {visual && clip.media && (
        <>
          <div className="inspGrid" role="group" aria-label="Tampilan gambar">
            <label>
              Di canvas
              <select
                aria-label="Tampilan di canvas"
                value={fitValue}
                onChange={(e) => {
                  const v = e.target.value;
                  submit([{ op: 'set_picture', clip_id: clip.clip_id, ...(v === 'hitam' ? { fit: null, fit_color: null } : v === 'warna' ? { fit: 'warna', fit_color: clip.fit_color ?? '#ffffff' } : { fit: v as 'isi' | 'blur' }) }]);
                }}
              >
                <option value="hitam">Pas + latar hitam</option>
                <option value="blur">Pas + latar blur</option>
                <option value="warna">Pas + latar warna</option>
                <option value="isi">Isi layar (crop)</option>
              </select>
            </label>
            {fitValue === 'warna' && (
              <label>
                Warna latar
                <input type="color" aria-label="Warna latar" value={clip.fit_color ?? '#ffffff'} onChange={(e) => submit([{ op: 'set_picture', clip_id: clip.clip_id, fit: 'warna', fit_color: e.target.value }])} />
              </label>
            )}
            <label>
              Filter warna
              <select aria-label="Filter warna" value={clip.look ?? ''} onChange={(e) => submit([{ op: 'set_picture', clip_id: clip.clip_id, look: e.target.value === '' ? null : (e.target.value as (typeof LOOK_IDS)[number] | 'none') }])}>
                <option value="">{brandLook ? `Ikuti brand (${brandLook})` : 'Ikuti brand (tanpa filter)'}</option>
                <option value="none">Tanpa filter</option>
                {LOOK_IDS.map((id) => (
                  <option key={id} value={id}>
                    {LOOKS[id].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="inspGrid" role="group" aria-label="Adjust gambar">
            {ADJUST_KEYS.map((k) => (
              <label key={k}>
                {ADJUST_LABEL[k]} {adj[k]}
                <input
                  type="range"
                  aria-label={ADJUST_LABEL[k]}
                  min={ADJUST_RANGE[k][0]}
                  max={ADJUST_RANGE[k][1]}
                  value={adj[k]}
                  onChange={(e) => {
                    const next = { ...adjRef.current, [k]: Number(e.target.value) };
                    adjRef.current = next;
                    setAdj(next);
                    if (adjTimer.current) clearTimeout(adjTimer.current);
                    adjTimer.current = setTimeout(() => commitRef.current(), 450);
                  }}
                  onPointerUp={commitAdjust}
                  onBlur={() => adjTimer.current && commitAdjust()}
                />
              </label>
            ))}
            {clip.adjust && (
              <span className="row" style={{ alignItems: 'end' }}>
                <button className="btn small" onClick={() => submit([{ op: 'set_picture', clip_id: clip.clip_id, adjust: null }])}>
                  Reset adjust
                </button>
              </span>
            )}
          </div>
          <div className="muted small">Ketajaman hanya terlihat di hasil render; warna di pratinjau mendekati hasil render.</div>
          <div className="inspGrid" role="group" aria-label="Transisi masuk">
            <label>
              Transisi masuk
              <select
                aria-label="Transisi masuk"
                value={clip.transition?.type ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'zoom_through') {
                    // The zoom-through effect that already exists: a short push-in across the cut.
                    const at = clip.start_ms;
                    submit([{ op: 'add_clip', track_kind: 'effects', start_ms: Math.max(0, at - 200), duration_ms: 400, effect: { type: 'zoom_through', scale: 1.4, x: 0.5, y: 0.5 } }]);
                  } else submit([{ op: 'set_picture', clip_id: clip.clip_id, transition: v ? { type: v as TransitionType, ms: clip.transition?.ms ?? 500 } : null }]);
                }}
              >
                <option value="">Tanpa (potong langsung)</option>
                {TRANSITIONS.map((tr) => (
                  <option key={tr} value={tr}>
                    {TRANSITION_LABEL[tr]}
                  </option>
                ))}
                <option value="zoom_through">Zoom-through (tambah efek di track Efek)</option>
              </select>
            </label>
            {clip.transition && (
              <label>
                Durasi transisi (ms)
                <input type="number" aria-label="Durasi transisi" min={TRANSITION_MS[0]} max={TRANSITION_MS[1]} step={50} value={transMs} onChange={(e) => setTransMs(e.target.value)} onBlur={commitTransMs} onKeyDown={(e) => enter(e, commitTransMs)} />
              </label>
            )}
          </div>
        </>
      )}
    </>
  );
}
