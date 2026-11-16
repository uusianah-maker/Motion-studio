import { useEffect, useMemo, useRef, useState } from 'react';
import { OVERLAY_DEFAULT, OVERLAY_POS, OVERLAY_POS_LABEL, type Overlay } from '../../../../packages/core/dist/storage/overlay.js';
import type { Api, BrandKit, Clip, JobOverlay } from '../api';
import { OverlayLayer } from './OverlayLayer';
import { OverlayPicker, type OverlayPick } from './OverlayPicker';

const BIG = 3_600_000;

/**
 * R26 "Buat video": overlays for this job, chosen BEFORE Generate, with a live preview on the
 * source video (same placement code as the Editor and the render). They are added to the engine's
 * draft as ordinary overlay clips, so everything stays editable afterwards (hybrid). The brand's
 * "pasang logo otomatis" logo is shown too (it is added by the server, not listed here).
 */
export function JobOverlays({ api, kit, file, value, onChange, onKitSaved }: { api: Api; kit: BrandKit | null; file: File | null; value: JobOverlay[]; onChange: (v: JobOverlay[]) => void; onKitSaved?: (k: BrandKit) => void }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [time, setTime] = useState(0);
  const src = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState({ w: 180, h: 320 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setCanvas({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const auto = kit?.logo_otomatis && kit.logo ? kit.logo : null;
  // Preview clips: whole-video overlays always; timed ones at their seconds (time follows the video).
  const clips: Clip[] = [
    ...value.map((o, i) => ({ clip_id: `job${i}`, start_ms: o.overlay.sepanjang ? 0 : (o.dari_ms ?? 0), end_ms: o.overlay.sepanjang ? BIG : (o.sampai_ms ?? BIG), media: o.ref, overlay: o.overlay })),
    ...(auto && !value.some((o) => o.ref.version_id === auto.ref.version_id) ? [{ clip_id: 'auto', start_ms: 0, end_ms: BIG, media: auto.ref, overlay: { ...OVERLAY_DEFAULT, pos: auto.corner, skala: auto.size, opasitas: auto.opacity, layer: 999, sepanjang: true as const } }] : []),
  ];
  const patch = (i: number, p: Partial<JobOverlay> & { overlay?: Overlay }) => onChange(value.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const setOv = (i: number, p: Partial<Omit<Overlay, 'sepanjang'>> & { sepanjang?: boolean }) => {
    const next = { ...value[i]!.overlay, ...p } as Overlay & { sepanjang?: boolean };
    if (!next.sepanjang) delete next.sepanjang;
    patch(i, { overlay: next as Overlay, ...(next.sepanjang ? {} : { dari_ms: value[i]!.dari_ms ?? 0, sampai_ms: value[i]!.sampai_ms ?? 3000 }) });
  };
  const add = (p: OverlayPick) => {
    setOpen(false);
    setNames((n) => ({ ...n, [p.ref.version_id]: p.nama }));
    const layer = value.length;
    const overlay: Overlay = { ...OVERLAY_DEFAULT, pos: p.jenis === 'logo' ? 'tr' : p.jenis === 'frame' ? 'c' : 'br', skala: p.jenis === 'frame' ? 100 : p.jenis === 'logo' ? 18 : 30, opasitas: p.jenis === 'watermark' ? 0.6 : 1, margin: p.jenis === 'frame' ? 0 : 4, layer, ...(p.sepanjang ? { sepanjang: true as const } : {}) };
    onChange([...value, { ref: p.ref, overlay, ...(p.sepanjang ? {} : { dari_ms: 0, sampai_ms: 3000 }) }]);
    setSel(value.length);
  };
  const nameOf = (vid: string) => names[vid] ?? kit?.aset.find((a) => a.ref.version_id === vid)?.nama ?? (kit?.logo?.ref.version_id === vid ? 'Logo default' : 'Gambar');
  const sec = (ms: number | undefined) => ((ms ?? 0) / 1000).toString().replace('.', ',');
  const toMs = (s: string) => Math.max(0, Math.round(Number(s.replace(',', '.')) * 1000) || 0);

  return (
    <div className="jobOverlays" role="group" aria-label="Overlay video">
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="canvas live jobOverlayCanvas" ref={canvasRef} style={{ aspectRatio: '9 / 16', width: 180 }} aria-label="Pratinjau overlay">
          {src ? <video src={src} muted playsInline controls={false} preload="metadata" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime * 1000)} onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())} style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} /> : <div className="emptyFrame">Pilih video untuk pratinjau</div>}
          <OverlayLayer api={api} clips={clips} media={[]} time={time} total={BIG} canvas={canvas} selectedId={sel === null ? null : `job${sel}`} onSelect={(id) => id.startsWith('job') && setSel(Number(id.slice(3)))} onMove={(id, dx, dy) => id.startsWith('job') && setOv(Number(id.slice(3)), { dx, dy })} />
        </div>
        <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 8 }}>
          {auto && <div className="muted small">Logo default brand ikut otomatis (Brand → pasang logo otomatis).</div>}
          {value.map((o, i) => (
            <div key={i} className={`assetRow${sel === i ? ' picked' : ''}`} role="group" aria-label={`Overlay ${i + 1}`} onClick={() => setSel(i)}>
              <div className="row wrap" style={{ gap: 6 }}>
                <b className="small">{nameOf(o.ref.version_id)}</b>
                <span className="spacer" />
                <select aria-label={`Posisi overlay ${i + 1}`} value={o.overlay.pos} onChange={(e) => setOv(i, { pos: e.target.value as Overlay['pos'], dx: 0, dy: 0 })}>
                  {OVERLAY_POS.map((p) => (
                    <option key={p} value={p}>
                      {OVERLAY_POS_LABEL[p]}
                    </option>
                  ))}
                </select>
                <button className="tiny" aria-label={`Hapus overlay ${i + 1}`} onClick={() => (onChange(value.filter((_, j) => j !== i)), setSel(null))}>
                  ×
                </button>
              </div>
              <div className="inspGrid">
                <label>
                  Ukuran {o.overlay.skala}%
                  <input type="range" aria-label={`Ukuran overlay ${i + 1}`} min={2} max={100} value={o.overlay.skala} onChange={(e) => setOv(i, { skala: Number(e.target.value) })} />
                </label>
                <label>
                  Opasitas {Math.round(o.overlay.opasitas * 100)}%
                  <input type="range" aria-label={`Opasitas overlay ${i + 1}`} min={5} max={100} value={Math.round(o.overlay.opasitas * 100)} onChange={(e) => setOv(i, { opasitas: Number(e.target.value) / 100 })} />
                </label>
                <label>
                  Jarak tepi {o.overlay.margin}%
                  <input type="range" aria-label={`Jarak tepi overlay ${i + 1}`} min={0} max={20} value={o.overlay.margin} onChange={(e) => setOv(i, { margin: Number(e.target.value) })} />
                </label>
                <label>
                  Durasi
                  <select aria-label={`Durasi overlay ${i + 1}`} value={o.overlay.sepanjang ? 'semua' : 'detik'} onChange={(e) => setOv(i, { sepanjang: e.target.value === 'semua' })}>
                    <option value="semua">Sepanjang video</option>
                    <option value="detik">Detik tertentu</option>
                  </select>
                </label>
                {!o.overlay.sepanjang && (
                  <>
                    <label>
                      Dari (dtk)
                      <input aria-label={`Overlay ${i + 1} dari detik`} inputMode="decimal" defaultValue={sec(o.dari_ms)} onBlur={(e) => patch(i, { dari_ms: toMs(e.target.value) })} />
                    </label>
                    <label>
                      Sampai (dtk)
                      <input aria-label={`Overlay ${i + 1} sampai detik`} inputMode="decimal" defaultValue={sec(o.sampai_ms)} onBlur={(e) => patch(i, { sampai_ms: toMs(e.target.value) })} />
                    </label>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" disabled={value.length >= 10} onClick={() => setOpen(true)}>
              ＋ Overlay (logo / watermark / stiker / frame)
            </button>
            {value.length > 0 && <span className="muted small">Urutan lapisan = urutan daftar (bawah = paling depan). Seret gambar di pratinjau untuk menggeser.</span>}
          </div>
        </div>
      </div>
      {open && <OverlayPicker api={api} kit={kit} onPick={add} onClose={() => setOpen(false)} {...(onKitSaved ? { onKitSaved } : {})} />}
    </div>
  );
}
