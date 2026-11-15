import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { pantauDanUnduh } from '../autoUnduh';
import type { Api, BatchDecision, BatchRowStatus, BatchTable, BrandKit, EngineJob, ProjectSummary, RenderJob, Role, ShotLibrary } from '../api';
import { readyJobShown } from '../lib';
import { ErrorNotice, useSessionState } from '../ui';
import { AudioPilihanSelect } from './PresetGaya';
import { LineBreakdown, PisahPanel, batchLabel, useEngineBatches } from './BatchLibrary';
import { ENGINE_STATE, EngineProgress, useEngineJob } from './GenerateView';

/**
 * U5 Batch Remix: the engine plans N variants from the winning-video library (footage + vocals in
 * the engine's own folder). The team strikes / approves rows in ONE table; approved rows become
 * approved variant projects of the batch project, and only those are rendered (contract §5.3a).
 */
const today = () => new Date().toISOString().slice(0, 10);
/** Jam Susun (HH.MM) di nama proyek batch: tiap Susun di hari yang sama dapat nama berbeda (owner 14 Nov). */
const jamSusun = () => new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
/** Kinds of VO sentence the engine may drop by itself (contract §8). Default: none. */
const BUANG = [
  { id: 'superlatif', label: 'Superlatif ("paling …")' },
  { id: 'urgensi', label: 'Urgensi ("buruan, stok terbatas")' },
  { id: 'live', label: 'Ajakan live' },
  { id: 'musiman', label: 'Musiman (lebaran, ramadan …)' },
];

export function BatchView({ api, role = 'owner', projects, onOpenProject, onProjectsChanged, active = true }: { api: Api; role?: Role; projects: ProjectSummary[]; onOpenProject: (id: string) => void; onProjectsChanged: () => void; active?: boolean }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  // The form and the job shown survive switching menus (this tab only).
  const [batchName, setBatchName] = useSessionState('batch.nama', '');
  const [jumlah, setJumlah] = useSessionState('batch.jumlah', 10);
  const [tujuan, setTujuan] = useSessionState('batch.tujuan', 'konversi');
  const [hak, setHak] = useSessionState('batch.hak', false);
  const [akun, setAkun] = useSessionState('batch.akun', '');
  const [voBatch, setVoBatch] = useSessionState('batch.vo', '');
  const [musikUji, setMusikUji] = useSessionState('batch.musikUji', false);
  const [buang, setBuang] = useSessionState<string[]>('batch.buang', []);
  /** What was sent with the job on screen, shown on its card (sukma: was "Hak pakai" sent?). */
  const [sent, setSent] = useSessionState<{ job_id: string; text: string } | null>('batch.terkirim', null);
  const [excluded, setExcluded] = useState<number | null>(null);
  const [library, setLibrary] = useState<ShotLibrary | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [preset, setPreset] = useSessionState('batch.preset', '');
  const [audio, setAudio] = useSessionState<'' | 'vo' | 'musik' | 'keduanya'>('batch.audio', '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useSessionState<{ project_id: string; job_id: string } | null>('batch.job', null);
  const [table, setTable] = useState<BatchTable | null>(null);
  const [saved, setSaved] = useState<Record<string, BatchDecision>>({});
  /** What the last save did, shown next to its button (owner, 15 Nov: "Render 0" without a reason). */
  const [saveNote, setSaveNote] = useState<{ ok: number; rusak: { id: string; why: string }[] } | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
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
  const { list: batchList, error: listError, reload: reloadBatches } = useEngineBatches(api, installed === true);
  const pickable = (batchList?.batches ?? []).filter((b) => b.siap_batch);
  // Halaman ini tetap hidup saat pindah menu: setiap kali dibuka lagi, muat ulang daftar batch
  // (batch baru dari Pisah Audio) dan jumlah shot dikecualikan (diubah di menu Shot).
  const [shown, setShown] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      void reloadBatches();
      setShown((n) => n + 1);
    }
    wasActive.current = active;
  }, [active, reloadBatches]);
  useEffect(() => {
    const pk = (batchList?.batches ?? []).filter((b) => b.siap_batch);
    if (batchList?.tersedia) setBatchName((n) => (pk.some((b) => b.batch === n) ? n : (pk[0]?.batch ?? '')));
  }, [batchList]);
  // How many shots of the picture batch the team excluded (sent to the engine by the server).
  useEffect(() => {
    setExcluded(null);
    if (!batchList?.tersedia || !batchName || !batchList.batches.some((b) => b.siap_batch && b.batch === batchName)) return;
    let stale = false;
    void api.engineShots(batchName).then(
      (r) => !stale && setExcluded(r.kecualikan.length),
      () => !stale && setExcluded(null),
    );
    return () => {
      stale = true;
    };
  }, [api, batchName, batchList, shown]);
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

  const loadTable = useCallback(async (isStale: () => boolean) => {
    if (!current) return;
    try {
      const r = await api.engineBatch(current.project_id, current.job_id);
      // Audit 14 Nov: a slower answer for the batch shown before must not land here (its rows
      // would be saved onto this job).
      if (isStale()) return;
      setError(null);
      setTable(r.batch);
      setOpen({});
      // Shot labels for the breakdown (the picture batch); a batch without a library just has no labels.
      setLibrary(null);
      const lb = r.batch.batch;
      if (lb) void api.engineShots(lb).then((x) => setLibrary((cur) => (x.library.batch === lb ? x.library : cur)), () => setLibrary(null));
      setSaved(r.decisions);
      setDraft(Object.fromEntries(r.batch.varian.map((v) => [v.id, r.decisions[v.id]?.status ?? 'usul'])));
    } catch (e) {
      if (!isStale()) setError(e);
    }
  }, [api, current]);
  useEffect(() => {
    setTable(null);
    setRendered(null);
    // Only this job's own "siap" (the previous job's state lingers for one render).
    if (!readyJobShown(job, current)) return;
    let stale = false;
    void loadTable(() => stale);
    return () => {
      stale = true;
    };
  }, [job?.state, job?.job_id, current, loadTable]);

  // Audit 14 Nov: a project made for a start that then failed is reused by the retry (no pile of
  // empty "Batch …" projects); a brand without a code is refused before anything is made.
  const unstarted = useRef<string | null>(null);
  const start = async () => {
    if (!brand) return;
    if (!brand.kode) return setError(new Error('Brand ini belum punya kode (Brand Kit → A). Isi dulu, baru susun batch.'));
    setBusy(true);
    setError(null);
    try {
      const p = unstarted.current ? { project_id: unstarted.current } : await api.createProject(`Batch ${batchName} · ${today()} ${jamSusun()}`.slice(0, 120));
      unstarted.current = p.project_id;
      const full = await api.project(p.project_id);
      if (full.brand_id !== brand.brand_id) await api.updateProject(p.project_id, full.revision, { brand_id: brand.brand_id });
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
        ...(audio ? { audio_pilihan: audio } : {}),
        batch: {
          batch: batchName.trim(),
          jumlah,
          tujuan,
          hak_pakai_jelas: hak,
          ...(akunList.length ? { akun_sendiri: akunList } : {}),
          ...(voBatch.trim() && voBatch.trim() !== batchName.trim() ? { vo_batch: voBatch.trim() } : {}),
          ...(musikUji ? { izinkan_musik_tanpa_lisensi: true } : {}),
          ...(buang.length ? { buang_otomatis: buang } : {}),
        },
      });
      unstarted.current = null;
      setSent({
        job_id: j.job_id,
        text: [
          `batch ${batchName.trim()}`,
          voBatch.trim() && voBatch.trim() !== batchName.trim() ? `VO dari ${voBatch.trim()}` : null,
          `${jumlah} varian`,
          `tujuan ${tujuan}`,
          `hak pakai jelas: ${hak ? 'ya (blur watermark / teks bawaan boleh)' : 'tidak'}`,
          `musik tanpa lisensi (uji): ${musikUji ? 'ya' : 'tidak'}`,
          `buang otomatis: ${buang.length ? buang.join(', ') : 'tidak ada'}`,
          akunList.length ? `akun sendiri: ${akunList.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
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
    setError(null); // audit 14 Nov: an old error never stays next to a new success
    setSaveNote(null);
    setSaveError(null);
    try {
      const asked = changed.map((v) => ({ varian: v.id, status: draft[v.id]! }));
      const res = await api.engineDecide(current.project_id, current.job_id, asked);
      setSaved(res);
      // The table shows what was really saved (a broken row stays unapproved).
      setDraft((d) => ({ ...d, ...Object.fromEntries(asked.map((a) => [a.varian, res[a.varian]?.status ?? d[a.varian]!])) }));
      setSaveNote({
        ok: asked.filter((a) => !res[a.varian]?.rusak).length,
        rusak: asked.filter((a) => res[a.varian]?.rusak).map((a) => ({ id: a.varian, why: res[a.varian]!.rusak! })),
      });
      onProjectsChanged();
    } catch (e) {
      setSaveError(e); // shown next to the button that failed
    } finally {
      setBusy(false);
    }
  };
  const renderApproved = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.renderVariants(current.project_id, { short_side: 1080 });
      setRendered(r);
      // Owner 14 Nov: tiap varian yang selesai dirender langsung terunduh ke komputer ini.
      for (const j of r.jobs) pantauDanUnduh(api, j);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const approvedCount = Object.values(saved).filter((d) => d.status === 'disetujui').length;
  // "Setujui semua" never approves a row the engine's plan cannot make (it stays as it is).
  /** Why a row cannot be approved: the engine said so (batch.json) or a save found it (keputusan). */
  const rusakOf = (id: string): string | undefined => saved[id]?.rusak ?? table?.varian.find((v) => v.id === id)?.rusak ?? undefined;
  const setAll = (s: BatchRowStatus) => setDraft((d) => Object.fromEntries(Object.keys(d).map((k) => [k, s === 'disetujui' && rusakOf(k) ? d[k]! : s])));

  return (
    <>
      <header className="top">
        <h1>Batch Remix</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Library video winning → N rencana varian → coret / setujui sekali → render yang disetujui</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError ?? listError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        <PisahPanel
          api={api}
          role={role}
          brand={brand}
          installed={installed === true}
          onDone={(b) => {
            onProjectsChanged();
            void reloadBatches().then(() => setBatchName(b));
          }}
        />
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
            {batchList?.tersedia ? (
              <>
                <label>
                  Batch gambar (footage)
                  <select aria-label="Nama batch" value={batchName} onChange={(e) => setBatchName(e.target.value)}>
                    {!pickable.length && <option value="">Belum ada batch siap — upload &amp; pisahkan dulu</option>}
                    {pickable.map((b) => (
                      <option key={b.batch} value={b.batch}>
                        {batchLabel(b)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  VO dari batch lain
                  <select aria-label="VO dari batch lain" value={voBatch} onChange={(e) => setVoBatch(e.target.value)}>
                    <option value="">Sama dengan batch gambar</option>
                    {(batchList.batches ?? [])
                      .filter((b) => b.vo > 0 && b.batch !== batchName)
                      .map((b) => (
                        <option key={b.batch} value={b.batch}>
                          {b.batch} · {b.vo} VO
                        </option>
                      ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Nama batch (folder di mesin)
                  <input aria-label="Nama batch" value={batchName} maxLength={80} placeholder="2026-11-13_video-winning" onChange={(e) => setBatchName(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''))} />
                </label>
                <label>
                  VO dari batch lain (opsional)
                  <input aria-label="VO dari batch lain" value={voBatch} maxLength={80} placeholder="kosong = sama" onChange={(e) => setVoBatch(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''))} />
                </label>
              </>
            )}
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
            <AudioPilihanSelect value={audio} onChange={setAudio} bawaan="tanpa musik" />
            <label>
              Akun sendiri (watermark milik brand)
              <input aria-label="Akun sendiri" value={akun} placeholder="@aysillafactoryid" onChange={(e) => setAkun(e.target.value)} />
            </label>
            <label className="inline inspFull">
              <input type="checkbox" aria-label="Hak pakai footage jelas" checked={hak} onChange={(e) => setHak(e.target.checked)} /> Hak pakai footage jelas milik brand (boleh blur watermark / teks bawaan)
            </label>
            <label className="inline inspFull">
              <input type="checkbox" aria-label="Izinkan musik tanpa lisensi" checked={musikUji} onChange={(e) => setMusikUji(e.target.checked)} /> Izinkan musik tanpa lisensi iklan (uji) — varian seperti ini diberi label UJI dan tidak boleh disetujui sebagai iklan
            </label>
            <fieldset className="inspFull buangSet">
              <legend className="small">Buang otomatis kalimat VO jenis ini (default: tidak ada, hanya diberi peringatan)</legend>
              {BUANG.map((b) => (
                <label key={b.id} className="inline">
                  <input type="checkbox" aria-label={`Buang ${b.id}`} checked={buang.includes(b.id)} onChange={(e) => setBuang((x) => (e.target.checked ? [...x, b.id] : x.filter((y) => y !== b.id)))} /> {b.label}
                </label>
              ))}
            </fieldset>
          </div>
          {batchList && !batchList.tersedia && <div className="muted small">Daftar batch belum bisa dibaca dari mesin ({batchList.alasan}); ketik nama folder batch.</div>}
          {excluded !== null && (
            <div className="muted small" aria-label="Shot dikecualikan">
              {excluded ? `${excluded} shot dikecualikan tim untuk batch ini (atur di menu Shot).` : 'Tidak ada shot yang dikecualikan (atur di menu Shot).'}
            </div>
          )}
          <button className="btn primary" disabled={role === 'reviewer' || !installed || !brand || !batchName.trim() || !preset || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
            ▦ Susun {jumlah} varian
          </button>
        </section>

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses mesin</h2>
            <EngineProgress job={job} log={log} onCancel={() => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />
            {sent?.job_id === current.job_id && (
              <p className="muted small" aria-label="Pilihan yang dikirim">
                Dikirim ke mesin: {sent.text}
              </p>
            )}
          </section>
        )}

        {table && current && (
          <section className="card" aria-label="Tabel batch">
            <h2>
              3 · Tabel batch — {table.jumlah_jadi ?? table.varian.length} dari {table.jumlah_diminta ?? table.varian.length} varian
            </h2>
            {table.alasan_kurang && <div className="notice warn small">{table.alasan_kurang}</div>}
            {table.vo_batch && <div className="muted small">VO diambil dari batch {table.vo_batch}.</div>}
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
                    <Fragment key={v.id}>
                    <tr data-status={draft[v.id]} className={draft[v.id] === 'dicoret' ? 'struck' : ''}>
                      <td>
                        {v.id}
                        {v.bukan_iklan && <span className="badge bad" title="Musik tanpa lisensi iklan: hanya untuk uji, bukan untuk iklan">UJI</span>}
                        {rusakOf(v.id) && (
                          <span className="badge bad" title={rusakOf(v.id)}>
                            rusak
                          </span>
                        )}
                        <button className="linkBtn small" aria-expanded={!!open[v.id]} aria-label={`Rincian ${v.id}`} onClick={() => setOpen((o) => ({ ...o, [v.id]: !o[v.id] }))}>
                          {open[v.id] ? '▾ rincian' : '▸ rincian'}
                        </button>
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
                            <button
                              key={s}
                              className={`btn small${draft[v.id] === s ? ' sel' : ''}`}
                              aria-pressed={draft[v.id] === s}
                              disabled={s === 'disetujui' && !!rusakOf(v.id)}
                              title={s === 'disetujui' && rusakOf(v.id) ? `Tidak bisa disetujui: ${rusakOf(v.id)}` : undefined}
                              onClick={() => setDraft((d) => ({ ...d, [v.id]: d[v.id] === s ? 'usul' : s }))}
                            >
                              {s === 'disetujui' ? '✓ Setujui' : '✕ Coret'}
                            </button>
                          ))}
                        </div>
                        {rusakOf(v.id) && (
                          <div className="small" style={{ color: 'var(--bad, #ff8a80)' }} aria-label={`Varian rusak ${v.id}`}>
                            Rusak — tidak bisa dibuat: {rusakOf(v.id)}
                          </div>
                        )}
                        {saved[v.id]?.project_id && (
                          <button className="linkBtn small" onClick={() => onOpenProject(saved[v.id]!.project_id!)}>
                            buka varian
                          </button>
                        )}
                      </td>
                    </tr>
                    {open[v.id] && (
                      <tr className="detailRow">
                        <td colSpan={8}>
                          <LineBreakdown api={api} batch={table.batch ?? null} row={v} library={library} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn primary" disabled={busy || !changed.length || role === 'editor'} title={role === 'editor' ? 'Persetujuan oleh Owner / Reviewer' : undefined} onClick={() => void save()}>
                Simpan keputusan ({changed.length})
              </button>
              {!!saveError && (
                <div style={{ flexBasis: '100%' }} aria-label="Simpan keputusan gagal">
                  <ErrorNotice error={saveError} />
                </div>
              )}
              {saveNote && (
                <div className={`notice small ${saveNote.rusak.length ? 'warn' : 'ok'}`} role="status" aria-label="Hasil simpan keputusan" style={{ flexBasis: '100%' }}>
                  {saveNote.ok} keputusan disimpan.
                  {saveNote.rusak.length > 0 && (
                    <>
                      {' '}
                      {saveNote.rusak.length} varian tidak bisa dibuat dan tetap belum disetujui:
                      <ul style={{ margin: '4px 0 0' }}>
                        {saveNote.rusak.map((r) => (
                          <li key={r.id}>
                            <b>{r.id}</b> — {r.why}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <button className="btn" disabled={busy || !approvedCount || changed.length > 0 || role === 'reviewer'} onClick={() => void renderApproved()}>
                ▶ Render {approvedCount} varian disetujui
              </button>
              <button className="linkBtn small" onClick={() => onOpenProject(current.project_id)}>
                buka proyek batch
              </button>
            </div>
            {rendered && (
              <div className="notice small" role="status">
                {rendered.jobs.length} render masuk antrean — tiap video otomatis terunduh begitu selesai (jangan tutup tab ini){rendered.skipped.length ? ` · dilewati: ${rendered.skipped.map((s) => s.reason).join(', ')}` : ''}. Pantau di Editor (proyek varian).
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
