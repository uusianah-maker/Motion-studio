import { useEffect, useRef, useState } from 'react';
import { fillCrop } from '../../../../packages/core/dist/storage/framing.js';
import { TEXT_PRESETS } from '../../../../packages/core/dist/storage/textPresets.js';
import { DEFAULT_STYLES, type TextStyle, effectiveStyle } from '../../../../packages/core/dist/storage/textStyle.js';
import type { BrandKit, Clip, EditOp, Track } from '../api';
import { formatDuration, parseDecimal } from '../lib';
import { ClipLookPanel } from './ClipLookPanel';
import { KeyframePanel } from './KeyframePanel';
import { LOOKS } from '../../../../packages/core/dist/storage/clipLook.js';

export type SelectedClip = Clip & { kind: Track['kind'] };
const KIND_NAME: Record<Track['kind'], string> = { video: 'Video', broll: 'B-roll', text: 'Teks', subtitle: 'Subtitle', audio: 'Audio', music: 'Musik', sfx: 'SFX', effects: 'Efek' };
const sec = (ms: number) => (ms / 1000).toFixed(2);

/**
 * Inspector (X02, PRD §6 "media bin/inspector"): properties of the selected clip. Timing and text
 * commit on blur/Enter; style changes show live on the preview (draft) and are saved as one
 * `set_style` edit after a short pause, so dragging a slider is one undo step, not fifty.
 */
export function InspectorPanel({
  clip,
  name,
  sourceMs,
  busy,
  onEdit,
  onDraft,
  readOnly = false,
  brand = null,
  onCutReview,
  sourceSize = null,
  canvasRatio = 9 / 16,
  duck,
  playhead = 0,
}: {
  clip: SelectedClip;
  name: string;
  sourceMs: number | undefined;
  busy: boolean;
  onEdit: (ops: EditOp[]) => Promise<void> | void;
  onDraft: (d: { clip_id: string; style: Partial<TextStyle> } | null) => void;
  /** X05: archived project — everything is shown but nothing can be changed. */
  readOnly?: boolean;
  /** X06: Brand Kit colours + whether it has a font. */
  brand?: BrandKit | null;
  /** X07: open "Deteksi jeda & adegan" for this media clip. */
  onCutReview?: () => void;
  /** U3d: source frame size (probe) and canvas ratio w/h for the "fill" crop. */
  sourceSize?: { w: number; h: number } | null;
  canvasRatio?: number;
  /** Malam 15 Nov: music-track ducking level (undefined = off). */
  duck?: number | undefined;
  /** Malam 15 Nov: playhead (ms) for "＋ Keyframe di playhead". */
  playhead?: number;
}) {
  const isText = clip.kind === 'text' || clip.kind === 'subtitle';
  const [start, setStart] = useState(sec(clip.start_ms));
  const [dur, setDur] = useState(sec(clip.end_ms - clip.start_ms));
  const [text, setText] = useState(clip.text ?? '');
  const [draft, setDraft] = useState<Partial<TextStyle>>({});
  const [vol, setVol] = useState(Math.round((clip.volume ?? 1) * 100));
  // U3c: effect edits replace the clip in one step (delete + add = one undo).
  const effectDraft = useRef(clip.effect ?? null);
  const setEffectDraft = (e: NonNullable<Clip['effect']>) => {
    effectDraft.current = e;
  };
  const commitEffect = () => {
    const e = effectDraft.current;
    if (!e || JSON.stringify(e) === JSON.stringify(clip.effect)) return;
    submit([{ op: 'delete_clip', clip_id: clip.clip_id }, { op: 'add_clip', track_kind: 'effects', start_ms: clip.start_ms, duration_ms: clip.end_ms - clip.start_ms, effect: e }]);
  };
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Queued edits must use the latest edit function (it carries the current project revision).
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const startRef = useRef<HTMLInputElement>(null);
  const durRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Saved values flow back in — but never over a field the user is typing in.
  useEffect(() => {
    if (document.activeElement !== startRef.current) setStart(sec(clip.start_ms));
    if (document.activeElement !== durRef.current) setDur(sec(clip.end_ms - clip.start_ms));
    if (document.activeElement !== textRef.current) setText(clip.text ?? '');
  }, [clip.clip_id, clip.start_ms, clip.end_ms, clip.text]);
  // A new clip, or the server's saved version of this one: drop the local draft.
  useEffect(() => {
    setDraft({});
    onDraft(null);
  }, [clip.clip_id, JSON.stringify(clip.style ?? {})]);
  useEffect(() => setVol(Math.round((clip.volume ?? 1) * 100)), [clip.clip_id, clip.volume]);
  // Audit 14 Nov: a change still waiting its 0,45 s when the clip is let go is SAVED, not dropped
  // (the preview kept showing it while the render used the old value).
  const pendingStyle = useRef<Partial<TextStyle> | null>(null);
  const pendingVol = useRef<number | null>(null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (volTimer.current) clearTimeout(volTimer.current);
      const ops: EditOp[] = [];
      if (pendingStyle.current) ops.push({ op: 'set_style', clip_id: clip.clip_id, style: pendingStyle.current });
      if (pendingVol.current !== null) ops.push({ op: 'set_volume', clip_id: clip.clip_id, volume: pendingVol.current });
      if (ops.length) {
        const go = () => (busyRef.current ? void setTimeout(go, 150) : void onEditRef.current(ops));
        go();
      }
      onDraftRef.current(null);
    },
    // Runs once, on unmount (the panel is keyed by clip id).
    [clip.clip_id],
  );
  /** Volume slider: one `set_volume` edit after the hand stops (one undo step). */
  const changeVolume = (pct: number) => {
    setVol(pct);
    if (volTimer.current) clearTimeout(volTimer.current);
    pendingVol.current = pct / 100;
    const fire = () => {
      if (busyRef.current) {
        volTimer.current = setTimeout(fire, 250);
        return;
      }
      pendingVol.current = null;
      void onEditRef.current([{ op: 'set_volume', clip_id: clip.clip_id, volume: pct / 100 }]);
    };
    volTimer.current = setTimeout(fire, 450);
  };

  const s = isText ? { ...effectiveStyle(clip.kind as 'text' | 'subtitle', clip.style), ...draft } : null;

  /** Edits made while the previous one is still saving wait for it (nothing is silently dropped). */
  const submit = (ops: EditOp[]) => {
    const go = () => {
      if (busyRef.current) return void setTimeout(go, 150);
      void onEditRef.current(ops);
    };
    go();
  };

  const commitStyle = (next: Partial<TextStyle>) => {
    if (timer.current) clearTimeout(timer.current);
    pendingStyle.current = next;
    const fire = () => {
      if (busyRef.current) {
        timer.current = setTimeout(fire, 250);
        return;
      }
      pendingStyle.current = null;
      void onEditRef.current([{ op: 'set_style', clip_id: clip.clip_id, style: next }]);
    };
    timer.current = setTimeout(fire, 450);
  };
  const change = (patch: Partial<TextStyle>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraft({ clip_id: clip.clip_id, style: next });
    commitStyle(next);
  };

  const commitTiming = () => {
    // Audit 14 Nov: an emptied field means "unchanged", never 0 s.
    const st = Math.round((parseDecimal(start) ?? NaN) * 1000);
    const d = Math.round((parseDecimal(dur) ?? NaN) * 1000);
    const ops: EditOp[] = [];
    if (Number.isFinite(st) && st >= 0 && st !== clip.start_ms) ops.push({ op: 'move_clip', clip_id: clip.clip_id, start_ms: st });
    const base = ops.length ? st : clip.start_ms;
    if (Number.isFinite(d) && d >= 100 && d !== clip.end_ms - clip.start_ms) ops.push({ op: 'trim_clip', clip_id: clip.clip_id, edge: 'end', to_ms: base + d });
    if (ops.length) submit(ops);
    else {
      setStart(sec(clip.start_ms));
      setDur(sec(clip.end_ms - clip.start_ms));
    }
  };
  const enter = (e: React.KeyboardEvent<HTMLElement>, fn: () => void) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) {
      e.preventDefault();
      fn();
    }
  };
  const commitText = () => {
    if (isText && text.trim() && text !== clip.text) submit([{ op: 'set_text', clip_id: clip.clip_id, text }]);
  };

  return (
    <section className="inspector" aria-label="Inspector klip">
      <fieldset className="plain" disabled={readOnly}>
      <div className="inspHead">
        <b>Inspector</b>
        <span className="badge vio">{KIND_NAME[clip.kind]}</span>
        <span className="muted small ellipsis" title={name}>
          {name}
        </span>
      </div>

      <div className="inspGrid">
        <label>
          Mulai (dtk)
          <input ref={startRef} aria-label="Mulai klip (detik)" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} onBlur={commitTiming} onKeyDown={(e) => enter(e, commitTiming)} />
        </label>
        <label>
          Durasi (dtk)
          <input ref={durRef} aria-label="Durasi klip (detik)" inputMode="decimal" value={dur} onChange={(e) => setDur(e.target.value)} onBlur={commitTiming} onKeyDown={(e) => enter(e, commitTiming)} />
        </label>
      </div>
      {clip.media && (
        <div className="muted small">
          Sumber mulai {formatDuration(clip.in_ms ?? 0)}
          {sourceMs !== undefined ? ` dari ${formatDuration(sourceMs)}` : ''}
        </div>
      )}
      {clip.media && (
        <div className="inspGrid">
          <label>
            Volume {vol}%
            <input type="range" aria-label="Volume klip" min={0} max={100} value={vol} onChange={(e) => changeVolume(Number(e.target.value))} />
          </label>
          <span className="row" style={{ gap: 6, alignItems: 'end' }}>
            <button className="btn small" aria-label={vol === 0 ? 'Nyalakan suara klip' : 'Bisukan klip'} onClick={() => changeVolume(vol === 0 ? 100 : 0)}>
              {vol === 0 ? '🔇 Nyalakan' : '🔊 Bisukan'}
            </button>
          </span>
        </div>
      )}
      {clip.effect && (
        <div className="inspGrid" role="group" aria-label="Efek zoom">
          <label>
            Efek
            <select aria-label="Jenis efek" value={clip.effect.type === 'zoom' ? `zoom-${clip.effect.mode}` : 'zoom_through'} onChange={(e) => {
              const v = e.target.value;
              const base = { scale: clip.effect!.scale, x: clip.effect!.x, y: clip.effect!.y };
              submit([{ op: 'delete_clip', clip_id: clip.clip_id }, { op: 'add_clip', track_kind: 'effects', start_ms: clip.start_ms, duration_ms: clip.end_ms - clip.start_ms, effect: v === 'zoom_through' ? { type: 'zoom_through', ...base } : { type: 'zoom', mode: v === 'zoom-cut' ? 'cut' : 'smooth', ...base } }]);
            }}>
              <option value="zoom-smooth">Zoom halus (punch-in)</option>
              <option value="zoom-cut">Zoom langsung (cut)</option>
              <option value="zoom_through">Zoom-through (transisi)</option>
            </select>
          </label>
          <label>
            Besar zoom {clip.effect.scale.toFixed(2)}×
            <input type="range" aria-label="Besar zoom" min={102} max={250} key={`${clip.clip_id}:${clip.effect.scale}`} defaultValue={Math.round(clip.effect.scale * 100)} onChange={(e) => setEffectDraft({ ...clip.effect!, scale: Number(e.target.value) / 100 })} onPointerUp={commitEffect} onKeyUp={commitEffect} onBlur={commitEffect} />
          </label>
        </div>
      )}
      {clip.media && (clip.kind === 'video' || clip.kind === 'broll') && (
        <div className="inspGrid" role="group" aria-label="Bingkai (crop & blur)">
          <label>
            Crop
            <select
              aria-label="Crop klip"
              value={!clip.crop ? 'full' : sourceSize && JSON.stringify(clip.crop) === JSON.stringify(fillCrop(sourceSize, canvasRatio)) ? 'fill' : 'custom'}
              onChange={(e) => {
                if (e.target.value === 'full') submit([{ op: 'set_framing', clip_id: clip.clip_id, crop: null }]);
                else if (e.target.value === 'fill' && sourceSize) {
                  const c = fillCrop(sourceSize, canvasRatio);
                  submit([{ op: 'set_framing', clip_id: clip.clip_id, crop: c.w === 1 && c.h === 1 ? null : c }]); // same shape as the canvas: nothing to crop
                }
              }}
            >
              <option value="full">Bingkai penuh</option>
              <option value="fill" disabled={!sourceSize}>
                Isi canvas (crop tengah)
              </option>
              {clip.crop && <option value="custom">Crop khusus {`${Math.round(clip.crop.w * 100)}%×${Math.round(clip.crop.h * 100)}%`}</option>}
            </select>
          </label>
          <span className="row" style={{ gap: 6, alignItems: 'end', flexWrap: 'wrap' }}>
            <button
              className="btn small"
              disabled={(clip.blur?.length ?? 0) >= 8}
              title="Blur area di tengah bingkai selama klip ini (geser angka lewat rencana engine)"
              onClick={() => {
                const from = clip.in_ms ?? 0;
                submit([{ op: 'set_framing', clip_id: clip.clip_id, blur: [...(clip.blur ?? []), { x: 0.35, y: 0.4, w: 0.3, h: 0.2, dari_ms: from, sampai_ms: from + (clip.end_ms - clip.start_ms), radius: 20 }] }]);
              }}
            >
              ＋ Blur area
            </button>
            {!!clip.blur?.length && (
              <button className="btn small" onClick={() => submit([{ op: 'set_framing', clip_id: clip.clip_id, blur: [] }])}>
                Hapus {clip.blur.length} blur
              </button>
            )}
          </span>
        </div>
      )}
      {clip.media && <ClipLookPanel key={clip.clip_id} clip={clip} kind={clip.kind} submit={submit} duck={duck} brandLook={brand?.filter_bawaan ? LOOKS[brand.filter_bawaan].label : null} />}
      {((clip.media && (clip.kind === 'video' || clip.kind === 'broll')) || isText) && <KeyframePanel clip={clip} playhead={playhead} submit={submit} />}
      {clip.media && onCutReview && (
        <button className="btn small" onClick={onCutReview} title="Cari jeda & pergantian adegan, lalu pilih yang mau dipotong (FFmpeg, tanpa AI)">
          ✂ Deteksi jeda & adegan
        </button>
      )}

      {isText && s && (
        <>
          <label className="inspFull">
            Teks
            <textarea ref={textRef} aria-label="Isi teks di inspector" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} onKeyDown={(e) => enter(e, commitText)} />
          </label>
          <label className="inspFull">
            Preset
            <select
              aria-label="Terapkan preset"
              value=""
              onChange={(e) => {
                const p = TEXT_PRESETS.find((x) => x.id === e.target.value);
                if (p) change({ ...DEFAULT_STYLES[clip.kind as 'text' | 'subtitle'], ...p.style });
              }}
            >
              <option value="">Pilih preset…</option>
              {TEXT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </label>
          <div className="inspGrid">
            <label>
              Posisi X {Math.round(s.x * 100)}%
              <input type="range" aria-label="Posisi horizontal" min={0} max={100} value={Math.round(s.x * 100)} onChange={(e) => change({ x: Number(e.target.value) / 100 })} />
            </label>
            <label>
              Posisi Y {Math.round(s.y * 100)}%
              <input type="range" aria-label="Posisi vertikal" min={0} max={100} value={Math.round(s.y * 100)} onChange={(e) => change({ y: Number(e.target.value) / 100 })} />
            </label>
            <label>
              Ukuran {s.size.toFixed(1)}
              <input type="range" aria-label="Ukuran teks" min={2} max={20} step={0.5} value={s.size} onChange={(e) => change({ size: Number(e.target.value) })} />
            </label>
            <label>
              Lebar baris {Math.round(s.width * 100)}%
              <input type="range" aria-label="Lebar baris" min={20} max={100} value={Math.round(s.width * 100)} onChange={(e) => change({ width: Number(e.target.value) / 100 })} />
            </label>
            <label>
              Warna teks
              <span className="row" style={{ gap: 4 }}>
                <input type="color" aria-label="Warna teks" value={s.color} onChange={(e) => change({ color: e.target.value })} />
                {[...(brand?.colors ?? []), ...(brand ? [brand.text_color] : [])].filter((c, i, a) => a.indexOf(c) === i).map((c) => (
                  <button key={c} className="swatchBtn" style={{ background: c }} aria-label={`Pakai warna brand ${c} untuk teks`} title={`Warna brand ${c}`} onClick={() => change({ color: c })} />
                ))}
              </span>
            </label>
            <label>
              Kotak latar
              <span className="row" style={{ gap: 6 }}>
                <input type="checkbox" aria-label="Pakai kotak latar" checked={!!s.bg} onChange={(e) => change({ bg: e.target.checked ? (s.bg ?? '#000000') : null })} />
                <input type="color" aria-label="Warna kotak" value={s.bg ?? '#000000'} disabled={!s.bg} onChange={(e) => change({ bg: e.target.value })} />
                {(brand?.colors ?? []).map((c) => (
                  <button key={c} className="swatchBtn" style={{ background: c }} aria-label={`Pakai warna brand ${c} untuk kotak`} title={`Kotak warna brand ${c}`} onClick={() => change({ bg: c, bg_opacity: 1 })} />
                ))}
              </span>
            </label>
            {s.bg && (
              <label>
                Opasitas kotak {Math.round(s.bg_opacity * 100)}%
                <input type="range" aria-label="Opasitas kotak" min={0} max={100} value={Math.round(s.bg_opacity * 100)} onChange={(e) => change({ bg_opacity: Number(e.target.value) / 100 })} />
              </label>
            )}
            {s.bg && (
              <label>
                Kotak kaca (blur) {s.bg_blur}
                <input type="range" aria-label="Kotak kaca blur" min={0} max={30} value={s.bg_blur} onChange={(e) => change({ bg_blur: Number(e.target.value) })} />
              </label>
            )}
          </div>
          <div className="inspGrid">
            <label>
              Animasi
              <select aria-label="Animasi teks" value={s.anim} onChange={(e) => change({ anim: e.target.value as TextStyle['anim'] })}>
                <option value="none">Tanpa</option>
                <option value="pop">Pop</option>
                <option value="fade">Fade</option>
              </select>
            </label>
            <label>
              Durasi animasi (ms)
              <input type="number" aria-label="Durasi animasi" min={0} max={2000} step={20} value={s.anim_ms} onChange={(e) => change({ anim_ms: Math.max(0, Math.min(2000, Number(e.target.value) || 0)) })} />
            </label>
          </div>
          <label className="inspFull">
            Sorot kata kunci (pisah koma){clip.words?.length ? ` · ${clip.words.length} kata bertimecode` : ''}
            <span className="row" style={{ gap: 6 }}>
              <input
                aria-label="Kata kunci disorot"
                placeholder="mis. anti kusut, flowy"
                defaultValue={(s.highlight?.words ?? []).join(', ')}
                key={`${clip.clip_id}:${(s.highlight?.words ?? []).join('|')}`}
                onBlur={(e) => {
                  const words = e.target.value.split(',').flatMap((w) => w.trim().split(/\s+/)).filter(Boolean);
                  // Audit 14 Nov: leaving the field unchanged is not an edit (no empty undo step).
                  if (words.join('|') === (s.highlight?.words ?? []).join('|')) return;
                  change({ highlight: words.length || s.highlight?.current ? { words, color: s.highlight?.color ?? brand?.colors[1] ?? '#ffd23f', scale: s.highlight?.scale ?? 1.15, current: s.highlight?.current ?? false, box: s.highlight?.box ?? false } : null });
                }}
              />
              <input type="color" aria-label="Warna sorot" value={s.highlight?.color ?? '#ffd23f'} onChange={(e) => change({ highlight: { words: s.highlight?.words ?? [], scale: s.highlight?.scale ?? 1.15, current: s.highlight?.current ?? false, box: s.highlight?.box ?? false, color: e.target.value } })} />
            </span>
          </label>
          <label className="inline">
            <input type="checkbox" aria-label="Sorot kata yang sedang diucapkan" checked={!!s.highlight?.current} onChange={(e) => change({ highlight: { words: s.highlight?.words ?? [], color: s.highlight?.color ?? '#ffd23f', scale: s.highlight?.scale ?? 1.15, box: s.highlight?.box ?? false, current: e.target.checked } })} /> Sorot kata yang sedang diucapkan
          </label>
          <label className="inline">
            <input type="checkbox" aria-label="Kotak di belakang kata sorot" checked={!!s.highlight?.box} onChange={(e) => change({ highlight: { words: s.highlight?.words ?? [], color: s.highlight?.color ?? '#ffd23f', scale: s.highlight?.scale ?? 1.15, current: s.highlight?.current ?? false, box: e.target.checked } })} /> Kotak warna sorot di belakang kata
          </label>
          <label className="inspFull">
            Font
            <select aria-label="Font teks" value={s.font} onChange={(e) => change({ font: e.target.value as TextStyle['font'] })}>
              <option value="default">Bawaan</option>
              <option value="brand" disabled={!brand?.font && s.font !== 'brand'}>
                Brand · judul{brand?.font ? '' : ' (belum ada di Brand Kit)'}
              </option>
              <option value="caption" disabled={!brand?.font_caption && s.font !== 'caption'}>
                Brand · caption{brand?.font_caption ? '' : ' (belum ada di Brand Kit)'}
              </option>
            </select>
          </label>
          <div className="row wrap" style={{ gap: 6 }}>
            <label className="inline">
              <input type="checkbox" aria-label="Tebal" checked={s.bold} onChange={(e) => change({ bold: e.target.checked })} /> Tebal
            </label>
            <label className="inline">
              <input type="checkbox" aria-label="Outline" checked={s.outline} onChange={(e) => change({ outline: e.target.checked })} /> Outline
            </label>
            <span className="segmented" role="group" aria-label="Perataan">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} className={`chip${s.align === a ? ' on' : ''}`} aria-pressed={s.align === a} onClick={() => change({ align: a })}>
                  {a === 'left' ? 'Kiri' : a === 'center' ? 'Tengah' : 'Kanan'}
                </button>
              ))}
            </span>
            <button className="btn small" disabled={busy} onClick={() => change({ ...DEFAULT_STYLES[clip.kind as 'text' | 'subtitle'] })} title="Kembalikan ke gaya bawaan track">
              Reset gaya
            </button>
          </div>
          <div className="muted small">Tips: seret teks di pratinjau untuk memindahkan posisinya.</div>
        </>
      )}
      </fieldset>
    </section>
  );
}
