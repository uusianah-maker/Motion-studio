import { useState } from 'react';
import type { Api, Clip, DiffItem, EditPlan, MediaAnalysis, Project } from '../api';
import { ErrorNotice, Modal } from '../ui';

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0').replace('.', ',')}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} dtk`;

/**
 * X07 (PRD workflow B "silence detection → review cuts"): find pauses and scene changes in the
 * selected clip with FFmpeg (no AI, no cost), let the user tick which ones to cut, then show the
 * plan + diff and apply it as one undo step. Nothing is cut before "Terapkan".
 */
export function CutReviewDialog({
  api,
  project,
  clip,
  name,
  onClose,
  onApplied,
  onSeek,
}: {
  api: Api;
  project: Project;
  clip: Clip;
  name: string;
  onClose: () => void;
  onApplied: (p: Project) => void;
  onSeek: (ms: number) => void;
}) {
  const [noise, setNoise] = useState(-35);
  const [minSil, setMinSil] = useState(600);
  const [scene, setScene] = useState(0.3);
  const [pad, setPad] = useState(150);
  const [res, setRes] = useState<MediaAnalysis | null>(null);
  const [pickS, setPickS] = useState<Set<number>>(new Set());
  const [pickC, setPickC] = useState<Set<number>>(new Set());
  const [plan, setPlan] = useState<{ plan: EditPlan; diff: DiffItem[] } | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'plan' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const inMs = clip.in_ms ?? 0;
  const srcEnd = inMs + (clip.end_ms - clip.start_ms);
  const toTl = (src: number) => clip.start_ms + (src - inMs);
  // Only what lies inside the part of the source this clip shows.
  const silences = (res?.silences ?? []).map((s, i) => ({ ...s, i })).filter((s) => s.to_ms > inMs && s.from_ms < srcEnd);
  const scenes = (res?.scenes ?? []).map((t, i) => ({ t, i })).filter((s) => s.t > inMs && s.t < srcEnd);
  const saved = silences.filter((s) => pickS.has(s.i)).reduce((n, s) => n + Math.max(0, Math.min(s.to_ms, srcEnd) - pad - (Math.max(s.from_ms, inMs) + pad)), 0);

  const analyze = async () => {
    setBusy('analyze');
    setError(null);
    setPlan(null);
    try {
      const a = await api.analyzeMedia(clip.media!.version_id, { noise_db: noise, min_silence_ms: minSil, scene_threshold: scene });
      setRes(a);
      setPickS(new Set(a.silences.map((_, i) => i))); // pauses: all on by default
      setPickC(new Set()); // scene splits: opt-in
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const makePlan = async () => {
    if (!res) return;
    setBusy('plan');
    setError(null);
    try {
      const r = await api.cutPlan(project.project_id, {
        clip_id: clip.clip_id,
        silences: silences.filter((s) => pickS.has(s.i)).map(({ from_ms, to_ms }) => ({ from_ms, to_ms })),
        scenes: scenes.filter((s) => pickC.has(s.i)).map((s) => s.t),
        padding_ms: pad,
      });
      if (r.plan) setPlan({ plan: r.plan, diff: r.diff });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await api.copilotApply(project.project_id, plan.plan.plan_id, plan.plan.project_revision);
      onApplied(r.project);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (set: Set<number>, i: number, on: boolean, upd: (s: Set<number>) => void) => {
    const n = new Set(set);
    if (on) n.add(i);
    else n.delete(i);
    upd(n);
    setPlan(null);
  };
  const nPicked = silences.filter((s) => pickS.has(s.i)).length + scenes.filter((s) => pickC.has(s.i)).length;

  return (
    <Modal title="Deteksi jeda & adegan" onClose={onClose} busy={!!busy}>
      <div className="muted small">
        Klip <b>{name}</b> ({fmt(clip.start_ms)}–{fmt(clip.end_ms)}). Analisis memakai FFmpeg di PC ini: tanpa AI, tanpa biaya. Tidak ada yang dipotong sebelum lo menekan Terapkan.
      </div>
      <div className="inspGrid cutParams">
        <label>
          Ambang hening
          <select aria-label="Ambang hening" value={noise} onChange={(e) => setNoise(Number(e.target.value))}>
            {[-45, -40, -35, -30, -25].map((v) => (
              <option key={v} value={v}>
                {v} dB{v === -35 ? ' (normal)' : v < -35 ? ' (lebih ketat)' : ' (lebih longgar)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Jeda minimal
          <select aria-label="Jeda minimal" value={minSil} onChange={(e) => setMinSil(Number(e.target.value))}>
            {[400, 600, 800, 1000, 1500].map((v) => (
              <option key={v} value={v}>
                {secs(v)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Deteksi adegan
          <select aria-label="Sensitivitas adegan" value={scene} onChange={(e) => setScene(Number(e.target.value))}>
            <option value={0.2}>Peka</option>
            <option value={0.3}>Sedang</option>
            <option value={0.45}>Hanya potongan jelas</option>
          </select>
        </label>
        <label>
          Jarak aman tiap sisi
          <select aria-label="Jarak aman" value={pad} onChange={(e) => (setPad(Number(e.target.value)), setPlan(null))}>
            {[50, 150, 300].map((v) => (
              <option key={v} value={v}>
                {String(v / 1000).replace('.', ',')} dtk
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={!!busy} onClick={() => void analyze()}>
          {busy === 'analyze' ? 'Menganalisis…' : res ? '↻ Analisis ulang' : 'Analisis'}
        </button>
        {res && <span className="muted small">{res.cached ? 'Hasil tersimpan (cepat)' : 'Analisis baru'} · durasi sumber {secs(res.duration_ms)}</span>}
      </div>
      {error ? <ErrorNotice error={error} /> : null}

      {res && (
        <div className="cutLists" aria-label="Hasil deteksi">
          <div>
            <b>Jeda ({silences.length})</b>
            {!res.has_audio && <div className="muted small">Media ini tanpa suara.</div>}
            {res.has_audio && !silences.length && <div className="muted small">Tidak ada jeda di klip ini dengan pengaturan tersebut.</div>}
            {silences.map((s) => (
              <label key={s.i} className="cutRow">
                <input type="checkbox" aria-label={`Potong jeda ${fmt(toTl(Math.max(s.from_ms, inMs)))}`} checked={pickS.has(s.i)} onChange={(e) => toggle(pickS, s.i, e.target.checked, setPickS)} />
                <span>
                  {fmt(toTl(Math.max(s.from_ms, inMs)))}–{fmt(toTl(Math.min(s.to_ms, srcEnd)))} <span className="muted">({secs(Math.min(s.to_ms, srcEnd) - Math.max(s.from_ms, inMs))})</span>
                </span>
                <button className="tiny" title="Lihat di pratinjau" aria-label={`Lihat jeda ${fmt(toTl(Math.max(s.from_ms, inMs)))}`} onClick={(e) => (e.preventDefault(), onSeek(toTl(Math.max(s.from_ms, inMs))))}>
                  ▶
                </button>
              </label>
            ))}
          </div>
          <div>
            <b>Pergantian adegan ({scenes.length})</b>
            {!res.has_video && <div className="muted small">Media ini tanpa gambar.</div>}
            {res.has_video && !scenes.length && <div className="muted small">Tidak ada pergantian adegan terdeteksi.</div>}
            {scenes.map((s) => (
              <label key={s.i} className="cutRow">
                <input type="checkbox" aria-label={`Potong di adegan ${fmt(toTl(s.t))}`} checked={pickC.has(s.i)} onChange={(e) => toggle(pickC, s.i, e.target.checked, setPickC)} />
                <span>Potong di {fmt(toTl(s.t))}</span>
                <button className="tiny" title="Lihat di pratinjau" aria-label={`Lihat adegan ${fmt(toTl(s.t))}`} onClick={(e) => (e.preventDefault(), onSeek(toTl(s.t)))}>
                  ▶
                </button>
              </label>
            ))}
          </div>
        </div>
      )}

      {res && !plan && (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn primary" disabled={!!busy || nPicked === 0} onClick={() => void makePlan()}>
            {busy === 'plan' ? 'Menyusun…' : `Buat rencana (${nPicked})`}
          </button>
          {saved > 0 && <span className="badge ok">Hemat ±{secs(saved)}</span>}
          <span className="muted small">Jeda dihapus di semua track, jadi teks & subtitle ikut bergeser.</span>
        </div>
      )}

      {plan && (
        <div className="card planCard" aria-label="Rencana potongan">
          <b>{plan.plan.prompt}</b>
          <div className="muted small">{plan.plan.rationale}</div>
          {plan.plan.warnings.map((w) => (
            <div key={w} className="notice warn small">
              {w}
            </div>
          ))}
          <ol className="planOps">
            {plan.plan.operations.slice(0, 10).map((o, i) => (
              <li key={i}>{o.label}</li>
            ))}
          </ol>
          {plan.plan.operations.length > 10 && <div className="muted small">…dan {plan.plan.operations.length - 10} lagi</div>}
          <div className="planDiff">
            {plan.diff.slice(0, 10).map((d, i) => (
              <div key={i} className={`diff ${d.kind}`}>
                {d.summary}
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={() => void apply()}>
              {busy === 'apply' ? 'Menerapkan…' : `Terapkan (${plan.plan.operations.length})`}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setPlan(null)}>
              Ubah pilihan
            </button>
          </div>
        </div>
      )}

      <div className="modalActions">
        <button className="btn" onClick={onClose} disabled={!!busy}>
          Tutup
        </button>
      </div>
    </Modal>
  );
}
