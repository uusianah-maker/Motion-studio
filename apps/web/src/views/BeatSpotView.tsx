import { useCallback, useEffect, useRef, useState } from 'react';
import { proyekFitur } from '../fitur';
import type { Api, BeatspotSettings, BeatspotView, BrandKit, DiffItem, EditPlan, EngineJob, EngineQc, EngineRencana, JobVo, ProjectSummary, Role } from '../api';
import { readyJobShown } from '../lib';
import { ErrorNotice, useSessionState } from '../ui';
import { AudioPilihanSelect } from './PresetGaya';
import { SuaraPilihan } from './SuaraPilihan';
import { ENGINE_STATE, EngineProgress, PlanCard, useEngineJob } from './GenerateView';

/**
 * R16 Beat Spot tahap 1 (KONTRAK-ENGINE §16): awareness video from footage of people (in a mall)
 * wearing the brand's product, cut exactly on the beat of the team's sound, + logo and end card from
 * the Brand Kit. No face blur, no AI outfit change (owner PC-R7). Hybrid: the team picks the shot
 * order, drops shots and marks creator / public people, then runs it again; the plan reaches the
 * timeline only after approval (one undo step), like Generate.
 */
const sec = (n: number) => n.toFixed(2).replace('.', ',');
const today = () => new Date().toISOString().slice(0, 10);
const AUDIO = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;
const MAKS_FOOTAGE = 39;
/** Owner 25 Nov 2026: footage / sound may also come from a Google Drive share link (the server downloads it). */
const DRIVE = /^https:\/\/(drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com)\//i;
/** Links pasted one per line (or separated by spaces), duplicates dropped. */
export function driveLinks(text: string): string[] {
  return [...new Set(text.split(/\s+/).map((l) => l.trim()).filter(Boolean))];
}
/** Short label for a Drive link before it is downloaded (the file name comes from Drive). */
const driveLabel = (l: string) => {
  const id = l.match(/\/d\/([^/?#]+)/)?.[1] ?? l.match(/[?&]id=([^&#]+)/)?.[1] ?? l;
  return `Google Drive …${id.slice(-6)}`;
};

/** File name → a source id the engine accepts (`$sumber:<id>`), unique in this job. */
export function sourceIds(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = (n.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'footage').slice(0, 34);
    let id = base;
    for (let i = 2; used.has(id.toLowerCase()); i++) id = `${base}-${i}`;
    used.add(id.toLowerCase());
    return id;
  });
}

export function BeatSpotView({ api, role = 'owner', projects, active = true, onOpenProject, onProjectsChanged }: { api: Api; role?: Role; projects: ProjectSummary[]; active?: boolean; onOpenProject: (id: string) => void; onProjectsChanged?: () => void }) {
  const readOnly = role === 'reviewer';
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [brandId, setBrandId] = useState('');
  // R22: projects without a brand use the workspace default brand.
  const [defaultBrand, setDefaultBrand] = useState<string | null>(null);
  const [target, setTarget] = useSessionState('beatspot.proyek', 'new');
  const [name, setName] = useState('');
  const [footage, setFootage] = useState<File[]>([]);
  /** Per footage (index): creator / model who agreed, or the public (default) — contract §16, PC-R7. */
  /** Key: `f:<index>` (file from this computer) or `d:<link>` (Google Drive). */
  const [orang, setOrang] = useState<Record<string, 'kreator' | 'umum'>>({});
  const [driveFootage, setDriveFootage] = useState('');
  const [sound, setSound] = useState<File | null>(null);
  const [driveSound, setDriveSound] = useState('');
  const [bpm, setBpm] = useState('');
  const [kpp, setKpp] = useState<BeatspotSettings['ketukan_per_potong']>('auto');
  const [durMin, setDurMin] = useState(15);
  const [durMax, setDurMax] = useState(20);
  const [tagline, setTagline] = useState('');
  const [preset, setPreset] = useState('');
  const [audio, setAudio] = useState<'' | 'vo' | 'musik' | 'keduanya'>('');
  /** R37: VO dari Library over the beat-cut footage (null = without). */
  const [vo, setVo] = useState<JobVo | null>(null);
  const [upload, setUpload] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useSessionState<{ project_id: string; job_id: string } | null>('beatspot.job', null);
  const [history, setHistory] = useState<EngineJob[]>([]);
  const [view, setView] = useState<BeatspotView | null>(null);
  /** The team's choices for the next run (start from what the job ran with). */
  const [pilih, setPilih] = useState<BeatspotSettings | null>(null);
  const [plan, setPlan] = useState<{ plan: EditPlan; diff: DiffItem[]; rencana: EngineRencana; qc: EngineQc | null } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const { job, log, error: jobError } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  useEffect(() => {
    if (!active) return;
    void api.engineInfo().then((r) => setInstalled(r.installed), setError);
    void api.brands().then((r) => {
      setBrands(r.brands);
      setBrandsLoaded(true);
      setBrandId((cur) => cur || r.default_id || r.brands[0]?.brand_id || '');
      setDefaultBrand(r.default_id ?? null);
    }, setError);
  }, [api, active]);
  const brand = brands.find((b) => b.brand_id === brandId) ?? null;

  const loadHistory = useCallback(
    async (projectId: string) => {
      try {
        setHistory((await api.engineJobs(projectId)).filter((j) => j.mode === 'beatspot'));
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
  const final = !!job && job.state !== 'menunggu' && job.state !== 'berjalan';
  useEffect(() => {
    if (final && current) void loadHistory(current.project_id);
  }, [final, current, loadHistory]);

  // Report + settings once the job has ended (a refused job still shows its files / settings).
  useEffect(() => {
    setView(null);
    setPilih(null);
    if (!final || !current || job?.job_id !== current.job_id) return;
    let stale = false;
    void api.beatspot(current.project_id, current.job_id).then(
      (v) => {
        if (stale) return;
        setView(v);
        setPilih(v.pengaturan);
      },
      (e) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [api, final, current, job?.job_id]);
  // The edit plan (opening it imports nothing new here, but it is a write: Owner / Editor only).
  useEffect(() => {
    setPlan(null);
    if (readOnly || !current || !readyJobShown(job, current) || applied) return;
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
  }, [api, readOnly, current, job?.state, job?.job_id, applied]);

  const unstarted = useRef<string | null>(null);
  const linksFootage = driveLinks(driveFootage);
  const linkSound = driveSound.trim();
  const linkSalah = [...linksFootage, ...(linkSound ? [linkSound] : [])].filter((l) => !DRIVE.test(l));
  /** Footage in job order: files from this computer first, then Google Drive links. */
  const footageItems: { key: string; label: string; file?: File; link?: string }[] = [
    ...footage.map((f, i) => ({ key: `f:${i}`, label: f.name, file: f })),
    ...linksFootage.filter((l) => DRIVE.test(l)).map((l) => ({ key: `d:${l}`, label: driveLabel(l), link: l })),
  ].slice(0, MAKS_FOOTAGE);
  const adaSound = !!sound || !!linkSound;
  const start = async () => {
    if (!footageItems.length || !brand || linkSalah.length) return;
    if (!brand.kode) return setError(new Error('Brand ini belum punya kode (Brand Kit → A). Isi dulu, baru jalankan mesin.'));
    if (durMin < 5 || durMax > 60 || durMin > durMax) return setError(new Error('Durasi: min ≤ maks, antara 5 dan 60 detik.'));
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      let projectId = target;
      if (target === 'new') {
        projectId = unstarted.current ?? (await api.createProject(name.trim() || `Beat Spot ${brand.name} ${today()}`, 'beatspot')).project_id;
        unstarted.current = projectId;
        // R22: the new project shows in this page's list (and in Edit) right away.
        onProjectsChanged?.();
      }
      const p = await api.project(projectId);
      if (p.brand_id !== brand.brand_id) await api.updateProject(projectId, p.revision, { brand_id: brand.brand_id });
      const soundItem: { file?: File; link?: string } | null = sound ? { file: sound } : linkSound ? { link: linkSound } : null;
      const items = [...footageItems, ...(soundItem ? [soundItem] : [])];
      const scope = { kind: 'project' as const, project_id: projectId };
      const ups: { name: string; ref: { media_id: string; version_id: string } }[] = [];
      for (const [i, it] of items.entries()) {
        const n = `${i + 1}/${items.length}`;
        if (it.file) {
          setUpload(`Mengunggah ${n} ${it.file.name}`);
          const up = await api.importFile(it.file, scope);
          ups.push({ name: it.file.name, ref: { media_id: up.media_id, version_id: up.version.version_id } });
        } else {
          setUpload(`Mengambil dari Google Drive ${n}`);
          const up = await api.importDriveLink(it.link!, scope);
          ups.push({ name: up.name, ref: { media_id: up.media_id, version_id: up.version.version_id } });
        }
      }
      const ids = sourceIds(ups.map((u) => u.name));
      const sources = ups.map((u, i) => ({ kunci: `$sumber:${ids[i]}`, ref: u.ref }));
      setUpload(null);
      const b = Number(bpm);
      const j = await api.engineBeatspot(projectId, {
        mode: 'beatspot',
        sources,
        ...(preset ? { preset } : {}),
        ...(audio ? { audio_pilihan: audio } : {}),
        ...(vo ? { vo } : {}),
        beatspot: {
          // Only "kreator" needs saying: "umum" is the engine's default.
          sumber_orang: Object.fromEntries(footageItems.map((it, i) => [ids[i]!, orang[it.key] ?? 'umum'] as const).filter(([, v]) => v === 'kreator')),
          sound: soundItem ? `$sumber:${ids[ids.length - 1]}` : null, bpm: !soundItem && b ? b : null, ketukan_per_potong: kpp, durasi: [durMin, durMax], tagline: tagline.trim() || null },
      });
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

  const rerun = async () => {
    if (!current || !pilih) return;
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      const j = await api.beatspotRerun(current.project_id, current.job_id, pilih);
      setCurrent({ project_id: current.project_id, job_id: j.job_id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!plan || !current) return;
    setBusy(true);
    setError(null);
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
  };

  const nameOf = (id: string) => view?.sumber.find((s) => s.id === id)?.nama ?? id;
  const toggleExclude = (id: string) => setPilih((p) => p && { ...p, kecualikan_shot: p.kecualikan_shot.includes(id) ? p.kecualikan_shot.filter((x) => x !== id) : [...p.kecualikan_shot, id], urutan_shot: p.urutan_shot.filter((x) => x !== id) });
  const toggleFirst = (id: string) => setPilih((p) => p && { ...p, urutan_shot: p.urutan_shot.includes(id) ? p.urutan_shot.filter((x) => x !== id) : [...p.urutan_shot, id] });
  const setPerson = (key: string, v: 'kreator' | 'umum') => setPilih((p) => p && { ...p, sumber_orang: { ...p.sumber_orang, [key]: v } });
  const changed = !!view?.pengaturan && !!pilih && JSON.stringify(view.pengaturan) !== JSON.stringify(pilih);
  const lap = view?.laporan ?? null;

  return (
    <>
      <header className="top">
        <h1>Beat Spot</h1>
        <div className="spacer" />
        <span className="muted small hideNarrow">Footage orang pakai produk + sound → potong tepat di ketukan, logo + end card (awareness)</span>
      </header>
      <div className="body enginePage">
        <ErrorNotice error={error ?? jobError} />
        {installed === false && <div className="notice warn">Mesin belum dipasang di server ini. Set <code>MOTION_ENGINE_ROOT</code> ke folder repo mesin lalu jalankan ulang server.</div>}
        {!readOnly && (
          <section className="card" aria-label="Footage dan sound">
            <h2>1 · Footage &amp; sound</h2>
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
                  <input aria-label="Nama proyek baru" value={name} maxLength={120} placeholder={`Beat Spot ${brand?.name ?? ''} ${today()}`} onChange={(e) => setName(e.target.value)} />
                </label>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <label>
                  Footage orang (bisa banyak video)
                  <input
                    aria-label="Footage orang"
                    type="file"
                    accept="video/*"
                    multiple
                    onChange={(e) => {
                      setFootage([...(e.target.files ?? [])].filter((f) => !AUDIO.test(f.name)).slice(0, MAKS_FOOTAGE));
                      setOrang((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith('d:'))));
                    }}
                  />
                </label>
                <label>
                  atau link Google Drive (1 link per baris)
                  <textarea
                    aria-label="Link Google Drive footage"
                    rows={2}
                    placeholder="https://drive.google.com/file/d/…/view"
                    value={driveFootage}
                    onChange={(e) => setDriveFootage(e.target.value)}
                  />
                </label>
              </div>
              {footageItems.length > 0 && (
                <div className="inspFull" role="group" aria-label="Orang di footage">
                  <div className="small">Orang di tiap footage (umum = orang lewat yang memakai produk; kreator = model/kreator sendiri yang setuju):</div>
                  {footageItems.map((it) => (
                    <label key={it.key} className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="small" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {it.label}
                      </span>
                      <select aria-label={`Orang di ${it.label}`} value={orang[it.key] ?? 'umum'} onChange={(e) => setOrang((o) => ({ ...o, [it.key]: e.target.value as 'kreator' | 'umum' }))}>
                        <option value="umum">Umum</option>
                        <option value="kreator">Kreator</option>
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <label>
                  Sound tim (opsional, video atau audio)
                  <input aria-label="Sound tim" type="file" accept="audio/*,video/*" disabled={!!linkSound} onChange={(e) => setSound(e.target.files?.[0] ?? null)} />
                </label>
                <label>
                  atau link Google Drive
                  <input aria-label="Link Google Drive sound" placeholder="https://drive.google.com/file/d/…/view" value={driveSound} disabled={!!sound} onChange={(e) => setDriveSound(e.target.value)} />
                </label>
              </div>
              {(linksFootage.length > 0 || !!linkSound) && (
                <div className={`inspFull small ${linkSalah.length ? 'notice err' : 'muted'}`} role={linkSalah.length ? 'alert' : undefined}>
                  {linkSalah.length
                    ? `Bukan link Google Drive: ${linkSalah.join(', ')}`
                    : 'File Google Drive harus dibagikan "Siapa saja yang memiliki link" (Bagikan → Akses umum). Link folder belum bisa: salin link tiap file. Server mengunduh file lalu menyimpannya di proyek ini.'}
                </div>
              )}
              {!adaSound && (
                <label>
                  BPM (tanpa sound; kosong = 120)
                  <input aria-label="BPM" type="number" min={60} max={200} value={bpm} onChange={(e) => setBpm(e.target.value)} />
                </label>
              )}
              <label>
                Ketukan per potong
                <select aria-label="Ketukan per potong" value={String(kpp)} onChange={(e) => setKpp(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as 1 | 2 | 4))}>
                  <option value="auto">Otomatis (±1,8 dtk per orang)</option>
                  <option value="1">1 ketukan</option>
                  <option value="2">2 ketukan</option>
                  <option value="4">4 ketukan</option>
                </select>
              </label>
              <label>
                Durasi (dtk, termasuk end card)
                <span className="row" style={{ gap: 6 }}>
                  <input aria-label="Durasi minimal" type="number" min={5} max={60} value={durMin} onChange={(e) => setDurMin(Number(e.target.value))} style={{ width: 70 }} />
                  –
                  <input aria-label="Durasi maksimal" type="number" min={5} max={60} value={durMax} onChange={(e) => setDurMax(Number(e.target.value))} style={{ width: 70 }} />
                </span>
              </label>
              <label>
                Preset (opsional)
                <select
                  aria-label="Preset"
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value);
                    // The preset's duration fills the form (still editable); its beat defaults apply in the engine.
                    const pr = brand?.presets.find((x) => x.id === e.target.value);
                    if (pr && pr.durasi.min >= 5 && pr.durasi.max <= 60) {
                      setDurMin(pr.durasi.min);
                      setDurMax(pr.durasi.max);
                    }
                  }}
                >
                  <option value="">— tanpa preset —</option>
                  {(brand?.presets ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nama}
                    </option>
                  ))}
                </select>
              </label>
              <AudioPilihanSelect value={audio} onChange={setAudio} bawaan="sound tim kalau ada" tanpaMusikSaja={!!vo} />
              <SuaraPilihan api={api} kit={brand} value={vo} onChange={setVo} audio={audio} setAudio={setAudio} />
              <label className="inspFull">
                Tagline end card (kosong = dari Brand Kit)
                <input aria-label="Tagline" value={tagline} maxLength={120} onChange={(e) => setTagline(e.target.value)} />
              </label>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <button className="btn primary" disabled={!installed || !footageItems.length || linkSalah.length > 0 || !brand || busy || job?.state === 'berjalan' || job?.state === 'menunggu'} onClick={() => void start()}>
                ♪ Susun Beat Spot
              </button>
              {upload !== null && <span className="muted small">{upload}…</span>}
              {!brand && <span className="muted small">{brandsLoaded ? 'Buat brand dulu di menu Brand.' : 'Memuat brand…'}</span>}
              <span className="muted small">Tanpa blur wajah; orang umum hanya dipakai kalau memang memakai produk brand.</span>
            </div>
          </section>
        )}
        {readOnly && <div className="notice info">Peran Reviewer: bisa melihat hasil Beat Spot. Menjalankan, memilih shot dan menerapkan ke timeline dilakukan Editor / Owner.</div>}

        {job && current && (
          <section className="card" aria-label="Proses mesin">
            <h2>2 · Proses mesin</h2>
            <EngineProgress job={job} log={log} onCancel={readOnly ? undefined : () => void api.engineCancel(current.project_id, current.job_id).catch(setError)} />
          </section>
        )}

        {lap && view && (
          <section className="card" aria-label="Hasil Beat Spot">
            <h2>3 · Potongan di ketukan</h2>
            <div className="statGrid">
              <div className="stat">
                <small>Tempo</small>
                <b>{Math.round(lap.bpm)} BPM</b>
                <span className="muted small">{lap.sumber_ketukan === 'sound' ? 'dari sound tim' : 'pola BPM (tanpa sound)'}</span>
              </div>
              <div className="stat">
                <small>Potong tiap</small>
                <b>{lap.ketukan_per_potong} ketukan</b>
              </div>
              <div className="stat">
                <small>Durasi</small>
                <b>{sec(lap.durasi)} dtk</b>
                {lap.end_card_dtk > 0 && <span className="muted small">end card {sec(lap.end_card_dtk)} dtk</span>}
              </div>
              <div className="stat">
                <small>Potongan</small>
                <b>{lap.potongan.length} orang</b>
              </div>
            </div>
            <table className="list" aria-label="Daftar potongan">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Mulai</th>
                  <th>Durasi</th>
                  <th>Shot</th>
                  <th>Footage</th>
                  <th>Orang</th>
                </tr>
              </thead>
              <tbody>
                {lap.potongan.map((p) => (
                  <tr key={p.no}>
                    <td>{p.no}</td>
                    <td>{sec(p.mulai)}</td>
                    <td>{sec(p.durasi)}</td>
                    <td>{p.shot}</td>
                    <td>{nameOf(p.footage)}</td>
                    <td>{p.sumber_orang === 'kreator' ? 'Kreator' : 'Umum'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {pilih && !readOnly && (
              <details open={changed} aria-label="Pilihan tim">
                <summary>Atur ulang: urutan, kecualikan shot, kreator / umum ({lap.kandidat.length} shot layak)</summary>
                <div className="small muted">Klik "Pakai duluan" sesuai urutan yang diinginkan; sisanya diisi otomatis.</div>
                <table className="list small" aria-label="Kandidat shot">
                  <thead>
                    <tr>
                      <th>Shot</th>
                      <th>Footage</th>
                      <th>Rentang</th>
                      <th>Skor</th>
                      <th>Orang</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lap.kandidat.map((k) => {
                      const out = pilih.kecualikan_shot.includes(k.id);
                      const order = pilih.urutan_shot.indexOf(k.id);
                      const who = pilih.sumber_orang[k.id] ?? pilih.sumber_orang[k.footage] ?? 'umum';
                      return (
                        <tr key={k.id} data-shot={k.id} className={out ? 'muted' : undefined}>
                          <td>
                            {k.id}
                            {k.dipakai && <span className="badge ok">dipakai</span>}
                          </td>
                          <td>{nameOf(k.footage)}</td>
                          <td>
                            {sec(k.dari)}–{sec(k.sampai)}
                          </td>
                          <td>{k.skor === null ? '–' : k.skor.toFixed(2)}</td>
                          <td>
                            <select aria-label={`Orang di ${k.id}`} value={who} onChange={(e) => setPerson(k.id, e.target.value as 'kreator' | 'umum')}>
                              <option value="umum">Umum</option>
                              <option value="kreator">Kreator</option>
                            </select>
                          </td>
                          <td className="row" style={{ gap: 4 }}>
                            <button className={`btn small${order >= 0 ? ' sel' : ''}`} disabled={out} aria-pressed={order >= 0} aria-label={`Pakai ${k.id} duluan`} onClick={() => toggleFirst(k.id)}>
                              {order >= 0 ? `#${order + 1}` : '▲ Pakai duluan'}
                            </button>
                            <button className={`btn small${out ? ' sel' : ''}`} aria-pressed={out} aria-label={`Kecualikan ${k.id}`} onClick={() => toggleExclude(k.id)}>
                              {out ? '↺ Pakai lagi' : '✕ Kecualikan'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {lap.dibuang.length > 0 && (
                  <div className="small muted">
                    Tidak dipakai mesin: {lap.dibuang.slice(0, 30).map((d) => `${d.id} (${d.alasan})`).join(', ')}
                    {lap.dibuang.length > 30 ? ` … +${lap.dibuang.length - 30}` : ''}
                  </div>
                )}
                <button className="btn primary" disabled={busy || !changed} onClick={() => void rerun()}>
                  ↻ Susun ulang dengan pilihan tim
                </button>
              </details>
            )}
          </section>
        )}

        {plan && <PlanCard rencana={plan.rencana} qc={plan.qc} plan={plan.plan} diff={plan.diff} busy={busy} onApprove={() => void approve()} onReject={() => void reject()} />}
        {applied && (
          <section className="card" aria-label="Draf diterapkan">
            <h2>4 · Draf sudah di timeline</h2>
            <p className="small">Satu langkah undo. Geser potongan, render dan QC di Edit.</p>
            <button className="btn primary" onClick={() => onOpenProject(applied)}>
              Buka di Edit →
            </button>
          </section>
        )}

        {history.length > 0 && (
          <section className="card" aria-label="Riwayat Beat Spot">
            <h2>Riwayat Beat Spot proyek ini</h2>
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
                      <button
                        className="btn small"
                        aria-label={`Lihat ${h.job_id}`}
                        onClick={() => {
                          setApplied(null);
                          setCurrent({ project_id: h.project_id, job_id: h.job_id });
                        }}
                      >
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
