import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, BrandKit, DiffItem, EditPlan, EngineBrief, EngineJob, EngineQc, EngineRencana, ProjectSummary, Role } from '../api';
import { pollDelay, readyJobShown } from '../lib';
import { ErrorNotice } from '../ui';

/**
 * U4 Generate Otomatis: one talking-head video + brief → the engine plans the edit (cuts, hook,
 * captions, SFX…) → the team reviews the plan card → approve = applied to the project's timeline as
 * ONE undo step → render + QC in the Editor. Nothing is rendered here, nothing applies by itself.
 */
export const ENGINE_STATE: Record<EngineJob['state'], string> = { menunggu: 'Antre', berjalan: 'Berjalan', siap: 'Rencana siap', ditolak: 'Ditolak mesin', gagal: 'Gagal' };
const TAHAP: Record<string, string> = { antre: 'Menunggu giliran', mulai: 'Memulai mesin', cek_input: 'Cek video', transkrip: 'Transkrip (Whisper)', rencana: 'Menyusun rencana', pisah: 'Memisah audio (Demucs)', shot_library: 'Menyusun Shot Library', selesai: 'Selesai' };
const sec = (n: number | undefined) => (typeof n === 'number' ? `${n.toFixed(1).replace('.', ',')} dtk` : '–');
const today = () => new Date().toISOString().slice(0, 10);

/** Poll a job until it stops running. */
export function useEngineJob(api: Api, projectId: string | null, jobId: string | null) {
  const [job, setJob] = useState<EngineJob | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setJob(null);
    setLog(null);
    if (!projectId || !jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const tick = async () => {
      try {
        const r = await api.engineJob(projectId, jobId);
        if (stop) return;
        failures = 0;
        setJob(r.job);
        setLog(r.log);
        setError(null);
        if (r.job.state === 'menunggu' || r.job.state === 'berjalan') timer = setTimeout(() => void tick(), pollDelay(0));
      } catch (e) {
        if (stop) return;
        setError(e);
        // Audit 14 Nov: one failed check (tunnel hiccup) used to stop the progress for good.
        timer = setTimeout(() => void tick(), pollDelay(++failures));
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [api, projectId, jobId]);
  return { job, log, error };
}

export function EngineProgress({ job, log, onCancel }: { job: EngineJob; log: string | null; onCancel?: () => void }) {
  const live = job.state === 'menunggu' || job.state === 'berjalan';
  return (
    <div className="engineJob" role="status" aria-label="Status mesin" data-state={job.state}>
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <b>{job.job_id}</b>
        <span className={`badge ${job.state === 'siap' ? 'ok' : job.state === 'gagal' || job.state === 'ditolak' ? 'bad' : ''}`}>{job.mode === 'pisah' && job.state === 'siap' ? 'Selesai dipisah' : ENGINE_STATE[job.state]}</span>
        <span className="spacer" />
        {live && onCancel && (
          <button className="btn small" onClick={onCancel}>
            Batalkan
          </button>
        )}
      </div>
      {live && (
        <>
          <div className="bar" aria-label={`Progres ${job.persen}%`}>
            <span style={{ width: `${job.persen}%` }} />
          </div>
          <div className="muted small">
            {TAHAP[job.tahap] ?? job.tahap} · {job.persen}%{job.pesan ? ` · ${job.pesan}` : ''}
          </div>
        </>
      )}
      {job.alasan && <div className={`notice ${job.state === 'ditolak' ? 'warn' : 'err'}`}>{job.alasan}</div>}
      {log && (
        <details>
          <summary className="small">Log mesin</summary>
          <pre className="engineLog">{log}</pre>
        </details>
      )}
    </div>
  );
}

/** "Rencana edit siap, render ditahan" card (contract §5.1). */
export function PlanCard({ rencana, qc, plan, diff, busy, onApprove, onReject }: { rencana: EngineRencana; qc: EngineQc | null; plan: EditPlan; diff: DiffItem[]; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const d = rencana.durasi;
  return (
    <section className="card planCard" aria-label="Rencana edit">
      <h2>Rencana edit siap — render ditahan sampai disetujui</h2>
      <div className="statGrid">
        <div className="stat">
          <small>Hook</small>
          <b>{rencana.hook?.teks ?? '–'}</b>
        </div>
        <div className="stat">
          <small>Durasi</small>
          <b>
            {sec(d?.mentah)} → {sec(d?.akhir)}
          </b>
          {d?.target ? <span className="muted small">target {d.target.join('–')} dtk</span> : <span className="muted small">tanpa batas durasi{d?.saran?.length ? ` · saran ${d.saran.join('–')} dtk` : ''}</span>}
        </div>
        <div className="stat">
          <small>Dibuang</small>
          <b>{rencana.dibuang?.length ?? 0} bagian</b>
        </div>
        <div className="stat">
          <small>Audio</small>
          <b>
            {rencana.audio?.sfx ?? 0} SFX · {rencana.audio?.musik ? `musik ${rencana.audio.musik.replace(/^\$musik:/, '')}` : 'tanpa musik'}
          </b>
          {rencana.audio?.lisensi_musik && <span className="muted small">lisensi: {rencana.audio.lisensi_musik}</span>}
          {rencana.audio?.alasan_tanpa_musik && <span className="muted small">{rencana.audio.alasan_tanpa_musik}</span>}
        </div>
      </div>
      {typeof rencana.posisi_caption === 'number' && <div className="small">Posisi caption: {Math.round(rencana.posisi_caption * 100)}% dari atas</div>}
      {qc && qc.butir.length > 0 && (
        <ul className="qcList small" aria-label="Cek rencana mesin">
          {qc.butir.map((b, i) => (
            <li key={i} data-ok={b.lulus}>
              {b.lulus ? '✓' : '⚠'} {b.butir}
              {b.nilai !== undefined && b.nilai !== null && !b.lulus ? ` (${typeof b.nilai === 'object' ? JSON.stringify(b.nilai) : String(b.nilai)})` : ''}
            </li>
          ))}
        </ul>
      )}
      {!!rencana.kata_kunci?.length && <div className="small">Kata kunci: {rencana.kata_kunci.map((k) => k.teks).join(', ')}</div>}
      {rencana.cta && <div className="small">CTA: {rencana.cta}</div>}
      {plan.warnings.map((w, i) => (
        <div key={i} className="notice warn small">
          {w}
        </div>
      ))}
      <details>
        <summary className="small">
          {plan.operations.length} operasi · {diff.length} perubahan di timeline
        </summary>
        <ol className="small planOps">
          {plan.operations.slice(0, 200).map((o, i) => (
            <li key={i}>{o.label}</li>
          ))}
        </ol>
      </details>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy} onClick={onApprove}>
          ✓ Setujui &amp; terapkan ke timeline
        </button>
        <button className="btn" disabled={busy} onClick={onReject}>
          Tolak
        </button>
      </div>
    </section>
  );
}

export function GenerateView({ api, role = 'owner', projects, onOpenProject }: { api: Api; role?: Role; projects: ProjectSummary[]; onOpenProject: (id: string) => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [brief, setBrief] = useState<EngineBrief>({ produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' });
  const [preset, setPreset] = useState('');
  const [ai, setAi] = useState(false);
  const [upload, setUpload] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState<{ project_id: string; job_id: string } | null>(null);
  const [history, setHistory] = useState<EngineJob[]>([]);
  const [plan, setPlan] = useState<{ plan: EditPlan; diff: DiffItem[]; rencana: EngineRencana; qc: EngineQc | null } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { job, log, error: jobError } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  useEffect(() => {
    void api.engineInfo().then((r) => setInstalled(r.installed), setError);
    void api.brands().then((r) => {
      setBrands(r.brands);
      setBrandId((cur) => cur || r.default_id || r.brands[0]?.brand_id || '');
    }, setError);
  }, [api]);
  const brand = brands.find((b) => b.brand_id === brandId) ?? null;
  useEffect(() => {
    setPreset((p) => (brand?.presets.some((x) => x.id === p) ? p : (brand?.presets[0]?.id ?? 'standar')));
  }, [brand]);

  const loadHistory = useCallback(async (projectId: string) => {
    try {
      setHistory(await api.engineJobs(projectId));
    } catch (e) {
      setError(e);
    }
  }, [api]);
  useEffect(() => {
    if (target !== 'new') void loadHistory(target);
    else setHistory([]);
  }, [target, loadHistory]);
  // The history follows the job; the plan card appears as soon as the engine is done.
  const final = !!job && job.state !== 'menunggu' && job.state !== 'berjalan';
  useEffect(() => {
    if (final && current) void loadHistory(current.project_id);
  }, [final, current, loadHistory]);
  useEffect(() => {
    // Opening a plan imports the engine's media (a write): Owner / Editor only (audit 14 Nov).
    if (role === 'reviewer' || !current || !readyJobShown(job, current) || plan || applied) return;
    // Audit 14 Nov: a slower answer for the job shown before must never become this job's plan.
    let stale = false;
    void api.enginePlan(current.project_id, current.job_id).then(
      (r) => {
        if (!stale && r.plan) setPlan({ plan: r.plan, diff: r.diff, rencana: r.rencana, qc: r.qc });
      },
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, role, current, job?.state, job?.job_id, plan, applied]);

  // Audit 14 Nov: a new project made for a start that then failed is reused by the retry; a brand
  // without a code is refused before anything is made or uploaded.
  const unstarted = useRef<string | null>(null);
  const start = async () => {
    if (!file || !brand) return;
    if (!brand.kode) return setError(new Error('Brand ini belum punya kode (Brand Kit → A). Isi dulu, baru jalankan mesin.'));
    setBusy(true);
    setError(null);
    setPlan(null);
    setApplied(null);
    try {
      let projectId = target;
      if (target === 'new') {
        projectId = unstarted.current ?? (await api.createProject(name.trim() || `Generate ${brief.produk || brand.name} ${today()}`)).project_id;
        unstarted.current = projectId;
      }
      const p = await api.project(projectId);
      if (p.brand_id !== brand.brand_id) await api.updateProject(projectId, p.revision, { brand_id: brand.brand_id });
      setUpload(0);
      const up = await api.importFile(file, { kind: 'project', project_id: projectId }, setUpload);
      setUpload(null);
      const j = await api.engineStart(projectId, { mode: 'generate', sources: [{ kunci: '$sumber', ref: { media_id: up.media_id, version_id: up.version.version_id } }], preset, brief, ai });
      unstarted.current = null;
      setTarget(projectId);
      setCurrent({ project_id: projectId, job_id: j.job_id });
    } catch (e) {
      setError(e);
      setUpload(null);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!plan || !current) return;
    setBusy(true);
    try {
      const p = await api.project(current.project_id);
      await api.copilotApply(current.project_id, plan.plan.plan_id, p.revision);
      setApplied(current.project_id);
      setPlan(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!plan || !current) return;
    await api.copilotReject(current.project_id, plan.plan.plan_id).catch(() => undefined);
    setPlan(null);
    setApplied(null);
    setCurrent(null);
  };
  const set = (k: keyof EngineBrief) => (e: { target: { value: string } }) => setBrief((b) => ({ ...b, [k]: e.target.value }));
  const products = brand?.produk ?? [];
  const variants = products.find((x) => x.nama === brief.produk)?.varian ?? [];

  return (
    <>
      <header className="top">
        <h1>Generate Otomatis</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Video bicara + brief → mesin menyusun draf → tim menyetujui → render di Editor</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        <section className="card" aria-label="Video dan brief">
          <h2>1 · Video &amp; brief</h2>
          <div className="inspGrid">
            <label>
              Brand
              <select aria-label="Brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.brand_id} value={b.brand_id}>
                    {b.name} ({b.kode})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Proyek
              <select aria-label="Proyek tujuan" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="new">＋ Proyek baru</option>
                {projects
                  .filter((p) => !p.error && p.status !== 'archived' && !p.variant)
                  .map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            {target === 'new' && (
              <label>
                Nama proyek
                <input aria-label="Nama proyek baru" value={name} maxLength={120} placeholder={`Generate ${brief.produk || brand?.name || ''} ${today()}`} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label>
              Video bicara
              <input ref={fileRef} aria-label="Video bicara" type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <label>
              Produk
              {products.length ? (
                <select aria-label="Produk" value={brief.produk} onChange={set('produk')}>
                  <option value="">— pilih —</option>
                  {products.map((p) => (
                    <option key={p.nama}>{p.nama}</option>
                  ))}
                </select>
              ) : (
                <input aria-label="Produk" value={brief.produk} maxLength={80} onChange={set('produk')} />
              )}
            </label>
            <label>
              Varian
              {variants.length ? (
                <select aria-label="Varian" value={brief.varian} onChange={set('varian')}>
                  <option value="">— semua —</option>
                  {variants.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input aria-label="Varian" value={brief.varian} maxLength={80} onChange={set('varian')} />
              )}
            </label>
            <label>
              Harga (persis; kosong = tanpa angka)
              <input aria-label="Harga" value={brief.harga} maxLength={40} onChange={set('harga')} />
            </label>
            <label>
              Placement
              <select aria-label="Placement" value={brief.placement} onChange={set('placement')}>
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram Reels</option>
                <option value="shopee">Shopee Video</option>
                <option value="youtube">YouTube Shorts</option>
              </select>
            </label>
            <label>
              Preset
              {brand?.presets.length ? (
                <select aria-label="Preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {brand.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nama}
                    </option>
                  ))}
                </select>
              ) : (
                <input aria-label="Preset" value={preset} maxLength={60} onChange={(e) => setPreset(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              )}
            </label>
            <label className="inspFull">
              Catatan untuk mesin
              <textarea aria-label="Catatan" rows={2} maxLength={500} value={brief.catatan} onChange={set('catatan')} />
            </label>
            <label className="inline">
              <input type="checkbox" aria-label="Pakai AI untuk hook" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Pakai AI untuk hook/kata kunci (API key di mesin; tanpa centang = aturan saja, gratis)
            </label>
          </div>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <button className="btn primary" disabled={role === 'reviewer' || !installed || !file || !brand || !preset || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
              ⚡ Susun draf otomatis
            </button>
            {upload !== null && <span className="muted small">Mengunggah {Math.round(upload * 100)}%…</span>}
            {!brand && <span className="muted small">Buat brand dulu di menu Brand.</span>}
          </div>
        </section>

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses mesin</h2>
            <EngineProgress job={job} log={log} onCancel={() => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />
          </section>
        )}
        {role === 'reviewer' && <div className="notice info">Peran Reviewer: bisa melihat status job mesin. Rencana edit dibuka dan diterapkan oleh Editor / Owner; setelah itu Reviewer menilainya di Editor (Lulus / Revisi).</div>}
        {plan && <PlanCard rencana={plan.rencana} qc={plan.qc} plan={plan.plan} diff={plan.diff} busy={busy || role === 'reviewer'} onApprove={() => void approve()} onReject={() => void reject()} />}
        {applied && (
          <section className="card" aria-label="Draf diterapkan">
            <h2>3 · Draf sudah di timeline</h2>
            <p className="small">Satu langkah undo. Lanjut finishing, render dan QC di Editor.</p>
            <button className="btn primary" onClick={() => onOpenProject(applied)}>
              Buka di Editor →
            </button>
          </section>
        )}
        {history.length > 0 && (
          <section className="card" aria-label="Riwayat job mesin">
            <h2>Riwayat job proyek ini</h2>
            <table className="list">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.job_id}>
                    <td>{h.job_id}</td>
                    <td>
                      {ENGINE_STATE[h.state]}
                      {h.alasan ? ` · ${h.alasan}` : ''}
                    </td>
                    <td>
                      {h.mode === 'generate' && (
                        <button
                          className="btn small"
                          onClick={() => {
                            setPlan(null);
                            setApplied(null);
                            setCurrent({ project_id: h.project_id, job_id: h.job_id });
                          }}
                        >
                          Lihat
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
