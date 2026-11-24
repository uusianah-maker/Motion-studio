import { useEffect, useMemo, useState } from 'react';
import { splitKalimat, voSubtitleOps } from '../../../../packages/core/dist/storage/voText.js';
import type { Api, BrandKit, EditOp, ProjectSummary, Role, TtsGayaInfo, TtsModelId, TtsModelInfo, TtsRequest, TtsView, TtsVoice } from '../api';
import { ErrorNotice } from '../ui';
import { useEngineJob } from './GenerateView';
import { SuaraOwnerPanel } from './SuaraOwnerPanel';

const today = () => new Date().toISOString().slice(0, 10);
const sec = (n: number) => `${n.toFixed(1).replace('.', ',')} dtk`;

/** Plays one media version through a short-lived stream link. */
function Play({ api, versionId, label }: { api: Api; versionId: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    void api.streamUrl(versionId).then((r) => !stale && setUrl(r.url), () => undefined);
    return () => {
      stale = true;
    };
  }, [api, versionId]);
  return url ? <audio controls preload="none" src={url} aria-label={label} style={{ height: 32, maxWidth: '100%' }} /> : <span className="muted small">memuat…</span>;
}

/**
 * R34 "Suara dari Teks" (owner 16 Nov; KONTRAK-ENGINE §21). Paragraph → voice over by the engine
 * (Windows "Andika" now; more voices later). The result goes to Media + Brand → Aset (VO) by itself,
 * with its text and timings, so Editor and other features can use it — and subtitles come from the
 * known text (no Whisper). Hybrid: a sentence can be redone with new text.
 */
export function SuaraView({ api, role = 'owner', projects, onOpenProject, onProjectsChanged }: { api: Api; role?: Role; projects: ProjectSummary[]; onOpenProject: (id: string) => void; onProjectsChanged?: () => void }) {
  /** Owner 16 Nov: "Suara saya" — train the owner's own voice (contract §23). */
  const [tab, setTab] = useState<'teks' | 'saya'>('teks');
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [brandId, setBrandId] = useState('');
  const [defaultBrand, setDefaultBrand] = useState<string | null>(null);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [target, setTarget] = useState('new');
  const [teks, setTeks] = useState('');
  const [suara, setSuara] = useState('windows:Andika');
  const [kecepatan, setKecepatan] = useState(1);
  const [jeda, setJeda] = useState(300);
  /** §28 (owner 24 Nov): ketik teks / upload rekaman VO -> suara -> kecepatan -> gaya -> model. */
  const [asal, setAsal] = useState<'teks' | 'rekaman'>('teks');
  const [rekaman, setRekaman] = useState<File | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [models, setModels] = useState<TtsModelInfo[]>([]);
  const [gayaList, setGayaList] = useState<TtsGayaInfo[]>([]);
  const [model, setModel] = useState<TtsModelId>('andika');
  const [gaya, setGaya] = useState('natural');
  const [perkuat, setPerkuat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState<{ project_id: string; job_id: string } | null>(null);
  const [result, setResult] = useState<TtsView | null>(null);
  /** Redone sentences: no → the new take. */
  const [redo, setRedo] = useState<Record<number, { text: string; job?: { project_id: string; job_id: string }; view?: TtsView }>>({});
  const [placed, setPlaced] = useState<string | null>(null);
  const { job, log } = useEngineJob(api, current?.project_id ?? null, current?.job_id ?? null);

  useEffect(() => {
    void api.brands().then((r) => {
      setBrands(r.brands);
      setBrandId((cur) => cur || r.default_id || r.brands[0]?.brand_id || '');
      setDefaultBrand(r.default_id ?? null);
    }, setError);
    void api.engineSuara().then((r) => {
      setEngineOk(r.tersedia);
      setVoices(r.suara);
      setModels(r.model ?? []);
      setGayaList(r.gaya ?? []);
      if (r.suara.length && !r.suara.some((v) => v.id === 'windows:Andika')) setSuara(r.suara.find((v) => v.bahasa.startsWith('id'))?.id ?? r.suara[0]!.id);
    }, setError);
  }, [api]);
  const brand = brands.find((b) => b.brand_id === brandId) ?? null;
  const kalimat = useMemo(() => splitKalimat(teks), [teks]);
  const neural = asal === 'teks' && model !== 'andika';
  /** Neural readers and Ubah suara copy a trained profile's own recording: Windows voices do not apply. */
  const butuhProfil = neural || asal === 'rekaman';
  const pilihanSuara = (voices?.length ? voices : [{ id: 'windows:Andika', nama: 'Microsoft Andika', bahasa: 'id-ID', gender: 'Male', backend: 'windows' }]).filter((v) => !butuhProfil || v.backend !== 'windows');
  useEffect(() => {
    if (pilihanSuara.length && !pilihanSuara.some((v) => v.id === suara)) setSuara(pilihanSuara[0]!.id);
  }, [pilihanSuara, suara]);
  const modelInfo = models.find((m) => m.id === model);
  const pilihGaya = (g: string) => {
    setGaya(g);
    const j = gayaList.find((x) => x.id === g)?.jeda_ms;
    if (j !== undefined) setJeda(j);
  };
  const ttsRequest = (k: string[]): TtsRequest => ({ kalimat: k, suara, kecepatan, jeda_ms: jeda, ...(neural ? { model, gaya, perkuat_warna: perkuat } : {}) });
  // Projects of this brand (any feature): the VO can be placed on one right away.
  const usable = projects.filter((p) => !p.error && p.status !== 'archived' && !p.variant && (p.brand_id ?? defaultBrand) === brandId);

  // A finished job → its voice over (the first read imports it into Media + Brand → Aset).
  useEffect(() => {
    if (!current || job?.state !== 'siap' || job.job_id !== current.job_id || result?.job_id === current.job_id) return;
    void api.ttsResult(current.project_id, current.job_id).then(setResult, setError);
  }, [api, current, job?.state, job?.job_id, result?.job_id]);

  const ensureProject = async () => {
    if (target !== 'new') return target;
    const p = await api.createProject(`Suara ${brand?.name ?? ''} ${today()}`.replace(/\s+/g, ' ').trim(), 'editor');
    const pr = await api.project(p.project_id);
    if (brand && pr.brand_id !== brand.brand_id) await api.updateProject(p.project_id, pr.revision, { brand_id: brand.brand_id });
    setTarget(p.project_id);
    onProjectsChanged?.();
    return p.project_id;
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setRedo({});
    setPlaced(null);
    try {
      const pid = await ensureProject();
      if (asal === 'rekaman') {
        if (!rekaman) return;
        const up = await api.importFile(rekaman, { kind: 'project', project_id: pid }, setUpload);
        setUpload(null);
        const j = await api.engineUbahSuara(pid, { media_id: up.media_id, version_id: up.version.version_id }, { suara, kecepatan });
        setCurrent({ project_id: pid, job_id: j.job_id });
        return;
      }
      const j = await api.engineTts(pid, ttsRequest(kalimat));
      setCurrent({ project_id: pid, job_id: j.job_id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const redoOne = async (no: number) => {
    const r = redo[no];
    if (!current || !r?.text.trim()) return;
    setError(null);
    try {
      const j = await api.engineTts(current.project_id, ttsRequest([r.text.trim()]));
      setRedo((x) => ({ ...x, [no]: { ...r, job: { project_id: current.project_id, job_id: j.job_id } } }));
      // Wait for it (small job) and read its take.
      for (let i = 0; i < 120; i++) {
        const s = (await api.engineJob(current.project_id, j.job_id)).job;
        if (s.state === 'siap') {
          const view = await api.ttsResult(current.project_id, j.job_id);
          setRedo((x) => ({ ...x, [no]: { ...x[no]!, view } }));
          return;
        }
        if (s.state !== 'menunggu' && s.state !== 'berjalan') throw new Error(s.alasan ?? 'Mesin gagal membuat ulang kalimat ini');
        await new Promise((ok) => setTimeout(ok, 700));
      }
    } catch (e) {
      setError(e);
    }
  };
  /** Put the take on the project's audio lane + subtitles from its text (one edit). */
  const place = async () => {
    if (!current || !result?.gabungan) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.project(current.project_id);
      const at = Math.max(0, ...(p.timeline.tracks.find((t) => t.kind === 'audio')?.clips.map((c) => c.end_ms) ?? [0]));
      const vo = await api.voIndex(result.gabungan.version_id);
      const ops: EditOp[] = [{ op: 'add_clip', track_kind: 'audio', media: result.gabungan, start_ms: at, duration_ms: Math.max(100, Math.round(result.total_durasi * 1000)) }];
      const subsFree = !(p.timeline.tracks.find((t) => t.kind === 'subtitle')?.clips.some((c) => c.end_ms > at));
      if (vo && subsFree) ops.push(...(voSubtitleOps(vo, at) as EditOp[]));
      await api.editProject(current.project_id, p.revision, ops);
      setPlaced(current.project_id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const running = !!job && (job.state === 'menunggu' || job.state === 'berjalan');
  const reviewer = role === 'reviewer';

  return (
    <>
      <header className="top">
        <h1>Suara dari Teks</h1>
        <div className="tabs" role="tablist" aria-label="Bagian suara">
          <button type="button" role="tab" aria-selected={tab === 'teks'} className={`btn small${tab === 'teks' ? ' primary' : ''}`} onClick={() => setTab('teks')}>
            Dari teks
          </button>
          <button type="button" role="tab" aria-selected={tab === 'saya'} className={`btn small${tab === 'saya' ? ' primary' : ''}`} onClick={() => setTab('saya')}>
            Suara saya
          </button>
        </div>
        <div className="spacer" />
        <span className="muted small hideNarrow">Tulis kalimat → suara VO → tersimpan di Aset (VO) → pakai di Edit &amp; fitur lain, subtitle langsung dari teks</span>
      </header>
      {tab === 'saya' ? (
        <SuaraOwnerPanel api={api} role={role} projects={projects} onProjectsChanged={onProjectsChanged} />
      ) : (
      <div className="body enginePage">
        {error ? <ErrorNotice error={error} /> : null}
        {engineOk === false && <div className="notice warn">Mesin belum terpasang di server ini, jadi suara belum bisa dibuat.</div>}
        {reviewer && <div className="notice info">Peran Reviewer hanya melihat. Pembuatan suara oleh Editor / Owner.</div>}
        <section className="card" aria-label="Teks dan suara">
          <div className="inspGrid">
            <label>
              Brand
              <select aria-label="Brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.brand_id} value={b.brand_id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Proyek tujuan
              <select aria-label="Proyek tujuan" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="new">＋ Proyek baru</option>
                {usable.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="tabs" role="radiogroup" aria-label="Asal suara">
            <button type="button" role="radio" aria-checked={asal === 'teks'} className={`btn small${asal === 'teks' ? ' primary' : ''}`} onClick={() => setAsal('teks')}>
              ⌨️ Ketik teks
            </button>
            <button type="button" role="radio" aria-checked={asal === 'rekaman'} className={`btn small${asal === 'rekaman' ? ' primary' : ''}`} onClick={() => setAsal('rekaman')}>
              🎙️ Upload rekaman VO
            </button>
          </div>
          {asal === 'teks' ? (
            <>
              <label className="inspFull">
                Teks yang diucapkan (paragraf / kalimat)
                <textarea aria-label="Teks yang diucapkan" rows={5} style={{ width: '100%' }} maxLength={20000} value={teks} onChange={(e) => setTeks(e.target.value)} placeholder="Halo kak, ini Loose Pants dari Aysilla. Bahannya adem, harganya cuma 99 ribu! Cek keranjang kuning sekarang." />
              </label>
              <div className="muted small">{kalimat.length} kalimat{kalimat.length > 60 ? ' — maksimal 60 per job' : neural && kalimat.length > 25 ? ' — Chatterbox / ZONOS maksimal 25 per job' : ''}</div>
            </>
          ) : (
            <>
              <label className="inspFull">
                Rekaman VO (suara siapa pun, maks 10 menit)
                <input aria-label="Rekaman VO" type="file" accept="audio/*,video/*" onChange={(e) => setRekaman(e.target.files?.[0] ?? null)} />
              </label>
              <div className="muted small">Rekaman diubah ke suara yang dipilih. Intonasi, gaya, dan jeda ikut rekaman aslinya, jadi gaya &amp; model tidak dipakai.{upload !== null ? ` Mengunggah ${Math.round(upload * 100)}%…` : ''}</div>
            </>
          )}
          <div className="inspGrid">
            <label>
              Suara
              <select aria-label="Suara" value={suara} onChange={(e) => setSuara(e.target.value)}>
                {pilihanSuara.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.nama} ({v.bahasa})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kecepatan {kecepatan.toFixed(2).replace('.', ',')}×
              <input type="range" aria-label="Kecepatan bicara" min={0.5} max={2} step={0.05} value={kecepatan} onChange={(e) => setKecepatan(Number(e.target.value))} />
            </label>
            {asal === 'teks' && (
              <label>
                Jeda antar kalimat (ms)
                <input aria-label="Jeda antar kalimat (ms)" type="number" min={0} max={3000} step={50} value={jeda} onChange={(e) => setJeda(Math.max(0, Math.min(3000, Number(e.target.value) || 0)))} />
              </label>
            )}
          </div>
          {asal === 'teks' && (
            <div className="inspGrid">
              <label>
                Gaya bicara
                <select aria-label="Gaya bicara" value={gaya} disabled={!neural} onChange={(e) => pilihGaya(e.target.value)}>
                  {(gayaList.length ? gayaList : [{ id: 'natural', label: 'Natural (ngobrol biasa)', jeda_ms: 300 }]).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model pembaca
                <select aria-label="Model pembaca" value={model} onChange={(e) => setModel(e.target.value as TtsModelId)}>
                  {(models.length ? models : [{ id: 'andika' as const, nama: 'Andika (cepat, kaku)', siap: true, gaya: false }]).map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.siap}>
                      {m.nama}
                      {m.siap ? '' : ' — belum terpasang'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {neural && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" aria-label="Perkuat warna suara" checked={perkuat} onChange={(e) => setPerkuat(e.target.checked)} />
              Perkuat warna suara (lebih mirip, sedikit lebih lama)
            </label>
          )}
          {asal === 'teks' && !neural && <div className="muted small">Andika cepat tapi intonasinya kaku; gaya bicara hanya untuk Chatterbox / ZONOS.</div>}
          {neural && <div className="muted small">{modelInfo?.id === 'zonos' ? 'ZONOS jalan di CPU: ±3 menit per 30 detik suara.' : 'Chatterbox: ±4 menit per 30 detik suara (lebih lama bila GPU sedang dipakai).'} Waktu kata subtitle berupa perkiraan, cek di Edit.</div>}
          <div className="muted small">
            Pelafalan brand: {brand?.pelafalan?.length ? brand.pelafalan.map((p) => `${p.tulisan} → ${p.ucapan}`).join(' · ') : 'belum ada'} (atur di Brand → C).
          </div>
          <button className="btn primary" disabled={busy || running || reviewer || engineOk === false || !brand || !pilihanSuara.length || (asal === 'teks' ? kalimat.length === 0 || kalimat.length > 60 || (neural && (!modelInfo?.siap || kalimat.length > 25)) : !rekaman)} onClick={() => void start()}>
            {asal === 'rekaman' ? '🔁 Ubah suara' : '🔊 Buat suara'}
          </button>
          {butuhProfil && !pilihanSuara.length && <div className="notice warn">Belum ada profil suara yang siap. Latih dulu di tab Suara saya.</div>}
        </section>
        {job && (
          <div className="notice info" role="status" aria-label="Status suara" data-state={job.state}>
            Job {job.job_id}: {job.state === 'siap' ? 'suara siap' : job.state === 'gagal' || job.state === 'ditolak' ? `${job.state} — ${job.alasan ?? ''}` : `${job.tahap} ${job.persen}%`}
            {log && job.state === 'gagal' ? <pre className="small">{log}</pre> : null}
          </div>
        )}
        {result && current && (
          <section className="card" aria-label="Hasil suara">
            <b>Hasil · {sec(result.total_durasi)}</b>
            <div className="muted small">Tersimpan di Media dan Brand → Aset (VO){result.aset_id ? ` sebagai "${result.aset_id}"` : ''}. Teks &amp; waktu tiap kata ikut, jadi subtitle bisa dibuat tanpa Whisper.</div>
            {result.gabungan && <Play api={api} versionId={result.gabungan.version_id} label="Dengar suara lengkap" />}
            <table className="small" aria-label="Kalimat suara">
              <tbody>
                {result.kalimat.map((k) => {
                  const r = redo[k.no];
                  return (
                    <tr key={k.no}>
                      <td>{k.no}</td>
                      <td style={{ minWidth: 220 }}>
                        {r ? <input aria-label={`Teks ulang kalimat ${k.no}`} value={r.text} onChange={(e) => setRedo((x) => ({ ...x, [k.no]: { text: e.target.value } }))} /> : k.teks}
                        {r?.view?.kalimat[0]?.ref && (
                          <div className="small">
                            Pengganti: <Play api={api} versionId={r.view.kalimat[0].ref.version_id} label={`Dengar pengganti kalimat ${k.no}`} />
                          </div>
                        )}
                      </td>
                      <td>{sec(k.durasi)}</td>
                      <td>{k.ref && <Play api={api} versionId={k.ref.version_id} label={`Dengar kalimat ${k.no}`} />}</td>
                      <td>
                        {!r ? (
                          <button className="btn small" disabled={reviewer} onClick={() => setRedo((x) => ({ ...x, [k.no]: { text: k.teks } }))}>
                            Ulang
                          </button>
                        ) : (
                          <button className="btn small" disabled={reviewer || !!(r.job && !r.view)} onClick={() => void redoOne(k.no)}>
                            {r.job && !r.view ? 'Membuat…' : '🔊 Buat ulang'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" disabled={busy || reviewer || !result.gabungan} onClick={() => void place()}>
                ＋ Tambah ke linimasa proyek (audio + subtitle dari teks)
              </button>
              {placed && (
                <button className="btn" onClick={() => onOpenProject(placed)}>
                  Buka di Edit →
                </button>
              )}
            </div>
            {placed && <div className="notice ok small">VO + subtitle masuk ke proyek (satu langkah undo).</div>}
          </section>
        )}
      </div>
      )}
    </>
  );
}
