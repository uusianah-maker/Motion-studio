import { useEffect, useState } from 'react';
import { reframeCanvas, reframeKeyframes, visualEstimate } from '../../../../packages/core/dist/storage/visualCalc.js';
import type { Api, Clip, EditOp, VisualView } from '../api';
import { useEngineJob } from './GenerateView';

type Ref = { media_id: string; version_id: string };
const menit = (s: number) => (s < 60 ? `±${Math.max(1, Math.round(s))} dtk` : `±${Math.round(s / 60)} menit`);

/**
 * R35 Visual Tools (owner 16 Nov; KONTRAK-ENGINE §18.10). Per video/b-roll/image clip:
 * "Hapus latar" and "Perjelas (AI)" run as background engine jobs (low priority, one at a time,
 * cancellable) on THIS PC. The result lands in Media; "Pakai di klip ini" swaps the clip's file
 * (one undo), "Kembalikan asli" swaps it back — the AI result is only a suggestion (hybrid).
 */
export function VisualToolsPanel({ api, projectId, clip, video, durasiS, locked, edit, ratio = '9:16' }: { api: Api; projectId: string; clip: Clip; video: boolean; durasiS: number; locked: boolean; edit: (ops: EditOp[]) => Promise<void> | void; ratio?: string }) {
  const [kualitas, setKualitas] = useState<'cepat' | 'tinggi'>(video ? 'cepat' : 'tinggi');
  const [mode, setMode] = useState<'cepat' | 'kualitas'>(video ? 'cepat' : 'kualitas');
  const [current, setCurrent] = useState<{ job_id: string; alat: 'hapus_latar' | 'perjelas' } | null>(null);
  const [result, setResult] = useState<VisualView | null>(null);
  const [orig, setOrig] = useState<Ref | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job } = useEngineJob(api, current ? projectId : null, current?.job_id ?? null);
  useEffect(() => {
    if (!current || job?.state !== 'siap' || job.job_id !== current.job_id || result?.job_id === current.job_id) return;
    void api.visualResult(projectId, current.job_id).then(setResult, (e) => setError(String((e as Error).message ?? e)));
  }, [api, projectId, current, job?.state, job?.job_id, result?.job_id]);
  const tooLong = video && durasiS > 15;
  const run = async (alat: 'hapus_latar' | 'perjelas') => {
    if (!clip.media) return;
    setError(null);
    setResult(null);
    try {
      const j = await api.engineVisual(projectId, clip.media, alat === 'hapus_latar' ? { alat, kualitas } : { alat, mode, skala: mode === 'kualitas' ? 4 : 2 });
      setCurrent({ job_id: j.job_id, alat });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const running = !!job && (job.state === 'menunggu' || job.state === 'berjalan');
  const use = async () => {
    if (!result?.hasil || !clip.media) return;
    setOrig(clip.media);
    await edit([{ op: 'set_media', clip_id: clip.clip_id, media: result.hasil }]);
  };
  const back = async () => {
    if (!orig) return;
    await edit([{ op: 'set_media', clip_id: clip.clip_id, media: orig }]);
    setOrig(null);
  };

  return (
    <section className="inspector" aria-label="Alat AI">
      <div className="inspHead">
        <b>Alat AI</b>
        <span className="muted small">di PC ini, tanpa biaya</span>
      </div>
      {video && <ReframeTool api={api} projectId={projectId} clip={clip} ratio={ratio} locked={locked} tooLong={tooLong} edit={edit} />}
      {tooLong && <div className="notice warn small">Klip video maksimal 15 dtk untuk alat AI. Potong klipnya dulu.</div>}
      <div className="inspGrid" role="group" aria-label="Hapus latar">
        <label>
          Hapus latar
          <select aria-label="Kualitas hapus latar" value={kualitas} onChange={(e) => setKualitas(e.target.value as 'cepat' | 'tinggi')}>
            <option value="cepat">Cepat</option>
            <option value="tinggi">Kualitas tinggi (lambat)</option>
          </select>
        </label>
        <div className="inspFull">
          <span className="muted small">Perkiraan {menit(visualEstimate('hapus_latar', { video, durasi_s: durasiS, kualitas }))}</span>
          <button type="button" className="btn small" disabled={locked || running || tooLong} onClick={() => void run('hapus_latar')}>
            ✂ Hapus latar
          </button>
        </div>
      </div>
      <div className="inspGrid" role="group" aria-label="Perjelas">
        <label>
          Perjelas (AI)
          <select aria-label="Mode perjelas" value={mode} onChange={(e) => setMode(e.target.value as 'cepat' | 'kualitas')}>
            <option value="cepat">Cepat ×2</option>
            <option value="kualitas">Kualitas ×4 (lambat)</option>
          </select>
        </label>
        <div className="inspFull">
          <span className="muted small">Perkiraan {menit(visualEstimate('perjelas', { video, durasi_s: durasiS, mode }))}</span>
          <button type="button" className="btn small" disabled={locked || running || tooLong} onClick={() => void run('perjelas')}>
            ✦ Perjelas
          </button>
        </div>
      </div>
      {job && current && (
        <div className="notice info small" role="status" aria-label="Status alat AI" data-state={job.state}>
          {current.alat === 'hapus_latar' ? 'Hapus latar' : 'Perjelas'} · {job.state === 'siap' ? 'selesai' : job.state === 'gagal' || job.state === 'ditolak' ? `${job.state}: ${job.alasan ?? ''}` : `${job.tahap} ${job.persen}%`}{' '}
          {running && (
            <button type="button" className="btn small" onClick={() => void api.engineCancel(projectId, current.job_id).catch(() => undefined)}>
              Batal
            </button>
          )}
        </div>
      )}
      {error && <div className="notice warn small">{error}</div>}
      {result?.hasil && (
        <div className="notice ok small" role="status" aria-label="Hasil alat AI">
          {result.alat === 'hapus_latar' ? 'Latar terhapus' : 'Gambar diperjelas'} — tersimpan di Media
          {Array.isArray(result.info.jadi) ? ` (${(result.info.jadi as number[]).join('×')})` : ''}.{' '}
          {orig ? (
            <button type="button" className="btn small" disabled={locked} onClick={() => void back()}>
              ↩ Kembalikan asli
            </button>
          ) : (
            <button type="button" className="btn small" disabled={locked || clip.media?.version_id === result.hasil.version_id} onClick={() => void use()}>
              Pakai di klip ini
            </button>
          )}
          {result.alat === 'hapus_latar' && <div className="muted">Bagian transparan tampil hitam di render sampai ditumpuk di atas video lewat Overlay (R26).</div>}
        </div>
      )}
    </section>
  );
}

/**
 * R23g / R35b Auto reframe (KONTRAK-ENGINE §18.2/§18.10): detect the face/subject, then the engine's
 * AutoFlip-style crop path → keyframes on THIS clip (position + scale). The keyframes are a
 * suggestion: move / delete them in "Keyframe (gerak)", or remove them all here (one undo).
 */
function ReframeTool({ api, projectId, clip, ratio, locked, tooLong, edit }: { api: Api; projectId: string; clip: Clip; ratio: string; locked: boolean; tooLong: boolean; edit: (ops: EditOp[]) => Promise<void> | void }) {
  const [jenis, setJenis] = useState<'wajah' | 'objek'>('wajah');
  const [step, setStep] = useState<{ fase: 'deteksi' | 'reframe'; job_id: string } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job } = useEngineJob(api, step ? projectId : null, step?.job_id ?? null);
  useEffect(() => {
    if (!step || job?.job_id !== step.job_id) return;
    if (job.state === 'gagal' || job.state === 'ditolak') {
      setError(`${step.fase === 'deteksi' ? 'Deteksi' : 'Reframe'} ${job.state}: ${job.alasan ?? ''}`);
      setStep(null);
      return;
    }
    if (job.state !== 'siap' || !clip.media) return;
    if (step.fase === 'deteksi') {
      void api
        .engineVisual(projectId, clip.media, { alat: 'reframe', jalur_job: step.job_id, rasio: ratio, kanvas: reframeCanvas(ratio), fit: clip.fit === 'isi' ? 'isi' : 'pas', awal_ms: clip.in_ms ?? 0 })
        .then((j) => setStep({ fase: 'reframe', job_id: j.job_id }), (e) => (setError(String((e as Error).message ?? e)), setStep(null)));
    } else {
      void api.visualResult(projectId, step.job_id).then(
        async (r) => {
          const kfs = reframeKeyframes(r.data?.keyframe_app, clip.end_ms - clip.start_ms);
          setStep(null);
          if (!kfs.length) return setError('Tidak ada wajah/subjek yang bisa diikuti di klip ini');
          await edit([{ op: 'set_keyframes', clip_id: clip.clip_id, keyframes: kfs }]);
          setDone(kfs.length);
        },
        (e) => (setError(String((e as Error).message ?? e)), setStep(null)),
      );
    }
  }, [job?.state, job?.job_id]);
  const start = async () => {
    if (!clip.media) return;
    setError(null);
    setDone(null);
    try {
      const j = await api.engineVisual(projectId, clip.media, { alat: 'deteksi', jenis: [jenis] });
      setStep({ fase: 'deteksi', job_id: j.job_id });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const busy = !!step;
  return (
    <div className="inspGrid" role="group" aria-label="Auto reframe">
      <label>
        Auto reframe ({ratio})
        <select aria-label="Ikuti" value={jenis} onChange={(e) => setJenis(e.target.value as 'wajah' | 'objek')}>
          <option value="wajah">Ikuti wajah</option>
          <option value="objek">Ikuti orang / objek</option>
        </select>
      </label>
      <div className="inspFull">
        <span className="muted small">{busy ? (step!.fase === 'deteksi' ? `Mendeteksi… ${job?.persen ?? 0}%` : `Menyusun bingkai… ${job?.persen ?? 0}%`) : 'Bingkai otomatis mengikuti subjek'}</span>
        <button type="button" className="btn small" disabled={locked || busy || tooLong} onClick={() => void start()}>
          🎯 Auto reframe
        </button>
      </div>
      {error && <div className="notice warn small">{error}</div>}
      {done !== null && (
        <div className="notice ok small" role="status" aria-label="Hasil reframe">
          {done} keyframe dipasang (atur di &quot;Keyframe (gerak)&quot;).{' '}
          <button type="button" className="btn small" disabled={locked} onClick={() => void Promise.resolve(edit([{ op: 'set_keyframes', clip_id: clip.clip_id, keyframes: [] }])).then(() => setDone(null))}>
            Hapus keyframe reframe
          </button>
        </div>
      )}
    </div>
  );
}
