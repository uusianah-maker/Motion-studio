import { useCallback, useEffect, useState } from 'react';
import type { Api, Cue, DiffItem, EditPlan, Media, Project, SttJob, TranscriptFull } from '../api';
import { ErrorNotice, Modal } from '../ui';

const PHASE: Record<SttJob['phase'], string> = {
  extracting: 'Mengambil audio (tanpa metadata)…',
  transcribing: 'Mentranskripsi di provider AI…',
  saving: 'Menyimpan transkrip…',
};

type Draft = { cue_id?: string; start: string; end: string; text: string };
const toDraft = (c: Cue): Draft => ({ cue_id: c.cue_id, start: (c.start_ms / 1000).toFixed(2), end: (c.end_ms / 1000).toFixed(2), text: c.text });
const secToMs = (s: string) => Math.round(Number(s.replace(',', '.')) * 1000);

/**
 * Captions (W14): transcribe one media (paid → cost shown and confirmed first), edit the cues,
 * then turn them into subtitle clips through an edit plan (approve → one undo step).
 */
export function TranscriptDialog({ api, project, media, onClose, onApplied }: { api: Api; project: Project; media: Media; onClose: () => void; onApplied: (p: Project) => void }) {
  const versionId = media.current_version_id;
  const [tr, setTr] = useState<TranscriptFull | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<SttJob | null>(null);
  const [est, setEst] = useState<Awaited<ReturnType<Api['transcriptEstimate']>> | null>(null);
  const [lang, setLang] = useState<'id' | 'en' | 'auto'>('id');
  const [plan, setPlan] = useState<{ plan: EditPlan; diff: DiffItem[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const openTranscript = useCallback(
    async (tid: string) => {
      const t = await api.transcript(project.project_id, tid);
      setTr(t);
      setDrafts(t.cues.map(toDraft));
      setDirty(false);
    },
    [api, project.project_id],
  );

  const refresh = useCallback(async () => {
    const r = await api.transcripts(project.project_id);
    const mine = r.jobs.find((j) => j.version_id === versionId) ?? null;
    setJob(mine);
    const latest = r.transcripts.find((t) => t.version_id === versionId);
    if (mine?.status === 'running') return;
    if (mine?.status === 'completed' && mine.transcript_id) await openTranscript(mine.transcript_id);
    else if (latest) await openTranscript(latest.transcript_id);
    else setEst(await api.transcriptEstimate(project.project_id, versionId));
  }, [api, project.project_id, versionId, openTranscript]);

  useEffect(() => {
    refresh()
      .catch(setError)
      .finally(() => setLoaded(true));
  }, [refresh]);

  const running = job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh().catch(setError), 700);
    return () => clearInterval(id);
  }, [running, refresh]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    act(async () => {
      if (!est?.provider || est.estimate_usd === null) return;
      setTr(null);
      setPlan(null);
      setJob(await api.transcriptStart(project.project_id, versionId, lang, est.estimate_usd, est.provider.connection_id));
    });

  const save = () =>
    act(async () => {
      if (!tr) return;
      const t = await api.transcriptSave(
        project.project_id,
        tr.transcript_id,
        tr.rev,
        drafts.map((d) => ({ ...(d.cue_id ? { cue_id: d.cue_id } : {}), start_ms: secToMs(d.start), end_ms: secToMs(d.end), text: d.text })),
      );
      setTr(t);
      setDrafts(t.cues.map(toDraft));
      setDirty(false);
      setNotice('Transkrip disimpan.');
    });

  const toSubtitles = () =>
    act(async () => {
      if (!tr) return;
      const r = await api.transcriptSubtitles(project.project_id, tr.transcript_id);
      if (r.plan) setPlan({ plan: r.plan, diff: r.diff });
    });

  const apply = () =>
    act(async () => {
      if (!plan) return;
      const r = await api.copilotApply(project.project_id, plan.plan.plan_id, plan.plan.project_revision);
      onApplied(r.project);
      setPlan(null);
      setNotice(`${r.accepted.length} subtitle masuk ke linimasa (satu langkah, bisa di-Undo).`);
    });

  const edit = (i: number, patch: Partial<Draft>) => {
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setDirty(true);
  };

  return (
    <Modal title={`Transkrip: ${media.display_name}`} onClose={onClose} busy={busy}>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice ok" role="status">
          {notice}
        </div>
      )}
      {!loaded && <div className="muted">Memuat…</div>}

      {loaded && !tr && !running && est && (
        <div className="sttStart">
          <p>
            Audio diambil dari media (tanpa metadata judul/lokasi), dikirim ke provider transkripsi, lalu dijadikan teks bertimestamp yang bisa lo edit. File asli tidak diubah.
          </p>
          {est.provider ? (
            <>
              <div className="row wrap">
                <label className="inline">
                  Bahasa
                  <select aria-label="Bahasa audio" value={lang} onChange={(e) => setLang(e.target.value as 'id' | 'en' | 'auto')}>
                    <option value="id">Indonesia</option>
                    <option value="en">English</option>
                    <option value="auto">Otomatis</option>
                  </select>
                </label>
                <span className="muted small">
                  {est.provider.label} ({est.provider.model}) · {est.minutes} menit
                </span>
              </div>
              <div className="notice info" role="note">
                Biaya perkiraan <b>${(est.estimate_usd ?? 0).toFixed(4)}</b>. Dengan menekan tombol di bawah, lo menyetujui biaya ini (tetap dibatasi anggaran di menu AI).
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void start()}>
                Transkripsi (≈ ${(est.estimate_usd ?? 0).toFixed(4)})
              </button>
            </>
          ) : (
            <div className="notice warn" role="alert">
              {est.unavailable ?? 'Belum ada koneksi transkripsi.'} Tambahkan koneksi dengan kemampuan “Transkripsi” di menu AI.
            </div>
          )}
        </div>
      )}

      {running && job && (
        <div className="card" aria-live="polite">
          <div className="muted">{PHASE[job.phase]}</div>
          <div className="bar" role="progressbar" aria-label="Progres transkripsi">
            <span style={{ width: job.phase === 'extracting' ? '20%' : job.phase === 'transcribing' ? '60%' : '90%' }} />
          </div>
        </div>
      )}
      {job?.status === 'failed' && !tr && job.error && (
        <div className="notice err" role="alert">
          Transkripsi gagal: {job.error.message}
        </div>
      )}

      {tr && (
        <div className="sttEdit">
          <div className="row wrap">
            <span className="muted small">
              {tr.provider} · {tr.model} · {tr.language ?? 'bahasa otomatis'} · {drafts.length} cue{tr.edited ? ' · sudah diedit' : ''}
            </span>
            <span className="spacer" />
            <button
              className="btn small"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setEst(await api.transcriptEstimate(project.project_id, versionId));
                  setTr(null);
                  setPlan(null);
                  setJob(null);
                })
              }
            >
              Transkripsi ulang
            </button>
          </div>
          <ol className="cues" aria-label="Daftar cue">
            {drafts.map((d, i) => (
              <li key={d.cue_id ?? `new${i}`}>
                <input aria-label={`Mulai cue ${i + 1} (detik)`} className="t" inputMode="decimal" value={d.start} onChange={(e) => edit(i, { start: e.target.value })} />
                <span className="muted">–</span>
                <input aria-label={`Akhir cue ${i + 1} (detik)`} className="t" inputMode="decimal" value={d.end} onChange={(e) => edit(i, { end: e.target.value })} />
                <input aria-label={`Teks cue ${i + 1}`} className="txt" value={d.text} maxLength={500} onChange={(e) => edit(i, { text: e.target.value })} />
                <button className="btn small" aria-label={`Hapus cue ${i + 1}`} onClick={() => {
                  setDrafts((ds) => ds.filter((_, j) => j !== i));
                  setDirty(true);
                }}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <div className="row wrap">
            <button
              className="btn small"
              onClick={() => {
                const last = drafts[drafts.length - 1];
                const s = last ? secToMs(last.end) : 0;
                setDrafts((ds) => [...ds, { start: (s / 1000).toFixed(2), end: ((s + 1500) / 1000).toFixed(2), text: '' }]);
                setDirty(true);
              }}
            >
              ＋ Tambah cue
            </button>
            <span className="spacer" />
            <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>
              Simpan transkrip
            </button>
            <button className="btn primary" disabled={busy || dirty || !drafts.length} onClick={() => void toSubtitles()} title={dirty ? 'Simpan dulu perubahan transkrip' : undefined}>
              Jadikan subtitle
            </button>
          </div>
          {dirty && <div className="muted small">Ada perubahan yang belum disimpan.</div>}
        </div>
      )}

      {plan && (
        <div className="card planCard" aria-label="Rencana subtitle">
          <b>Rencana: {plan.plan.operations.length} subtitle</b>
          {plan.plan.warnings.map((w) => (
            <div key={w} className="notice warn small">
              {w}
            </div>
          ))}
          <div className="planDiff">
            {plan.diff.slice(0, 12).map((d, i) => (
              <div key={i} className={`diff ${d.kind}`}>
                {d.summary}
              </div>
            ))}
            {plan.diff.length > 12 && <div className="muted small">…dan {plan.diff.length - 12} lagi</div>}
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void apply()}>
              Terapkan ({plan.plan.operations.length})
            </button>
            <button className="btn" disabled={busy} onClick={() => setPlan(null)}>
              Batal
            </button>
          </div>
        </div>
      )}

      <div className="modalActions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Tutup
        </button>
      </div>
    </Modal>
  );
}
