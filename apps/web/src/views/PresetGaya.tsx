import type { BrandPreset, PresetJenis } from '../api';

/**
 * R18 (KONTRAK-ENGINE §17.1): the optional style fields learnt from winning videos (Hanagaki's
 * study). An empty field = not sent = the engine keeps its usual behaviour.
 */
const JENIS: { id: PresetJenis; label: string }[] = [
  { id: 'street_interview', label: 'Street interview' },
  { id: 'test_produk', label: 'Test produk' },
  { id: 'harian_studio', label: 'Harian studio' },
  { id: 'beat_spot', label: 'Beat Spot' },
  { id: 'lain', label: 'Lain' },
];

/** '' → undefined; otherwise the number. */
const numOrUndef = (v: string): number | undefined => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
/** Drop undefined keys; an object left empty = undefined. */
function compact<T extends object>(o: T): T | undefined {
  const e = Object.entries(o).filter(([, v]) => v !== undefined);
  return e.length ? (Object.fromEntries(e) as T) : undefined;
}
const withOpt = <T extends object, K extends string>(base: T, key: K, value: unknown): T => {
  const next = { ...base } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
};

export function PresetGaya({ p, i, onChange }: { p: BrandPreset; i: number; onChange: (patch: Partial<BrandPreset>) => void }) {
  const n = i + 1;
  const setCaption = (k: 'y' | 'warna' | 'kotak', v: unknown) => onChange({ caption: withOpt(p.caption, k, v) });
  const setHook = (k: 'y' | 'ukuran' | 'baris' | 'warna' | 'dari_kalimat_kuat', v: unknown) => onChange({ hook: withOpt(p.hook, k, v) });
  const setShot = (k: 'target_dtk' | 'maks_dtk', v: number | undefined) => onChange({ shot: compact({ ...p.shot, [k]: v }) });
  const setBeat = (k: 'tiap_ketukan' | 'bpm', v: number | undefined) => onChange({ beat: compact({ ...p.beat, [k]: v }) as BrandPreset['beat'] });
  const field = (label: string, aria: string, value: number | undefined, step: number, min: number, max: number, set: (v: number | undefined) => void) => (
    <label>
      {label}
      <input type="number" aria-label={aria} step={step} min={min} max={max} value={value ?? ''} placeholder="bawaan" onChange={(e) => set(numOrUndef(e.target.value))} />
    </label>
  );
  const color = (label: string, aria: string, value: string | undefined, set: (v: string | undefined) => void) => (
    <label>
      {label}
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input type="color" aria-label={aria} value={value ?? '#ffffff'} onChange={(e) => set(e.target.value)} />
        {value ? (
          <button className="btn small" aria-label={`${aria}: bawaan`} onClick={() => set(undefined)}>
            ✕
          </button>
        ) : (
          <span className="muted small">bawaan</span>
        )}
      </span>
    </label>
  );
  const set = Boolean(p.jenis || p.shot || p.transisi || p.penutup || p.beat || p.caption.y !== undefined || p.hook.y !== undefined);
  return (
    <details className="presetGaya" open={set}>
      <summary className="small">Gaya hasil belajar (opsional — kosong = bawaan mesin)</summary>
      <div className="inspGrid">
        <label>
          Jenis konten
          <select aria-label={`Preset ${n} jenis`} value={p.jenis ?? ''} onChange={(e) => onChange({ jenis: (e.target.value || undefined) as PresetJenis | undefined })}>
            <option value="">—</option>
            {JENIS.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </label>
        {field('Posisi caption (0 atas – 1 bawah)', `Preset ${n} posisi caption`, p.caption.y, 0.01, 0, 1, (v) => setCaption('y', v))}
        {color('Warna caption', `Preset ${n} warna caption`, p.caption.warna, (v) => setCaption('warna', v))}
        <label className="inline">
          <input type="checkbox" aria-label={`Preset ${n} kotak caption`} checked={p.caption.kotak === true} onChange={(e) => setCaption('kotak', e.target.checked ? true : undefined)} /> Kotak latar caption
        </label>
        {field('Posisi hook (0 atas – 1 bawah)', `Preset ${n} posisi hook`, p.hook.y, 0.01, 0, 1, (v) => setHook('y', v))}
        {field('Ukuran hook (% tinggi per baris, 1–8)', `Preset ${n} ukuran hook`, p.hook.ukuran, 0.1, 1, 8, (v) => setHook('ukuran', v))}
        <label>
          Baris hook maks
          <select aria-label={`Preset ${n} baris hook`} value={p.hook.baris ?? ''} onChange={(e) => setHook('baris', numOrUndef(e.target.value))}>
            <option value="">bawaan</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        {color('Warna hook', `Preset ${n} warna hook`, p.hook.warna, (v) => setHook('warna', v))}
        <label className="inline">
          <input type="checkbox" aria-label={`Preset ${n} hook dari kalimat kuat`} checked={p.hook.dari_kalimat_kuat === true} onChange={(e) => setHook('dari_kalimat_kuat', e.target.checked ? true : undefined)} /> Hook dari kalimat kuat (angka / harga / rating / "!")
        </label>
        {field('Target lama shot (dtk)', `Preset ${n} target shot`, p.shot?.target_dtk, 0.1, 0.3, 30, (v) => setShot('target_dtk', v))}
        {field('Shot maks (dtk; lebih lama dipecah + punch-in)', `Preset ${n} shot maks`, p.shot?.maks_dtk, 0.1, 0.5, 60, (v) => setShot('maks_dtk', v))}
        <label className="inline">
          <input type="checkbox" aria-label={`Preset ${n} flash ganti orang`} checked={p.transisi?.ganti_orang === 'flash'} onChange={(e) => onChange({ transisi: e.target.checked ? { ganti_orang: 'flash' } : undefined })} /> Flash putih saat ganti orang
        </label>
        <label className="inline">
          <input type="checkbox" aria-label={`Preset ${n} end card wajib`} checked={p.penutup?.end_card === true} onChange={(e) => onChange({ penutup: e.target.checked ? { end_card: true } : undefined })} /> End card wajib (penutup + tagline)
        </label>
        <label>
          Beat Spot: potong tiap
          <select aria-label={`Preset ${n} tiap ketukan`} value={p.beat?.tiap_ketukan ?? ''} onChange={(e) => setBeat('tiap_ketukan', numOrUndef(e.target.value))}>
            <option value="">bawaan</option>
            <option value="1">1 ketukan</option>
            <option value="2">2 ketukan</option>
            <option value="4">4 ketukan</option>
          </select>
        </label>
        {field('Beat Spot: BPM (60–200)', `Preset ${n} BPM`, p.beat?.bpm, 1, 60, 200, (v) => setBeat('bpm', v))}
      </div>
    </details>
  );
}

/** Audio for one job (R18 §17.2); '' = engine default. Shared by Video iklan, Batch, Beat Spot. */
export function AudioPilihanSelect({ value, onChange, bawaan }: { value: '' | 'vo' | 'musik' | 'keduanya'; onChange: (v: '' | 'vo' | 'musik' | 'keduanya') => void; bawaan: string }) {
  return (
    <label>
      Audio
      <select aria-label="Audio" value={value} onChange={(e) => onChange(e.target.value as '' | 'vo' | 'musik' | 'keduanya')}>
        <option value="">Otomatis ({bawaan})</option>
        <option value="vo">Voice over (tanpa musik)</option>
        <option value="musik">Musik (tanpa voice over)</option>
        <option value="keduanya">Keduanya (musik di bawah voice over)</option>
      </select>
    </label>
  );
}
