import { useEffect, useRef, useState } from 'react';
import { errorText } from '../lib';
import { type Api, ApiError, type DiffItem, type EditPlan, type Project } from '../api';
import { ErrorNotice } from '../ui';
import type { BrandAsset, Clip, EditOp, Media } from '../api';
import { CetakanPanel } from './CetakanPanel';

const QUICK = ['hook "Diskon 50% hari ini!" 2 detik', 'CTA "Join live jam 7" di akhir', 'ubah rasio ke 1:1'];

/**
 * Motion Copilot (W11): prompt → plan (nothing changes yet) → review the operations and the
 * diff → apply all or some → one Undo step. The server validates and applies; this panel only
 * shows and asks.
 */
export function CopilotPanel({
  api,
  project,
  selectedClipId,
  playheadMs,
  busy,
  onApplied,
  onUndo,
  media = [],
  aset = [],
  selectedClip = null,
  edit,
  videoAi,
}: {
  /** 25 Nov: start a Video AI job (B-roll AI from a sentence). */
  videoAi?: (b: Parameters<Api['videoAiStart']>[1]) => Promise<void>;
  media?: readonly Media[];
  aset?: readonly BrandAsset[];
  selectedClip?: Clip | null;
  /** 25 Nov "Cetakan per kalimat": ordinary edits (one Undo each). */
  edit?: (ops: EditOp[]) => Promise<void>;
  api: Api;
  project: Project;
  selectedClipId: string | null;
  playheadMs: number;
  busy: boolean;
  onApplied: (p: Project) => void;
  onUndo: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [diff, setDiff] = useState<DiffItem[]>([]);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [unsupported, setUnsupported] = useState<{ message: string; examples: string[] } | null>(null);
  const [done, setDone] = useState<{ count: number; of: number; revision: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  const [mode, setMode] = useState<'local' | 'auto' | 'ai'>('local');
  /** Audit 14 Nov: why the ticked subset cannot be applied (the diff then shows nothing to apply). */
  const [subsetProblem, setSubsetProblem] = useState<string | null>(null);
  const projectRef = useRef(project.project_id);
  projectRef.current = project.project_id;

  useEffect(() => {
    api.aiProviders().then((r) => setMode(r.settings.mode), () => undefined);
  }, [api]);

  // Another project: start clean.
  useEffect(() => {
    setPlan(null);
    setUnsupported(null);
    setDone(null);
    setError(null);
  }, [project.project_id]);

  // A plan made for an older revision cannot be applied (the server refuses it too).
  const stale = !!plan && plan.project_revision !== project.revision;

  // The diff always shows what WILL be applied: recomputed by the server for the ticked subset.
  const tickKey = checked.map((c) => (c ? '1' : '0')).join('');
  useEffect(() => {
    if (!plan || stale) return;
    const sel = checked.flatMap((c, i) => (c ? [i] : []));
    setSubsetProblem(null);
    if (!sel.length) {
      setDiff([]);
      return;
    }
    let live = true;
    api.copilotPreview(project.project_id, plan.plan_id, sel).then(
      (d) => live && setDiff(d),
      // Not applicable as ticked (e.g. "add text where X was" without "delete X"): say so, show no
      // diff, and keep "Terapkan" off — it used to show the full plan and then fail on apply.
      (e) => {
        if (!live) return;
        setDiff([]);
        setSubsetProblem(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [tickKey, plan?.plan_id]);

  const makePlan = async () => {
    if (!prompt.trim() || working) return;
    setWorking(true);
    setError(null);
    setUnsupported(null);
    setDone(null);
    setPlan(null);
    try {
      const pid = project.project_id;
      const r = await api.copilotPlan(pid, { prompt, ...(selectedClipId ? { selected_clip_ids: [selectedClipId] } : {}), playhead_ms: Math.round(playheadMs) });
      if (projectRef.current !== pid) return; // another project opened meanwhile: not its plan
      if (r.plan) {
        setPlan(r.plan);
        setDiff(r.diff);
        setChecked(r.plan.operations.map(() => true));
      } else setUnsupported(r.unsupported);
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  };

  const accepted = checked.flatMap((c, i) => (c ? [i] : []));
  const apply = async () => {
    if (!plan || !accepted.length) return;
    setWorking(true);
    setError(null);
    try {
      const r = await api.copilotApply(project.project_id, plan.plan_id, plan.project_revision, accepted.length === plan.operations.length ? undefined : accepted);
      onApplied(r.project);
      setDone({ count: r.accepted.length, of: plan.operations.length, revision: r.applied_revision });
      setPlan(null);
      setPrompt('');
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'CONFLICT' ? new ApiError(409, 'CONFLICT', e.message) : e);
    } finally {
      setWorking(false);
    }
  };

  const reject = async () => {
    if (!plan) return;
    setWorking(true);
    try {
      await api.copilotReject(project.project_id, plan.plan_id).catch(() => undefined);
      setPlan(null);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="copilot" aria-label="Motion Copilot">
      <div className="copilotHead">
        <b>Motion Copilot</b>
        <span className={`badge${mode === 'local' ? '' : ' warn'}`} title={mode === 'local' ? 'Perintah dikenali aturan lokal; tidak ada panggilan AI atau biaya API' : 'Perintah yang tidak dikenali aturan dikirim ke AI (berbiaya, dibatasi anggaran)'}>
          {mode === 'local' ? 'Lokal · tanpa AI' : mode === 'auto' ? 'Otomatis · AI jika perlu' : 'AI'}
        </span>
      </div>
      {edit && <CetakanPanel api={api} project={project} media={media} aset={aset} selectedClip={selectedClip} playheadMs={playheadMs} busy={busy} edit={edit} {...(videoAi ? { videoAi } : {})} />}
      <textarea
        aria-label="Perintah Copilot"
        placeholder={'Contoh: hook "Diskon 50%" 2 detik; subtitle "Cek keranjang" detik 2-5'}
        value={prompt}
        maxLength={1000}
        rows={3}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void makePlan();
          }
        }}
      />
      <div className="copilotQuick">
        {QUICK.map((q) => (
          <button key={q} className="chip" onClick={() => setPrompt(q)} title="Isi contoh perintah">
            {q}
          </button>
        ))}
      </div>
      <button className="btn primary" onClick={() => void makePlan()} disabled={!prompt.trim() || working || busy}>
        {working && !plan ? 'Menyusun…' : 'Buat rencana'}
      </button>
      <ErrorNotice error={error} />

      {unsupported && (
        <div className="notice warn" role="alert">
          {unsupported.message}
          <div className="muted" style={{ marginTop: 6 }}>
            Perintah yang dikenali, klik untuk memakai:
          </div>
          <div className="copilotQuick">
            {unsupported.examples.map((x) => (
              <button key={x} className="chip" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
        </div>
      )}

      {plan && (
        <div className="card planCard" aria-label="Rencana edit">
          <div className="row">
            <b>Rencana</b>
            <span className="badge">{plan.source === 'local' ? 'Lokal' : plan.source === 'ai' ? `AI · ${plan.provider?.provider ?? ''}` : 'Transkrip'}</span>
            <div className="spacer" />
            <span className="muted small">{plan.cost_estimate.usd > 0 ? `≈ $${plan.cost_estimate.usd.toFixed(4)}` : 'tanpa biaya API'}</span>
          </div>
          <p className="muted small">{plan.rationale}</p>
          {plan.warnings.map((w) => (
            <div key={w} className="notice warn small">
              {w}
            </div>
          ))}
          <ul className="planOps">
            {plan.operations.map((o, i) => (
              <li key={i}>
                <label>
                  <input type="checkbox" checked={checked[i] ?? false} onChange={(e) => setChecked((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} aria-label={`Terapkan: ${o.label}`} />
                  {o.label}
                </label>
              </li>
            ))}
          </ul>
          <div className="planDiff" aria-label="Perubahan">
            <div className="muted small">Perubahan di linimasa (operasi yang dicentang):</div>
            {diff.map((d, i) => (
              <div key={i} className={`diff ${d.kind}`}>
                {d.summary}
              </div>
            ))}
          </div>
          {stale && <div className="notice warn small">Proyek berubah sejak rencana ini dibuat. Buat rencana baru.</div>}
          <div className="row" style={{ marginTop: 8 }}>
            {subsetProblem && (
              <div className="notice warn small" role="alert" aria-label="Langkah terpilih tidak bisa diterapkan">
                Kombinasi langkah yang dicentang tidak bisa diterapkan: {subsetProblem}
              </div>
            )}
            <button className="btn primary" onClick={() => void apply()} disabled={working || busy || stale || !accepted.length || !!subsetProblem}>
              Terapkan ({accepted.length})
            </button>
            <button className="btn" onClick={() => void reject()} disabled={working}>
              Tolak
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="notice ok" role="status">
          Diterapkan {done.count} dari {done.of} operasi sebagai satu langkah.
          {project.revision === done.revision && project.history.undo > 0 && (
            <button className="btn small" style={{ marginLeft: 8 }} onClick={onUndo} disabled={busy}>
              ↶ Undo
            </button>
          )}
        </div>
      )}
    </section>
  );
}
