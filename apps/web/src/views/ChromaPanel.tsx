import { useEffect, useRef, useState } from 'react';
import { CHROMA_DEFAULT, CHROMA_PRESETS } from '../../../../packages/core/dist/storage/chroma.js';
import type { Clip, EditOp } from '../api';

type Chroma = { warna: string; toleransi: number; halus: number };
/** Chrome / Edge: pick any colour on the screen (the preview included). */
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };

/**
 * R23e (owner 16 Nov): chroma key / green screen for a video or picture on the overlay track —
 * key colour (presets, picker, 🎯 eyedropper from the preview), tolerance and soft edge. Preview and
 * render use the same rule (FFmpeg chromakey). Sliders save once the hand stops: one undo.
 */
export function ChromaPanel({ clip, submit }: { clip: Clip; submit: (ops: EditOp[]) => void }) {
  const cur: Chroma | null = clip.chroma ?? null;
  const [draft, setDraft] = useState<Chroma>(cur ?? CHROMA_DEFAULT);
  useEffect(() => setDraft(clip.chroma ?? CHROMA_DEFAULT), [clip.clip_id, JSON.stringify(clip.chroma ?? null)]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (c: Chroma, now = false) => {
    setDraft(c);
    if (timer.current) clearTimeout(timer.current);
    const go = () => submit([{ op: 'set_chroma', clip_id: clip.clip_id, chroma: c }]);
    if (now) go();
    else timer.current = setTimeout(go, 450);
  };
  const Dropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  const pick = async () => {
    if (!Dropper) return;
    try {
      const r = await new Dropper().open();
      save({ ...draft, warna: r.sRGBHex.toLowerCase() }, true);
    } catch {
      /* cancelled */
    }
  };
  return (
    <div className="inspGrid" role="group" aria-label="Chroma key">
      <label className="inline" title="Warna latar (hijau/biru) jadi transparan, jadi subjek menempel di atas video utama.">
        <input type="checkbox" aria-label="Chroma key" checked={!!cur} onChange={(e) => submit([{ op: 'set_chroma', clip_id: clip.clip_id, chroma: e.target.checked ? draft : null }])} /> Chroma key (green screen)
      </label>
      {cur && (
        <>
          <label>
            Warna kunci
            <span className="row" style={{ gap: 6 }}>
              <input type="color" aria-label="Warna kunci" value={draft.warna} onChange={(e) => save({ ...draft, warna: e.target.value })} />
              <button type="button" className="smallbtn" aria-label="Kunci hijau" onClick={() => save({ ...draft, warna: CHROMA_PRESETS.hijau }, true)}>
                Hijau
              </button>
              <button type="button" className="smallbtn" aria-label="Kunci biru" onClick={() => save({ ...draft, warna: CHROMA_PRESETS.biru }, true)}>
                Biru
              </button>
              {Dropper && (
                <button type="button" className="smallbtn" aria-label="Pipet warna" title="Ambil warna dari layar (klik latar di pratinjau)" onClick={() => void pick()}>
                  🎯 Pipet
                </button>
              )}
            </span>
          </label>
          <label>
            Toleransi {Math.round(draft.toleransi * 100)}%
            <input type="range" aria-label="Toleransi chroma" min={1} max={60} value={Math.round(draft.toleransi * 100)} onChange={(e) => save({ ...draft, toleransi: Number(e.target.value) / 100 })} />
          </label>
          <label>
            Tepi halus {Math.round(draft.halus * 100)}%
            <input type="range" aria-label="Tepi halus chroma" min={0} max={50} value={Math.round(draft.halus * 100)} onChange={(e) => save({ ...draft, halus: Number(e.target.value) / 100 })} />
          </label>
        </>
      )}
    </div>
  );
}
