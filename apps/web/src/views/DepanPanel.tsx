import { useEffect, useRef, useState } from 'react';
import type { Api, Clip, DepanStatus, EditOp } from '../api';
import { EngineProgress, useEngineJob } from './GenerateView';

const MAX_MS = 15_000;
const FPS = 15;
/** ±seconds on the office PC: picture render + 1.3 s per cut frame (§18.8 "cepat"). */
const estimate = (ms: number) => Math.round(8 + (Math.min(ms, MAX_MS) / 1000) * FPS * 1.3);
const menit = (s: number) => (s < 60 ? `±${s} dtk` : `±${Math.round(s / 60)} menit`);

/**
 * 25 Nov (owner: "auto masking untuk overlay contohnya seperti objeck yang berada di depan teks
 * highlight"). Per text/subtitle clip: "Objek di depan teks" — the engine cuts the subject (person /
 * product) out of the picture under the text and the render lays it back IN FRONT of the text.
 * Runs on this PC in the background (low priority). The result is a proposal: switch it off, soften
 * the edge, or make it again after changing the video.
 */
export function DepanPanel({ api, projectId, clip, locked, submit }: { api: Api; projectId: string; clip: Clip; locked: boolean; submit: (ops: EditOp[]) => void }) {
  const [task, setTask] = useState<DepanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const len = clip.end_ms - clip.start_ms;
  const { job, log } = useEngineJob(api, task?.job_id ? projectId : null, task?.job_id ?? null);
  const saved = useRef<string | null>(null);
  // Step 1 (picture) progress from the server.
  useEffect(() => {
    if (!task || task.state === 'mesin' || task.state === 'gagal') return;
    const t = setTimeout(() => void api.depanStatus(projectId, clip.clip_id).then(setTask, (e) => setError(String((e as Error).message ?? e))), 1500);
    return () => clearTimeout(t);
  }, [api, projectId, clip.clip_id, task]);
  // Step 3: engine done → read the mask + cut-out, save on the clip (one undo).
  useEffect(() => {
    if (!task?.job_id || job?.job_id !== task.job_id || job.state !== 'siap' || saved.current === task.job_id) return;
    saved.current = task.job_id;
    void api.visualResult(projectId, task.job_id).then(
      (r) => {
        if (!r.masker || !r.hasil) return setError('Mesin selesai tanpa masker');
        submit([{ op: 'set_depan', clip_id: clip.clip_id, depan: { masker: r.masker, potongan: r.hasil, dari_ms: task.dari_ms ?? clip.start_ms, durasi_ms: task.durasi_ms ?? Math.min(len, MAX_MS), halus: clip.depan?.halus ?? 3 } }]);
        setTask(null);
      },
      (e) => setError(String((e as Error).message ?? e)),
    );
  }, [api, projectId, clip.clip_id, clip.start_ms, clip.depan?.halus, len, job?.job_id, job?.state, task, submit]);
  const running = !!task && task.state !== 'gagal' && !(job && (job.state === 'gagal' || job.state === 'ditolak'));
  const start = async () => {
    setError(null);
    try {
      setTask(await api.depanStart(projectId, clip.clip_id));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const d = clip.depan;
  return (
    <div className="inspGrid depanPanel" role="group" aria-label="Objek di depan teks">
      <div className="inspFull">
        <b className="small">Objek di depan teks</b>
        <div className="muted small">Orang / produk di video dipotong otomatis lalu ditaruh DI DEPAN teks ini (teks seperti di belakang objek). Dibuat di PC ini, perkiraan {menit(estimate(len))}.</div>
        {len > MAX_MS && <div className="notice warn small">Teks lebih dari 15 dtk: hanya 15 dtk pertama yang diberi objek di depan.</div>}
      </div>
      {d ? (
        <>
          <label className="inspFull">
            Tepi halus {d.halus}
            <input type="range" aria-label="Tepi halus objek" min={0} max={12} key={`${clip.clip_id}:${d.halus}`} defaultValue={d.halus} disabled={locked} onPointerUp={(e) => submit([{ op: 'set_depan', clip_id: clip.clip_id, depan: { ...d, halus: Number((e.target as HTMLInputElement).value) } }])} onKeyUp={(e) => submit([{ op: 'set_depan', clip_id: clip.clip_id, depan: { ...d, halus: Number((e.target as HTMLInputElement).value) } }])} />
          </label>
          <div className="inspFull row wrap" style={{ gap: 6 }}>
            <span className="badge ok">aktif</span>
            <button className="btn small" disabled={locked || running} onClick={() => void start()} title="Buat ulang setelah video di bawah teks diganti / digeser">
              ↻ Buat ulang
            </button>
            <button className="btn small" disabled={locked} onClick={() => submit([{ op: 'set_depan', clip_id: clip.clip_id, depan: null }])}>
              ✕ Matikan
            </button>
          </div>
          {(d.dari_ms !== clip.start_ms || d.durasi_ms < Math.min(len, MAX_MS)) && <div className="inspFull muted small">Masker dibuat untuk detik {(d.dari_ms / 1000).toFixed(1).replace('.', ',')}–{((d.dari_ms + d.durasi_ms) / 1000).toFixed(1).replace('.', ',')}. Kalau teks/video digeser, klik Buat ulang.</div>}
        </>
      ) : (
        <div className="inspFull">
          <button className="btn small" disabled={locked || running} onClick={() => void start()}>
            ✂ Taruh objek di depan teks
          </button>
        </div>
      )}
      {task && task.state !== 'mesin' && (
        <div className="inspFull notice small" role="status" aria-label="Status objek di depan teks">
          {task.state === 'antre' ? 'Menunggu giliran…' : task.state === 'gambar' ? 'Menyiapkan gambar di bawah teks…' : `Gagal: ${task.pesan ?? ''}`}
        </div>
      )}
      {task?.state === 'mesin' && job && (
        <div className="inspFull">
          <EngineProgress job={job} log={log} onCancel={() => void api.engineCancel(projectId, job.job_id).catch(() => undefined)} />
        </div>
      )}
      {error && <div className="inspFull notice warn small">{error}</div>}
    </div>
  );
}
