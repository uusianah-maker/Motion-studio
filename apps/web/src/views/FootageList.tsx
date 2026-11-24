import { useEffect, useRef, useState } from 'react';

/**
 * §26 Video Iklan: the footage of one ad, in the order the engine joins them. Pick several at once,
 * add more later, move up / down, remove one by one. Durations are read in the browser (video
 * metadata) so the team sees the joined length before anything is uploaded.
 */
export interface Footage {
  id: string;
  file: File;
}

export const MAKS_FOOTAGE = 20;
const sama = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
const dtk = (n: number) => `${n.toFixed(1).replace('.', ',')} dtk`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
let seq = 0;

/** Add picked files after the current list: same file twice is skipped, the list stops at the limit. */
export function tambahFootage(cur: readonly Footage[], picked: readonly File[]): { list: Footage[]; dilewati: string[] } {
  const list = [...cur];
  const dilewati: string[] = [];
  for (const f of picked) {
    if (list.some((x) => sama(x.file, f))) dilewati.push(`${f.name} sudah ada di daftar`);
    else if (list.length >= MAKS_FOOTAGE) dilewati.push(`${f.name}: maksimal ${MAKS_FOOTAGE} footage`);
    else list.push({ id: `f${++seq}`, file: f });
  }
  return { list, dilewati };
}

/** Move item `i` by `d` (-1 up, +1 down); out of range = unchanged. */
export function geser<T>(list: readonly T[], i: number, d: number): T[] {
  const j = i + d;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Video length in seconds from the browser (null = unreadable here; the engine still checks it). */
function useDurasi(list: readonly Footage[]): Record<string, number | null> {
  const [dur, setDur] = useState<Record<string, number | null>>({});
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const f of list) {
      if (seen.current.has(f.id)) continue;
      seen.current.add(f.id);
      const url = URL.createObjectURL(f.file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      const done = (n: number | null) => {
        URL.revokeObjectURL(url);
        setDur((d) => ({ ...d, [f.id]: n }));
      };
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
      v.onerror = () => done(null);
      v.src = url;
    }
  }, [list]);
  return dur;
}

export function FootageList({ value, onChange, disabled = false }: { value: Footage[]; onChange: (v: Footage[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string[]>([]);
  const dur = useDurasi(value);
  // Cleared from outside (a job started): the hidden picker forgets the old files too.
  useEffect(() => {
    if (!value.length && ref.current) ref.current.value = '';
  }, [value.length]);
  const known = value.map((f) => dur[f.id]);
  const total = known.every((d) => typeof d === 'number') ? (known as number[]).reduce((a, b) => a + b, 0) : null;
  return (
    <div className="footageList">
      <label>
        Video bicara
        <input
          ref={ref}
          aria-label="Video bicara"
          type="file"
          accept="video/*"
          multiple
          disabled={disabled}
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = ''; // the same file can be picked again after it was removed
            if (!picked.length) return;
            const r = tambahFootage(value, picked);
            setNote(r.dilewati);
            onChange(r.list);
          }}
        />
      </label>
      <span className="muted small">
        Boleh pilih beberapa file sekaligus (Ctrl/Shift + klik) atau tambah lagi nanti. Mesin menggabungkannya sesuai urutan di bawah jadi satu video.
      </span>
      {note.map((n) => (
        <div key={n} className="notice warn small">
          {n}
        </div>
      ))}
      {value.length > 0 && (
        <ol className="footageItems" aria-label="Daftar footage">
          {value.map((f, i) => (
            <li key={f.id} aria-label={`Footage ${i + 1}: ${f.file.name}`}>
              <span className="footageNo">{i + 1}</span>
              <span className="footageName" title={f.file.name}>
                {f.file.name}
              </span>
              <span className="muted small">
                {dur[f.id] === undefined ? '…' : dur[f.id] === null ? 'durasi ?' : dtk(dur[f.id]!)} · {mb(f.file.size)}
              </span>
              <span className="spacer" />
              <button type="button" className="btn small" aria-label={`Naikkan footage ${i + 1}`} disabled={disabled || i === 0} onClick={() => onChange(geser(value, i, -1))}>
                ↑
              </button>
              <button type="button" className="btn small" aria-label={`Turunkan footage ${i + 1}`} disabled={disabled || i === value.length - 1} onClick={() => onChange(geser(value, i, 1))}>
                ↓
              </button>
              <button type="button" className="btn small danger" aria-label={`Hapus footage ${i + 1}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x.id !== f.id))}>
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
      {value.length > 1 && (
        <div className="small" aria-label="Total footage">
          {value.length} footage digabung · total {total === null ? '…' : dtk(total)}
        </div>
      )}
    </div>
  );
}
