import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, BrandKit, EngineJob, ProjectSummary, Role, TransferScene, TransferView } from '../api';
import { ErrorNotice, useSessionState } from '../ui';
import { ENGINE_STATE, EngineProgress, useEngineJob } from './GenerateView';

/**
 * R11 Motion Transfer tahap 1 (KONTRAK-ENGINE §15): a reference video whose concept the team wants
 * to copy + a Brand Kit product → the engine splits it into scenes, picks the sharpest frame of each
 * and writes two prompts per scene (image: swap the product; motion: move it like the reference).
 * The team copies them into its own AI tools (no API call, no cost) and may delete / merge scenes;
 * the engine's split can always be restored (hybrid).
 */
const sec = (n: number) => `${n.toFixed(1).replace('.', ',')}`;
const today = () => new Date().toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, '0');

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Not a secure context / no permission: the old way.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Browser menolak menyalin; pilih teks prompt lalu salin manual.');
}

function SceneCard({ s, index, total, img, jobId, readOnly, busy, onCopy, onDelete, onMerge }: { s: TransferScene; index: number; total: number; img: string | undefined; jobId: string; readOnly: boolean; busy: boolean; onCopy: (what: string, text: string) => void; onDelete: () => void; onMerge: () => void }) {
  const label = s.nos.length > 1 ? `Adegan ${index + 1} (gabungan ${s.nos.join('+')})` : `Adegan ${index + 1}`;
  return (
    <div className="shotCard transferCard" aria-label={label} data-adegan={s.id}>
      {img ? <img className="transferImg" src={img} alt={`Gambar ${label}`} /> : <div className="transferImg" aria-label={`Memuat gambar ${label}`} />}
      <div className="small">
        <b>{label}</b> · {sec(s.dari)}–{sec(s.sampai)} dtk · <b>{sec(s.durasi)} dtk</b>
        {s.sumber === 'tim' && <span className="badge">digabung tim</span>}
      </div>
      <details className="small">
        <summary>Lihat prompt</summary>
        <p className="transferPrompt"><b>Gambar:</b> {s.prompt_gambar}</p>
        <p className="transferPrompt"><b>Gerak:</b> {s.prompt_gerak}</p>
      </details>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn small" onClick={() => onCopy(`Prompt gambar ${label}`, s.prompt_gambar)}>
          ⧉ Salin prompt gambar
        </button>
        <button className="btn small" onClick={() => onCopy(`Prompt gerak ${label}`, s.prompt_gerak)}>
          ⧉ Salin prompt gerak
        </button>
        {img ? (
          <a className="btn small" href={img} download={`${jobId}-adegan-${pad2(index + 1)}.jpg`} aria-label={`Unduh gambar ${label}`}>
            ⤓ Unduh gambar
          </a>
        ) : null}
      </div>
      {!readOnly && (
        <div className="row wrap" style={{ gap: 4 }}>
          <button className="btn small" disabled={busy || total <= 1} onClick={onDelete} aria-label={`Hapus ${label}`}>
            ✕ Hapus
          </button>
          <button className="btn small" disabled={busy || index >= total - 1} onClick={onMerge} aria-label={`Gabung ${label} dengan berikutnya`}>
            ⊕ Gabung dengan berikutnya
          </button>
        </div>
      )}
    </div>
  );
}

export function MotionTransferView({ api, role = 'owner', projects, active = true }: { api: Api; role?: Role; projects: ProjectSummary[]; active?: boolean }) {
  const readOnly = role === 'reviewer';
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [brandId, setBrandId] = useState('');
  // The project and the job open stay after a reload (the scenes themselves live on the server).
  const [target, setTarget] = useSessionState('transfer.proyek', 'new');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [produk, setProduk] = useState('');
  const [deskripsi, setDeskripsi] = useState('');
  const [upload, setUpload] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [current, setCurrent] = useSessionState<{ project_id: string; job_id: string } | null>('transfer.job', null);
  const [history, setHistory] = useState<EngineJob[]>([]);
  const [view, setView] = useState<TransferView | null>(null);
  const [images, setImages] = useState<Record<number, string>>({});
  const { job, log, error: jobError } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  useEffect(() => {
    if (!active) return;
    void api.engineInfo().then((r) => setInstalled(r.installed), setError);
    void api.brands().then((r) => {
      setBrands(r.brands);
      setBrandsLoaded(true);
      setBrandId((cur) => cur || r.default_id || r.brands[0]?.brand_id || '');
    }, setError);
  }, [api, active]);
  const brand = brands.find((b) => b.brand_id === brandId) ?? null;
  const products = brand?.produk ?? [];
  useEffect(() => {
    const list = brand?.produk ?? [];
    setProduk((p) => (list.some((x) => x.nama === p) ? p : (list[0]?.nama ?? '')));
  }, [brand]);

  const loadHistory = useCallback(
    async (projectId: string) => {
      try {
        setHistory((await api.engineJobs(projectId)).filter((j) => j.mode === 'transfer'));
      } catch (e) {
        setError(e);
      }
    },
    [api],
  );
  useEffect(() => {
    if (target !== 'new') void loadHistory(target);
    else setHistory([]);
  }, [target, loadHistory]);

  // The scenes appear as soon as the engine is done (a slower answer for an older job is dropped).
  const ready = !!job && !!current && job.job_id === current.job_id && job.state === 'siap';
  const final = !!job && job.state !== 'menunggu' && job.state !== 'berjalan';
  useEffect(() => {
    if (final && current) void loadHistory(current.project_id);
  }, [final, current, loadHistory]);
  useEffect(() => {
    setView(null);
    if (!ready || !current) return;
    let stale = false;
    void api.transfer(current.project_id, current.job_id).then(
      (v) => !stale && setView(v),
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, ready, current]);

  // Frames: fetched with the session header, shown as blob URLs (freed when the job changes).
  const urls = useRef<Record<number, string>>({});
  useEffect(() => {
    for (const u of Object.values(urls.current)) URL.revokeObjectURL(u);
    urls.current = {};
    setImages({});
  }, [current?.job_id]);
  useEffect(() => () => Object.values(urls.current).forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    if (!view || !current) return;
    let stale = false;
    const jobAtStart = current.job_id;
    for (const s of view.adegan) {
      if (urls.current[s.gambar_no]) continue;
      void api.transferImage(current.project_id, current.job_id, s.gambar_no).then(
        (blob) => {
          if (stale || jobAtStart !== current.job_id || urls.current[s.gambar_no]) return;
          const u = URL.createObjectURL(blob);
          urls.current[s.gambar_no] = u;
          setImages((m) => ({ ...m, [s.gambar_no]: u }));
        },
        () => undefined, // a missing frame only leaves its card without a picture
      );
    }
    return () => {
      stale = true;
    };
  }, [api, view, current]);

  const unstarted = useRef<string | null>(null);
  const start = async () => {
    if (!file || !brand) return;
    if (!brand.kode) return setError(new Error('Brand ini belum punya kode (Brand Kit → A). Isi dulu, baru jalankan mesin.'));
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      let projectId = target;
      if (target === 'new') {
        projectId = unstarted.current ?? (await api.createProject(name.trim() || `Motion Transfer ${produk || brand.name} ${today()}`)).project_id;
        unstarted.current = projectId;
      }
      const p = await api.project(projectId);
      if (p.brand_id !== brand.brand_id) await api.updateProject(projectId, p.revision, { brand_id: brand.brand_id });
      setUpload(0);
      const up = await api.importFile(file, { kind: 'project', project_id: projectId }, setUpload);
      setUpload(null);
      const j = await api.engineTransfer(projectId, { mode: 'transfer', sources: [{ kunci: '$sumber', ref: { media_id: up.media_id, version_id: up.version.version_id } }], ...(produk ? { produk } : {}), ...(deskripsi.trim() ? { deskripsi_produk: deskripsi.trim() } : {}) });
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

  const edit = async (aksi: 'hapus' | 'gabung' | 'pulihkan', sceneId?: string) => {
    if (!view || !current) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setView(await api.transferEdit(current.project_id, current.job_id, aksi, view.versi, sceneId));
    } catch (e) {
      setError(e);
      // Someone else changed the list: show theirs.
      await api.transfer(current.project_id, current.job_id).then(setView, () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const copy = (what: string, text: string) => {
    setError(null);
    void copyText(text).then(
      () => setNote(`${what} disalin ✓ — tempel di alat AI pilihan tim bersama foto produk.`),
      (e) => setError(e),
    );
  };
  const total = view ? view.adegan.reduce((n, a) => n + a.durasi, 0) : 0;

  return (
    <>
      <header className="top">
        <h1>Motion Transfer</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Video referensi → adegan + gambar + prompt siap salin (tanpa API AI)</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        {!readOnly && (
          <section className="card" aria-label="Video referensi dan produk">
            <h2>1 · Video referensi &amp; produk</h2>
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
                  <input aria-label="Nama proyek baru" value={name} maxLength={120} placeholder={`Motion Transfer ${produk || brand?.name || ''} ${today()}`} onChange={(e) => setName(e.target.value)} />
                </label>
              )}
              <label>
                Video referensi (konsep yang mau ditiru)
                <input aria-label="Video referensi" type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <label>
                Produk (Brand Kit)
                {products.length ? (
                  <select aria-label="Produk" value={produk} onChange={(e) => setProduk(e.target.value)}>
                    {products.map((p) => (
                      <option key={p.nama}>{p.nama}</option>
                    ))}
                  </select>
                ) : (
                  <input aria-label="Produk" value={produk} maxLength={120} placeholder="nama produk" onChange={(e) => setProduk(e.target.value)} />
                )}
              </label>
              <label className="inspFull">
                Keterangan produk untuk prompt (opsional)
                <input aria-label="Keterangan produk" value={deskripsi} maxLength={500} placeholder="mis. hitam, high waist, bahan adem" onChange={(e) => setDeskripsi(e.target.value)} />
              </label>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <button className="btn primary" disabled={!installed || !file || !brand || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
                ⇄ Pecah jadi adegan
              </button>
              {upload !== null && <span className="muted small">Mengunggah {Math.round(upload * 100)}%…</span>}
              {!brand && <span className="muted small">{brandsLoaded ? 'Buat brand dulu di menu Brand.' : 'Memuat brand…'}</span>}
            </div>
          </section>
        )}
        {readOnly && <div className="notice info">Peran Reviewer: bisa melihat adegan dan menyalin prompt. Menjalankan dan mengubah adegan dilakukan Editor / Owner.</div>}

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses mesin</h2>
            <EngineProgress job={job} log={log} onCancel={readOnly ? undefined : () => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />
          </section>
        )}

        {view && current && (
          <section className="card" aria-label="Adegan Motion Transfer">
            <h2>3 · Adegan ({view.adegan.length})</h2>
            <p className="small">
              Referensi <b>{view.referensi}</b> · {sec(view.durasi)} dtk · produk <b>{view.produk}</b> · total adegan dipakai {sec(total)} dtk
              {view.diubah && <> · diubah tim (mesin membuat {view.jumlah_mesin} adegan)</>}
            </p>
            <p className="muted small">Langkah lanjut (manual): salin prompt gambar + lampirkan foto produk ke alat AI gambar, lalu gerakkan hasilnya dengan prompt gerak di alat AI video.</p>
            {note && (
              <div className="notice small" role="status">
                {note}
              </div>
            )}
            {view.diubah && !readOnly && (
              <button className="btn small" disabled={busy} onClick={() => void edit('pulihkan')}>
                ↺ Pulihkan adegan mesin
              </button>
            )}
            <div className="shotGrid transferGrid">
              {view.adegan.map((s, i) => (
                <SceneCard key={s.id} s={s} index={i} total={view.adegan.length} img={images[s.gambar_no]} jobId={view.job_id} readOnly={readOnly} busy={busy} onCopy={copy} onDelete={() => void edit('hapus', s.id)} onMerge={() => void edit('gabung', s.id)} />
              ))}
            </div>
          </section>
        )}

        {history.length > 0 && (
          <section className="card" aria-label="Riwayat Motion Transfer">
            <h2>Riwayat Motion Transfer proyek ini</h2>
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
                      <button className="btn small" aria-label={`Lihat ${h.job_id}`} onClick={() => setCurrent({ project_id: h.project_id, job_id: h.job_id })}>
                        Lihat
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
