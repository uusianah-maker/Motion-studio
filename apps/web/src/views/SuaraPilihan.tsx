import { useEffect, useId } from 'react';
import type { Api, BrandKit, JobVo } from '../api';
import { useSoundPreview } from '../audioPreview';

/**
 * R37 "Suara: dari footage | VO dari Library" (KONTRAK-ENGINE §22) for Video iklan, Batch Remix and
 * Beat Spot. A brand VO (Brand → Aset jenis VO, made with "Suara dari Teks") becomes the main
 * voice; its subtitles come from the known text (no Whisper); the footage is the picture. The
 * engine refuses "musik saja" together with a VO, so that choice is cleared here.
 */
export function SuaraPilihan({ api, kit, value, onChange, audio, setAudio }: { api: Api; kit: BrandKit | null; value: JobVo | null; onChange: (v: JobVo | null) => void; audio: '' | 'vo' | 'musik' | 'keduanya'; setAudio: (a: '' | 'vo' | 'musik' | 'keduanya') => void }) {
  const sound = useSoundPreview(api);
  // Pages stay mounted side by side: each needs its own radio group name.
  const group = useId();
  const vos = (kit?.aset ?? []).filter((a) => a.jenis === 'vo');
  // Another brand → its own VO list: a VO that is not there any more is dropped.
  useEffect(() => {
    if (value && kit && !kit.aset.some((a) => a.id === value.aset && a.jenis === 'vo')) onChange(null);
  }, [kit, value, onChange]);
  useEffect(() => {
    if (value && audio === 'musik') setAudio('');
  }, [value, audio, setAudio]);
  const chosen = value ? vos.find((a) => a.id === value.aset) : null;
  return (
    <div className="inspFull suaraPilihan" role="group" aria-label="Sumber suara">
      <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
        <b className="small">Suara</b>
        <label className="inline">
          <input type="radio" name={group} aria-label="Suara dari footage" checked={!value} onChange={() => onChange(null)} /> dari footage
        </label>
        <label className="inline" title={vos.length ? undefined : 'Belum ada VO di Aset brand. Buat lewat "Suara dari Teks".'}>
          <input type="radio" name={group} aria-label="VO dari Library" checked={!!value} disabled={!vos.length} onChange={() => vos[0] && onChange({ aset: vos[0].id, suara_footage: 'mati', subtitle: true })} /> VO dari Library
        </label>
        {!vos.length && <span className="muted small">Belum ada VO di Aset brand (buat lewat "Suara dari Teks").</span>}
      </div>
      {value && (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <select aria-label="Pilih VO" value={value.aset} onChange={(e) => onChange({ ...value, aset: e.target.value })}>
            {vos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nama || a.id}
              </option>
            ))}
          </select>
          {chosen && (
            <button className="tiny" aria-label={`${sound.playing === chosen.ref.version_id ? 'Hentikan' : 'Dengar'} VO`} aria-pressed={sound.playing === chosen.ref.version_id} onClick={() => sound.toggle(chosen.ref.version_id)}>
              {sound.playing === chosen.ref.version_id ? '■' : '▶'}
            </button>
          )}
          <label className="inline">
            Suara footage
            <select aria-label="Suara footage" value={value.suara_footage} onChange={(e) => onChange({ ...value, suara_footage: e.target.value as JobVo['suara_footage'] })}>
              <option value="mati">mati</option>
              <option value="pelan">pelan (suasana 15 %)</option>
              <option value="asli">asli</option>
            </select>
          </label>
          <label className="inline">
            <input type="checkbox" aria-label="Subtitle dari teks VO" checked={value.subtitle} onChange={(e) => onChange({ ...value, subtitle: e.target.checked })} /> Subtitle dari teks VO
          </label>
          <span className="muted small">Subtitle diambil dari teks VO (tanpa Whisper). Audio "musik saja" tidak bisa dipakai bersama VO.</span>
        </div>
      )}
    </div>
  );
}
