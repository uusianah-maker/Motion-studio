import { useCallback, useEffect, useRef, useState } from 'react';
import { proyekFitur } from '../fitur';
import type { Api, BrandKit, DiffItem, EditPlan, EngineQc, EngineRencana, Katalog, KatalogProduk, OutfitItem, OutfitView as OutfitViewData, ProjectSummary, Role } from '../api';
import { ErrorNotice, useSessionState } from '../ui';
import { sourceIds } from './BeatSpotView';
import { EngineProgress, PlanCard, useEngineJob } from './GenerateView';

/**
 * §29 Beat Spot "Ganti Outfit" (owner 24–25 Nov 2026): 1–5 footage of the brand's own model + the
 * template sound → per footage the walk cuts on the beat to an AI picture of the same person in ONE
 * catalog look (1 atasan + 1 bawahan, 1 colour) → end card of the real catalog photos. The team
 * checks before/after, may make a picture again or change a look, then opens the draft in Edit
 * (render held until approved).
 */
const MAKS = 5;
const today = () => new Date().toISOString().slice(0, 10);
const AUDIO = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;
const sec = (n: number | null | undefined) => (typeof n === 'number' ? `${n.toFixed(1).replace('.', ',')} dtk` : '–');
const TAHAP: Record<OutfitViewData['tahap'], string> = {
  menyiapkan: 'Mesin menyiapkan footage (orang, crop, frame diam, look)',
  membuat_gambar: 'Membuat gambar AI (satu per satu)',
  merakit: 'Merakit tepat di ketukan',
  siap: 'Siap dicek',
  ditolak: 'Ditolak',
  gagal: 'Ada yang gagal',
  berhenti: 'Dihentikan',
};

/** "Katalog/Lucy Pants/1. Black.png" → product "Lucy Pants", colour "Black". */
export function parseKatalogPath(rel: string): { produk: string; warna: string } | null {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const produk = parts[parts.length - 2]!.trim();
  let warna = parts[parts.length - 1]!.replace(/\.[^.]+$/, '');
  warna = warna.replace(/^\s*\d+\s*[.)_-]?\s*/, '').replace(/[_-]+/g, ' ').trim();
  if (!warna || /^chatgpt image|^img[ _-]?\d|^dsc|^whatsapp|^\d+$/i.test(warna)) warna = '';
  else warna = warna.replace(/\b\w/g, (c) => c.toUpperCase());
  return produk ? { produk, warna } : null;
}
export const tebakJenis = (nama: string): 'atasan' | 'bawahan' =>
  /pants|celana|kulot|culotte|rok|skirt|jeans|trouser|legging|jogger|bawahan/i.test(nama) ? 'bawahan' : 'atasan';
const kid = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'item';

function Gambar({ api, pid, jid, fid, jenis, alt, versi }: { api: Api; pid: string; jid: string; fid: string; jenis: 'frame' | 'hasil' | 'diam' | 'end'; alt: string; versi: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let stale = false;
    void api.outfitImage(pid, jid, fid, jenis).then(
      (b) => {
        if (stale) return;
        u = URL.createObjectURL(b);
        setUrl(u);
      },
      () => !stale && setUrl(null),
    );
    return () => {
      stale = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [api, pid, jid, fid, jenis, versi]);
  return url ? <img src={url} alt={alt} style={{ width: '100%', aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 8, background: '#111' }} /> : <div className="muted small" style={{ aspectRatio: '9 / 16', display: 'grid', placeItems: 'center', background: '#1112', borderRadius: 8 }}>…</div>;
}

function FotoMedia({ api, versionId, alt }: { api: Api; versionId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    void api.streamUrl(versionId).then((r) => !stale && setUrl(r.url), () => undefined);
    return () => {
      stale = true;
    };
  }, [api, versionId]);
  return url ? <img src={url} alt={alt} style={{ width: 56, height: 74, objectFit: 'contain', background: '#fff', borderRadius: 6 }} /> : <span className="muted small">…</span>;
}

/** Katalog Produk of one brand: import a folder (1 subfolder = 1 product, 1 file = 1 colour), name colours, set atasan / bawahan. */
function KatalogPanel({ api, brand, readOnly, onChanged }: { api: Api; brand: BrandKit; readOnly: boolean; onChanged: (k: Katalog) => void }) {
  const [kat, setKat] = useState<Katalog | null>(null);
  const [draft, setDraft] = useState<KatalogProduk[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    void api.katalog(brand.brand_id).then((k) => {
      setKat(k);
      setDraft(null);
      onChanged(k);
    }, setError);
  }, [api, brand.brand_id, onChanged]);
  useEffect(load, [load]);
  const list = draft ?? kat?.produk ?? [];
  const edit = (fn: (p: KatalogProduk[]) => KatalogProduk[]) => setDraft(fn(structuredClone(list)));

  const impor = async (files: File[]) => {
    setError(null);
    const img = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    if (!img.length) return setError(new Error('Folder tidak berisi foto (png / jpg / webp)'));
    const next = structuredClone(list);
    try {
      for (const [i, f] of img.entries()) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || `Produk/${f.name}`;
        const info = parseKatalogPath(rel);
        if (!info) continue;
        setBusy(`Mengunggah ${i + 1}/${img.length} ${f.name}`);
        const up = await api.importFile(f, { kind: 'shared' });
        let p = next.find((x) => x.nama.toLowerCase() === info.produk.toLowerCase());
        if (!p) {
          const used = new Set(next.map((x) => x.id));
          let id = kid(info.produk);
          for (let n = 2; used.has(id); n++) id = `${kid(info.produk)}-${n}`;
          p = { id, nama: info.produk, jenis: tebakJenis(info.produk), deskripsi: '', warna: [] };
          next.push(p);
        }
        const nama = info.warna || `Warna ${p.warna.length + 1}`;
        const used = new Set(p.warna.map((w) => w.id));
        let wid = kid(nama);
        for (let n = 2; used.has(wid); n++) wid = `${kid(nama)}-${n}`;
        if (!p.warna.some((w) => w.ref.version_id === up.version.version_id)) p.warna.push({ id: wid, nama, ref: { media_id: up.media_id, version_id: up.version.version_id } });
      }
      setDraft(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const simpan = async () => {
    if (!draft || !kat) return;
    setBusy('Menyimpan katalog');
    setError(null);
    try {
      const k = await api.saveKatalog(brand.brand_id, draft, kat.revision);
      setKat(k);
      setDraft(null);
      onChanged(k);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const tanpaNama = list.some((p) => p.warna.some((w) => /^Warna \d+$/.test(w.nama)));
  return (
    <details className="card" open={!kat || kat.produk.length === 0 || !!draft} aria-label="Katalog Produk">
      <summary>
        <b>Katalog Produk · {brand.name}</b> <span className="muted small">{kat ? `${kat.produk.length} produk, ${kat.produk.reduce((a, p) => a + p.warna.length, 0)} warna` : 'memuat…'}</span>
      </summary>
      <ErrorNotice error={error} />
      <p className="small muted">
        Foto katalog dipakai sebagai acuan AI <b>dan</b> apa adanya di end card. Impor folder (unduh folder katalog dari Drive): 1 subfolder = 1 produk, 1 file = 1 warna. Nama warna & jenis bisa diubah di sini.
      </p>
      {!readOnly && (
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="btn small">
            Impor folder katalog…
            <input
              aria-label="Impor folder katalog"
              type="file"
              multiple
              style={{ display: 'none' }}
              ref={(el) => {
                if (el) el.setAttribute('webkitdirectory', '');
              }}
              onChange={(e) => void impor([...(e.target.files ?? [])])}
            />
          </label>
          {draft && (
            <>
              <button className="btn small primary" disabled={!!busy} onClick={() => void simpan()}>
                Simpan katalog
              </button>
              <button className="btn small" disabled={!!busy} onClick={() => setDraft(null)}>
                Batal
              </button>
            </>
          )}
          {busy && <span className="muted small">{busy}…</span>}
          {tanpaNama && <span className="small" style={{ color: 'var(--warn, #d9a400)' }}>Ada warna tanpa nama (mis. "Warna 1"): ganti dengan nama warnanya.</span>}
        </div>
      )}
      {list.map((p, pi) => (
        <div key={p.id} className="card" style={{ marginTop: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input aria-label={`Nama produk ${p.nama}`} value={p.nama} disabled={readOnly} maxLength={80} onChange={(e) => edit((l) => (l[pi]!.nama = e.target.value, l))} />
            <select aria-label={`Jenis ${p.nama}`} value={p.jenis} disabled={readOnly} onChange={(e) => edit((l) => (l[pi]!.jenis = e.target.value as 'atasan' | 'bawahan', l))}>
              <option value="atasan">Atasan (kemeja, blus, kaos)</option>
              <option value="bawahan">Bawahan (celana, kulot, rok)</option>
            </select>
            <input aria-label={`Deskripsi ${p.nama}`} placeholder="Detail untuk AI (opsional), mis. kemeja garis tipis berdasi" value={p.deskripsi} disabled={readOnly} maxLength={300} style={{ flex: 1, minWidth: 200 }} onChange={(e) => edit((l) => (l[pi]!.deskripsi = e.target.value, l))} />
            {!readOnly && (
              <button className="btn small" onClick={() => edit((l) => l.filter((_, i) => i !== pi))}>
                Hapus produk
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {p.warna.map((w, wi) => (
              <div key={w.id + wi} style={{ display: 'grid', gap: 4, justifyItems: 'center', width: 96 }}>
                <FotoMedia api={api} versionId={w.ref.version_id} alt={`${p.nama} ${w.nama}`} />
                <input aria-label={`Warna ${p.nama} ${wi + 1}`} value={w.nama} disabled={readOnly} maxLength={80} style={{ width: 92 }} onChange={(e) => edit((l) => (l[pi]!.warna[wi]!.nama = e.target.value, l))} />
                {!readOnly && (
                  <button className="btn small" onClick={() => edit((l) => (l[pi]!.warna.splice(wi, 1), l))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </details>
  );
}

export function OutfitView({ api, role = 'owner', projects, active = true, onOpenProject, onProjectsChanged, embedded = false }: { api: Api; role?: Role; projects: ProjectSummary[]; active?: boolean; onOpenProject: (id: string) => void; onProjectsChanged?: () => void; embedded?: boolean }) {
  const readOnly = role === 'reviewer';
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  const [defaultBrand, setDefaultBrand] = useState<string | null>(null);
  const [katalog, setKatalog] = useState<Katalog | null>(null);
  const [target, setTarget] = useSessionState('outfit.proyek', 'new');
  const [name, setName] = useState('');
  const [footage, setFootage] = useState<File[]>([]);
  const [sound, setSound] = useState<File | null>(null);
  const [modelSendiri, setModelSendiri] = useState(false);
  const [teks, setTeks] = useState('');
  const [judul, setJudul] = useState('');
  const [sub, setSub] = useState('');
  const [upload, setUpload] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useSessionState<{ project_id: string; job_id: string } | null>('outfit.job', null);
  const [view, setView] = useState<OutfitViewData | null>(null);
  const [ubah, setUbah] = useState<Record<string, { atasan?: string | null; bawahan?: string | null; target?: 'utama' | 'semua' }>>({});
  const [plan, setPlan] = useState<{ plan: EditPlan; diff: DiffItem[]; rencana: EngineRencana; qc: EngineQc | null } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const { job, log, error: jobError } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  useEffect(() => {
    if (!active) return;
    void api.engineInfo().then((r) => setInstalled(r.installed), setError);
    void api.brands().then((r) => {
      setBrands(r.brands);
      setBrandId((cur) => cur || r.default_id || r.brands[0]?.brand_id || '');
      setDefaultBrand(r.default_id ?? null);
    }, setError);
  }, [api, active]);
  const brand = brands.find((b) => b.brand_id === brandId) ?? null;
  const onKatalog = useCallback((k: Katalog) => setKatalog(k), []);

  // The run: poll while the app / engine is still working.
  const final = !!job && job.state !== 'menunggu' && job.state !== 'berjalan';
  useEffect(() => {
    setView(null);
    setPlan(null);
    if (!current || !final || job?.job_id !== current.job_id) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await api.outfit(current.project_id, current.job_id);
        if (stop) return;
        setView(r.outfit);
        if (['menyiapkan', 'membuat_gambar', 'merakit'].includes(r.outfit.tahap)) t = setTimeout(() => void tick(), 2500);
      } catch (e) {
        if (!stop) setError(e);
      }
    };
    void tick();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
    };
  }, [api, current, final, job?.job_id]);
  const rakitId = view?.tahap === 'siap' ? view.rakit?.job_id ?? null : null;
  useEffect(() => {
    setPlan(null);
    if (readOnly || !current || !rakitId || applied) return;
    let stale = false;
    void api.enginePlan(current.project_id, rakitId).then(
      (r) => !stale && r.plan && setPlan({ plan: r.plan, diff: r.diff, rencana: r.rencana, qc: r.qc }),
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, readOnly, current, rakitId, applied]);

  const atasan = (katalog?.produk ?? []).filter((p) => p.jenis === 'atasan');
  const bawahan = (katalog?.produk ?? []).filter((p) => p.jenis === 'bawahan');
  const katalogOk = atasan.length + bawahan.length > 0;

  const unstarted = useRef<string | null>(null);
  const start = async () => {
    if (!brand || !footage.length || !sound) return;
    if (!brand.kode) return setError(new Error('Brand ini belum punya kode (Brand Kit → A). Isi dulu, baru jalankan mesin.'));
    setBusy(true);
    setError(null);
    setApplied(null);
    setUbah({});
    try {
      let projectId = target;
      if (target === 'new') {
        projectId = unstarted.current ?? (await api.createProject(name.trim() || `Ganti Outfit ${brand.name} ${today()}`, 'beatspot')).project_id;
        unstarted.current = projectId;
        onProjectsChanged?.();
      }
      const p = await api.project(projectId);
      if (p.brand_id !== brand.brand_id) await api.updateProject(projectId, p.revision, { brand_id: brand.brand_id });
      const files = [...footage, sound];
      const ids = sourceIds(files.map((f) => f.name));
      const sources = [];
      for (const [i, f] of files.entries()) {
        setUpload(`${i + 1}/${files.length} ${f.name}`);
        const up = await api.importFile(f, { kind: 'project', project_id: projectId });
        sources.push({ kunci: `$sumber:${ids[i]}`, ref: { media_id: up.media_id, version_id: up.version.version_id } });
      }
      setUpload(null);
      const j = await api.outfitStart(projectId, sources, { sound: `$sumber:${ids[ids.length - 1]}`, model_sendiri: true, teks_atas: teks.trim() || null, judul_akhir: judul.trim() || null, sub_akhir: sub.trim() || null });
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
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const ulang = (it: OutfitItem) => act(async () => {
    if (!current) return;
    setView(await api.outfitUlang(current.project_id, current.job_id, it.footage));
    setPlan(null);
    // Keep polling until the new picture + assembly are done.
    setCurrent({ ...current });
  });
  const simpanUbah = () => act(async () => {
    if (!current) return;
    const look: Record<string, { atasan?: string | null; bawahan?: string | null }> = {};
    const tgt: Record<string, 'utama' | 'semua'> = {};
    for (const [fid, u] of Object.entries(ubah)) {
      if (u.atasan !== undefined || u.bawahan !== undefined) look[fid] = { ...(u.atasan !== undefined ? { atasan: u.atasan } : {}), ...(u.bawahan !== undefined ? { bawahan: u.bawahan } : {}) };
      if (u.target) tgt[fid] = u.target;
    }
    const j = await api.outfitUbah(current.project_id, current.job_id, { look, target: tgt });
    setUbah({});
    setPlan(null);
    setCurrent({ project_id: current.project_id, job_id: j.job_id });
  });
  const approve = () => act(async () => {
    if (!plan || !current) return;
    const p = await api.project(current.project_id);
    await api.copilotApply(current.project_id, plan.plan.plan_id, p.revision);
    setApplied(current.project_id);
    setPlan(null);
  });
  const reject = async () => {
    if (!plan || !current) return;
    await api.copilotReject(current.project_id, plan.plan.plan_id).catch(() => undefined);
    setPlan(null);
  };
  const lookKey = (l: { produk: string; id: string } | null) => (l ? l.id : '');
  const versi = (it: OutfitItem) => `${it.gambar.status}-${it.gambar.ulang}-${view?.rakit?.job_id ?? ''}`;

  return (
    <>
      {!embedded && (
        <header className="top">
          <h1>Beat Spot · Ganti Outfit</h1>
          <div className="spacer" />
          <span className="muted small hideNarrow">Footage model sendiri + sound template → potong di ketukan ke gambar AI 1 look katalog per footage</span>
        </header>
      )}
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini (MOTION_ENGINE_ROOT).</div>}
        {brand && <KatalogPanel api={api} brand={brand} readOnly={readOnly} onChanged={onKatalog} />}
        {!readOnly && (
          <section className="card" aria-label="Footage dan sound">
            <h2>1 · Footage &amp; sound template</h2>
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
                  {proyekFitur(projects, 'beatspot', brandId, defaultBrand, target).map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {target === 'new' && (
                <label>
                  Nama proyek
                  <input aria-label="Nama proyek baru" value={name} maxLength={120} placeholder={`Ganti Outfit ${brand?.name ?? ''} ${today()}`} onChange={(e) => setName(e.target.value)} />
                </label>
              )}
              <label>
                Footage model (1–{MAKS} video, tiap footage = 1 look)
                <input aria-label="Footage model" type="file" accept="video/*" multiple onChange={(e) => setFootage([...(e.target.files ?? [])].filter((f) => !AUDIO.test(f.name)))} />
              </label>
              {footage.length > MAKS && <div className="notice warn inspFull">Maksimal {MAKS} footage per video (dipilih {footage.length}).</div>}
              <label>
                Sound template (video / audio contoh)
                <input aria-label="Sound template" type="file" accept="audio/*,video/*" onChange={(e) => setSound(e.target.files?.[0] ?? null)} />
              </label>
              <label className="inspFull">
                Teks atas (tetap sampai end card)
                <input aria-label="Teks atas" value={teks} maxLength={120} placeholder="mis. kemeja + kulot, auto rapi ke mana aja" onChange={(e) => setTeks(e.target.value)} />
              </label>
              <label>
                Judul end card
                <input aria-label="Judul end card" value={judul} maxLength={60} placeholder="Mix & Match" onChange={(e) => setJudul(e.target.value)} />
              </label>
              <label>
                Sub judul end card
                <input aria-label="Sub judul end card" value={sub} maxLength={90} placeholder="(otomatis: nama produk)" onChange={(e) => setSub(e.target.value)} />
              </label>
              <label className="inspFull row" style={{ gap: 8, alignItems: 'center' }}>
                <input aria-label="Model sendiri" type="checkbox" checked={modelSendiri} onChange={(e) => setModelSendiri(e.target.checked)} />
                <span className="small">
                  Orang di semua footage ini <b>model / kreator sendiri</b> yang setuju bajunya diganti AI (wajib).
                </span>
              </label>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={!installed || !brand || !footage.length || footage.length > MAKS || !sound || !modelSendiri || !katalogOk || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
                ♪ Buat Ganti Outfit
              </button>
              {upload !== null && <span className="muted small">Mengunggah {upload}…</span>}
              {!katalogOk && <span className="muted small">Isi Katalog Produk dulu (minimal 1 produk atasan / bawahan).</span>}
              <span className="muted small">Gambar dibuat dengan API key AI gambar (biaya per gambar, lihat menu AI). Sistem memilih look; bisa diganti setelah jadi.</span>
            </div>
          </section>
        )}

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses</h2>
            {/* The siapkan job's own "Rencana siap" would mislead: once it is done the run's stage below says where it is. */}
            {(!view || job.state !== 'siap') && <EngineProgress job={job} log={log} onCancel={readOnly ? undefined : () => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />}
            {view && (
              <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <span className={`badge ${view.tahap === 'siap' ? 'ok' : view.tahap === 'gagal' || view.tahap === 'ditolak' ? 'bad' : ''}`}>{TAHAP[view.tahap]}</span>
                {view.bpm && <span className="small muted">{Math.round(view.bpm)} BPM · {sec(view.durasi)}</span>}
                <span className="small muted">
                  Gambar: {view.items.filter((i) => i.gambar.status === 'siap').length}/{view.items.length}
                </span>
                {view.tahap === 'membuat_gambar' && !readOnly && (
                  <button className="btn small" disabled={busy} onClick={() => void act(async () => setView(await api.outfitBerhenti(current.project_id, current.job_id)))}>
                    Hentikan
                  </button>
                )}
                {view.rakit && view.rakit.state === 'gagal' && <span className="small bad">Rakit gagal: {view.rakit.alasan}</span>}
                {view.peringatan.map((p) => (
                  <span key={p} className="small" style={{ color: 'var(--warn, #d9a400)' }}>
                    {p}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {view && view.items.length > 0 && current && (
          <section className="card" aria-label="Cek sebelum dan sesudah">
            <h2>3 · Cek sebelum / sesudah</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
              {view.items.map((it) => {
                const u = ubah[it.footage] ?? {};
                return (
                  <div key={it.footage} className="card" aria-label={`Footage ${it.nama}`}>
                    <div className="small" style={{ overflowWrap: 'anywhere' }}>
                      <b>{it.nama}</b> · jalan {it.jalan.ketukan} ketukan · {it.orang >= 2 ? `${it.orang} orang` : '1 orang'}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                      <Gambar api={api} pid={current.project_id} jid={current.job_id} fid={it.footage} jenis="frame" alt={`Sebelum ${it.nama}`} versi="frame" />
                      {it.gambar.status === 'siap' ? (
                        view.rakit?.state === 'siap' ? <Gambar api={api} pid={current.project_id} jid={current.job_id} fid={it.footage} jenis="diam" alt={`Sesudah ${it.nama}`} versi={versi(it)} /> : <Gambar api={api} pid={current.project_id} jid={current.job_id} fid={it.footage} jenis="hasil" alt={`Sesudah ${it.nama}`} versi={versi(it)} />
                      ) : (
                        <div className="small muted" style={{ aspectRatio: '9 / 16', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 8, background: '#1112', borderRadius: 8 }}>
                          {it.gambar.status === 'gagal' ? <span className="bad">{it.gambar.alasan ?? 'Gagal'}</span> : it.gambar.status === 'membuat' ? 'Membuat gambar…' : 'Menunggu giliran…'}
                        </div>
                      )}
                    </div>
                    <div className="small" style={{ marginTop: 6 }}>
                      {it.look.atasan && (
                        <div>
                          Atasan: <b>{it.look.atasan.nama_produk} {it.look.atasan.warna}</b>
                        </div>
                      )}
                      {it.look.bawahan && (
                        <div>
                          Bawahan: <b>{it.look.bawahan.nama_produk} {it.look.bawahan.warna}</b>
                        </div>
                      )}
                      <span className="muted">{it.look.dipilih === 'tim' ? 'dipilih tim' : 'dipilih otomatis'}{it.gambar.dipakai_ulang ? ' · gambar lama dipakai lagi' : ''}</span>
                    </div>
                    {it.qc && (
                      <div className="small" style={{ marginTop: 4 }}>
                        <span className={`badge ${it.qc.lulus ? 'ok' : 'bad'}`}>{it.qc.lulus ? 'QC lulus' : 'Perlu dicek'}</span>{' '}
                        {!it.qc.lulus && it.qc.cek.filter((c) => !c.lulus).map((c) => `${c.cek} (${c.ket})`).join('; ')}
                      </div>
                    )}
                    {!readOnly && (
                      <details style={{ marginTop: 6 }}>
                        <summary className="small">Ubah</summary>
                        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                          <button className="btn small" disabled={busy || it.gambar.status === 'membuat' || it.gambar.status === 'menunggu' || (it.gambar.status === 'siap' && it.gambar.ulang_sisa <= 0)} onClick={() => void ulang(it)}>
                            ↻ Buat ulang gambar {it.gambar.status === 'siap' ? `(sisa ${it.gambar.ulang_sisa})` : ''}
                          </button>
                          {atasan.length > 0 && (
                            <select aria-label={`Atasan ${it.nama}`} value={u.atasan === undefined ? lookKey(it.look.atasan) : u.atasan ?? ''} onChange={(e) => setUbah((x) => ({ ...x, [it.footage]: { ...x[it.footage], atasan: e.target.value || null } }))}>
                              <option value="">— tanpa ganti atasan —</option>
                              {atasan.flatMap((p) => p.warna.map((w) => (
                                <option key={`${p.id}/${w.id}`} value={`${p.id}/${w.id}`}>
                                  {p.nama} {w.nama}
                                </option>
                              )))}
                            </select>
                          )}
                          {bawahan.length > 0 && (
                            <select aria-label={`Bawahan ${it.nama}`} value={u.bawahan === undefined ? lookKey(it.look.bawahan) : u.bawahan ?? ''} onChange={(e) => setUbah((x) => ({ ...x, [it.footage]: { ...x[it.footage], bawahan: e.target.value || null } }))}>
                              <option value="">— tanpa ganti bawahan —</option>
                              {bawahan.flatMap((p) => p.warna.map((w) => (
                                <option key={`${p.id}/${w.id}`} value={`${p.id}/${w.id}`}>
                                  {p.nama} {w.nama}
                                </option>
                              )))}
                            </select>
                          )}
                          <select aria-label={`Siapa diganti ${it.nama}`} value={u.target ?? it.target} onChange={(e) => setUbah((x) => ({ ...x, [it.footage]: { ...x[it.footage], target: e.target.value as 'utama' | 'semua' } }))}>
                            <option value="semua">Ganti baju semua orang yang jalan bersama</option>
                            <option value="utama">Ganti baju orang utama saja</option>
                          </select>
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
            {!readOnly && Object.keys(ubah).length > 0 && (
              <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
                <button className="btn primary" disabled={busy} onClick={() => void simpanUbah()}>
                  Terapkan perubahan look
                </button>
                <button className="btn" disabled={busy} onClick={() => setUbah({})}>
                  Batal
                </button>
                <span className="muted small">Footage lain tidak dibuat ulang (gambarnya dipakai lagi).</span>
              </div>
            )}
            {view.rakit?.state === 'siap' && (
              <div style={{ marginTop: 12, maxWidth: 220 }}>
                <div className="small muted">End card (foto katalog asli)</div>
                <Gambar api={api} pid={current.project_id} jid={current.job_id} fid="end" jenis="end" alt="End card" versi={view.rakit.job_id} />
              </div>
            )}
          </section>
        )}

        {plan && <PlanCard rencana={plan.rencana} qc={plan.qc} plan={plan.plan} diff={plan.diff} busy={busy} onApprove={() => void approve()} onReject={() => void reject()} />}
        {applied && (
          <section className="card">
            <p className="small">Draf masuk ke timeline (1 langkah undo). Render tetap menunggu persetujuan di Edit.</p>
            <button className="btn primary" onClick={() => onOpenProject(applied)}>
              Buka di Edit →
            </button>
          </section>
        )}
      </div>
    </>
  );
}
