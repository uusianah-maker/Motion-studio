import { useEffect, useState } from 'react';
import type { Api, BrandKitInput, KamusBelajarPasangan } from '../api';

/**
 * R36 Brand → C "Dipelajari dari koreksi editor": words the team corrected in engine subtitles
 * (core kamusBelajar). "otomatis dipakai" pairs already go to the next job's Whisper fixes;
 * "usulan" pairs wait for the team. "Tambah ke kamus" moves a pair into the Brand Kit dictionary,
 * "Abaikan" stops it for good (kamus_abaikan) — both are draft changes saved with "Simpan Brand Kit"
 * (hybrid: the team decides, every automatic choice can be changed).
 */
export function KamusBelajar({ api, brandId, revision, draft, set }: { api: Api; brandId: string | null; revision: number | null; draft: BrandKitInput; set: (patch: Partial<BrandKitInput>) => void }) {
  const [list, setList] = useState<KamusBelajarPasangan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    if (!brandId) return;
    api.kamusBelajar(brandId).then(
      (r) => live && setList(r.pasangan),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, brandId, revision]);
  if (!brandId) return null;
  const inKamus = new Set(draft.kamus.map((k) => k.salah.trim().toLowerCase()));
  const ignored = new Set((draft.kamus_abaikan ?? []).map((w) => w.toLowerCase()));
  const shown = (list ?? []).filter((p) => !inKamus.has(p.salah.toLowerCase()) && !ignored.has(p.salah.toLowerCase()));
  return (
    <div className="kamusBelajar" role="group" aria-label="Dipelajari dari koreksi editor">
      <b className="small">Dipelajari dari koreksi editor</b>
      <div className="muted small">Kata yang dibetulkan tim di subtitle mesin. "Otomatis dipakai" langsung masuk ke job berikutnya; "usulan" menunggu keputusan tim.</div>
      {error && <div className="notice err small">{error}</div>}
      {list && !shown.length && <div className="muted small">Belum ada koreksi baru dari editor.</div>}
      {shown.map((p) => (
        <div key={p.salah} className="row wrap kamusRow" role="group" aria-label={`Belajar ${p.salah}`} style={{ gap: 6, alignItems: 'center' }}>
          <span className="kamusPair">
            <s>{p.salah}</s> → <b>{p.benar}</b>
          </span>
          <span className={`badge ${p.otomatis ? 'ok' : 'warn'}`}>{p.otomatis ? 'otomatis dipakai' : 'usulan'}</span>
          <span className="muted small">{p.kali}× dibetulkan</span>
          <span className="spacer" />
          <button className="btn small" aria-label={`Tambah ${p.salah} ke kamus`} onClick={() => set({ kamus: [...draft.kamus, { salah: p.salah, benar: p.benar }] })}>
            Tambah ke kamus
          </button>
          <button className="btn small" aria-label={`Abaikan ${p.salah}`} onClick={() => set({ kamus_abaikan: [...(draft.kamus_abaikan ?? []), p.salah.toLowerCase()] })}>
            Abaikan
          </button>
        </div>
      ))}
      {(draft.kamus_abaikan ?? []).length > 0 && (
        <div className="row wrap" style={{ gap: 4, alignItems: 'center' }} aria-label="Kata yang diabaikan">
          <span className="muted small">Diabaikan:</span>
          {(draft.kamus_abaikan ?? []).map((w) => (
            <button key={w} className="chip tiny" aria-label={`Batal abaikan ${w}`} title="Klik untuk tidak mengabaikan lagi" onClick={() => set({ kamus_abaikan: (draft.kamus_abaikan ?? []).filter((x) => x !== w) })}>
              {w} ✕
            </button>
          ))}
        </div>
      )}
      {(list?.length ?? 0) > 0 && <div className="muted small">Perubahan berlaku setelah Simpan Brand Kit.</div>}
    </div>
  );
}
