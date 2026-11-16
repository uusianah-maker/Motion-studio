import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, EngineJob, Media, ProjectSummary, Role, SuaraOwnerList, SuaraProfilView } from '../api';
import { mediaKind } from '../lib';
import { ErrorNotice } from '../ui';
import { ENGINE_STATE, useEngineJob } from './GenerateView';

/** The project that holds the owner's voice jobs (one profile per workspace, contract §23). */
export const SUARA_OWNER_PROJECT = 'Suara owner (latihan)';
const TARGET: [number, number] = [600, 900];
const MINIMAL = 300;
const menit = (s: number) => `${(s / 60).toFixed(1).replace('.', ',')} mnt`;

/**
 * A browser recording (webm/opus from MediaRecorder) has no duration in its header, so the server
 * cannot probe it: decode it here and hand over a plain WAV (mono, 16-bit) instead.
 */
async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i]! += d[i]! / buf.numberOfChannels;
    }
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o: number, t: string) => [...t].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    out.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i]!)) * 0x7fff, true);
    return new Blob([out.buffer], { type: 'audio/wav' });
  } finally {
    void ctx.close();
  }
}

/** One sample / example take, played through a short-lived stream link (loaded on demand). */
function Dengar({ api, versionId, label }: { api: Api; versionId: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  if (url) return <audio controls autoPlay preload="none" src={url} aria-label={label} style={{ height: 30, maxWidth: 220 }} />;
  return (
    <button type="button" className="soPlay" aria-label={label} title="Dengar" onClick={() => void api.streamUrl(versionId).then((r) => setUrl(r.url), () => undefined)}>
      ▶
    </button>
  );
}

/**
 * "Suara owner" (owner 16 Nov; KONTRAK-ENGINE §23, engine by yuki): the owner's voice samples
 * (upload, pick from Media, or record in the browser), a quality check, "Latih suara" (hours,
 * runs on the office PC) and example takes. Once trained, "Suara owner" appears in the voice list
 * of "Dari teks" by itself (the engine lists it as `owner:Suara owner`).
 */
export function SuaraOwnerPanel({ api, role = 'owner', projects, onProjectsChanged }: { api: Api; role?: Role; projects: ProjectSummary[]; onProjectsChanged?: () => void }) {
  const [list, setList] = useState<SuaraOwnerList | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [current, setCurrent] = useState<{ project_id: string; job_id: string } | null>(null);
  const [report, setReport] = useState<SuaraProfilView | null>(null);
  const [recording, setRecording] = useState<{ rec: MediaRecorder; started: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewer = role === 'reviewer';
  const host = projects.find((p) => !p.error && p.status !== 'archived' && p.name === SUARA_OWNER_PROJECT) ?? null;
  const { job } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  const reload = useCallback(async () => {
    const [l, m] = await Promise.all([api.suaraOwner(), api.media({ scope: 'all' })]);
    setList(l);
    setMedia(m);
  }, [api]);
  useEffect(() => {
    reload().catch(setError);
  }, [reload]);
  // The newest check/training job of the host project (survives a page reload).
  useEffect(() => {
    if (!host || current) return;
    void api.engineJobs(host.project_id).then((jobs) => {
      const last = jobs.filter((j: EngineJob) => j.mode === 'suara_profil').sort((a, b) => b.created_at - a.created_at)[0];
      if (last) setCurrent({ project_id: last.project_id, job_id: last.job_id });
    }, setError);
  }, [api, host?.project_id, current]);
  useEffect(() => {
    if (!current || !job || job.job_id !== current.job_id || (job.state !== 'siap' && job.state !== 'ditolak') || report?.job_id === job.job_id) return;
    void api.suaraProfilResult(current.project_id, current.job_id).then(setReport, () => setReport(null));
    if (job.state === 'siap') void reload().catch(() => undefined); // example takes joined Media
  }, [api, current, job?.state, job?.job_id, report?.job_id, reload]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [recording]);

  const byId = new Map(media.map((m) => [m.media_id, m]));
  const versionOf = (m: Media | undefined) => m?.versions.find((v) => v.version_id === m.current_version_id);
  const rows = (list?.contoh ?? []).map((c) => {
    const m = byId.get(c.media_id);
    const v = versionOf(m);
    return { ref: c, name: m?.display_name ?? c.media_id, durasi: (v?.probe?.duration_ms ?? 0) / 1000, cek: report?.contoh.find((x) => x.media_id === c.media_id) ?? null };
  });
  const totalRaw = rows.reduce((a, r) => a + r.durasi, 0);
  const totalClean = report?.durasi_bersih_total ?? null;
  const counted = totalClean ?? totalRaw;
  const inList = new Set(rows.map((r) => r.ref.media_id));
  const candidates = media.filter((m) => {
    const k = mediaKind(versionOf(m)?.probe);
    return (k === 'audio' || k === 'video') && !inList.has(m.media_id) && !!versionOf(m)?.probe?.audio_codec && versionOf(m)?.lifecycle === 'active';
  });
  const running = job && current && job.job_id === current.job_id && (job.state === 'menunggu' || job.state === 'berjalan');
  const engineMissing = job?.state === 'gagal' && /tidak dikenal|unknown|invalid choice|belum (ada|tersedia)|no such/i.test(job.alasan ?? '');

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const addRefs = async (refs: { media_id: string; version_id: string }[]) => {
    setList(await api.suaraOwnerAdd(refs));
    setMedia(await api.media({ scope: 'all' }));
  };
  const upload = (files: FileList | null) =>
    files?.length &&
    run('unggah', async () => {
      const refs = [];
      for (const f of Array.from(files)) {
        const r = await api.importFile(f, { kind: 'shared' });
        refs.push({ media_id: r.media_id, version_id: r.version.version_id });
      }
      await addRefs(refs);
    });
  const startRecording = () =>
    run('rekam', async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
        void run('unggah', async () => {
          const file = new File([await toWav(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))], `Rekaman suara owner ${stamp}.wav`, { type: 'audio/wav' });
          const r = await api.importFile(file, { kind: 'shared' });
          await addRefs([{ media_id: r.media_id, version_id: r.version.version_id }]);
        });
      };
      rec.start(1000);
      setRecording({ rec, started: Date.now() });
    });
  const stopRecording = () => {
    recording?.rec.stop();
    setRecording(null);
  };
  const train = (latih: boolean) =>
    run(latih ? 'latih' : 'periksa', async () => {
      let pid = host?.project_id;
      if (!pid) {
        pid = (await api.createProject(SUARA_OWNER_PROJECT, 'editor')).project_id;
        onProjectsChanged?.();
      }
      const j = await api.suaraProfil(pid, list?.contoh ?? [], latih, list?.dihapus ?? []);
      setReport(null);
      setCurrent({ project_id: pid, job_id: j.job_id });
      setList(await api.suaraOwner());
    });

  const pct = Math.min(100, Math.round((counted / TARGET[0]) * 100));
  return (
    <div className="body enginePage">
      {error ? <ErrorNotice error={error} /> : null}
      {reviewer && <div className="notice info">Peran Reviewer hanya melihat. Contoh suara dan latihan oleh Editor / Owner.</div>}
      <section className="card" aria-label="Contoh suara owner">
        <h3 style={{ marginTop: 0 }}>Suara owner</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Kumpulkan rekaman suara owner yang bersih (bicara biasa, tanpa musik, tanpa suara orang lain), total 10–15 menit. Lalu tekan Latih suara. Setelah jadi, &quot;Suara owner&quot; muncul di pilihan suara Dari teks.
        </p>
        <div aria-label="Terkumpul" style={{ margin: '8px 0 12px' }}>
          <div className="small">
            Terkumpul <b>{menit(counted)}</b> dari 10–15 mnt{totalClean !== null ? ' (bersih, hasil periksa mesin)' : ' (durasi file; bagian bersih dihitung saat diperiksa)'}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: '#262d3a', overflow: 'hidden', marginTop: 4 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: counted >= TARGET[0] ? '#5bafa2' : counted >= MINIMAL ? '#f6d67c' : '#8870b1' }} />
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept="audio/*,video/*" multiple hidden aria-label="File contoh suara" onChange={(e) => void upload(e.target.files)} />
          <button type="button" className="btn primary" disabled={reviewer || !!busy} onClick={() => fileRef.current?.click()}>
            ＋ Tambahkan contoh suara
          </button>
          {recording ? (
            <button type="button" className="btn" onClick={stopRecording} aria-label="Berhenti merekam">
              ⏹ Berhenti ({Math.floor((now - recording.started) / 1000)} dtk)
            </button>
          ) : (
            <button type="button" className="btn" disabled={reviewer || !!busy || typeof MediaRecorder === 'undefined'} onClick={() => void startRecording()} title="Rekam langsung lewat mikrofon laptop/HP">
              🎙 Rekam
            </button>
          )}
          <select aria-label="Pilih dari Media" value={pick} disabled={reviewer || !!busy || !candidates.length} onChange={(e) => setPick(e.target.value)}>
            <option value="">{candidates.length ? 'Pilih dari Media…' : 'Media audio/video tidak ada'}</option>
            {candidates.map((m) => (
              <option key={m.media_id} value={m.media_id}>
                {m.display_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={reviewer || !!busy || !pick}
            onClick={() => {
              const m = byId.get(pick);
              if (m) void run('pilih', () => addRefs([{ media_id: m.media_id, version_id: m.current_version_id }]).then(() => setPick('')));
            }}
          >
            Tambahkan
          </button>
          {busy === 'unggah' && <span className="muted small">Mengunggah…</span>}
        </div>
        {rows.length === 0 ? (
          <div className="empty">Belum ada contoh suara.</div>
        ) : (
          <table className="list small" aria-label="Daftar contoh suara" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>CONTOH</th>
                <th>DURASI</th>
                <th>MUTU</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ref.media_id}>
                  <td>
                    <Dengar api={api} versionId={r.ref.version_id} label={`Dengar ${r.name}`} /> {r.name}
                  </td>
                  <td>{r.durasi ? `${Math.round(r.durasi)} dtk` : '–'}</td>
                  <td>
                    {!r.cek ? (
                      <span className="muted">belum diperiksa</span>
                    ) : r.cek.dipakai ? (
                      <span className="badge ok">dipakai{r.cek.snr_db !== null ? ` · SNR ${r.cek.snr_db} dB` : ''}</span>
                    ) : (
                      <span className="badge bad" title={r.cek.alasan}>
                        tidak dipakai{r.cek.musik ? ' · ada musik' : ''}{r.cek.clipping ? ' · pecah' : ''}{r.cek.alasan ? ` · ${r.cek.alasan}` : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="linkBtn small" disabled={reviewer || !!busy} aria-label={`Hapus contoh ${r.name}`} onClick={() => void run('hapus', async () => setList(await api.suaraOwnerRemove(r.ref.media_id)))}>
                      Hapus
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={reviewer || !!busy || !!running || (!rows.length && !list?.dihapus.length)} onClick={() => void train(false)} title="Mesin memeriksa mutu tiap contoh (bersih, tanpa musik); belum melatih">
            Periksa mutu
          </button>
          <button type="button" className="btn primary" disabled={reviewer || !!busy || !!running || counted < MINIMAL} onClick={() => void train(true)} title={counted < MINIMAL ? 'Butuh minimal 5 menit suara bersih' : 'Melatih makan waktu ±1–2 jam di PC kantor'}>
            Latih suara
          </button>
          {counted < MINIMAL && <span className="muted small">Latih butuh minimal 5 mnt suara bersih.</span>}
        </div>
      </section>

      {job && current && job.job_id === current.job_id && (
        <section className="card" aria-label="Status latihan suara" data-state={job.state}>
          {engineMissing ? (
            <div className="notice warn">Mesin Suara owner belum tersedia di server (sedang dipasang). Contoh suara tetap tersimpan; coba lagi nanti.</div>
          ) : (
            <div className="small">
              <b>{ENGINE_STATE[job.state]}</b>
              {job.state === 'berjalan' && ` · ${job.tahap}${job.persen ? ` ${job.persen}%` : ''}`}
              {job.state === 'gagal' || job.state === 'ditolak' ? ` · ${job.alasan ?? ''}` : ''}
              {job.state === 'berjalan' && job.tahap === 'latih' && <span className="muted"> · melatih bisa ±1–2 jam; halaman boleh ditutup.</span>}
            </div>
          )}
          {report && (
            <div className="small" style={{ marginTop: 8 }}>
              {report.status === 'siap' && <div className="notice ok">Suara owner siap{report.dilatih_pada ? ` (dilatih ${report.dilatih_pada.replace('T', ' ').slice(0, 16)})` : ''}. Pilih &quot;Suara owner&quot; di tab Dari teks.</div>}
              {report.status === 'kurang_contoh' && <div className="notice info">Contoh tersimpan, belum dilatih: suara bersih {menit(report.durasi_bersih_total)} dari minimal {menit(report.minimal_dtk)}.</div>}
              {report.status === 'perlu_latih_ulang' && <div className="notice warn">Ada contoh yang dihapus sejak latihan terakhir. Tekan Latih suara lagi supaya Suara owner memakai contoh terbaru.</div>}
              {report.status === 'ditolak' && <div className="notice warn">Ditolak mesin: {report.alasan}</div>}
              {report.contoh_hasil.some((h) => h.ref) && (
                <div aria-label="Contoh hasil suara owner" style={{ marginTop: 6 }}>
                  {report.contoh_hasil.map((h, i) =>
                    h.ref ? (
                      <div key={i} className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <Dengar api={api} versionId={h.ref.version_id} label={`Dengar hasil ${i + 1}`} /> <span>&ldquo;{h.teks}&rdquo;</span>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
