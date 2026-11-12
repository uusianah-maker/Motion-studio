import { useCallback, useEffect, useState } from 'react';
import type { Api, BatchRowStatus, BatchTable, BrandKit, EngineJob, ProjectSummary, RenderJob, Role } from '../api';
import { ErrorNotice } from '../ui';
import { ENGINE_STATE, EngineProgress, useEngineJob } from './GenerateView';

/**
 * U5 Batch Remix: the engine plans N variants from the winning-video library (footage + vocals in
 * the engine's own folder). The team strikes / approves rows in ONE table; approved rows become
 * approved variant projects of the batch project, and only those are rendered (contract §5.3a).
 */
const today = () => new Date().toISOString().slice(0, 10);

export function BatchView({ api, role = 'owner', projects, onOpenProject, onProjectsChanged }: { api: Api; role?: Role; projects: ProjectSummary[]; onOpenProject: (id: string) => void; onProjectsChanged: () => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  const [batchName, setBatchName] = useState('');
  const [jumlah, setJumlah] = useState(10);
  const [tujuan, setTujuan] = useState('konversi');
  const [hak, setHak] = useState(false);
  const [akun, setAkun] = useState('');
  const [preset, setPreset] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState<{ project_id: string; job_id: string } | null>(null);
  const [table, setTable] = useState<BatchTable | null>(null);
  const [saved, setSaved] = useState<Record<string, { status: BatchRowStatus; project_id: string | null }>>({});
  const [draft, setDraft] = useState<Record<string, BatchRowStatus>>({});
  const [rendered, setRendered] = useState<{ jobs: RenderJob[]; skipped: { project_id: string; reason: string }[] } | null>(null);
  const [jobs, setJobs] = useState<EngineJob[]>([]);
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

  // Earlier batches: every non-variant project's batch jobs.
  const masterIds = projects
    .filter((p) => !p.error && !p.variant && p.status !== 'archived')
    .slice(0, 40)
    .map((p) => p.project_id)
    .join(',');
  const loadJobs = useCallback(async () => {
    const all: EngineJob[] = [];
    for (const id of masterIds.split(',').filter(Boolean)) {
      const js = await api.engineJobs(id).catch(() => [] as EngineJob[]);
      all.push(...js.filter((j) => j.mode === 'batch'));
    }
    setJobs(all.sort((a, b) => b.created_at - a.created_at).slice(0, 20));
  }, [api, masterIds]);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs, job?.state]);

  const loadTable = useCallback(async () => {
    if (!current) return;
    try {
      const r = await api.engineBatch(current.project_id, current.job_id);
      setTable(r.batch);
      setSaved(r.decisions);
      setDraft(Object.fromEntries(r.batch.varian.map((v) => [v.id, r.decisions[v.id]?.status ?? 'usul'])));
    } catch (e) {
      setError(e);
    }
  }, [api, current]);
  useEffect(() => {
    setTable(null);
    setRendered(null);
    if (job?.state === 'siap') void loadTable();
  }, [job?.state, loadTable]);

  const start = async () => {
    if (!brand) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(`Batch ${batchName} ${today()}`.slice(0, 120));
      const full = await api.project(p.project_id);
      await api.updateProject(p.project_id, full.revision, { brand_id: brand.brand_id });
      const akunList = akun
        .split(/[\s,]+/)
        .map((a) => a.trim())
        .filter(Boolean);
      const j = await api.engineStart(p.project_id, {
        mode: 'batch',
        sources: [],
        preset,
        brief: { produk: '', varian: '', harga: '', placement: 'tiktok', catatan: '' },
        ai: false,
        mode_ops: 'u3',
        batch: { batch: batchName.trim(), jumlah, tujuan, hak_pakai_jelas: hak, ...(akunList.length ? { akun_sendiri: akunList } : {}) },
      });
      onProjectsChanged();
      setCurrent({ project_id: p.project_id, job_id: j.job_id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const changed = table ? table.varian.filter((v) => draft[v.id] !== (saved[v.id]?.status ?? 'usul')) : [];
  const save = async () => {
    if (!current || !changed.length) return;
    setBusy(true);
    try {
      setSaved(await api.engineDecide(current.project_id, current.job_id, changed.map((v) => ({ varian: v.id, status: draft[v.id]! }))));
      onProjectsChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const renderApproved = async () => {
    if (!current) return;
    setBusy(true);
    try {
      setRendered(await api.renderVariants(current.project_id, { short_side: 1080 }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const approvedCount = Object.values(saved).filter((d) => d.status === 'disetujui').length;
  const setAll = (s: BatchRowStatus) => setDraft((d) => Object.fromEntries(Object.keys(d).map((k) => [k, s])));

  return (
    <>
      <header className="top">
        <h1>Batch Remix</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Library video winning → N rencana varian → coret / setujui sekali → render yang disetujui</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        <section className="card" aria-label="Susun batch">
          <h2>1 · Susun batch</h2>
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
              Nama batch (folder di mesin)
              <input aria-label="Nama batch" value={batchName} maxLength={80} placeholder="2026-11-13_video-winning" onChange={(e) => setBatchName(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''))} />
            </label>
            <label>
              Jumlah varian
              <input aria-label="Jumlah varian" type="number" min={1} max={50} value={jumlah} onChange={(e) => setJumlah(Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))))} />
            </label>
            <label>
              Tujuan
              <select aria-label="Tujuan" value={tujuan} onChange={(e) => setTujuan(e.target.value)}>
                <option value="konversi">Konversi</option>
                <option value="awareness">Awareness</option>
                <option value="branding">Branding</option>
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
            <label>
              Akun sendiri (watermark milik brand)
              <input aria-label="Akun sendiri" value={akun} placeholder="@aysillafactoryid" onChange={(e) => setAkun(e.target.value)} />
            </label>
            <label className="inline inspFull">
              <input type="checkbox" aria-label="Hak pakai footage jelas" checked={hak} onChange={(e) => setHak(e.target.checked)} /> Hak pakai footage jelas milik brand (boleh blur watermark / teks bawaan)
            </label>
          </div>
          <button className="btn primary" disabled={role === 'reviewer' || !installed || !brand || !batchName.trim() || !preset || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
            ▦ Susun {jumlah} varian
          </button>
        </section>

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses mesin</h2>
            <EngineProgress job={job} log={log} onCancel={() => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />
          </section>
        )}

        {table && current && (
          <section className="card" aria-label="Tabel batch">
            <h2>
              3 · Tabel batch — {table.jumlah_jadi ?? table.varian.length} dari {table.jumlah_diminta ?? table.varian.length} varian
            </h2>
            {table.alasan_kurang && <div className="notice warn small">{table.alasan_kurang}</div>}
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn small" onClick={() => setAll('disetujui')}>
                Setujui semua
              </button>
              <button className="btn small" onClick={() => setAll('dicoret')}>
                Coret semua
              </button>
            </div>
            <div className="tableScroll">
              <table className="list batchTable">
                <thead>
                  <tr>
                    <th>Varian</th>
                    <th>Hook</th>
                    <th>VO</th>
                    <th>Shot</th>
                    <th>Musik</th>
                    <th>Durasi</th>
                    <th>QC</th>
                    <th>Keputusan</th>
                  </tr>
                </thead>
                <tbody>
                  {table.varian.map((v) => (
                    <tr key={v.id} data-status={draft[v.id]} className={draft[v.id] === 'dicoret' ? 'struck' : ''}>
                      <td>
                        {v.id}
                        {v.bukan_iklan && <span className="badge bad" title="Musik tanpa lisensi iklan: hanya untuk uji, bukan untuk iklan">UJI</span>}
                      </td>
                      <td>{v.hook ?? '–'}</td>
                      <td>{v.vo ?? '–'}</td>
                      <td>{v.shot?.length ?? 0}</td>
                      <td>{v.musik ?? '–'}</td>
                      <td>{typeof v.durasi === 'number' ? `${v.durasi.toFixed(1).replace('.', ',')} dtk` : '–'}</td>
                      <td>{v.qc_lulus === false ? '⚠' : '✓'}</td>
                      <td>
                        <div className="seg" role="group" aria-label={`Keputusan ${v.id}`}>
                          {(['disetujui', 'dicoret'] as const).map((s) => (
                            <button key={s} className={`btn small${draft[v.id] === s ? ' sel' : ''}`} aria-pressed={draft[v.id] === s} onClick={() => setDraft((d) => ({ ...d, [v.id]: d[v.id] === s ? 'usul' : s }))}>
                              {s === 'disetujui' ? '✓ Setujui' : '✕ Coret'}
                            </button>
                          ))}
                        </div>
                        {saved[v.id]?.project_id && (
                          <button className="linkBtn small" onClick={() => onOpenProject(saved[v.id]!.project_id!)}>
                            buka varian
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn primary" disabled={busy || !changed.length || role === 'editor'} title={role === 'editor' ? 'Persetujuan oleh Owner / Reviewer' : undefined} onClick={() => void save()}>
                Simpan keputusan ({changed.length})
              </button>
              <button className="btn" disabled={busy || !approvedCount || changed.length > 0 || role === 'reviewer'} onClick={() => void renderApproved()}>
                ▶ Render {approvedCount} varian disetujui
              </button>
              <button className="linkBtn small" onClick={() => onOpenProject(current.project_id)}>
                buka proyek batch
              </button>
            </div>
            {rendered && (
              <div className="notice small" role="status">
                {rendered.jobs.length} render masuk antrean{rendered.skipped.length ? ` · dilewati: ${rendered.skipped.map((s) => s.reason).join(', ')}` : ''}. Pantau di Editor (proyek varian).
              </div>
            )}
          </section>
        )}

        {jobs.length > 0 && (
          <section className="card" aria-label="Batch sebelumnya">
            <h2>Batch sebelumnya</h2>
            <table className="list">
              <tbody>
                {jobs.map((j) => (
                  <tr key={`${j.project_id}/${j.job_id}`}>
                    <td>{j.job_id}</td>
                    <td>{projects.find((p) => p.project_id === j.project_id)?.name ?? j.project_id}</td>
                    <td>{ENGINE_STATE[j.state]}</td>
                    <td>
                      <button className="btn small" onClick={() => setCurrent({ project_id: j.project_id, job_id: j.job_id })}>
                        Buka
                      </button>
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
