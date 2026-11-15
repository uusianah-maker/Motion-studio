import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Api, type KirimPic } from '../api';

/**
 * R19 "Kirim ke PIC" (owner: "Ya, buat"): one click renders the newest revision; when done the video
 * waits in 3. Setujui as "Revisi n". The same revision is not sent twice. Owner / Editor only.
 */
export function KirimPicButton({ api, projectId, revision, onChanged }: { api: Api; projectId: string; revision: number; onChanged?: () => void }) {
  const [kirim, setKirim] = useState<KirimPic | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.kirimPicStatus(projectId);
      setKirim(r.kirim);
      return r.kirim;
    } catch {
      return null;
    }
  }, [api, projectId]);
  useEffect(() => {
    setKirim(null);
    setNote(null);
    void load();
  }, [load]);
  // While rendering, look every 2 s; tell the editor when it is done (the project may have changed).
  const rendering = kirim?.state === 'merender';
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => {
      void load().then((k) => {
        if (k && k.state !== 'merender') onChanged?.();
      });
    }, 2000);
    return () => clearInterval(t);
  }, [rendering, load, onChanged]);

  const send = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.kirimPic(projectId, revision);
      setKirim(r.kirim);
      if (r.revision !== revision) onChanged?.(); // a variant's old approval was withdrawn (new revision)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SUDAH_DIKIRIM') setNote({ text: 'Sudah dikirim, tidak ada perubahan sejak kiriman terakhir.' });
      else setNote({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const sentThis = kirim && kirim.revision === revision;
  const label = busy ? 'Mengirim…' : rendering ? 'Merender…' : sentThis && kirim?.state === 'terkirim' ? 'Terkirim ke PIC ✓' : 'Kirim ke PIC';
  return (
    <span className="kirimPic" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button className="btn" disabled={busy || rendering} onClick={() => void send()} title="Render versi terbaru lalu masukkan ke antrean 3. Setujui (PIC)" aria-label="Kirim ke PIC">
        ➤ {label}
      </button>
      {kirim?.state === 'gagal' && sentThis && (
        <span className="badge bad" role="status" aria-label="Status kirim ke PIC">
          Gagal: {kirim.alasan}
        </span>
      )}
      {kirim?.state === 'terkirim' && (
        <span className="muted small" role="status" aria-label="Status kirim ke PIC">
          {sentThis ? `Revisi ${kirim.kiriman} di antrean PIC` : `Kiriman terakhir: revisi proyek ${kirim.revision}`}
        </span>
      )}
      {note && (
        <span className={`small ${note.bad ? 'badge bad' : 'muted'}`} role="status" aria-label="Pesan kirim ke PIC">
          {note.text}
        </span>
      )}
    </span>
  );
}
